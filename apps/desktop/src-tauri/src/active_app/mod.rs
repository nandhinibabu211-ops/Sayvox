//! Which app the user is dictating into (Story 3.4, T051), captured at hotkey press, before
//! the overlay could change anything.
//!
//! Only an *app id* leaves this module: the lower-cased exe name (`cursor.exe`) or, for web
//! apps in a browser, a virtual id (`web:gmail`). Window titles are read to recognise web
//! apps and then dropped; they never reach the web side or the server (Constitution I).

pub mod browser_map;
#[cfg(windows)]
pub mod windows;

/// Map an exe path + window title to the app id the mode resolver uses.
pub fn app_id(exe_path: &str, title: &str) -> String {
    let exe = exe_path
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if browser_map::BROWSERS.contains(&exe.as_str()) {
        if let Some(id) = browser_map::web_app(title) {
            return id.to_string();
        }
    }
    // Keep ids to the server's TargetApp charset ([A-Za-z0-9._:- ], ≤ 200).
    let cleaned: String = exe
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ' '))
        .take(200)
        .collect();
    if cleaned.is_empty() {
        "unknown".into()
    } else {
        cleaned
    }
}

/// App id of the current foreground window.
pub fn foreground_app_id() -> String {
    #[cfg(windows)]
    {
        let (exe, title) = windows::foreground_exe_and_title();
        app_id(&exe, &title)
    }
    #[cfg(not(windows))]
    {
        "unknown".into()
    }
}

/// App ids of running apps for Settings → Modes "Add app" (exe names only, sorted, unique).
pub fn running_app_ids(exe_paths: &[String]) -> Vec<String> {
    let mut ids: Vec<String> = exe_paths
        .iter()
        .map(|p| app_id(p, ""))
        .filter(|id| id != "unknown" && id != "sayvox.exe" && id != "sayvox-desktop.exe")
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

#[tauri::command]
pub fn list_running_apps() -> Vec<String> {
    #[cfg(windows)]
    {
        running_app_ids(&windows::running_exes())
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::{app_id, running_app_ids};

    #[test]
    fn running_apps_are_unique_sorted_ids_without_sayvox() {
        let paths = [
            r"C:\x\Slack.exe",
            r"C:\y\cursor.exe",
            r"C:\x\slack.exe",
            r"C:\p\Sayvox.exe",
            "",
        ]
        .map(String::from);
        assert_eq!(running_app_ids(&paths), vec!["cursor.exe", "slack.exe"]);
    }

    #[test]
    fn desktop_apps_use_their_exe_name() {
        assert_eq!(
            app_id(
                r"C:\Users\x\AppData\Local\Programs\cursor\Cursor.exe",
                "main.rs - Sayvox"
            ),
            "cursor.exe"
        );
        assert_eq!(
            app_id(r"C:\Program Files\Slack\slack.exe", "general"),
            "slack.exe"
        );
    }

    #[test]
    fn browsers_are_mapped_by_title_to_web_ids() {
        let chrome = r"C:\Program Files\Google\Chrome\Application\chrome.exe";
        assert_eq!(
            app_id(
                chrome,
                "Inbox (3) - priya@example.com - Gmail - Google Chrome"
            ),
            "web:gmail"
        );
        assert_eq!(
            app_id(r"C:\x\msedge.exe", "ChatGPT - Microsoft Edge"),
            "web:chatgpt"
        );
        assert_eq!(
            app_id(r"C:\x\msedge.exe", "Chat | Microsoft Teams"),
            "web:teams"
        );
        assert_eq!(app_id(chrome, "Some article - Google Chrome"), "chrome.exe");
    }

    #[test]
    fn the_title_never_leaks_into_the_id() {
        let id = app_id(r"C:\x\chrome.exe", "Secret project doc - Google Chrome");
        assert!(!id.contains("secret"));
        let odd = app_id(r"C:\x\wéird(app)!.exe", "");
        assert!(odd
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-_ ".contains(c)));
    }

    #[test]
    fn unknown_when_nothing_usable() {
        assert_eq!(app_id("", ""), "unknown");
    }
}
