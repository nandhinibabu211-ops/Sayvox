//! Foreground window → (exe path, title) via Win32.

use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsWindowVisible,
};

fn exe_of_window(hwnd: HWND) -> String {
    // SAFETY: read-only queries on a window handle and its process.
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let mut exe = String::new();
        if pid != 0 {
            if let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                let mut buf = [0u16; 1024];
                let mut len = buf.len() as u32;
                if QueryFullProcessImageNameW(
                    process,
                    PROCESS_NAME_WIN32,
                    PWSTR(buf.as_mut_ptr()),
                    &mut len,
                )
                .is_ok()
                {
                    exe = String::from_utf16_lossy(&buf[..len as usize]);
                }
                let _ = CloseHandle(process);
            }
        }
        exe
    }
}

pub fn foreground_exe_and_title() -> (String, String) {
    // SAFETY: read-only queries on the foreground window.
    unsafe {
        let hwnd = GetForegroundWindow();
        let mut title = [0u16; 512];
        let n = GetWindowTextW(hwnd, &mut title);
        let title = String::from_utf16_lossy(&title[..n.max(0) as usize]);
        (exe_of_window(hwnd), title)
    }
}

unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: lparam is the &mut Vec passed to EnumWindows below, alive for the call.
    let out = unsafe { &mut *(lparam.0 as *mut Vec<String>) };
    // Visible windows with a title: what the user thinks of as "running apps". The title
    // itself is never read.
    if unsafe { IsWindowVisible(hwnd) }.as_bool() && unsafe { GetWindowTextLengthW(hwnd) } > 0 {
        let exe = exe_of_window(hwnd);
        if !exe.is_empty() {
            out.push(exe);
        }
    }
    BOOL(1)
}

/// Exe paths of apps with a visible window.
pub fn running_exes() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    // SAFETY: the callback only touches `out` through lparam during this call.
    let _ = unsafe { EnumWindows(Some(collect), LPARAM(&mut out as *mut _ as isize)) };
    out
}
