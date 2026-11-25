# Phase 0 Research: Voice-to-Prompt Dictation

Each item: **Decision · Rationale · Alternatives considered**. Items marked **VERIFY** must be confirmed against live provider documentation before implementing the dependent task.

## R1 — Speech-to-text provider and protocol (VERIFIED 2026-11-25, T019)
- **Decision**: ElevenLabs Scribe v3 Live (`model_id=scribe_v3_live`) over realtime WebSocket; 16 kHz mono PCM16; `commit_strategy=manual`; single-use token minted per session via `POST /v1/single-use-token/realtime_scribe`.
- **Rationale**: Streams partials during speech; commit in ~150–300 ms; $0.22/audio hour (architecture doc; not stated on the API pages); keyterms for names/jargon; token keeps the API key off the client.
- **Alternatives**: Batch Scribe v3 ($0.20/hr) — adds upload-after-release delay. `scribe_v2_realtime` (the API default) — older model. Proxying audio through backend — adds latency and bandwidth cost.
- **Verified facts** (sources: elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime, /docs/capabilities/speech-to-text, /docs/api-reference/tokens/create):
  - WS URL `wss://api.elevenlabs.io/v1/speech-to-text/realtime`; query params `model_id` (`scribe_v3_live` | `scribe_v2_realtime`), `token`, `audio_format` (`pcm_16000` default), `commit_strategy` (`manual` default | `vad` | `turn_prediction`), `language_code`, `keyterms` (array), `enable_logging`, `keepalive_interval_ms` (500–10 000).
  - Client chunk: `{ "message_type": "input_audio_chunk", "audio_base_64", "commit": bool, "sample_rate": 16000 }` — all four fields required on every chunk; commit by sending `commit: true`.
  - Server messages: `session_started`, `partial_transcript` (`text`), `committed_transcript` (`text`); errors `error`, `auth_error`, `quota_exceeded`, `commit_throttled`, `rate_limited`, `queue_overflow`, `resource_exhausted`, `session_time_limit_exceeded`, `input_error`, `invalid_request`, `chunk_size_exceeded`, `insufficient_audio_activity`, `transcriber_error`, `unaccepted_terms` (field `error`).
  - Token: response `{ "token" }`; **expires after 15 minutes**, consumed on use; optional query `max_session_duration_seconds` closes the session server-side — use it to enforce `maxSessionSeconds` (Story 2.3) at the provider, not only on the client.
  - Keyterms limit (realtime): **up to 100 terms and 1 000 characters in total** — Story 2.7 must cap what it sends.
  - Billing counts every second of audio sent, **including silence**, so the client must stop streaming on release and never pre-open the mic stream to the provider.
  - Zero retention: `enable_logging=false`, **enterprise plans only**. On other plans ElevenLabs may log audio/transcripts; the privacy page (Story 5.6) must say so until an enterprise plan is in place.
  - Regional hosts exist (`api.us`, `api.eu.residency`, `api.in.residency`, `api.sg.residency`) — the India residency host is an option to evaluate for latency/DPDP.
