//! Sign-in callback (Story 2.2 / T018).
//!
//! The app opens the hosted sign-in page in the system browser with a one-time `state` and
//! a loopback port. After sign-in the page POSTs the tokens to
//! `http://127.0.0.1:<port>/callback` (never in a URL), then opens `sayvox://auth` to bring
//! the app to the front. This listener accepts exactly one valid callback, checks the
//! `state` and the page's `Origin`, stores the session in Credential Manager and stops.

use crate::credentials::{self, CredentialStore, Slot};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::time::{Duration, Instant};
use tiny_http::{Header, Method, Request, Response, Server};

/// Hosted sign-in page origin (Firebase Hosting, ADR-009).
pub const SIGNIN_ORIGIN: &str = "https://sayvox-app-2026.web.app";
pub const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_BODY_BYTES: u64 = 16 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallbackPayload {
    pub state: String,
    pub id_token: String,
    pub refresh_token: String,
    /// Seconds until the ID token expires (Firebase `expiresIn`).
    pub expires_in: u64,
    pub email: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub id_token: String,
    pub refresh_token: String,
    /// Unix epoch milliseconds.
    pub expires_at: u64,
    pub email: String,
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    SignedIn { email: String },
    TimedOut,
}

#[derive(Debug, PartialEq)]
enum Verdict {
    Preflight,
    Accept(String),
    Reject(u16),
}

fn header<'a>(req: &'a Request, name: &str) -> Option<&'a str> {
    req.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str())
}

/// Pure request check, unit-tested without sockets.
fn judge(method: &Method, url: &str, origin: Option<&str>, allowed_origin: &str) -> Verdict {
    if url != "/callback" {
        return Verdict::Reject(404);
    }
    if origin != Some(allowed_origin) {
        return Verdict::Reject(403);
    }
    match method {
        Method::Options => Verdict::Preflight,
        Method::Post => Verdict::Accept(String::new()),
        _ => Verdict::Reject(405),
    }
}

fn cors_headers(origin: &str) -> Vec<Header> {
    [
        ("Access-Control-Allow-Origin", origin),
        ("Access-Control-Allow-Methods", "POST, OPTIONS"),
        ("Access-Control-Allow-Headers", "content-type"),
        // Chrome Private Network Access: allow a public HTTPS page to reach 127.0.0.1.
        ("Access-Control-Allow-Private-Network", "true"),
        ("Vary", "Origin"),
    ]
    .iter()
    .filter_map(|(k, v)| Header::from_bytes(k.as_bytes(), v.as_bytes()).ok())
    .collect()
}

