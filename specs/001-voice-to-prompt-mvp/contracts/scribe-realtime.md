# Contract: ElevenLabs Scribe v3 Live (client ↔ provider)

> ⚠️ Shapes follow the architecture document. Verify every path, parameter and message name against the current ElevenLabs API reference (research R1) before implementing; update this file with confirmed values.

## Token (backend → ElevenLabs)
`POST https://api.elevenlabs.io/v1/single-use-token/realtime_scribe`
Headers: `xi-api-key: $ELEVENLABS_API_KEY` → `{ "token": "<single-use>" }`

## Connect (client → ElevenLabs)
```
wss://api.elevenlabs.io/v1/speech-to-text/realtime
  ?model_id=<SCRIBE_LIVE_MODEL>
  &token=<scribeToken>
  &audio_format=pcm_16000
  &commit_strategy=manual
  [&keyterms=…] [&language_code=…]
```

## Client → server messages
| Message | Shape | Notes |
| --- | --- | --- |
| Audio chunk | `{ "message_type": "input_audio_chunk", "audio_base_64": "<pcm16 b64>" }` | 100–250 ms per chunk |
| Commit | `{ "message_type": "input_audio_chunk", "audio_base_64": "", "commit": true }` | Sent on hotkey release |

## Server → client messages
| `message_type` | Handling |
| --- | --- |
| `partial_transcript` | `overlay.preview(text)` — never logged |
| `committed_transcript` | resolve final transcript; close socket |
| error / close | trigger retry policy |

## Client retry policy
1. On unexpected close/error before `committed_transcript`: request a new session token (`/v1/session/start`).
2. Reconnect once; replay ring-buffered audio in chunks; if key already released, send commit.
3. Second failure → overlay error; session ended with `insertResult=failed`.

## Timing captured
- `sttCommitMs` = commit sent → `committed_transcript` received.
