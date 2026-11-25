//! Hold-to-talk chord state machine (Story 1.3). Pure logic: no OS calls, injected time,
//! so every edge case is unit-tested without Windows.
//!
//! The chord is Ctrl+Shift held together with no other key. `Press` fires the moment both
//! are down (so capture starts at once and the overlay can show within 50 ms). Releasing
//! either modifier ends the hold: `Release` if it lasted at least `min_hold_ms`, else
//! `Cancel` (an accidental tap). Pressing any other key while the chord is down means the
//! user is typing a shortcut such as Ctrl+Shift+T: we emit `Cancel` and ignore the chord
//! until every key is released. Key repeat is ignored.

/// Virtual-key codes the low-level hook reports (left/right specific).
pub mod vk {
    pub const SHIFT: u32 = 0x10;
    pub const CONTROL: u32 = 0x11;
    pub const LSHIFT: u32 = 0xA0;
    pub const RSHIFT: u32 = 0xA1;
    pub const LCONTROL: u32 = 0xA2;
    pub const RCONTROL: u32 = 0xA3;
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
    Release { held_ms: u64 },
    Cancel,
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
    ctrl: [bool; 2],
    shift: [bool; 2],
    /// Non-modifier keys currently down (a set, so auto-repeat can't inflate it).
    others_down: std::collections::HashSet<u32>,
    phase: Phase,
}

impl ChordMachine {
    pub const DEFAULT_MIN_HOLD_MS: u64 = 300;

    pub fn new(min_hold_ms: u64) -> Self {
        Self {
            min_hold_ms,
            ctrl: [false; 2],
            shift: [false; 2],
            others_down: std::collections::HashSet::new(),
            phase: Phase::Idle,
        }
    }

    fn ctrl_down(&self) -> bool {
        self.ctrl[0] || self.ctrl[1]
    }

    fn shift_down(&self) -> bool {
        self.shift[0] || self.shift[1]
    }

    /// Returns true when the key's state actually changed (false for auto-repeat).
    fn track(&mut self, key: KeyEvent) -> bool {
        let (code, down) = match key {
            KeyEvent::Down(c) => (c, true),
            KeyEvent::Up(c) => (c, false),
        };
        let slot = match code {
            vk::LCONTROL | vk::CONTROL => Some((&mut self.ctrl, 0)),
            vk::RCONTROL => Some((&mut self.ctrl, 1)),
            vk::LSHIFT | vk::SHIFT => Some((&mut self.shift, 0)),
            vk::RSHIFT => Some((&mut self.shift, 1)),
            _ => None,
        };
        match slot {
            Some((arr, i)) => {
                let changed = arr[i] != down;
                arr[i] = down;
                changed
            }
            None => {
                if down {
                    self.others_down.insert(code)
                } else {
                    self.others_down.remove(&code)
                }
            }
        }
    }

    /// Feed one key event at `now_ms`; returns the hotkey event it caused, if any.
    pub fn on_key(&mut self, key: KeyEvent, now_ms: u64) -> Option<HotkeyEvent> {
        let is_modifier = matches!(
            key,
            KeyEvent::Down(c) | KeyEvent::Up(c)
                if matches!(c, vk::SHIFT | vk::CONTROL | vk::LSHIFT | vk::RSHIFT | vk::LCONTROL | vk::RCONTROL)
        );
        let changed = self.track(key);
        if is_modifier && !changed {
            return None; // auto-repeat of a held modifier
        }

        match self.phase {
            Phase::Idle => {
                if self.ctrl_down() && self.shift_down() && self.others_down.is_empty() {
                    self.phase = Phase::Holding { since_ms: now_ms };
                    return Some(HotkeyEvent::Press);
                }
                None
            }
            Phase::Holding { since_ms } => {
                if matches!(key, KeyEvent::Down(_)) && !is_modifier {
                    self.phase = Phase::Tainted;
                    return Some(HotkeyEvent::Cancel);
                }
                if !(self.ctrl_down() && self.shift_down()) {
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

    /// Stay tainted until every tracked key is up, so a lingering modifier can't re-arm.
    fn idle_or_tainted(&self) -> Phase {
        if self.ctrl_down() || self.shift_down() || !self.others_down.is_empty() {
            Phase::Tainted
        } else {
            Phase::Idle
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
        // Still holding Ctrl+Shift, but tainted: no new Press.
        assert_eq!(s.on_key(Down(LSHIFT), 120), None);
        assert_eq!(s.on_key(Up(LSHIFT), 900), None);
        assert_eq!(s.on_key(Up(LCONTROL), 910), None);
        // Fully released: the chord works again.
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
            s.on_key(Down(0x41), t); // 'A' auto-repeat
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
        // Releasing one Ctrl while the other is still down keeps the hold.
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
}
