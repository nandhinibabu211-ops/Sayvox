//! Signed auto-updates (Story 5.3 / T082) with the Tauri updater plugin.
//!
//! The web side decides *when*: it checks only if `/v1/client-config` puts this install in
//! the rollout (or the version is below the minimum), downloads in the background, and
//! installs when no dictation is running or the user clicks Update. Rust holds the
//! downloaded package so the bytes never cross into JavaScript.
//!
//! Every package is verified against the public key in `tauri.conf.json` before install;
//! installers themselves are unsigned (ADR-007), update packages are not.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Placeholder shipped in the repo until a real key pair is generated (see release runbook).
const PUBKEY_PLACEHOLDER: &str = "REPLACE_WITH_UPDATER_PUBLIC_KEY";

#[derive(Default)]
pub struct UpdateState(Mutex<Pending>);

#[derive(Default)]
struct Pending {
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CheckResult {
    /// No updater key in this build (dev builds, forks).
    NotConfigured,
    UpToDate,
    Available {
        version: String,
    },
}

/// True when the build carries a real updater public key.
pub fn configured(pubkey: Option<&str>) -> bool {
    matches!(pubkey, Some(k) if !k.trim().is_empty() && k != PUBKEY_PLACEHOLDER)
}

fn pubkey(app: &AppHandle) -> Option<String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .map(str::to_owned)
}

#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<CheckResult, String> {
    if !configured(pubkey(&app).as_deref()) {
        return Ok(CheckResult::NotConfigured);
    }
    let found = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let mut p = state.0.lock().map_err(|_| "update state poisoned")?;
    Ok(match found {
        Some(update) => {
            let version = update.version.clone();
            // A newer manifest replaces an older pending download.
            if p.update.as_ref().map(|u| &u.version) != Some(&version) {
                p.bytes = None;
            }
            p.update = Some(update);
            CheckResult::Available { version }
        }
        None => {
            *p = Pending::default();
            CheckResult::UpToDate
        }
    })
}

/// Download (and verify) the pending update in the background. Idempotent.
#[tauri::command]
pub async fn update_download(state: State<'_, UpdateState>) -> Result<(), String> {
    let update = {
        let p = state.0.lock().map_err(|_| "update state poisoned")?;
        if p.bytes.is_some() {
            return Ok(());
        }
        p.update.clone().ok_or("no update pending")?
    };
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    let mut p = state.0.lock().map_err(|_| "update state poisoned")?;
    if p.update.as_ref().map(|u| &u.version) == Some(&update.version) {
        p.bytes = Some(bytes);
    }
    Ok(())
}

/// Install the downloaded update. On Windows this starts the installer (passive mode) and
/// exits Sayvox; the installer starts the new version.
#[tauri::command]
pub async fn update_install(app: AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    update_download(state.clone()).await?;
    let (update, bytes) = {
        let mut p = state.0.lock().map_err(|_| "update state poisoned")?;
        let update = p.update.clone().ok_or("no update pending")?;
        let bytes = p.bytes.take().ok_or("update not downloaded")?;
        (update, bytes)
    };
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart();
}

pub fn manage(app: &tauri::App) {
    app.manage(UpdateState::default());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_or_empty_keys_mean_not_configured() {
        assert!(!configured(None));
        assert!(!configured(Some("")));
        assert!(!configured(Some(PUBKEY_PLACEHOLDER)));
        assert!(configured(Some(
            "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk="
        )));
    }

    #[test]
    fn check_results_serialize_for_the_web_side() {
        assert_eq!(
            serde_json::to_string(&CheckResult::Available {
                version: "0.2.0".into()
            })
            .unwrap(),
            r#"{"status":"available","version":"0.2.0"}"#
        );
        assert_eq!(
            serde_json::to_string(&CheckResult::NotConfigured).unwrap(),
            r#"{"status":"notConfigured"}"#
        );
    }
}
