# Phase 0 Research: Voice-to-Prompt Dictation

Each item: **Decision · Rationale · Alternatives considered**. Items marked **VERIFY** must be confirmed against live provider documentation before implementing the dependent task.

## R1 — Speech-to-text provider and protocol (VERIFY)
- **Decision**: ElevenLabs Scribe v3 Live over realtime WebSocket; 16 kHz mono PCM16; `commit_strategy=manual`; single-use token minted per session via `POST /v1/single-use-token/realtime_scribe`.
- **Rationale**: Streams partials during speech; commit in ~150–300 ms; $0.22/audio hour; keyterms support for names/jargon; token keeps the API key off the client.
- **Alternatives**: Batch Scribe v3 ($0.20/hr) — adds upload-after-release delay. Proxying audio through backend — adds latency and bandwidth cost.
- **To verify**: endpoint paths, v3 Live `model_id`, message names (`input_audio_chunk`, `partial_transcript`, `committed_transcript`, commit flag), token TTL, keyterm parameter name and limits, language hint parameter, per-plan concurrency limit, zero-retention availability. Record findings here.

## R2 — LLM gateway and model slugs (VERIFY)
- **Decision (owner, ADR-008)**: OpenRouter chat completions with `models: [primary, ...fallbacks]`, `stream: true`, `max_tokens: 600`, `temperature: 0.2`, lowest reasoning.
- **Rationale**: One API, one prepaid bill (5.5 % credit fee), built-in fallback list.
- **Alternatives**: Direct provider SDKs (three code paths, three bills); self-hosted LiteLLM (deferred).
- **To verify**: exact slugs for GPT-6 Luna, Claude Haiku 5.5, Gemini 3.5 Flash-Lite; reasoning-effort parameter shape; provider routing options for no-training/no-retention (`provider.data_collection`), SSE chunk format.
- **Rejected**: Gemini API (Gemini-only fallback; paid tier needed for privacy) and Vertex AI (not needed).

## R3 — TTFT fallback strategy
- **Decision**: Backend runs one model attempt at a time with a 1.5 s first-token deadline, aborting and moving to the next slug on miss/error (in addition to OpenRouter's own `models` fallback for hard errors).
- **Rationale**: OpenRouter fallback triggers on errors, not on slow first tokens; the latency budget needs an explicit deadline.
- **Alternatives**: Hedged parallel requests — lower tail latency but up to 2× cost; revisit if p95 misses budget.

## R4 — Desktop framework (ADR-001)
- **Decision (accepted)**: Tauri v2.
- **Rationale**: Few-MB installers, fast start, Rust access to OS hooks, clipboard and audio.
- **Alternatives**: Electron — all-JS team convenience at 100+ MB and higher memory.

## R5 — Global modifier-only hotkey
- **Decision**: Custom Rust module: macOS `CGEventTap` on `flagsChanged`; Windows `WH_KEYBOARD_LL` hook.
- **Rationale**: Standard global-shortcut APIs require a non-modifier key and don't expose release events.
- **Alternatives**: `rdev` crate — viable shortcut for prototyping; evaluate stability and permissions.

## R6 — Text insertion
- **Decision**: Clipboard save → set text → synthetic Cmd/Ctrl+V → restore after ~150 ms.
- **Rationale**: Works across nearly all apps, fast for long text.
- **Alternatives**: Synthetic per-character typing — slow, breaks with IMEs and autocomplete; Accessibility API value set — inconsistent across apps.

## R7 — Active-app detection
- **Decision**: macOS `NSWorkspace.frontmostApplication` bundle id; Windows `GetForegroundWindow` → process exe name. For browsers, map window-title patterns (e.g. "Gmail") locally to an app id; title itself is not sent.
- **Rationale**: Enough signal for mode selection without sending window contents.

## R8 — Backend framework & runtime
- **Decision**: TypeScript + Fastify 5 on Node 22.
- **Rationale**: Shared Zod types with client, low overhead, straightforward SSE via `reply.raw`.
- **Alternatives**: Python FastAPI — equally viable; loses shared types.

## R9 — Auth provider
- **Decision**: Google Identity Platform (Firebase Auth) — email + Google sign-in; ID tokens verified against Google's JWKS (ADR-006).
- **Rationale**: Already in the owner's Google Cloud account; standard JWTs; no new vendor.
- **Rationale**: One vendor for DB + auth at launch; standard JWTs.

## R10 — Billing (ADR-003)
- **Decision (owner)**: Razorpay only (ADR-003). International cards need Razorpay international payments enabled.
- **Rationale**: India-focused user base plus international customers.
- **Open**: confirm with business before Phase 4.

## R11 — Metering of audio
- **Decision**: Client reports audio seconds at session end; backend clamps to `maxSessionSeconds` and the session wall-clock; weekly reconciliation vs ElevenLabs usage.
- **Rationale**: Audio bypasses backend; this bounds abuse while keeping latency low.

## R12 — Quality evaluation
- **Decision**: 30+ consented real dictations incl. Indian English/Hinglish, names, self-corrections, injection attempts; rule checks + LLM-judge pairwise vs Lemon baseline; WER for raw STT.
- **Rationale**: Product claims (≥ Lemon) must be measurable and gate changes.

## R13 — Hosting
- **Decision (owner)**: Google Cloud (ADR-006) — Cloud Run `us-east4` (min 2 instances), Cloud SQL Postgres, Memorystore Redis, Load Balancer + Cloud Armor, Cloud Storage + CDN, Firebase Hosting.
- **Rationale**: Close to provider endpoints in US-East; uses the owner's existing Google Cloud account; scale by adding Cloud Run instances, then regions.

## R14 — Free tier (ADR-004)
- **Decision (accepted, revisit after beta)**: 10 min/day, 120 min/month, Balanced + Cheapest presets, 25 dictionary terms.

## R15 — Code signing (ADR-007)
- **Finding**: No free Windows code-signing option for a closed-source commercial app (SignPath Foundation is open-source only; Azure Trusted Signing and CA certificates are paid). macOS Developer ID needs the paid Apple Developer Program.
- **Decision (owner)**: Skip both. macOS self-signed certificate (stable identity so permissions survive updates — verify), Windows unsigned; Tauri updater signatures + SHA-256 checksums kept.

## R16 — Observability on Google Cloud (ADR-006)
- **Decision**: OTel → Cloud Monitoring/Trace; backend errors → Error Reporting; client crashes and text-free events → `POST /v1/telemetry` → Error Reporting / Cloud Logging → BigQuery sink.
- **Rationale**: Keeps provider credentials off the client and everything in one Google Cloud project.
