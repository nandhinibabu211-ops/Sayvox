//! The overlay ("notch") window: pre-created hidden at startup, shown top-center without
//! taking focus from the app the user is typing in (Story 1.2 AC 3, front-end spec §4).

use tauri::{AppHandle, Manager, PhysicalPosition, WebviewWindow};

pub const LABEL: &str = "overlay";
const TOP_MARGIN_PX: f64 = 12.0;

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

#[cfg(windows)]
fn raw_hwnd(w: &WebviewWindow) -> Option<windows::Win32::Foundation::HWND> {
    // Tauri may use a different `windows` crate version; go through the raw pointer.
    w.hwnd()
        .ok()
        .map(|h| windows::Win32::Foundation::HWND(h.0 as _))
}

/// Make the overlay a non-activating, always-on-top tool window (no taskbar entry, never
/// becomes the foreground window, so keystrokes keep going to the user's app).
pub fn configure(app: &AppHandle) {
    #[cfg(windows)]
    if let Some(hwnd) = window(app).as_ref().and_then(raw_hwnd) {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
            WS_EX_TOPMOST,
        };
        // SAFETY: valid HWND owned by this process.
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let add = (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0 | WS_EX_TOPMOST.0) as isize;
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | add);
        }
    }
}

fn place_top_center(w: &WebviewWindow) {
    let monitor = w.primary_monitor().ok().flatten();
    let size = w.outer_size().ok();
    if let (Some(m), Some(s)) = (monitor, size) {
        let area = m.work_area();
        let x = area.position.x as f64 + (area.size.width as f64 - s.width as f64) / 2.0;
        let y = area.position.y as f64 + TOP_MARGIN_PX * m.scale_factor();
        let _ = w.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
    }
}

/// Show without activation (`SW_SHOWNOACTIVATE`); called straight from the hotkey thread.
pub fn show(app: &AppHandle) {
    let Some(w) = window(app) else { return };
    place_top_center(&w);
    #[cfg(windows)]
    if let Some(hwnd) = raw_hwnd(&w) {
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
            SW_SHOWNOACTIVATE,
        };
        // SAFETY: valid HWND owned by this process.
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
        return;
    }
    let _ = w.show();
}

pub fn hide(app: &AppHandle) {
    if let Some(w) = window(app) {
        let _ = w.hide();
    }
}

#[tauri::command]
pub fn overlay_hide(app: AppHandle) {
    hide(&app);
}

// ── Watchdog ─────────────────────────────────────────────────────────────
// Rust shows the notch on every press, but only the overlay page draws it and hides it
// again. If the page isn't processing events (still loading, or its event channel
// stalled), the notch would sit there empty forever. The page reports each draw
// (`overlay_rendered`); if a press gets no draw within WATCHDOG_MS, hide the notch and
// reload the page, which re-attaches a fresh event channel.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// How long a press may wait for the page's first draw ("Listening" appears in ~50 ms).
pub const WATCHDOG_MS: u64 = 3_000;

static EPOCH: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
static LAST_RENDER_MS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    EPOCH.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1
}

/// True if the page drew nothing since `pressed_at` (both in watchdog milliseconds).
pub fn stalled_since(pressed_at: u64, last_render: u64) -> bool {
    last_render < pressed_at
}

/// Called by the overlay page every time it draws a state.
#[tauri::command]
pub fn overlay_rendered() {
    LAST_RENDER_MS.store(now_ms(), Ordering::SeqCst);
}

/// Start the watchdog for a press that just showed the notch.
pub fn watch_press(app: &AppHandle) {
    let pressed_at = now_ms();
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(WATCHDOG_MS));
        if stalled_since(pressed_at, LAST_RENDER_MS.load(Ordering::SeqCst)) {
            hide(&app);
            if let Some(w) = window(&app) {
                // A stalled or never-loaded page: start it again (it re-attaches itself).
                let _ = w.eval("location.reload()");
            }
        }
    });
}

/// Grow/shrink the notch for streamed text (front-end spec §4: 64–240 px tall).
#[tauri::command]
pub fn overlay_resize(app: AppHandle, height: f64) {
    if let Some(w) = window(&app) {
        let h = height.clamp(64.0, 240.0);
        let _ = w.set_size(tauri::LogicalSize::new(420.0, h));
        place_top_center(&w);
    }
}

#[cfg(test)]
mod watchdog_tests {
    use super::stalled_since;

    #[test]
    fn a_press_without_a_draw_is_stalled() {
        // Page drew at 100 ms; press at 5 000 ms; nothing since: stalled.
        assert!(stalled_since(5_000, 100));
        // Page drew right after the press: alive.
        assert!(!stalled_since(5_000, 5_040));
        // Draw at the same millisecond counts as alive.
        assert!(!stalled_since(5_000, 5_000));
    }
}
