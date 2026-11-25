# Sayvox Product Requirements Document (PRD)

> BMAD artifact · PM output · v1.0 · 2026-11-24
> Inputs: `docs/project-brief.md`, system architecture source document (2026-11-23)

## 1. Goals and Background Context

### Goals
- Let users dictate anywhere on Windows with a single hold-to-talk hotkey (Ctrl+Shift).
- Deliver plain dictation from key release to inserted text in **< 1 s**.
- Deliver structured Prompt and Email/Slack rewrites in **1.5–3 s p95**.
- Match or beat Lemon accuracy on a 30+ phrase test set including Indian English.
- Store no transcript or rewrite text by default.
- Keep cost near **$1/light user** and **< $4/heavy user** per month.

### Background Context
Knowledge workers increasingly "write" to AI tools and colleagues all day. OS dictation is raw and inaccurate on accents and jargon; it does not adapt output to the destination. Sayvox combines realtime STT (ElevenLabs Scribe v3 Live) with a fast LLM rewrite (via OpenRouter) and inserts text at the cursor, choosing the rewrite mode from the active app.

### Change Log
| Date | Version | Description | Author |
| --- | --- | --- | --- |
| 2026-11-24 | 1.0 | Initial PRD from architecture document | PM (BMAD) |

## 2. Requirements

### Functional Requirements
- **FR1:** The client registers a global hold-to-talk hotkey (default Ctrl+Shift) on Windows 10/11; pressing starts capture, releasing ends it.
- **FR2:** On hotkey down the client calls `POST /v1/session/start` and receives a session id, a single-use Scribe token and the user's keyterms. A token is pre-fetched in the background so one is ready before the next press.
- **FR3:** The client captures microphone audio as 16 kHz mono 16-bit PCM and streams it to Scribe v3 Live in 100–250 ms chunks.
- **FR4:** The overlay ("notch") shows recording state and live partial transcripts while the user speaks.
- **FR5:** On hotkey release the client sends a manual commit, receives the committed transcript and closes the socket. Silence detection is not used to end utterances.
- **FR6:** The client detects the active application (e.g. Cursor, Gmail, Slack) and resolves a mode: Dictation, Prompt or Email/Slack, using the user's default mode and per-app overrides.
- **FR7:** Dictation mode applies light cleanup (filler removal, punctuation, casing, self-corrections) and may skip the LLM or use a minimal filler-removal prompt.
- **FR8:** The client calls `POST /v1/rewrite` with transcript, mode and target app; the backend streams the rewrite via Server-Sent Events.
- **FR9:** The backend selects the system prompt by mode/app and maps the user's preset (Fastest / Balanced / Cheapest) to an ordered model list sent to OpenRouter with `stream: true`.
- **FR10:** If an LLM attempt fails or misses a 1.5 s first-token deadline, the backend falls over to the next model in the preset.
- **FR11:** Streamed tokens fill the overlay preview as they arrive.
- **FR12:** On completion the client saves the clipboard, writes the result, sends Ctrl+V to the focused app and restores the clipboard.
- **FR13:** A "review before insert" setting holds the result in the overlay until the user presses Enter (or Esc to discard).
- **FR14:** If Scribe drops mid-utterance the client keeps buffered audio and retries once on a new token.
- **FR15:** If all rewrite attempts fail the client pastes the raw transcript, so no words are lost.
- **FR16:** The client calls `POST /v1/session/{id}/end` with audio seconds, insert result and client timings; the backend closes the session row.
- **FR17:** Users can view and update settings (`GET/PUT /v1/settings`): preset, default mode, per-app mode overrides, insert behaviour.
- **FR18:** Users can manage a custom dictionary (`GET/POST/DELETE /v1/dictionary`), size-capped per plan; terms are sent to Scribe as keyterms.
- **FR19:** Users can view usage this period and plan limits (`GET /v1/usage`).
- **FR20:** Users sign in via Google Identity Platform (email or Google account); the client holds a short-lived JWT.
- **FR21:** The backend enforces per-user rate limits, daily audio caps and monthly plan quotas (Redis), and caps each token's session length.
- **FR22:** Users can subscribe and upgrade via Razorpay checkout; webhooks update the user's plan.
- **FR23:** The client auto-updates via signed manifests with staged rollout (10 % → 50 % → 100 %); the backend serves a kill switch and a minimum supported client version.
- **FR24:** Users can delete their account, removing all user rows and dictionary terms.
- **FR25:** The app shows a privacy page stating what is sent where and that nothing is kept.
- **FR26:** The user can set a language hint (Auto, English-India, Hinglish, etc.) passed to Scribe.

