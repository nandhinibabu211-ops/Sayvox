# Epic 1 — Foundation & Dictation Proof of Concept

**Phase:** 1 · **Goal:** Stand up the monorepo and a Tauri client on one OS (macOS first) that captures speech with a global hotkey, streams to Scribe v3 Live via a dev-only token endpoint, and pastes clean text at the cursor.
**Gate:** plain dictation release → inserted **< 1 s** on 20 test phrases.

---

## Story 1.1 — Monorepo and CI skeleton
As a developer, I want a monorepo with desktop, api and shared packages and CI, so that every later story has a consistent home and checks.

**Acceptance Criteria**
1. pnpm workspace + Turborepo with `apps/desktop`, `apps/api`, `apps/web`, `packages/shared`, `packages/prompts`, `eval/`.
2. Lint (ESLint + Prettier, clippy + rustfmt) and typecheck run with one command.
3. GitHub Actions runs lint, typecheck and unit tests on every PR.
4. `apps/api` exposes `GET /healthz` returning `200 {"status":"ok"}`.
5. README documents local setup.

## Story 1.2 — Tauri shell with tray and overlay window
As a user, I want the app to live in the menu bar/tray with an overlay that appears on demand, so that it never gets in my way.

**Acceptance Criteria**
1. Tauri v2 app launches into tray/menu bar with Settings and Quit items.
2. A transparent, always-on-top, non-focusable overlay window exists, hidden by default.
3. Showing the overlay does not steal focus from the frontmost app (verified in TextEdit/Notes and a browser).
4. Overlay follows OS light/dark.

## Story 1.3 — Global hold-to-talk hotkey
As a user, I want to hold Ctrl+Shift to talk and release to stop, so that dictation is one gesture.

**Acceptance Criteria**
1. Rust `hotkey` module emits `press` and `release` events for Ctrl+Shift held together, from any app.
2. Holds shorter than 300 ms are treated as accidental and emit `cancel`.
3. Overlay appears within 50 ms of press.
4. Key-repeat does not emit multiple presses.
5. Unit tests cover the press/release/cancel state machine.

## Story 1.4 — Microphone capture at 16 kHz PCM
As a user, I want my voice captured cleanly, so that transcription is accurate.

**Acceptance Criteria**
1. `audio` module captures default input device via `cpal`, resamples to 16 kHz mono 16-bit PCM.
2. Emits chunks of 100–250 ms (configurable, default 160 ms).
3. Keeps a ring buffer of the current utterance (for retry).
4. Requests microphone permission on first use; denial surfaces an error state.
5. Resampler has unit tests (48 kHz and 44.1 kHz inputs).

## Story 1.5 — Dev-only Scribe token endpoint
As a developer, I want a dev endpoint that mints a single-use Scribe token, so that the client never holds the ElevenLabs key.

**Acceptance Criteria**
1. `POST /v1/dev/scribe-token` (enabled only when `NODE_ENV=development`) calls ElevenLabs single-use token API and returns `{ token }`.
2. `ELEVENLABS_API_KEY` is read only server-side.
3. Endpoint path, model id and message names verified against current ElevenLabs docs and recorded in `specs/001-voice-to-prompt-mvp/research.md`.

## Story 1.6 — Scribe v3 Live streaming with manual commit
As a user, I want to see words appear while I speak and get the final text on release.

**Acceptance Criteria**
1. Client opens the Scribe WS with token, `audio_format=pcm_16000`, `commit_strategy=manual`.
2. Streams audio chunks as `input_audio_chunk` while held.
3. `partial_transcript` updates overlay text live.
4. On release, sends commit; `committed_transcript` resolves the final text; socket closes.
5. Commit → committed transcript time is measured and logged locally (no text logged).

## Story 1.7 — Paste at cursor with clipboard restore
As a user, I want the text typed where my cursor is without losing what I had copied.

**Acceptance Criteria**
1. `insert` saves clipboard contents (text and, where possible, other formats), writes result, sends Cmd+V (macOS) / Ctrl+V (Windows), restores clipboard in a `finally` path.
2. macOS Accessibility permission is checked; if missing, onboarding guide is shown.
3. Works in TextEdit, Notes, Chrome text fields, Slack desktop and VS Code/Cursor.
4. Clipboard is restored even if paste fails.

## Story 1.8 — PoC timing gate
As the team, we want to measure release → inserted on 20 phrases, so we know the PoC meets the bar.

**Acceptance Criteria**
1. `eval/timing` harness records release → inserted for 20 scripted phrases.
2. Report shows p50 and p95; gate passes when all 20 are < 1 s.
3. Results committed under `eval/results/phase1-<date>.json`.
