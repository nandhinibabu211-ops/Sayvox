//! Sayvox desktop core (Windows only, ADR-010).
//!
//! Phase 1 setup: an app shell only. Native modules arrive in later stories:
//! `hotkey` (1.3), `audio` (1.4), `insert` (1.7), `active_app` (3.4).

/// Product name shown in the shell; kept here so a unit test exercises the crate in CI.
pub const PRODUCT_NAME: &str = "Sayvox";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Sayvox");
}

#[cfg(test)]
mod tests {
    use super::PRODUCT_NAME;

    #[test]
    fn product_name_is_sayvox() {
        assert_eq!(PRODUCT_NAME, "Sayvox");
    }
}
