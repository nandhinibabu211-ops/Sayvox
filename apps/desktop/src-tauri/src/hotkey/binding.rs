//! Which modifier chord starts dictation (Story 2.6 / T072). Matches `HOTKEY_OPTIONS` in
//! packages/shared: modifier-only, exactly two keys.

/// Modifier bit flags (left and right variants count as the same modifier).
pub const CTRL: u8 = 1;
pub const SHIFT: u8 = 2;
pub const ALT: u8 = 4;
pub const WIN: u8 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Binding {
    /// Modifiers that must all be held, and no others.
    pub mods: u8,
}

impl Binding {
    pub const DEFAULT: Binding = Binding { mods: CTRL | SHIFT };

    /// Parse "Ctrl+Shift", "Ctrl+Alt", "Alt+Shift", "Ctrl+Win", "Shift+Win".
    pub fn parse(s: &str) -> Result<Binding, String> {
        let mut mods = 0u8;
        for part in s.split('+').map(|p| p.trim().to_ascii_lowercase()) {
            let bit = match part.as_str() {
                "ctrl" | "control" => CTRL,
                "shift" => SHIFT,
                "alt" => ALT,
                "win" | "windows" | "super" => WIN,
                other => return Err(format!("unsupported key in hotkey: {other:?}")),
            };
            if mods & bit != 0 {
                return Err("duplicate key in hotkey".into());
            }
            mods |= bit;
        }
        if mods.count_ones() != 2 {
            return Err("hotkey must be exactly two modifier keys".into());
        }
        // Alt+Win is reserved by Windows (e.g. Game Bar shortcuts start there).
        if mods == ALT | WIN {
            return Err("Alt+Win isn't supported".into());
        }
        Ok(Binding { mods })
    }
}

/// Map a low-level virtual-key code to its modifier bit, or 0 if it isn't a modifier.
pub fn modifier_bit(vk: u32) -> u8 {
    match vk {
        0x11 | 0xA2 | 0xA3 => CTRL,  // VK_CONTROL, VK_LCONTROL, VK_RCONTROL
        0x10 | 0xA0 | 0xA1 => SHIFT, // VK_SHIFT, VK_LSHIFT, VK_RSHIFT
        0x12 | 0xA4 | 0xA5 => ALT,   // VK_MENU, VK_LMENU, VK_RMENU
        0x5B | 0x5C => WIN,          // VK_LWIN, VK_RWIN
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_supported_options() {
        for (s, m) in [
            ("Ctrl+Shift", CTRL | SHIFT),
            ("Ctrl+Alt", CTRL | ALT),
            ("Alt+Shift", ALT | SHIFT),
            ("Ctrl+Win", CTRL | WIN),
            ("Shift+Win", SHIFT | WIN),
            ("shift + ctrl", CTRL | SHIFT),
        ] {
            assert_eq!(Binding::parse(s), Ok(Binding { mods: m }), "{s}");
        }
    }

    #[test]
    fn rejects_everything_else() {
        for s in [
            "Ctrl",
            "Ctrl+Shift+Alt",
            "Ctrl+K",
            "Ctrl+Ctrl",
            "Alt+Win",
            "",
        ] {
            assert!(Binding::parse(s).is_err(), "{s}");
        }
    }

    #[test]
    fn maps_left_and_right_keys() {
        assert_eq!(modifier_bit(0xA2), CTRL);
        assert_eq!(modifier_bit(0xA3), CTRL);
        assert_eq!(modifier_bit(0xA5), ALT);
        assert_eq!(modifier_bit(0x5C), WIN);
        assert_eq!(modifier_bit(0x41), 0);
    }
}
