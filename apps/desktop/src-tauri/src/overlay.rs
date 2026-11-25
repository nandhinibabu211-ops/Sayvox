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