- **Superseded in part by ADR-011 (2026-11-25)**: the desktop no longer connects to ElevenLabs. The API keeps the single-use token, proxies the WebSocket at `/v1/stream` and meters the audio, because client-reported seconds let a modified client bypass the quota (audit SEC-03).
- **Still open**: per-plan concurrency limit (see elevenlabs.io/docs/overview/models#concurrency-and-priority; confirm with ElevenLabs before Story 6.5).

## R2 — LLM gateway and model slugs (VERIFIED 2026-11-25, T019)
- **Decision (owner, ADR-008)**: OpenRouter chat completions, `stream: true`, `max_tokens: 600`, `temperature: 0.2`, `provider: { "data_collection": "deny", "zdr": true }`, per-model lowest reasoning effort.
- **Rationale**: One API, one prepaid bill (5.5 % credit fee), all three model families.
- **Alternatives**: Direct provider SDKs (three code paths, three bills); self-hosted LiteLLM (deferred).
- **Rejected**: Gemini API (Gemini-only fallback; paid tier needed for privacy) and Vertex AI (not needed).
- **Verified facts** (sources: openrouter.ai/api/v1/models, /docs/features/provider-routing, /docs/use-cases/reasoning-tokens, /docs/guides/routing/model-fallbacks, /docs/api-reference/streaming):
  - Slugs exist exactly as configured: `anthropic/claude-haiku-5.5`, `openai/gpt-6-luna`, `google/gemini-3.5-flash-lite`. Prices per 1M tokens (in/out): Haiku 5.5 $0.10/$0.50, GPT-6 Luna $0.10/$0.50, Gemini 3.5 Flash-Lite $0.30/$2.50.
  - **Reasoning differs per model**: Haiku 5.5 and GPT-6 Luna accept `reasoning: { "effort": "none" }` (off). Gemini 3.5 Flash-Lite has `mandatory: true`; supported efforts `high|medium|low|minimal`, so its lowest is `"minimal"` and `"none"` is invalid. One shared request body can't serve all three, so the backend sends **one attempt per model with that model's own effort** (map in config). Reasoning tokens count against `max_tokens`.
  - Privacy routing: `provider.data_collection: "deny"` (only providers that don't collect data) and `provider.zdr: true` (zero-data-retention endpoints only).
  - Enforced (T077): `requestBody()` in `apps/api/src/lib/openrouter/stream.ts` is the only way a request is built; `apps/api/test/unit/openrouter-privacy.test.ts` asserts every outbound request carries both fields. ElevenLabs retention is disclosed on the privacy page (`apps/web/privacy.html`) and in-app (Settings → Privacy & Account) until an enterprise zero-retention plan exists (R1).
  - `models` array = OpenRouter-side fallback on any error (rate limit, downtime, moderation, context). Not used, because each attempt needs a different `reasoning` value and our own 1.5 s TTFT deadline (R3).
  - SSE: `data: <json>` lines; keep-alive comment `: OPENROUTER PROCESSING` (skip lines starting with `:`); end sentinel `data: [DONE]`; `usage` arrives in a final chunk just before `[DONE]`; a mid-stream failure is a chunk with top-level `error` (`code`, `message`) and `finish_reason: "error"`; pre-stream errors are JSON with HTTP 400/401/402/429/502/503.
  - Response header `X-Generation-Id` identifies the generation (log it; never the text).

## R3 — TTFT fallback strategy
- **Decision**: Backend runs one model attempt at a time (single `model`, that model's reasoning effort) with a 1.5 s first-token deadline, aborting and moving to the next slug on miss/error. OpenRouter's `models` array is not used (see R2).
- **Rationale**: OpenRouter fallback triggers on errors, not on slow first tokens; the latency budget needs an explicit deadline.
- **Alternatives**: Hedged parallel requests — lower tail latency but up to 2× cost; revisit if p95 misses budget.

## R4 — Desktop framework (ADR-001)
- **Decision (accepted)**: Tauri v2.
- **Rationale**: Few-MB installers, fast start, Rust access to OS hooks, clipboard and audio.
- **Alternatives**: Electron — all-JS team convenience at 100+ MB and higher memory.

## R5 — Global modifier-only hotkey
- **Decision**: Custom Rust module: Windows `WH_KEYBOARD_LL` hook (Windows only, ADR-010).
- **Rationale**: Standard global-shortcut APIs require a non-modifier key and don't expose release events.
- **Alternatives**: `rdev` crate — viable shortcut for prototyping; evaluate stability and permissions.

## R6 — Text insertion
- **Decision**: Clipboard save → set text → synthetic Ctrl+V (`SendInput`) → restore after ~150 ms.
- **Rationale**: Works across nearly all apps, fast for long text.
- **Alternatives**: Synthetic per-character typing — slow, breaks with IMEs and autocomplete; Accessibility API value set — inconsistent across apps.

## R7 — Active-app detection
- **Decision**: `GetForegroundWindow` → process exe name. For browsers, map window-title patterns (e.g. "Gmail") locally to an app id; title itself is not sent.
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
- **Verified 2026-11-25 (T088, razorpay.com/docs)**: Subscriptions API `POST /v1/subscriptions` (`plan_id`, `total_count` required; `expire_by`, `notes` up to 15 pairs) returns `short_url` for the hosted authorisation payment; `POST /v1/subscriptions/:id/cancel` with `cancel_at_cycle_end` (true = at period end; status becomes `cancelled` only then; callable once). HTTP Basic with key id + secret. Statuses: created, authenticated, active, pending, halted, cancelled, completed, expired (plus paused in webhooks).
- **Webhooks**: `X-Razorpay-Signature` = hex HMAC-SHA256 of the raw body with the webhook secret; `x-razorpay-event-id` unique per event (dedupe on it); delivery may repeat and may arrive out of order; ports 80/443 only (fine for Cloud Run). Events: subscription.authenticated, activated, charged, completed, updated, pending, halted, cancelled, paused, resumed; entity at `payload.subscription.entity`.
- **Not stated in the docs read**: whether retries reuse the event id (assumed yes, per 'unique per event'), and the test-key prefix. Razorpay Subscriptions are listed for India, Malaysia, Singapore and the US.

## R11 — Metering of audio
- **Decision**: Client reports audio seconds at session end; backend clamps to `maxSessionSeconds` and the session wall-clock; weekly reconciliation vs ElevenLabs usage.
- **Rationale**: Audio bypasses backend; this bounds abuse while keeping latency low.
- **Reconciliation source (read 2026-11-25, T096)**: `GET /v1/usage/character-stats` with `start_unix` / `end_unix` in **milliseconds**, `metric` one of credits, tts_characters, minutes_used, request_count, ttfb_avg, ttfb_p95, fiat_units_spent, concurrency, concurrency_average; `breakdown_type` includes `product_type`; `aggregation_interval` hour/day/week/month/cumulative. Response `{ time: [...], usage: { <label>: [...] } }`.
- **Not confirmed**: whether `minutes_used` with `product_type` breakdown yields a speech-to-text series, and its label. The page marks the endpoint deprecated in favour of `/v1/workspace/analytics/query/usage-by-product-over-time`, which could not be read (403). The job therefore reports `unknown` (never a false drift alarm) when no STT-like series comes back; the runbook says to compare by hand then and update the job.

## R12 — Quality evaluation
- **Decision**: 30+ consented real dictations incl. Indian English/Hinglish, names, self-corrections, injection attempts; rule checks + LLM-judge pairwise vs Lemon baseline; WER for raw STT.
- **Rationale**: Product claims (≥ Lemon) must be measurable and gate changes.

## R13 — Hosting
- **Decision (owner)**: Google Cloud (ADR-006) — Cloud Run `us-east4` (min 2 instances), Cloud SQL Postgres, Memorystore Redis, Load Balancer + Cloud Armor, Cloud Storage + CDN, Firebase Hosting.
- **Rationale**: Close to provider endpoints in US-East; uses the owner's existing Google Cloud account; scale by adding Cloud Run instances, then regions.

## R14 — Free tier (ADR-004)
- **Decision (accepted, revisit after beta)**: 10 min/day, 120 min/month, Balanced + Cheapest presets, 25 dictionary terms.

## R15 — Code signing (ADR-007)
- **Finding**: No free Windows code-signing option for a closed-source commercial app (SignPath Foundation is open-source only; Azure Trusted Signing and CA certificates are paid). (macOS not in scope, ADR-010.)
- **Decision (owner)**: Skip it. Windows installers unsigned; Tauri updater signatures + SHA-256 checksums kept.

## R16 — Observability on Google Cloud (ADR-006)
- **Decision**: OTel → Cloud Monitoring/Trace; backend errors → Error Reporting; client crashes and text-free events → `POST /v1/telemetry` → Error Reporting / Cloud Logging → BigQuery sink.
- **Rationale**: Keeps provider credentials off the client and everything in one Google Cloud project.
- **Implementation (T092-T094)**: Google-built OpenTelemetry Collector as a Cloud Run sidecar (`infra/terraform/otel-collector.yaml`), `googlecloud` exporter with prefix `workload.googleapis.com`, so API metrics land on `generic_task` resources; `service.namespace` = env separates staging and prod. Alerts use ratio and percentile threshold conditions (`infra/observability`). The collector image tag must be checked against Google's sidecar guide before the first apply.
