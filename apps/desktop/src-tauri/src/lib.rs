//! Sayvox desktop core (Windows only, ADR-010).
//!
//! - `hotkey`: hold-to-talk chord (default Ctrl+Shift) (`WH_KEYBOARD_LL`), `audio`: cpal → 16 kHz PCM16,
//!   `insert`: clipboard paste + restore, `overlay`: non-activating notch window,
//!   `dictation`: wires them together and talks to the web side.
//! - `credentials` + `auth*`: Windows Credential Manager and the loopback sign-in callback.

mod active_app;
mod audio;
mod auth;
mod auth_callback;
mod credentials;
mod dictation;
mod hotkey;
mod insert;
mod overlay;
mod selection;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};

/// Product name shown in the shell; kept here so a unit test exercises the crate in CI.
pub const PRODUCT_NAME: &str = "Sayvox";

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Sayvox", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&settings, &quit])?;
    let mut tray = TrayIconBuilder::with_id("sayvox")
        .tooltip("Sayvox: hold Ctrl+Shift to dictate")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "settings" => focus_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = e
            {
                focus_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
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
            build_tray(app)?;
            overlay::configure(app.handle());
            dictation::start(app.handle())?;

            // First run (not signed in): open the settings window so onboarding shows.
            let signed_in = credentials::read(
                &credentials::WindowsCredentialStore,
                credentials::Slot::AuthSession,
            )
            .ok()
            .flatten()
            .is_some();
            if !signed_in {
                focus_main_window(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the settings window keeps Sayvox running in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            auth::auth_begin,
            credentials::credentials_get,
            credentials::credentials_set,
            credentials::credentials_delete,
            dictation::dictation_attach,
            dictation::dictation_now,
            dictation::insert_text,
            dictation::copy_text,
            dictation::timing_append,
            dictation::set_hotkey,
            dictation::hotkey_suspend,
            dictation::review_keys,
            overlay::overlay_hide,
            overlay::overlay_resize,
            selection::set_reply_context,
            active_app::list_running_apps,
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
