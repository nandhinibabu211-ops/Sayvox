//! Windows clipboard + `SendInput` implementation of [`Clipboard`] and [`Keyboard`].

use super::{Clipboard, Keyboard, Snapshot};
use std::time::Duration;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, GlobalFree, HANDLE, HGLOBAL};
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel,
    TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
    GetClipboardSequenceNumber, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CONTROL, VK_LSHIFT, VK_RSHIFT, VK_SHIFT, VK_V,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

const CF_UNICODETEXT: u32 = 13;
/// Formats whose clipboard handle is not an HGLOBAL (GDI objects, owner-display, private
/// GDI range). Windows re-synthesizes bitmaps from CF_DIB, so skipping them loses nothing.
fn is_memory_format(f: u32) -> bool {
    !matches!(f, 2 | 3 | 9 | 14 | 0x80 | 0x82 | 0x83 | 0x8E) && !(0x300..=0x3FF).contains(&f)
}
/// Don't snapshot more than this (e.g. a huge copied image) to keep paste fast.
const MAX_SNAPSHOT_BYTES: usize = 32 * 1024 * 1024;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn register(name: &str) -> u32 {
    let w = wide(name);
    // SAFETY: valid NUL-terminated UTF-16 string.
    unsafe { RegisterClipboardFormatW(PCWSTR(w.as_ptr())) }
}

/// Keeps dictated (and restored) text out of Win+V history and cloud clipboard sync.
fn privacy_formats() -> [u32; 3] {
    [
        register("ExcludeClipboardContentFromMonitorProcessing"),
        register("CanIncludeInClipboardHistory"),
        register("CanUploadToCloudClipboard"),
    ]
}

struct OpenGuard;
impl Drop for OpenGuard {
    fn drop(&mut self) {
        // SAFETY: only created after a successful OpenClipboard.
        let _ = unsafe { CloseClipboard() };
    }
}

