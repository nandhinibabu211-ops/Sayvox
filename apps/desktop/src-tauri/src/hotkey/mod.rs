//! Global hold-to-talk hotkey (Ctrl+Shift). See `state` for the rules.

pub mod state;
#[cfg(windows)]
pub mod windows;

pub use state::HotkeyEvent;
