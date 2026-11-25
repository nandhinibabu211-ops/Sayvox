//! Hold-to-talk chord state machine (Story 1.3, rebindable in Story 2.6). Pure logic: no OS
//! calls, injected time, so every edge case is unit-tested without Windows.
//!
//! The chord is a [`Binding`]: exactly its modifiers held, nothing else. `Press` fires the
//! moment the chord is complete (capture starts at once; overlay within 50 ms). Releasing
//! any of its modifiers ends the hold: `Release` if it lasted at least `min_hold_ms`, else
//! `Cancel` (accidental tap). Any other key — a letter or an extra modifier — while the
//! chord is held means the user is typing a shortcut (Ctrl+Shift+T, Ctrl+Shift+Alt…): we
//! emit `Cancel` and ignore the chord until every key is released. Key repeat is ignored.

use super::binding::{modifier_bit, Binding};
use std::collections::HashSet;

/// Virtual-key codes the low-level hook reports (left/right specific), for tests.
#[cfg(test)]
pub mod vk {
    pub const SHIFT: u32 = 0x10;
    pub const CONTROL: u32 = 0x11;
    pub const LSHIFT: u32 = 0xA0;
    pub const RSHIFT: u32 = 0xA1;
    pub const LCONTROL: u32 = 0xA2;
    pub const RCONTROL: u32 = 0xA3;
    pub const LMENU: u32 = 0xA4;
    pub const LWIN: u32 = 0x5B;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyEvent {
    Down(u32),
    Up(u32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HotkeyEvent {
    Press,
    Release {
        held_ms: u64,
    },
    Cancel,
    /// Enter (accept) / Esc (discard) while a rewrite waits for review. Emitted by the
    /// hook's [`super::review::ReviewFilter`], never by the chord machine.
    Review {
        accept: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Idle,
    /// Chord held; `Press` already emitted.
    Holding {
        since_ms: u64,
    },
    /// Another key joined the chord; wait until everything is released.
    Tainted,
}

#[derive(Debug)]
pub struct ChordMachine {
    min_hold_ms: u64,
    binding: Binding,
    /// Physical keys currently down (vk codes), so left/right and repeats are exact.
    down: HashSet<u32>,
    phase: Phase,
}

impl ChordMachine {
    pub const DEFAULT_MIN_HOLD_MS: u64 = 300;

    #[cfg(test)]
    pub fn new(min_hold_ms: u64) -> Self {
        Self::with_binding(min_hold_ms, Binding::DEFAULT)
    }

    pub fn with_binding(min_hold_ms: u64, binding: Binding) -> Self {
        Self {
            min_hold_ms,
            binding,
            down: HashSet::new(),
            phase: Phase::Idle,
        }
    }

    /// Change the chord at runtime (Settings → General). Ends any hold in progress.
    pub fn set_binding(&mut self, binding: Binding) {
        self.binding = binding;
        if !matches!(self.phase, Phase::Idle) {
            self.phase = Phase::Tainted;
        }
    }

    fn held_mods(&self) -> u8 {
        self.down.iter().fold(0, |m, &vk| m | modifier_bit(vk))
    }

    fn others_down(&self) -> bool {
        self.down.iter().any(|&vk| modifier_bit(vk) == 0)
    }

    fn chord_complete(&self) -> bool {
        self.held_mods() == self.binding.mods && !self.others_down()
    }

    /// Feed one key event at `now_ms`; returns the hotkey event it caused, if any.
    pub fn on_key(&mut self, key: KeyEvent, now_ms: u64) -> Option<HotkeyEvent> {
        let (code, is_down) = match key {
            KeyEvent::Down(c) => (c, true),
            KeyEvent::Up(c) => (c, false),
        };
        let changed = if is_down {
            self.down.insert(code)
        } else {
            self.down.remove(&code)
        };
        if !changed {
            return None; // auto-repeat, or an up we never saw go down
        }

        match self.phase {
            Phase::Idle => {
                if is_down && self.chord_complete() {
                    self.phase = Phase::Holding { since_ms: now_ms };
                    return Some(HotkeyEvent::Press);
                }
                None
            }
            Phase::Holding { since_ms } => {
                let bit = modifier_bit(code);
                if is_down {
                    // A letter, or a modifier that isn't part of the chord: it's a shortcut.
                    self.phase = Phase::Tainted;
                    return Some(HotkeyEvent::Cancel);
                }
                if bit & self.binding.mods != 0 && self.held_mods() & bit == 0 {
                    // One of the chord's modifiers is fully up (both left and right).
                    self.phase = self.idle_or_tainted();
                    let held_ms = now_ms.saturating_sub(since_ms);
                    return Some(if held_ms < self.min_hold_ms {
                        HotkeyEvent::Cancel
                    } else {
                        HotkeyEvent::Release { held_ms }
                    });
                }
                None
            }
            Phase::Tainted => {
                self.phase = self.idle_or_tainted();
                None
            }
        }
    }

    /// Stay tainted until every key is up, so a lingering modifier can't re-arm.
    fn idle_or_tainted(&self) -> Phase {
        if self.down.is_empty() {
            Phase::Idle
        } else {
            Phase::Tainted
        }
    }

    /// Force-end a hold (e.g. `maxSessionSeconds` reached). Returns `Release` if holding.
    pub fn force_release(&mut self, now_ms: u64) -> Option<HotkeyEvent> {
        if let Phase::Holding { since_ms } = self.phase {
            self.phase = Phase::Tainted;
            return Some(HotkeyEvent::Release {
                held_ms: now_ms.saturating_sub(since_ms),
            });
        }
        None
    }

    #[cfg(test)]
    pub fn is_holding(&self) -> bool {
        matches!(self.phase, Phase::Holding { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::super::binding::Binding;
    use super::vk::*;
    use super::KeyEvent::{Down, Up};
    use super::*;

    const T: u64 = 300;

    fn m() -> ChordMachine {
        ChordMachine::new(T)
    }

    #[test]
    fn press_then_release_after_min_hold() {
        let mut s = m();
        assert_eq!(s.on_key(Down(LCONTROL), 0), None);
        assert_eq!(s.on_key(Down(LSHIFT), 10), Some(HotkeyEvent::Press));
        assert!(s.is_holding());
        assert_eq!(
            s.on_key(Up(LSHIFT), 1_210),
            Some(HotkeyEvent::Release { held_ms: 1_200 })
        );
        assert_eq!(s.on_key(Up(LCONTROL), 1_220), None);
        assert!(!s.is_holding());
    }

    #[test]
    fn order_of_modifiers_does_not_matter() {
        let mut s = m();
        assert_eq!(s.on_key(Down(RSHIFT), 0), None);
        assert_eq!(s.on_key(Down(RCONTROL), 5), Some(HotkeyEvent::Press));
    }

    #[test]
    fn short_tap_is_cancelled() {
        let mut s = m();
        s.on_key(Down(LCONTROL), 0);
        assert_eq!(s.on_key(Down(LSHIFT), 0), Some(HotkeyEvent::Press));
        assert_eq!(s.on_key(Up(LCONTROL), T - 1), Some(HotkeyEvent::Cancel));
    }

    #[test]
    fn exactly_min_hold_is_a_release() {
        let mut s = m();
        s.on_key(Down(LCONTROL), 0);
        s.on_key(Down(LSHIFT), 0);
        assert_eq!(
            s.on_key(Up(LSHIFT), T),
            Some(HotkeyEvent::Release { held_ms: T })
        );
    }

    #[test]
    fn auto_repeat_does_not_emit_again() {
        let mut s = m();
        s.on_key(Down(LCONTROL), 0);
        assert_eq!(s.on_key(Down(LSHIFT), 1), Some(HotkeyEvent::Press));
        for t in (30..600).step_by(30) {
            assert_eq!(s.on_key(Down(LSHIFT), t), None);
            assert_eq!(s.on_key(Down(LCONTROL), t), None);
        }
        assert!(matches!(
            s.on_key(Up(LSHIFT), 700),
            Some(HotkeyEvent::Release { .. })
        ));
    }

    #[test]
    fn shortcut_like_ctrl_shift_t_cancels_and_does_not_rearm() {
        let mut s = m();
        s.on_key(Down(LCONTROL), 0);
        assert_eq!(s.on_key(Down(LSHIFT), 0), Some(HotkeyEvent::Press));
        assert_eq!(s.on_key(Down(0x54), 50), Some(HotkeyEvent::Cancel)); // 'T'
        assert_eq!(s.on_key(Up(0x54), 80), None);
        assert_eq!(s.on_key(Down(LSHIFT), 120), None);
        assert_eq!(s.on_key(Up(LSHIFT), 900), None);
        assert_eq!(s.on_key(Up(LCONTROL), 910), None);
        s.on_key(Down(LCONTROL), 1_000);
        assert_eq!(s.on_key(Down(LSHIFT), 1_001), Some(HotkeyEvent::Press));
    }

    #[test]
    fn chord_does_not_start_while_another_key_is_held() {
        let mut s = m();
        s.on_key(Down(0x41), 0); // 'A' held
        s.on_key(Down(LCONTROL), 10);
        assert_eq!(s.on_key(Down(LSHIFT), 20), None);
    }

    #[test]
    fn auto_repeat_of_another_key_does_not_block_the_chord_later() {
        let mut s = m();
        for t in 0..10 {
            s.on_key(Down(0x41), t);
        }
        s.on_key(Up(0x41), 20);
        s.on_key(Down(LCONTROL), 30);
        assert_eq!(s.on_key(Down(LSHIFT), 31), Some(HotkeyEvent::Press));
    }

    #[test]
    fn left_and_right_variants_combine() {
        let mut s = m();
        s.on_key(Down(LCONTROL), 0);
        s.on_key(Down(RCONTROL), 0);
        assert_eq!(s.on_key(Down(LSHIFT), 0), Some(HotkeyEvent::Press));
        assert_eq!(s.on_key(Up(LCONTROL), 500), None);
        assert!(matches!(
            s.on_key(Up(RCONTROL), 600),
            Some(HotkeyEvent::Release { .. })
        ));
    }

    #[test]
    fn force_release_ends_the_hold_and_waits_for_keys_up() {
        let mut s = m();
        s.on_key(Down(LCONTROL), 0);
        s.on_key(Down(LSHIFT), 0);
        assert_eq!(
            s.force_release(300_000),
            Some(HotkeyEvent::Release { held_ms: 300_000 })
        );
        assert_eq!(s.force_release(300_001), None);
        assert_eq!(s.on_key(Up(LSHIFT), 300_100), None);
        assert_eq!(s.on_key(Up(LCONTROL), 300_200), None);
        s.on_key(Down(LCONTROL), 400_000);
        assert_eq!(s.on_key(Down(LSHIFT), 400_000), Some(HotkeyEvent::Press));
    }

    // ── Story 2.6 / T072: rebindable chord ─────────────────────────────────

    #[test]
    fn a_third_modifier_is_a_shortcut_not_a_dictation() {
        let mut s = m();
        s.on_key(Down(LCONTROL), 0);
        assert_eq!(s.on_key(Down(LSHIFT), 0), Some(HotkeyEvent::Press));
        assert_eq!(s.on_key(Down(LMENU), 40), Some(HotkeyEvent::Cancel));
        // Ctrl+Shift+Alt pressed together from the start never presses at all.
        let mut s = m();
        s.on_key(Down(LMENU), 0);
        s.on_key(Down(LCONTROL), 0);
        assert_eq!(s.on_key(Down(LSHIFT), 0), None);
    }

    #[test]
    fn ctrl_alt_binding() {
        let mut s = ChordMachine::with_binding(T, Binding::parse("Ctrl+Alt").unwrap());
        s.on_key(Down(LCONTROL), 0);
        assert_eq!(
            s.on_key(Down(LSHIFT), 0),
            None,
            "Ctrl+Shift no longer triggers"
        );
        s.on_key(Up(LSHIFT), 10);
        s.on_key(Up(LCONTROL), 10);
        s.on_key(Down(LCONTROL), 100);
        assert_eq!(s.on_key(Down(LMENU), 110), Some(HotkeyEvent::Press));
        assert!(matches!(
            s.on_key(Up(LMENU), 900),
            Some(HotkeyEvent::Release { .. })
        ));
    }

    #[test]
    fn ctrl_win_binding() {
        let mut s = ChordMachine::with_binding(T, Binding::parse("Ctrl+Win").unwrap());
        s.on_key(Down(LWIN), 0);
        assert_eq!(s.on_key(Down(LCONTROL), 5), Some(HotkeyEvent::Press));
    }

    #[test]
    fn changing_the_binding_mid_hold_ends_it_safely() {
        let mut s = m();
        s.on_key(Down(LCONTROL), 0);
        assert_eq!(s.on_key(Down(LSHIFT), 0), Some(HotkeyEvent::Press));
        s.set_binding(Binding::parse("Ctrl+Alt").unwrap());
        assert_eq!(s.on_key(Up(LSHIFT), 900), None);
        assert_eq!(s.on_key(Up(LCONTROL), 910), None);
        s.on_key(Down(LCONTROL), 1_000);
        assert_eq!(s.on_key(Down(LMENU), 1_001), Some(HotkeyEvent::Press));
    }

    #[test]
    fn legacy_generic_vk_codes_still_work() {
        let mut s = m();
        s.on_key(Down(CONTROL), 0);
        assert_eq!(s.on_key(Down(SHIFT), 0), Some(HotkeyEvent::Press));
    }
}