fn open() -> Result<OpenGuard, String> {
    // Another app may hold the clipboard briefly; retry for ~200 ms.
    for _ in 0..20 {
        // SAFETY: no owner window is required for read/replace.
        if unsafe { OpenClipboard(None) }.is_ok() {
            return Ok(OpenGuard);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Err("clipboard is busy".into())
}

fn alloc(bytes: &[u8]) -> Result<HGLOBAL, String> {
    // SAFETY: allocate, copy, unlock; ownership passes to the clipboard on SetClipboardData.
    unsafe {
        let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)).map_err(|e| e.to_string())?;
        let p = GlobalLock(h) as *mut u8;
        if p.is_null() {
            let _ = GlobalFree(Some(h));
            return Err("GlobalLock failed".into());
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
        let _ = GlobalUnlock(h);
        Ok(h)
    }
}

fn put(format: u32, bytes: &[u8]) -> Result<(), String> {
    let h = alloc(bytes)?;
    // SAFETY: clipboard is open; on success the system owns `h`.
    if unsafe { SetClipboardData(format, Some(HANDLE(h.0))) }.is_err() {
        let _ = unsafe { GlobalFree(Some(h)) };
        return Err(format!("SetClipboardData({format}) failed"));
    }
    Ok(())
}

fn mark_private() {
    let zero = 0u32.to_le_bytes();
    for f in privacy_formats() {
        let _ = put(f, &zero);
    }
}

pub struct WindowsClipboard;

impl Clipboard for WindowsClipboard {
    fn sequence(&self) -> u32 {
        // SAFETY: no preconditions.
        unsafe { GetClipboardSequenceNumber() }
    }

    fn snapshot(&mut self) -> Result<Snapshot, String> {
        let _g = open()?;
        let skip = privacy_formats();
        let mut items = Vec::new();
        let mut total = 0usize;
        let mut format = 0u32;
        loop {
            // SAFETY: clipboard is open.
            format = unsafe { EnumClipboardFormats(format) };
            if format == 0 {
                break;
            }
            if !is_memory_format(format) || skip.contains(&format) {
                continue;
            }
            // SAFETY: memory formats hold an HGLOBAL; we copy out under GlobalLock.
            unsafe {
                let Ok(handle) = GetClipboardData(format) else {
                    continue;
                };
                let h = HGLOBAL(handle.0);
                let size = GlobalSize(h);
                if size == 0 || total + size > MAX_SNAPSHOT_BYTES {
                    continue;
                }
                let p = GlobalLock(h) as *const u8;
                if p.is_null() {
                    continue;
                }
                let bytes = std::slice::from_raw_parts(p, size).to_vec();
                let _ = GlobalUnlock(h);
                total += size;
                items.push((format, bytes));
            }
        }
        Ok(Snapshot { items })
    }

    fn set_text(&mut self, text: &str) -> Result<(), String> {
        let _g = open()?;
        // SAFETY: clipboard is open.
        unsafe { EmptyClipboard() }.map_err(|e| e.to_string())?;
        let utf16: Vec<u8> = wide(text).iter().flat_map(|c| c.to_le_bytes()).collect();
        put(CF_UNICODETEXT, &utf16)?;
        mark_private();
        Ok(())
    }

    fn restore(&mut self, snapshot: &Snapshot) -> Result<(), String> {
        let _g = open()?;
        // SAFETY: clipboard is open.
        unsafe { EmptyClipboard() }.map_err(|e| e.to_string())?;
        for (format, bytes) in &snapshot.items {
            let _ = put(*format, bytes);
        }
        // The original was already in history; don't add a duplicate entry.
        mark_private();
        Ok(())
    }
}

fn key(vk: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    KEYBD_EVENT_FLAGS(0)
                },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn integrity_rid(process: HANDLE) -> Option<u32> {
    // SAFETY: standard token query; buffers sized from the first call.
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
        let mut len = 0u32;
        let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut len);
        let mut buf = vec![0u8; len as usize];
        let ok = GetTokenInformation(
            token,
            TokenIntegrityLevel,
            Some(buf.as_mut_ptr().cast()),
            len,
            &mut len,
        );
        let _ = CloseHandle(token);
        ok.ok()?;
        let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let count = *GetSidSubAuthorityCount(label.Label.Sid);
        Some(*GetSidSubAuthority(
            label.Label.Sid,
            u32::from(count.saturating_sub(1)),
        ))
    }
}

pub struct WindowsKeyboard;

impl Keyboard for WindowsKeyboard {
    fn target_is_elevated(&self) -> bool {
        // SAFETY: read-only queries on the foreground window's process.
        unsafe {
            let hwnd = GetForegroundWindow();
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 {
                return false;
            }
            let Some(ours) = integrity_rid(GetCurrentProcess()) else {
                return false;
            };
            let Ok(target) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return false;
            };
            // Can't read an elevated process's token from medium integrity: treat as elevated.
            let theirs = integrity_rid(target);
            let _ = CloseHandle(target);
            theirs.is_none_or(|t| t > ours)
        }
    }

    fn paste(&mut self) -> Result<(), String> {
        let mut inputs = Vec::with_capacity(8);
        // The user may still be holding Shift from the chord: lift it so this is Ctrl+V,
        // not Ctrl+Shift+V (paste-as-plain or a different command in some apps).
        // SAFETY: GetAsyncKeyState has no preconditions.
        for vk in [VK_LSHIFT, VK_RSHIFT, VK_SHIFT] {
            if unsafe { GetAsyncKeyState(i32::from(vk.0)) } < 0 {
                inputs.push(key(vk, true));
            }
        }
        inputs.extend([
            key(VK_CONTROL, false),
            key(VK_V, false),
            key(VK_V, true),
            key(VK_CONTROL, true),
        ]);
        // SAFETY: well-formed keyboard INPUT array.
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize != inputs.len() {
            return Err("SendInput was blocked".into());
        }
        Ok(())
    }
}
