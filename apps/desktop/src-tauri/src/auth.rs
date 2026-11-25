//! `auth_begin` command: starts the loopback listener and returns the sign-in URL to open.

use crate::auth_callback::{serve_once, Outcome, CALLBACK_TIMEOUT, SIGNIN_ORIGIN};
use crate::credentials::WindowsCredentialStore;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tiny_http::Server;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInStart {
    pub signin_url: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedIn {
    pub email: String,
}

pub fn signin_url(port: u16, state: &str) -> String {
    format!("{SIGNIN_ORIGIN}/signin?port={port}&state={state}")
}

#[tauri::command]
pub fn auth_begin(app: AppHandle) -> Result<SignInStart, String> {
    // Port 0 = OS picks a free port; bound to loopback only.
    let server = Server::http("127.0.0.1:0").map_err(|e| format!("listener: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or("listener has no IP address")?;
    let state = uuid::Uuid::new_v4().simple().to_string();

    let expected = state.clone();
    std::thread::spawn(move || {
        match serve_once(
            &server,
            &expected,
            SIGNIN_ORIGIN,
            &WindowsCredentialStore,
            CALLBACK_TIMEOUT,
        ) {
            Outcome::SignedIn { email } => {
                let _ = app.emit("auth://signed-in", SignedIn { email });
            }
            Outcome::TimedOut => {
                let _ = app.emit("auth://timed-out", ());
            }
        }
    });

    Ok(SignInStart {
        signin_url: signin_url(port, &state),
        state,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn signin_url_carries_port_and_state_only() {
        assert_eq!(
            super::signin_url(51234, "abc"),
            "https://sayvox-app-2026.web.app/signin?port=51234&state=abc"
        );
    }
}
