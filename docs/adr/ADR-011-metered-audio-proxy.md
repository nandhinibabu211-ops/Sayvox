# ADR-011: Audio goes through a metering proxy in the API

**Status:** Accepted · 2026-11-25 · Decided by: project owner ("Second one do it", choosing the
audio proxy over a minimum charge or anomaly detection)
**Supersedes:** research R1's "token keeps the API key off the client; proxying audio adds
latency and bandwidth cost" (the desktop no longer connects to ElevenLabs directly).

## Context
The production-readiness audit (SEC-03) found that usage was recorded from the audio seconds
the desktop app reported at `/v1/session/:id/end`. Audio went straight from the app to
ElevenLabs, so the API could not see it. A modified client could report 0 seconds, or never
call `/end`, and stream unlimited audio that Sayvox pays for, with no effect on its quota.

## Decision
The desktop streams to the API's `GET /v1/stream` WebSocket, which forwards to ElevenLabs
Scribe and meters every audio chunk itself.

- `/v1/session/start` still mints the single-use Scribe token (with
  `max_session_duration_seconds`) but keeps it in Redis behind a one-time **stream ticket**;
  only the ticket goes to the client.
- The client sends the ticket as a WebSocket subprotocol (`["sayvox.stream.v1", ticket]`),
  never in the URL. The ticket works once and expires with the token (15 min).
- The proxy accepts only `input_audio_chunk` messages, fixes the audio format (16 kHz PCM16)
  in the upstream URL, measures `bytes / 32 000` seconds, stops forwarding at the session's
  `maxSessionSeconds` and asks Scribe to commit.
- When either side closes, the proxy charges the metered seconds once (`sessions.metered_at`
  guards repeats). `/end` records the result and timings only; the client's `audioSeconds`
  is diagnostic.

## Consequences
- **Quota is server-authoritative.** Under-reporting or skipping `/end` no longer saves
  quota; sessions that never stream cost nothing (correct for unused prefetched sessions).
- **Latency:** one extra hop (PC → Cloud Run `us-east4` → ElevenLabs). Not yet measured;
  T040's timing run must include it.
- **Cost:** audio bandwidth through Cloud Run (~32 KB/s per active dictation, plus base64
  overhead) and longer-lived connections. Cloud Run's request timeout is now 600 s so a
  5-minute stream fits.
- **Privacy:** audio now passes through Sayvox's servers. It is never stored or logged; only
  its length is recorded. The privacy page says so.
- **Availability:** an API instance restart ends the dictations it carries; shutdown charges
  them first. The client's one retry starts a new session.
- The desktop CSP no longer allows `wss://api.elevenlabs.io`; release builds allow
  `wss://<API host>` instead.
