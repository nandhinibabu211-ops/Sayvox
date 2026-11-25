//! Opt-in reply context (Story 3 / T063): the text the user has *selected* in the app they
//! dictate into (e.g. the email they're replying to), read at hotkey press.
//!
//! Privacy rules (Constitution I):
//! - off by default; the user turns it on (Settings → Modes, Story 2.6);
//! - only an explicit selection is read — never the whole window or document;
//! - read via UI Automation, so the clipboard is untouched and no keys are sent;
//! - capped at 8 000 characters, held in memory for one rewrite, never stored or logged.

#[cfg(windows)]
pub mod windows;

use std::sync::atomic::{AtomicBool, Ordering};

/// Matches `RewriteRequest.threadContext` (max 8 000) in packages/shared.
pub const MAX_CHARS: usize = 8_000;
/// A selection shorter than this is a stray click, not a message to reply to.
const MIN_CHARS: usize = 20;

static ENABLED: AtomicBool = AtomicBool::new(false);

pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_reply_context(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

/// Normalise a raw selection: trim, collapse runs of blank lines, cap at MAX_CHARS
/// (on a char boundary), and drop selections too short to be useful.
pub fn clean(raw: &str) -> Option<String> {
    let mut out = String::with_capacity(raw.len().min(MAX_CHARS * 4));
    let mut blank_run = 0;
    for line in raw.replace("\r\n", "\n").replace('\r', "\n").lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
        } else {
            blank_run = 0;
        }
        out.push_str(line);
        out.push('\n');
    }
    let trimmed = out.trim();
    if trimmed.chars().count() < MIN_CHARS {
        return None;
    }
    Some(trimmed.chars().take(MAX_CHARS).collect())
}

/// The cleaned selection in the foreground app, if the feature is on and there is one.
pub fn capture() -> Option<String> {
    if !enabled() {
        return None;
    }
    #[cfg(windows)]
    {
        windows::selected_text().and_then(|raw| clean(&raw))
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn off_by_default() {
        assert!(!enabled());
        assert_eq!(capture(), None);
    }

    #[test]
    fn cleans_and_caps() {
        let raw = "Hi team,\r\n\r\n\r\n\r\nCan you send the Q3 numbers by Friday?\r\n  ";
        assert_eq!(
            clean(raw).as_deref(),
            Some("Hi team,\n\nCan you send the Q3 numbers by Friday?")
        );
        let long = "é".repeat(MAX_CHARS + 50);
        assert_eq!(clean(&long).unwrap().chars().count(), MAX_CHARS);
    }

    #[test]
    fn ignores_stray_short_selections() {
        assert_eq!(clean("ok"), None);
        assert_eq!(clean("   \n  "), None);
    }
}
