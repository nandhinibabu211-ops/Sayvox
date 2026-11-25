# Implementation Plan: Voice-to-Prompt Dictation (MVP → Launch)

**Branch**: `001-voice-to-prompt-mvp` | **Date**: 2026-11-24 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/001-voice-to-prompt-mvp/spec.md`

## Summary
A Tauri desktop client captures speech on a Ctrl+Shift hold, streams 16 kHz PCM directly to ElevenLabs Scribe v3 Live with a backend-minted single-use token, and on release commits the transcript. A stateless Fastify backend selects a mode template and model preset, streams an OpenRouter rewrite back over SSE (1.5 s TTFT fallback), and the client pastes the result at the cursor with clipboard restore. Postgres stores metadata only; Redis enforces limits.

## Technical Context
**Language/Version**: TypeScript 5.x on Node.js 22 LTS (API, client UI); Rust stable (Tauri core)
**Primary Dependencies**: Tauri 2.x, cpal, Fastify 5, Zod, Drizzle ORM, undici, ioredis, Firebase Admin SDK (Identity Platform), Razorpay SDK, @google-cloud/error-reporting, OpenTelemetry → Cloud Monitoring/Trace exporters
**Storage**: Cloud SQL for PostgreSQL 16, Memorystore for Redis 7 (Google Cloud, ADR-006)
**LLM provider**: OpenRouter (ADR-008); not Vertex AI
**Testing**: Vitest, cargo test, testcontainers, mock Scribe WS + mock OpenRouter SSE servers, WebdriverIO + tauri-driver, k6, `eval/` quality + timing harness
**Target Platform**: Windows 10/11 only (ADR-010); API on Cloud Run `us-east4`; installers not code-signed (ADR-007)
**Project Type**: Desktop app + web service (monorepo)
**Performance Goals**: release→insert < 1 s dictation, ≤ 3 s p95 prompt/email; `/session/start` < 150 ms; TTFT 0.5–1 s
**Constraints**: no transcript storage; provider keys server-only; ElevenLabs concurrency is first limit; installer a few MB
**Scale/Scope**: launch with 2+ API instances; designed for thousands of concurrent users; ~7 tables, ~12 endpoints, ~8 desktop modules

## Constitution Check
*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
| --- | --- | --- |
| I. Privacy by Default | ✅ | No text columns in data model; pino redaction; error reports drop bodies; `/v1/telemetry` accepts enum/number fields only |
| II. Secrets Never Ship | ✅ | Single-use Scribe tokens; provider keys only in `apps/api/src/lib` |
| III. Latency Is a Feature | ✅ | Pre-fetched tokens, direct-to-provider audio, warm OpenRouter pool, timing harness gate |
| IV. Never Lose Words | ✅ | Retry → fallback → raw transcript; clipboard restore in `finally` |
| V. Measured Quality | ✅ | Eval set + CI gate on prompt/preset changes |
| VI. Transcript Is Data | ✅ | `<transcript>` wrapping + injection eval cases |
| VII. Stateless, Config-Driven | ✅ | Presets/slugs/kill switch in config + Redis |
| VIII. Simplicity | ✅ | Single API service; managed services; no queue until needed |

## Project Structure

### Documentation (this feature)
```text
specs/001-voice-to-prompt-mvp/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── openapi.yaml
│   ├── rewrite-sse.md
│   └── scribe-realtime.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 (/speckit.tasks)
```

### Source Code (repository root)
```text
apps/
├── desktop/
│   ├── src/                       # TS UI
│   │   ├── overlay/               # state machine + views
│   │   ├── settings/              # General, Modes, Preset, Dictionary, Usage, Privacy
│   │   ├── services/              # scribeClient, rewriteClient, tokenCache, modeResolver, apiClient
│   │   └── telemetry/
│   └── src-tauri/src/
│       ├── hotkey/                # Windows LL hook, state machine
│       ├── audio/                 # cpal capture, resampler, ring buffer
│       ├── active_app/
│       └── insert/                # clipboard save/paste/restore
├── api/
│   ├── src/modules/{auth,limits,session,rewrite,settings,dictionary,usage,billing,config,account}/
│   ├── src/lib/{elevenlabs,openrouter,redis,db,otel,logger}/
│   ├── drizzle/
│   └── test/{unit,integration,contract}/
└── web/                           # landing, privacy, terms, downloads
packages/
├── shared/                        # Zod schemas, types, error codes
└── prompts/                       # dictation.md, prompt.md, email.md + version
eval/
├── dataset/  ├── scorer/  ├── timing/  └── results/
infra/  .github/workflows/
```

**Structure Decision**: Monorepo (pnpm + Turborepo) with a desktop app, one API service, a static web app and shared packages — matches architecture doc §10.

## Phase Plan (maps to roadmap gates)
| Phase | Scope | Gate |
| --- | --- | --- |
| 1 PoC | Setup, hotkey, mic, overlay, Scribe via dev token, paste | dictation < 1 s on 20 phrases |
| 2 MVP | Backend, auth, sessions, rewrite/presets/templates, app detection, eval + timing | prompt p95 < 3 s; quality ≥ Lemon |
| 3 Beta | Release builds (unsigned),  auto-update, quotas, observability, privacy, deletion | 50+ users × 2 weeks, > 99.5 % crash-free |
| 4 Launch | Billing, plan limits, spend controls, kill-switch drill, load test | 3× peak load test passes |

## Complexity Tracking
| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| Native Rust modules per OS (hotkey, paste, active app) | Hold-to-talk modifiers-only chord and non-activating overlay need OS hooks | Tauri global-shortcut plugin cannot detect modifier-only hold/release |
| Client telemetry relayed through the API | Google Cloud Error Reporting/BigQuery can't take client writes without exposing credentials | Third-party SDKs (Sentry/PostHog) dropped to keep everything on Google Cloud (ADR-006) |
