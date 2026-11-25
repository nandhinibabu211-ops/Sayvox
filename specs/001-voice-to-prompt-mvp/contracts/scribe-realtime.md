# Contract: ElevenLabs Scribe v3 Live (client ↔ provider)

> Verified against the ElevenLabs API reference on 2026-11-25 (research R1, task T019).

## Token (backend → ElevenLabs)
`POST https://api.elevenlabs.io/v1/single-use-token/realtime_scribe?max_session_duration_seconds=<maxSessionSeconds>`
Headers: `xi-api-key: $ELEVENLABS_API_KEY` → `{ "token": "<single-use>" }`
- Expires **15 minutes** after minting; consumed on first use. Pre-fetched tokens older than ~14 min must be replaced.
- `max_session_duration_seconds` makes ElevenLabs close the session itself — the server-side cap for Story 2.3.

## Connect (client → ElevenLabs)
```
wss://api.elevenlabs.io/v1/speech-to-text/realtime
  ?model_id=scribe_v3_live
  &token=<scribeToken>
  &audio_format=pcm_16000
  &commit_strategy=manual
  [&language_code=<hint>]
  [&keyterms=<term>&keyterms=<term>…]   # ≤ 100 terms, ≤ 1 000 characters total
```

## Client → server messages
Every chunk carries all four fields:

| Message | Shape | Notes |
| --- | --- | --- |
| Audio chunk | `{ "message_type": "input_audio_chunk", "audio_base_64": "<pcm16 b64>", "commit": false, "sample_rate": 16000 }` | 100–250 ms per chunk |
| Commit | `{ "message_type": "input_audio_chunk", "audio_base_64": "", "commit": true, "sample_rate": 16000 }` | Sent on hotkey release |

Billing counts every second sent, including silence: stop sending as soon as the key is released.

## Server → client messages
| `message_type` | Handling |
| --- | --- |
| `session_started` | socket ready; flush queued chunks |
| `partial_transcript` | `overlay.preview(text)` — never logged |
| `committed_transcript` | resolve final transcript (`text`); close socket |
| `auth_error`, `quota_exceeded`, `unaccepted_terms` | fatal for this press: no retry; overlay error |
| `rate_limited`, `resource_exhausted`, `queue_overflow`, `transcriber_error`, `error`, unexpected close | trigger retry policy |
| `session_time_limit_exceeded` | treat as release: commit what we have |
| `commit_throttled`, `insufficient_audio_activity`, `input_error`, `invalid_request`, `chunk_size_exceeded` | log code only; overlay error |

## Client retry policy
1. On a retryable error/close before `committed_transcript`: take a new session token (`/v1/session/start`).
2. Reconnect once; replay ring-buffered audio in chunks; if the key was already released, send commit.
3. Second failure → overlay error; session ended with `insertResult=failed`.

## Privacy
Zero retention (`enable_logging=false`) is available on ElevenLabs **enterprise plans only**. Until then, ElevenLabs may retain audio/transcripts under its terms; the privacy page says so (Story 5.6).

## Timing captured
- `sttCommitMs` = commit sent → `committed_transcript` received.
