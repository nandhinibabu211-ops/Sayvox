//! Sayvox desktop core (Windows only, ADR-010).
//!
//! Modules so far: `credentials` (Windows Credential Manager, T017) and the sign-in
//! loopback callback (`auth`, `auth_callback`, T018). Native dictation modules arrive in
//! later stories: `hotkey` (1.3), `audio` (1.4), `insert` (1.7), `active_app` (3.4).

mod auth;
mod auth_callback;
mod credentials;

use tauri::Manager;

/// Product name shown in the shell; kept here so a unit test exercises the crate in CI.
pub const PRODUCT_NAME: &str = "Sayvox";

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be first: a `sayvox://auth` link launches a second process on Windows; this
        // forwards it to the running instance and exits the new one.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                // Installers register the scheme; dev builds register it for this exe.
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth::auth_begin,
            credentials::credentials_get,
            credentials::credentials_set,
            credentials::credentials_delete,
        ])
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
