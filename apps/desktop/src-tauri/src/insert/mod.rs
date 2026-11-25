//! Paste text at the cursor and put the user's clipboard back (Story 1.7).
//!
//! Order: refuse if the target window would silently drop our input (elevated app) →
//! snapshot clipboard → write text → Ctrl+V → wait → restore. The restore runs on every
//! path after the snapshot, success or failure (coding standard #7), and is skipped only if
//! the user copied something new meanwhile, so we never clobber their newer copy.

#[cfg(windows)]
pub mod windows;

use std::time::Duration;

pub const DEFAULT_RESTORE_DELAY: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InsertOutcome {
    Inserted,
    /// Foreground app runs elevated; Windows (UIPI) would drop our Ctrl+V. Text stays in
    /// the overlay with a Copy button.
    BlockedElevated,
    Failed {
        reason: String,
    },
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Snapshot {
    /// (clipboard format, raw bytes) for every memory-backed format that was present.
    pub items: Vec<(u32, Vec<u8>)>,
}

pub trait Clipboard {
    fn sequence(&self) -> u32;
    fn snapshot(&mut self) -> Result<Snapshot, String>;
    fn set_text(&mut self, text: &str) -> Result<(), String>;
    fn restore(&mut self, snapshot: &Snapshot) -> Result<(), String>;
}

pub trait Keyboard {
    fn target_is_elevated(&self) -> bool;
    fn paste(&mut self) -> Result<(), String>;
}

pub fn insert_text(
    clipboard: &mut dyn Clipboard,
    keyboard: &mut dyn Keyboard,
    text: &str,
    restore_delay: Duration,
    sleep: &dyn Fn(Duration),
) -> InsertOutcome {
    if keyboard.target_is_elevated() {
        return InsertOutcome::BlockedElevated;
    }
    let snapshot = match clipboard.snapshot() {
        Ok(s) => s,
        Err(reason) => return InsertOutcome::Failed { reason },
    };

    let attempt = (|| -> Result<u32, String> {
        clipboard.set_text(text)?;
        let ours = clipboard.sequence();
        keyboard.paste()?;
        // Give the target app time to read the clipboard before we put the old one back.
        sleep(restore_delay);
        Ok(ours)
    })();

    // "finally": always try to restore once the snapshot exists.
    let user_copied_meanwhile = matches!(attempt, Ok(ours) if clipboard.sequence() != ours);
    if !user_copied_meanwhile {
        let _ = clipboard.restore(&snapshot);
    }

    match attempt {
        Ok(_) => InsertOutcome::Inserted,
        Err(reason) => InsertOutcome::Failed { reason },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    type Log = Rc<RefCell<Vec<String>>>;

    struct FakeClipboard {
        log: Log,
        seq: u32,
        content: Snapshot,
        fail_set: bool,
        bump_after_paste: Rc<RefCell<bool>>,
    }

    impl Clipboard for FakeClipboard {
        fn sequence(&self) -> u32 {
            if *self.bump_after_paste.borrow() {
                self.seq + 1
            } else {
                self.seq
            }
        }
        fn snapshot(&mut self) -> Result<Snapshot, String> {
            self.log.borrow_mut().push("snapshot".into());
            Ok(self.content.clone())
        }
        fn set_text(&mut self, text: &str) -> Result<(), String> {
            if self.fail_set {
                return Err("clipboard busy".into());
            }
            self.log.borrow_mut().push(format!("set:{text}"));
            self.seq += 1;
            self.content = Snapshot {
                items: vec![(13, text.as_bytes().to_vec())],
            };
            Ok(())
        }
        fn restore(&mut self, s: &Snapshot) -> Result<(), String> {
            self.log.borrow_mut().push("restore".into());
            self.content = s.clone();
            Ok(())
        }
    }

    struct FakeKeyboard {
        log: Log,
        elevated: bool,
        fail: bool,
        user_copies: Rc<RefCell<bool>>,
    }

    impl Keyboard for FakeKeyboard {
        fn target_is_elevated(&self) -> bool {
            self.elevated
        }
        fn paste(&mut self) -> Result<(), String> {
            self.log.borrow_mut().push("paste".into());
            if self.fail {
                return Err("SendInput failed".into());
            }
            Ok(())
        }
    }

    fn setup() -> (FakeClipboard, FakeKeyboard, Log, Rc<RefCell<bool>>) {
        let log: Log = Rc::default();
        let copied = Rc::new(RefCell::new(false));
        let original = Snapshot {
            items: vec![(13, b"hello".to_vec())],
        };
        (
            FakeClipboard {
                log: log.clone(),
                seq: 1,
                content: original,
                fail_set: false,
                bump_after_paste: copied.clone(),
            },
            FakeKeyboard {
                log: log.clone(),
                elevated: false,
                fail: false,
                user_copies: copied.clone(),
            },
            log,
            copied,
        )
    }

    fn no_sleep(_: Duration) {}

    #[test]
    fn pastes_then_restores_the_original_clipboard() {
        let (mut cb, mut kb, log, _) = setup();
        let out = insert_text(
            &mut cb,
            &mut kb,
            "Let's meet Friday.",
            DEFAULT_RESTORE_DELAY,
            &no_sleep,
        );
        assert_eq!(out, InsertOutcome::Inserted);
        assert_eq!(
            *log.borrow(),
            vec!["snapshot", "set:Let's meet Friday.", "paste", "restore"]
        );
        assert_eq!(cb.content.items, vec![(13, b"hello".to_vec())]);
    }

    #[test]
    fn restores_even_when_paste_fails() {
        let (mut cb, mut kb, log, _) = setup();
        kb.fail = true;
        let out = insert_text(&mut cb, &mut kb, "x", DEFAULT_RESTORE_DELAY, &no_sleep);
        assert!(matches!(out, InsertOutcome::Failed { .. }));
        assert_eq!(log.borrow().last().unwrap(), "restore");
        assert_eq!(cb.content.items, vec![(13, b"hello".to_vec())]);
    }

    #[test]
    fn restores_when_writing_the_clipboard_fails() {
        let (mut cb, mut kb, log, _) = setup();
        cb.fail_set = true;
        let out = insert_text(&mut cb, &mut kb, "x", DEFAULT_RESTORE_DELAY, &no_sleep);
        assert!(matches!(out, InsertOutcome::Failed { .. }));
        assert!(!log.borrow().contains(&"paste".to_string()));
        assert_eq!(log.borrow().last().unwrap(), "restore");
    }

    #[test]
    fn does_not_clobber_a_copy_the_user_made_meanwhile() {
        let (mut cb, mut kb, log, copied) = setup();
        let _ = &kb.user_copies;
        let sleep = move |_| *copied.borrow_mut() = true;
        let out = insert_text(&mut cb, &mut kb, "x", DEFAULT_RESTORE_DELAY, &sleep);
        assert_eq!(out, InsertOutcome::Inserted);
        assert!(!log.borrow().contains(&"restore".to_string()));
    }

    #[test]
    fn refuses_elevated_targets_without_touching_the_clipboard() {
        let (mut cb, mut kb, log, _) = setup();
        kb.elevated = true;
        let out = insert_text(&mut cb, &mut kb, "x", DEFAULT_RESTORE_DELAY, &no_sleep);
        assert_eq!(out, InsertOutcome::BlockedElevated);
        assert!(log.borrow().is_empty());
    }

    #[test]
    fn waits_the_restore_delay_before_restoring() {
        let (mut cb, mut kb, _, _) = setup();
        let waited = RefCell::new(Duration::ZERO);
        let sleep = |d| *waited.borrow_mut() = d;
        insert_text(&mut cb, &mut kb, "x", Duration::from_millis(150), &sleep);
        assert_eq!(*waited.borrow(), Duration::from_millis(150));
    }
}
