//! Browser window title → virtual app id (Story 3.4 / T062).
//!
//! Web apps put their own name at the end of the tab title ("Inbox - me@x.com - Gmail"),
//! and the browser then appends its name ("… - Google Chrome"). We strip the browser part
//! and look only at the *last* segment, so a page that merely mentions an app ("How to use
//! Slack - Google Search") is not mistaken for it. Titles are used here and dropped.

pub const BROWSERS: &[&str] = &[
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "brave.exe",
    "opera.exe",
    "vivaldi.exe",
    "arc.exe",
];

const BROWSER_SUFFIXES: &[&str] = &[
    "google chrome",
    "microsoft edge",
    "microsoft\u{200b} edge", // Edge inserts a zero-width space
    "mozilla firefox",
    "firefox",
    "brave",
    "opera",
    "vivaldi",
    "arc",
];

/// Last-segment name → app id.
const APPS: &[(&str, &str)] = &[
    ("gmail", "web:gmail"),
    ("outlook", "web:outlook"),
    ("outlook.com", "web:outlook"),
    ("slack", "web:slack"),
    ("microsoft teams", "web:teams"),
    ("chatgpt", "web:chatgpt"),
    ("claude", "web:claude"),
    ("gemini", "web:gemini"),
    ("google gemini", "web:gemini"),
    ("whatsapp", "web:whatsapp"),
    ("discord", "web:discord"),
];

fn segments(title: &str) -> Vec<String> {
    let normalized = title.replace(['—', '–', '|'], " - ");
    normalized
        .split(" - ")
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Strip trailing "and N more pages" noise and the browser name.
fn app_segments(title: &str) -> Vec<String> {
    let mut segs = segments(title);
    while let Some(last) = segs.last() {
        let last = last.trim_end_matches(|c: char| c.is_ascii_digit() || c == ' ');
        let is_browser = BROWSER_SUFFIXES
            .iter()
            .any(|b| last == *b || last.ends_with(b));
        let is_more_pages = last.contains("more page") || last.ends_with("and");
        if is_browser || is_more_pages {
            segs.pop();
        } else {
            break;
        }
    }
    segs
}

/// App id for a browser window, or None if it isn't a known web app.
pub fn web_app(title: &str) -> Option<&'static str> {
    let segs = app_segments(title);
    let last = segs.last()?;
    // Gmail and Outlook web sometimes end with the account ("… - Gmail - me@x.com").
    let candidates = [Some(last), segs.get(segs.len().wrapping_sub(2))];
    for seg in candidates.into_iter().flatten() {
        if let Some((_, id)) = APPS.iter().find(|(name, _)| seg == name) {
            return Some(id);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::web_app;

    #[test]
    fn recognises_mail_apps() {
        assert_eq!(
            web_app("Inbox (3) - priya@example.com - Gmail - Google Chrome"),
            Some("web:gmail")
        );
        assert_eq!(
            web_app("Re: Invoice - me@x.in - Gmail - Google Chrome and 2 more pages"),
            Some("web:gmail")
        );
        assert_eq!(
            web_app("Mail - Nandhini - Outlook - Microsoft\u{200b} Edge"),
            Some("web:outlook")
        );
        assert_eq!(
            web_app("Mail - Outlook — Mozilla Firefox"),
            Some("web:outlook")
        );
    }

    #[test]
    fn recognises_chat_apps() {
        assert_eq!(
            web_app("general (Channel) - Acme - Slack - Google Chrome"),
            Some("web:slack")
        );
        assert_eq!(
            web_app("Chat | Kavya | Microsoft Teams - Microsoft Edge"),
            Some("web:teams")
        );
        assert_eq!(web_app("WhatsApp - Google Chrome"), Some("web:whatsapp"));
    }

    #[test]
    fn recognises_ai_chat_apps() {
        assert_eq!(web_app("ChatGPT - Google Chrome"), Some("web:chatgpt"));
        assert_eq!(
            web_app("Refactor plan - Claude - Microsoft Edge"),
            Some("web:claude")
        );
        assert_eq!(web_app("Google Gemini - Google Chrome"), Some("web:gemini"));
    }

    #[test]
    fn pages_that_only_mention_an_app_are_not_matched() {
        assert_eq!(
            web_app("How to use Slack - Google Search - Google Chrome"),
            None
        );
        assert_eq!(web_app("gmail login help - Bing - Microsoft Edge"), None);
        assert_eq!(
            web_app("Claude Monet paintings - Wikipedia - Google Chrome"),
            None
        );
    }

    #[test]
    fn empty_or_browser_only_titles() {
        assert_eq!(web_app(""), None);
        assert_eq!(web_app("Google Chrome"), None);
    }
}
