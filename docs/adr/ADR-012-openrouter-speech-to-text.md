# ADR-012: Speech-to-text through OpenRouter

**Status:** Accepted · 2026-11-26 · Decided by: project owner ("ElevenLabs ku badhila
OpenRouter laye neriya models irukku, so unakku edhu best ah thonudho adha choose panni use
pannikko"); model choice by Claude.
**Amends:** research R1 (ElevenLabs Scribe v3 Live). ElevenLabs remains a supported upstream
(`STT_PROVIDER=elevenlabs`).

## Context
The owner has an OpenRouter key and no ElevenLabs key, and wants one provider. OpenRouter
has a transcription endpoint, `POST /api/v1/audio/transcriptions` (base64 audio, `language`,
`keyterms` / `prompt`, provider routing incl. `zdr` and `data_collection`), and 30
transcription models (checked 2026-11-26 via `GET /api/v1/models?output_modalities=transcription`
and `GET /api/v1/endpoints/zdr`).

| Model | ≈ US$ / audio hour | ZDR endpoints | Notes |
| --- | --- | --- | --- |
| `openai/whisper-large-v3-turbo` | 0.012 | Groq, DeepInfra, PrimeIntellect | very fast; vocabulary as a prompt |
| `elevenlabs/scribe-v2` | 0.22 | ElevenLabs | good on mixed languages; `keyterms` |
| `deepgram/nova-3` | 0.26 | Deepgram | fast; keyterms |

## Decision
- `STT_PROVIDER=openrouter` (staging now). The `/v1/stream` proxy (ADR-011) buffers the
  session's audio and, on commit, sends it as WAV to `STT_MODELS` in order:
  **`openai/whisper-large-v3-turbo`** first (cheapest, fastest; provider sort = latency),
  **`elevenlabs/scribe-v2`** on timeout/429/5xx. A refused key stops at once.
- Live text: every `STT_PARTIAL_EVERY_MS` (2 s) the audio so far is re-transcribed with the
  first model and sent as `partial_transcript`. Best effort; errors are ignored.
- Every request: `provider: { zdr: true, data_collection: "deny" }`, like the rewrites.
- Clients are unchanged: the proxy answers in the Scribe protocol. Their commit timeout is
  6 s (whole-clip transcription), up from 2 s.
- Usage is still metered by the proxy; the cost recorded is OpenRouter's reported cost.

## Consequences
- No per-session ElevenLabs token or key; one provider key for speech and rewrites.
- Much cheaper speech (about 1/18 of Scribe) even with live-text re-transcription.
- Release → text now includes uploading and transcribing the clip; to be measured (T040).
  Live text appears in ~2 s steps instead of word by word.
- Quality on Tamil-English is unmeasured; if Whisper falls short, put
  `elevenlabs/scribe-v2` first in `STT_MODELS` (configuration, no code change).
- Privacy: audio goes to OpenRouter's zero-data-retention providers; the privacy page says so.
