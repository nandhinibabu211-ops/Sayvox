//! Windows backend for the hold-to-talk chord: a `WH_KEYBOARD_LL` hook on its own thread
//! with a message loop (Story 1.3, ADR-010).
//!
//! The hook never swallows keys (it always calls `CallNextHookEx`), ignores events we
//! inject ourselves (`LLKHF_INJECTED`, e.g. our own Ctrl+V), and does only O(1) work before
//! handing the event to a channel: Windows silently removes hooks that take longer than
//! `LowLevelHooksTimeout` (~300 ms).
//!
//! The one exception to "never swallow": Enter / Esc while a rewrite waits for review
//! (see `review`), so they don't also reach the app the text is about to go into.

use super::binding::Binding;
use super::review::{ReviewFilter, ReviewKey};
use super::state::{ChordMachine, HotkeyEvent, KeyEvent};
use std::sync::mpsc::Sender;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG,
    WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

struct HookState {
    machine: ChordMachine,
    review: ReviewFilter,
    binding: Binding,
    /// Settings → General is recording a new hotkey: keep tracking keys, emit nothing.
    suspended: bool,
    tx: Sender<HotkeyEvent>,
    start: Instant,
}

static STATE: OnceLock<Mutex<HookState>> = OnceLock::new();

fn now_ms(start: Instant) -> u64 {
    start.elapsed().as_millis() as u64
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let mut consume = false;
    if code == HC_ACTION as i32 {
        // SAFETY: for WH_KEYBOARD_LL with HC_ACTION, lparam points to a KBDLLHOOKSTRUCT.
        let kb = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        if kb.flags.0 & LLKHF_INJECTED.0 == 0 {
            let key = match wparam.0 as u32 {
                WM_KEYDOWN | WM_SYSKEYDOWN => Some(KeyEvent::Down(kb.vkCode)),
                WM_KEYUP | WM_SYSKEYUP => Some(KeyEvent::Up(kb.vkCode)),
                _ => None,
            };
            if let (Some(key), Some(state)) = (key, STATE.get()) {
                if let Ok(mut s) = state.lock() {
                    let t = now_ms(s.start);
                    let (eat, review) = s.review.on_key(key, t);
                    consume = eat;
                    if let Some(r) = review {
                        let _ = s.tx.send(HotkeyEvent::Review {
                            accept: r == ReviewKey::Accept,
                        });
                    }
                    // Consumed keys never reach the chord machine (down or up), so its
                    // view of the keyboard stays consistent.
                    if !eat {
                        if let Some(ev) = s.machine.on_key(key, t) {
                            if !s.suspended {
                                let _ = s.tx.send(ev);
                            }
                        }
                    }
                }
            }
        }
    }
    if consume {
        return LRESULT(1);
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

fn with_state(f: impl FnOnce(&mut HookState)) {
    if let Some(state) = STATE.get() {
        if let Ok(mut s) = state.lock() {
            f(&mut s);
        }
    }
}

/// Handle to the running hook thread.
pub struct HookHandle {
    thread_id: u32,
}

impl HookHandle {
    /// End a hold from outside the keyboard (e.g. `maxSessionSeconds` reached).
    pub fn force_release(&self) {
        with_state(|s| {
            let t = now_ms(s.start);
            if let Some(ev) = s.machine.force_release(t) {
                let _ = s.tx.send(ev);
            }
        });
    }

    /// Switch the hold-to-talk chord (Settings → General).
    pub fn set_binding(&self, binding: Binding) {
        with_state(|s| {
            s.binding = binding;
            s.machine.set_binding(binding);
        });
    }

    /// Pause the chord while the settings window records a new one.
    pub fn set_suspended(&self, suspended: bool) {
        with_state(|s| {
            s.suspended = suspended;
            // A hold that started while suspended must not complete after resuming.
            let b = s.binding;
            s.machine.set_binding(b);
        });
    }

    /// Consume Enter / Esc and report them while a rewrite waits for review.
    pub fn set_review(&self, active: bool) {
        with_state(|s| {
            let t = now_ms(s.start);
            s.review.set_active(active, t);
        });
    }
}

impl Drop for HookHandle {
    fn drop(&mut self) {
        // SAFETY: posting WM_QUIT to our own hook thread ends its message loop.
        let _ = unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
    }
}

/// Install the global hook. Only one hook per process; a second call returns an error.
pub fn install(
    tx: Sender<HotkeyEvent>,
    min_hold_ms: u64,
    binding: Binding,
) -> Result<HookHandle, String> {
    STATE
        .set(Mutex::new(HookState {
            machine: ChordMachine::with_binding(min_hold_ms, binding),
            review: ReviewFilter::default(),
            binding,
            suspended: false,
            tx,
            start: Instant::now(),
        }))
        .map_err(|_| "hotkey hook already installed".to_string())?;

    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<u32, String>>();
    std::thread::Builder::new()
        .name("sayvox-hotkey".into())
        .spawn(move || {
            // SAFETY: standard LL-hook setup; the hook lives as long as this thread's loop.
            unsafe {
                let module = match GetModuleHandleW(None) {
                    Ok(m) => m,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("GetModuleHandleW: {e}")));
                        return;
                    }
                };
                let hook = match SetWindowsHookExW(
                    WH_KEYBOARD_LL,
                    Some(hook_proc),
                    Some(HINSTANCE(module.0)),
                    0,
                ) {
                    Ok(h) => h,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("SetWindowsHookExW: {e}")));
                        return;
                    }
                };
                let _ = ready_tx.send(Ok(GetCurrentThreadId()));

                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                let _ = UnhookWindowsHookEx(hook);
            }
        })
        .map_err(|e| format!("spawn hotkey thread: {e}"))?;

    let thread_id = ready_rx
        .recv()
        .map_err(|_| "hotkey thread exited".to_string())??;
    Ok(HookHandle { thread_id })
}