fn respond(req: Request, status: u16, origin: &str) {
    let mut resp = Response::empty(status);
    for h in cors_headers(origin) {
        resp.add_header(h);
    }
    let _ = req.respond(resp);
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Serve until one valid callback arrives or `timeout` passes.
pub fn serve_once(
    server: &Server,
    expected_state: &str,
    allowed_origin: &str,
    store: &dyn CredentialStore,
    timeout: Duration,
) -> Outcome {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Outcome::TimedOut;
        }
        let Ok(Some(mut req)) = server.recv_timeout(remaining) else {
            continue;
        };
        let origin = header(&req, "Origin").map(str::to_owned);
        match judge(req.method(), req.url(), origin.as_deref(), allowed_origin) {
            Verdict::Reject(code) => {
                let _ = req.respond(Response::empty(code));
            }
            Verdict::Preflight => respond(req, 204, allowed_origin),
            Verdict::Accept(_) => {
                let mut body = String::new();
                if req
                    .as_reader()
                    .take(MAX_BODY_BYTES)
                    .read_to_string(&mut body)
                    .is_err()
                {
                    respond(req, 400, allowed_origin);
                    continue;
                }
                let Ok(p) = serde_json::from_str::<CallbackPayload>(&body) else {
                    respond(req, 400, allowed_origin);
                    continue;
                };
                // Constant-time compare is unnecessary for a one-shot random state on loopback,
                // but a mismatch must never store anything.
                if p.state != expected_state {
                    respond(req, 403, allowed_origin);
                    continue;
                }
                let session = StoredSession {
                    id_token: p.id_token,
                    refresh_token: p.refresh_token,
                    expires_at: now_ms() + p.expires_in.saturating_mul(1000),
                    email: p.email.to_lowercase(),
                };
                let Ok(json) = serde_json::to_string(&session) else {
                    respond(req, 500, allowed_origin);
                    continue;
                };
                if credentials::write(store, Slot::AuthSession, &json).is_err() {
                    respond(req, 500, allowed_origin);
                    continue;
                }
                respond(req, 204, allowed_origin);
                return Outcome::SignedIn {
                    email: session.email,
                };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn judges_requests() {
        let o = Some(SIGNIN_ORIGIN);
        assert_eq!(
            judge(&Method::Post, "/callback", o, SIGNIN_ORIGIN),
            Verdict::Accept(String::new())
        );
        assert_eq!(
            judge(&Method::Options, "/callback", o, SIGNIN_ORIGIN),
            Verdict::Preflight
        );
        assert_eq!(
            judge(&Method::Get, "/callback", o, SIGNIN_ORIGIN),
            Verdict::Reject(405)
        );
        assert_eq!(
            judge(&Method::Post, "/other", o, SIGNIN_ORIGIN),
            Verdict::Reject(404)
        );
        assert_eq!(
            judge(
                &Method::Post,
                "/callback",
                Some("https://evil.example"),
                SIGNIN_ORIGIN
            ),
            Verdict::Reject(403)
        );
        assert_eq!(
            judge(&Method::Post, "/callback", None, SIGNIN_ORIGIN),
            Verdict::Reject(403)
        );
    }

    use crate::credentials::memory::MemoryStore;
    use std::io::Write;
    use std::net::TcpStream;
    use std::sync::Arc;

    fn http(port: u16, method: &str, origin: Option<&str>, body: &str) -> u16 {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let origin_line = origin
            .map(|o| format!("Origin: {o}\r\n"))
            .unwrap_or_default();
        write!(
            s,
            "{method} /callback HTTP/1.1\r\nHost: 127.0.0.1\r\n{origin_line}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let mut resp = String::new();
        s.read_to_string(&mut resp).unwrap();
        resp.split_whitespace().nth(1).unwrap().parse().unwrap()
    }

    fn payload(state: &str) -> String {
        format!(
            r#"{{"state":"{state}","idToken":"id-tok","refreshToken":"ref-tok","expiresIn":3600,"email":"Nandhini@Example.com"}}"#
        )
    }

    #[test]
    fn accepts_one_valid_callback_and_stores_the_session() {
        let server = Arc::new(Server::http("127.0.0.1:0").unwrap());
        let port = server.server_addr().to_ip().unwrap().port();
        let store = Arc::new(MemoryStore::default());

        let (srv, st) = (server.clone(), store.clone());
        let handle = std::thread::spawn(move || {
            serve_once(
                &srv,
                "state-123",
                SIGNIN_ORIGIN,
                st.as_ref(),
                Duration::from_secs(10),
            )
        });

        // Wrong origin, preflight, and wrong state are refused without storing anything.
        assert_eq!(
            http(
                port,
                "POST",
                Some("https://evil.example"),
                &payload("state-123")
            ),
            403
        );
        assert_eq!(http(port, "OPTIONS", Some(SIGNIN_ORIGIN), ""), 204);
        assert_eq!(
            http(port, "POST", Some(SIGNIN_ORIGIN), &payload("wrong")),
            403
        );
        assert_eq!(http(port, "POST", Some(SIGNIN_ORIGIN), "{not json"), 400);
        assert!(credentials::read(store.as_ref(), Slot::AuthSession)
            .unwrap()
            .is_none());

        assert_eq!(
            http(port, "POST", Some(SIGNIN_ORIGIN), &payload("state-123")),
            204
        );
        assert_eq!(
            handle.join().unwrap(),
            Outcome::SignedIn {
                email: "nandhini@example.com".into()
            }
        );

        let saved: StoredSession = serde_json::from_str(
            &credentials::read(store.as_ref(), Slot::AuthSession)
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(saved.id_token, "id-tok");
        assert_eq!(saved.refresh_token, "ref-tok");
        assert!(saved.expires_at > now_ms());
    }

    #[test]
    fn times_out_without_a_callback() {
        let server = Server::http("127.0.0.1:0").unwrap();
        let store = MemoryStore::default();
        let outcome = serve_once(
            &server,
            "s",
            SIGNIN_ORIGIN,
            &store,
            Duration::from_millis(200),
        );
        assert_eq!(outcome, Outcome::TimedOut);
    }

    #[test]
    fn rejects_unknown_fields() {
        let body = r#"{"state":"s","idToken":"i","refreshToken":"r","expiresIn":3600,"email":"a@b.c","extra":1}"#;
        assert!(serde_json::from_str::<CallbackPayload>(body).is_err());
    }
}