### Non-Functional Requirements
- **NFR1 Latency:** release→inserted p50 < 1 s for dictation (alert p95 > 1.2 s); prompt/email p95 ≤ 3 s; time-to-first-token ~0.5–1 s.
- **NFR2 Latency:** `POST /v1/session/start` < 150 ms target (alert p95 > 250 ms).
- **NFR3 Accuracy:** output quality ≥ Lemon on a fixed 30+ phrase set incl. Indian English; every prompt/model change is scored before shipping.
- **NFR4 Privacy:** no transcript or rewrite text stored or logged by default; error reports drop request bodies; only metadata persisted.
- **NFR5 Security:** provider API keys only on the backend; TLS everywhere; Cloud Armor WAF; Postgres encrypted at rest; least-privilege DB roles; secrets rotated every 90 days.
- **NFR6 Prompt-injection safety:** transcript wrapped as data in the user message; system prompt forbids following instructions inside it.
- **NFR7 Scalability:** stateless backend scaled horizontally; audio never touches backend.
- **NFR8 Reliability:** crash-free sessions > 99.5 %; API error rate < 1 %; Scribe disconnects < 1 %; LLM fallback < 5 %.
- **NFR9 Cost:** ~$1.06 light / ~$3.82 heavy user per month on Balanced preset.
- **NFR10 Distribution:** Windows `.msi`/`.exe` unsigned; update packages signed with the Tauri updater key; SHA-256 checksums published; install guide covers the SmartScreen prompt (ADR-007, ADR-010).
- **NFR11 Footprint:** installer a few MB (Tauri); fast cold start.
- **NFR12 Compliance:** DPDP Act (India) and GDPR readiness (consent, purpose limits, DPAs, breach notice); SOC 2 path later.
- **NFR13 Observability:** release→insert p50/p95 split by mode, model, region; spend alerts at 2× 7-day average.

## 3. User Interface Design Goals

### Overall UX Vision
Invisible until needed. A small always-on-top "notch" overlay appears on hotkey down, shows a live waveform and partial text, then the streamed rewrite, then disappears after insert. Configuration lives in a compact system-tray settings window.

### Key Interaction Paradigms
- Hold-to-talk; release = end of speech.
- Zero-click insert into the focused app; optional review-before-insert (Enter / Esc).
- Mode badge in the overlay (Dictation / Prompt / Email) with a quick-switch.

### Core Screens and Views
1. Onboarding & microphone access check.
2. Sign-in.
3. Overlay / notch (idle-hidden, listening, transcribing, rewriting, inserted, error).
4. Settings: General (hotkey, insert behaviour, language), Modes (default + per-app overrides), Preset, Dictionary.
5. Usage & Plan (minutes used, limits, upgrade).
6. Privacy & Account (privacy statement, sign out, delete account).
7. Update / forced-update prompt.

### Accessibility
WCAG AA for the settings UI; overlay readable at high contrast; all settings keyboard-navigable.

### Branding
Clean, minimal, system-native look; light/dark following the OS.

### Target Platforms
Windows 10/11 desktop only (ADR-010).

## 4. Technical Assumptions

- **Repository structure:** Monorepo (`apps/desktop`, `apps/api`, `apps/web`, `packages/shared`, `packages/prompts`, `eval/`).
- **Service architecture:** Single stateless REST + SSE service (modular monolith) behind a load balancer; managed services for STT, LLM, auth, billing.
- **Testing:** Unit + integration; contract tests against mocked Scribe and OpenRouter; transcript quality eval set in CI; staging smoke test with one real end-to-end dictation.
- **Additional:** Tauri v2 (Rust + TypeScript UI), TypeScript + Fastify backend, Postgres + Redis, GitHub Actions CI/CD, all hosting on Google Cloud (Cloud Run `us-east4`, Cloud SQL, Memorystore, Identity Platform — ADR-006). LLM via OpenRouter (ADR-008; no Vertex AI).

## 5. Epic List

| # | Epic | Goal | Phase |
| --- | --- | --- | --- |
| 1 | Foundation & Dictation PoC | Monorepo, Tauri shell, hotkey, mic, overlay, Scribe streaming, paste at cursor; gate: dictation < 1 s on 20 phrases | 1 |
| 2 | Backend Core & Auth | Fastify service, auth, data model, `/session/start`, `/session/{id}/end`, settings, dictionary, usage | 2 |
| 3 | AI Rewrite & Modes | OpenRouter presets/fallbacks, prompt templates, `/rewrite` SSE, active-app detection, failure paths | 2 |
| 4 | Quality & Performance Harness | Eval set, timing harness, CI quality gate; gate: prompt p95 < 3 s, quality ≥ Lemon | 2 |
| 5 | Beta Readiness | Windows builds (unsigned, signed updates), auto-update, quotas, observability, privacy, account deletion; gate: 50+ users, > 99.5 % crash-free | 3 |
| 6 | Monetization & Launch | Billing, plan limits, staged rollout + kill switch, capacity planning, load test at 3× peak | 4 |

Detailed stories and acceptance criteria: `docs/epics/epic-1-*.md` … `docs/epics/epic-6-*.md`.

## 6. Checklist Results
See `docs/checklists/pm-checklist-results.md`.

## 7. Next Steps

### UX Expert Prompt
Using this PRD, create `docs/front-end-spec.md` covering the overlay state machine, onboarding/permissions flow and settings IA for a Tauri desktop client.

### Architect Prompt
Using this PRD and the source architecture document, create `docs/architecture.md`: monorepo layout, Tauri client modules, Fastify API, data model, provider integrations, deployment, security and observability. Resolve or frame the open decisions.
