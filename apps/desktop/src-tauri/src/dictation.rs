//! Native side of the dictation loop (Stories 1.3–1.7).
//!
//! Hotkey events are handled here, not in JavaScript, so a press starts the microphone and
//! shows the overlay immediately. The web side (overlay window) owns the network parts.
//!
//! Everything goes to the web side over ONE ordered binary channel: audio chunks as raw
//! 16 kHz PCM16 LE bytes, control events as JSON. Audio and control messages are merged
//! into a single queue first, so `release` always arrives after the last chunk of the hold.

use crate::audio::capture::{self, AudioErrorCode, AudioHandle, AudioOut};
use crate::hotkey::HotkeyEvent;
use crate::insert::{self, InsertOutcome};
use crate::overlay;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

/// Hard cap on one hold (Story 2.3 default; the server also caps the Scribe session).
pub const MAX_SESSION_SECONDS: u32 = 300;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DictationEvent {
    /// Chord pressed; mic is starting. `t` = ms since app start (monotonic). `app` = app id
    /// of the window being dictated into (exe name or `web:*`; never the window title).
    Press {
        t: u64,
        app: String,
    },
    /// Held long enough; mic stopped. Every chunk of this hold was sent before this event.
    #[serde(rename_all = "camelCase")]
    Release {
        t: u64,
        audio_seconds: f32,
    },
    /// Accidental tap or the chord became a shortcut (Ctrl+Shift+T): discard.
    Cancel {
        t: u64,
    },
    AudioError {
        code: AudioErrorCode,
    },
}

/// One queue for both audio and control messages: this is what keeps them ordered.
enum Outbound {
    Audio(AudioOut),
    Event(DictationEvent),
}

#[derive(Default)]
pub struct WebSink(Mutex<Option<Channel<InvokeResponseBody>>>);

pub struct DictationState {
    pub sink: Arc<WebSink>,
    pub audio: AudioHandle,
    pub started: Instant,
    outbound: Sender<Outbound>,
    #[cfg(windows)]
    pub hook: Mutex<Option<crate::hotkey::windows::HookHandle>>,
}

fn pcm_bytes(chunk: &[i16]) -> Vec<u8> {
    chunk.iter().flat_map(|s| s.to_le_bytes()).collect()
}

fn forward(sink: Arc<WebSink>, rx: Receiver<Outbound>) {
    for msg in rx {
        let body = match msg {
            Outbound::Audio(AudioOut::Chunk(chunk)) => InvokeResponseBody::Raw(pcm_bytes(&chunk)),
            Outbound::Audio(AudioOut::Error(code)) => {
                match serde_json::to_string(&DictationEvent::AudioError { code }) {
                    Ok(json) => InvokeResponseBody::Json(json),
                    Err(_) => continue,
                }
            }
            Outbound::Event(ev) => match serde_json::to_string(&ev) {
                Ok(json) => InvokeResponseBody::Json(json),
                Err(_) => continue,
            },
        };
        if let Ok(guard) = sink.0.lock() {
            if let Some(ch) = guard.as_ref() {
                let _ = ch.send(body);
            }
        }
    }
}

fn handle_hotkeys(app: AppHandle, rx: Receiver<HotkeyEvent>) {
    let generation = Arc::new(AtomicU64::new(0));
    for ev in rx {
        let state = app.state::<DictationState>();
        let t = state.started.elapsed().as_millis() as u64;
        let send = |e: DictationEvent| {
            let _ = state.outbound.send(Outbound::Event(e));
        };
        match ev {
            HotkeyEvent::Press => {
                state.audio.begin();
                // Read the target app before the overlay appears.
                let target = crate::active_app::foreground_app_id();
                overlay::show(&app);
                send(DictationEvent::Press { t, app: target });
                // Auto-release after MAX_SESSION_SECONDS unless this hold already ended.
                let my_gen = generation.fetch_add(1, Ordering::SeqCst) + 1;
                let (app2, gen2) = (app.clone(), generation.clone());
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(MAX_SESSION_SECONDS.into()));
                    if gen2.load(Ordering::SeqCst) == my_gen {
                        #[cfg(windows)]
                        if let Ok(h) = app2.state::<DictationState>().hook.lock() {
                            if let Some(h) = h.as_ref() {
                                h.force_release();
                            }
                        }
                        let _ = &app2;
                    }
                });
            }
            HotkeyEvent::Release { .. } => {
                generation.fetch_add(1, Ordering::SeqCst);
                // end() returns only after the tail chunk is queued, so Release follows it.
                let audio_seconds = state.audio.end();
                send(DictationEvent::Release { t, audio_seconds });
            }
            HotkeyEvent::Cancel => {
                generation.fetch_add(1, Ordering::SeqCst);
                let _ = state.audio.end();
                overlay::hide(&app);
                send(DictationEvent::Cancel { t });
            }
        }
    }
}

