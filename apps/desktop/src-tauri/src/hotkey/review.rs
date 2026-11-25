//! Enter / Esc while a rewrite waits for review (Story 3.6 / T071). Pure logic, unit-tested.
//!
//! The overlay never takes focus, so the keys are read in the low-level hook. While review
//! is active they are *consumed*: Enter must not also send the Slack message or the email
//! the user is about to insert into. The matching key-up is consumed too, and only keys
//! whose down we consumed, so the target app never sees half a keystroke.
//!
//! Review has a deadline so a crashed web side can't leave Enter swallowed forever.

use super::state::KeyEvent;
use std::collections::HashSet;

pub const VK_RETURN: u32 = 0x0D;
pub const VK_ESCAPE: u32 = 0x1B;

/// Rust-side upper bound; the overlay discards after 60 s on its own.
pub const MAX_REVIEW_MS: u64 = 65_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewKey {
    Accept,
    Discard,
}

#[derive(Debug, Default)]
pub struct ReviewFilter {
    /// Review is active while `now < until_ms`.
    until_ms: u64,
    /// Keys whose down we consumed; their up is consumed too.
    consumed: HashSet<u32>,
}

impl ReviewFilter {
    pub fn set_active(&mut self, active: bool, now_ms: u64) {
        self.until_ms = if active { now_ms + MAX_REVIEW_MS } else { 0 };
    }

    pub fn active(&self, now_ms: u64) -> bool {
        now_ms < self.until_ms
    }

    /// Returns (consume the key?, review action to report).
    pub fn on_key(&mut self, key: KeyEvent, now_ms: u64) -> (bool, Option<ReviewKey>) {
        match key {
            KeyEvent::Down(vk @ (VK_RETURN | VK_ESCAPE)) if self.active(now_ms) => {
                // First down reports; auto-repeat is consumed silently.
                if !self.consumed.insert(vk) {
                    return (true, None);
                }
                // One decision per review: further keys pass through normally.
                self.until_ms = 0;
                let action = if vk == VK_RETURN {
                    ReviewKey::Accept
                } else {
                    ReviewKey::Discard
                };
                (true, Some(action))
            }
            KeyEvent::Down(vk) if self.consumed.contains(&vk) => (true, None),
            KeyEvent::Up(vk) => (self.consumed.remove(&vk), None),
            KeyEvent::Down(_) => (false, None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use KeyEvent::{Down, Up};

    #[test]
    fn inactive_passes_everything_through() {
        let mut f = ReviewFilter::default();
        assert_eq!(f.on_key(Down(VK_RETURN), 0), (false, None));
        assert_eq!(f.on_key(Up(VK_RETURN), 1), (false, None));
    }

    #[test]
    fn enter_accepts_and_is_consumed_down_and_up() {
        let mut f = ReviewFilter::default();
        f.set_active(true, 100);
        assert_eq!(
            f.on_key(Down(VK_RETURN), 200),
            (true, Some(ReviewKey::Accept))
        );
        assert_eq!(f.on_key(Down(VK_RETURN), 230), (true, None)); // repeat
        assert_eq!(f.on_key(Up(VK_RETURN), 260), (true, None));
        // The review is over: the next Enter reaches the app.
        assert_eq!(f.on_key(Down(VK_RETURN), 400), (false, None));
    }

    #[test]
    fn esc_discards() {
        let mut f = ReviewFilter::default();
        f.set_active(true, 0);
        assert_eq!(
            f.on_key(Down(VK_ESCAPE), 5),
            (true, Some(ReviewKey::Discard))
        );
        assert_eq!(f.on_key(Up(VK_ESCAPE), 6), (true, None));
    }

    #[test]
    fn other_keys_are_untouched() {
        let mut f = ReviewFilter::default();
        f.set_active(true, 0);
        assert_eq!(f.on_key(Down(0x41), 1), (false, None));
        assert_eq!(f.on_key(Up(0x41), 2), (false, None));
    }

    #[test]
    fn an_enter_already_down_when_review_starts_is_not_half_consumed() {
        let mut f = ReviewFilter::default();
        // Enter went down before review: its up must reach the app.
        f.set_active(true, 10);
        assert_eq!(f.on_key(Up(VK_RETURN), 20), (false, None));
    }

    #[test]
    fn review_expires_on_its_own() {
        let mut f = ReviewFilter::default();
        f.set_active(true, 0);
        assert!(f.active(MAX_REVIEW_MS - 1));
        assert_eq!(f.on_key(Down(VK_RETURN), MAX_REVIEW_MS), (false, None));
    }

    #[test]
    fn deactivating_still_consumes_the_pending_key_up() {
        let mut f = ReviewFilter::default();
        f.set_active(true, 0);
        f.on_key(Down(VK_ESCAPE), 1);
        f.set_active(false, 2);
        assert_eq!(f.on_key(Up(VK_ESCAPE), 3), (true, None));
    }
}
