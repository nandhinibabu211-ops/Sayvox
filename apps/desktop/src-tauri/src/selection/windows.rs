//! UI Automation: selected text of the focused element (TextPattern.GetSelection).
//! Works in apps that expose text through UIA (Outlook, Word, Notepad, and Chromium/Edge
//! pages once their accessibility tree is active). Returns None when unsupported.

use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationTextPattern, UIA_TextPatternId,
};

/// Runs on its own thread (COM is initialised per thread), so the caller never blocks
/// the hotkey path; the result is sent as a separate `context` event.
pub fn selected_text() -> Option<String> {
    // SAFETY: COM initialised on this thread and released below; all interface calls
    // follow UIA's documented contracts.
    unsafe {
        let init = CoInitializeEx(None, COINIT_MULTITHREADED);
        let result = (|| -> Option<String> {
            let uia: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
            let focused = uia.GetFocusedElement().ok()?;
            let pattern: IUIAutomationTextPattern =
                focused.GetCurrentPatternAs(UIA_TextPatternId).ok()?;
            let ranges = pattern.GetSelection().ok()?;
            let mut text = String::new();
            for i in 0..ranges.Length().ok()?.min(8) {
                let range = ranges.GetElement(i).ok()?;
                // Ask for a little more than the cap so `clean` can trim on a boundary.
                let bstr = range.GetText((super::MAX_CHARS + 100) as i32).ok()?;
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(&bstr.to_string());
            }
            (!text.trim().is_empty()).then_some(text)
        })();
        if init.is_ok() {
            CoUninitialize();
        }
        result
    }
}
