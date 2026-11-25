//! Global hold-to-talk hotkey (default Ctrl+Shift, rebindable). See `state` for the chord
//! rules, `binding` for the supported chords and `review` for Enter/Esc during review.

pub mod binding;
pub mod review;
pub mod state;
#[cfg(windows)]
pub mod windows;

pub use binding::Binding;
pub use state::HotkeyEvent;