/// Start audio + hotkey threads. Call once from `setup`.
pub fn start(app: &AppHandle) -> Result<(), String> {
    let sink = Arc::new(WebSink::default());
    let (out_tx, out_rx) = std::sync::mpsc::channel::<Outbound>();
    let audio_tx = Mutex::new(out_tx.clone());
    let audio = capture::spawn(
        MAX_SESSION_SECONDS,
        Arc::new(move |m| {
            if let Ok(tx) = audio_tx.lock() {
                let _ = tx.send(Outbound::Audio(m));
            }
        }),
    );
    app.manage(DictationState {
        sink: sink.clone(),
        audio,
        started: Instant::now(),
        outbound: out_tx,
        #[cfg(windows)]
        hook: Mutex::new(None),
    });

    std::thread::Builder::new()
        .name("sayvox-forward".into())
        .spawn(move || forward(sink, out_rx))
        .map_err(|e| e.to_string())?;

    let (tx, rx) = std::sync::mpsc::channel();
    #[cfg(windows)]
    {
        let handle = crate::hotkey::windows::install(
            tx,
            crate::hotkey::state::ChordMachine::DEFAULT_MIN_HOLD_MS,
        )?;
        if let Ok(mut h) = app.state::<DictationState>().hook.lock() {
            *h = Some(handle);
        }
    }
    #[cfg(not(windows))]
    drop(tx);

    let a = app.clone();
    std::thread::Builder::new()
        .name("sayvox-hotkey-dispatch".into())
        .spawn(move || handle_hotkeys(a, rx))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The overlay registers the channel that receives chunks (raw) and events (JSON).
#[tauri::command]
pub fn dictation_attach(state: State<'_, DictationState>, chunks: Channel<InvokeResponseBody>) {
    if let Ok(mut s) = state.sink.0.lock() {
        *s = Some(chunks);
    }
}

/// Monotonic ms since app start, for release → inserted timing (same clock as events).
#[tauri::command]
pub fn dictation_now(state: State<'_, DictationState>) -> u64 {
    state.started.elapsed().as_millis() as u64
}

#[tauri::command]
pub async fn insert_text(text: String) -> InsertOutcome {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            insert::insert_text(
                &mut insert::windows::WindowsClipboard,
                &mut insert::windows::WindowsKeyboard,
                &text,
                insert::DEFAULT_RESTORE_DELAY,
                &std::thread::sleep,
            )
        })
        .await
        .unwrap_or(InsertOutcome::Failed {
            reason: "insert task panicked".into(),
        })
    }
    #[cfg(not(windows))]
    {
        let _ = text;
        InsertOutcome::Failed {
            reason: "Sayvox supports Windows only".into(),
        }
    }
}

/// Copy text for the user when paste isn't possible (elevated target).
#[tauri::command]
pub async fn copy_text(text: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use insert::Clipboard;
        tauri::async_runtime::spawn_blocking(move || {
            insert::windows::WindowsClipboard.set_text(&text)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = text;
        Err("Sayvox supports Windows only".into())
    }
}

/// One dictation's timings for the Phase 1 gate (T040). Numbers only, never text.
#[derive(Debug, Clone, serde::Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimingRecord {
    pub release_to_insert_ms: u64,
    pub stt_commit_ms: u64,
    pub audio_seconds: f32,
    pub result: String,
}

/// Debug builds (or `SAYVOX_TIMING=1`) append to `<app data>/timings.jsonl` for
/// `eval/timing/report.ts`. Release builds without the variable write nothing.
#[tauri::command]
pub fn timing_append(app: AppHandle, record: TimingRecord) -> Result<(), String> {
    if !cfg!(debug_assertions) && std::env::var("SAYVOX_TIMING").as_deref() != Ok("1") {
        return Ok(());
    }
    use std::io::Write;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let line = serde_json::to_string(&record).map_err(|e| e.to_string())?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("timings.jsonl"))
        .map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timing_records_reject_extra_fields() {
        let ok =
            r#"{"releaseToInsertMs":640,"sttCommitMs":210,"audioSeconds":1.2,"result":"inserted"}"#;
        assert!(serde_json::from_str::<TimingRecord>(ok).is_ok());
        let with_text = r#"{"releaseToInsertMs":640,"sttCommitMs":210,"audioSeconds":1.2,"result":"inserted","text":"hi"}"#;
        assert!(serde_json::from_str::<TimingRecord>(with_text).is_err());
    }

    #[test]
    fn pcm_is_little_endian_i16() {
        assert_eq!(
            pcm_bytes(&[1, -2, 0x1234]),
            vec![1, 0, 0xFE, 0xFF, 0x34, 0x12]
        );
    }

    #[test]
    fn events_serialize_for_the_web_side() {
        let s = serde_json::to_string(&DictationEvent::Release {
            t: 5,
            audio_seconds: 1.5,
        })
        .unwrap();
        assert_eq!(s, r#"{"kind":"release","t":5,"audioSeconds":1.5}"#);
        let e = serde_json::to_string(&DictationEvent::AudioError {
            code: AudioErrorCode::PermissionDenied,
        })
        .unwrap();
        assert_eq!(e, r#"{"kind":"audioError","code":"permissionDenied"}"#);
    }
}
