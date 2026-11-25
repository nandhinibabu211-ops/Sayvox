# Tasks: Voice-to-Prompt Dictation (MVP → Launch)

**Input**: Design documents from `specs/001-voice-to-prompt-mvp/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

Format: `- [ ] T### [P?] [Story?] Description — path`
`[P]` = parallelizable (different files, no dependency). `[USn]` = user story from spec.md.
Tests are written first and must fail before implementation (Constitution V).

---

## Phase 1: Setup (shared infrastructure)
- [x] T001 Create pnpm workspace + Turborepo — `package.json`, `pnpm-workspace.yaml`, `turbo.json`
- [x] T002 [P] Scaffold Tauri v2 app (Vite + TS) — `apps/desktop/`
- [x] T003 [P] Scaffold Fastify 5 API with `GET /healthz` — `apps/api/src/server.ts`
- [x] T004 [P] Create shared package with Zod schemas from `contracts/openapi.yaml` — `packages/shared/src/`
- [x] T005 [P] Create prompts package skeleton with version export — `packages/prompts/`
- [x] T006 [P] ESLint/Prettier, clippy/rustfmt configs — root + `apps/desktop/src-tauri/`
- [x] T007 GitHub Actions CI: lint, typecheck, unit tests — `.github/workflows/ci.yml`
- [x] T008 [P] docker-compose for Postgres + Redis; `.env.example` — `docker-compose.yml`, `apps/api/.env.example`
- [x] T009 [P] Structured logger with transcript redaction + test — `apps/api/src/lib/logger.ts`

## Phase 2: Foundational (blocks all user stories)
- [x] T010 Drizzle schema for all tables per data-model.md — `apps/api/src/lib/db/schema.ts`
- [x] T011 Migrations + seed (`free`, `pro` plans) — `apps/api/drizzle/`
- [x] T012 [P] Redis client + key helpers — `apps/api/src/lib/redis/`
- [x] T013 [P] Error envelope + error codes — `packages/shared/src/errors.ts`, `apps/api/src/plugins/errors.ts`
- [x] T014 JWT auth plugin (JWKS verify, lazy user + settings create) + tests — `apps/api/src/modules/auth/`
- [x] T015 [P] Config module: presets, model slugs, kill switch, min version (env + Redis) — `apps/api/src/modules/config/`
- [x] T016 [P] OTel metrics/traces bootstrap — `apps/api/src/lib/otel/`
- [x] T017 [P] Client API wrapper with JWT injection + Windows Credential Manager storage — `apps/desktop/src/services/apiClient.ts`, `src-tauri/src/credentials/`
- [x] T018 Client sign-in flow via system browser + `sayvox://auth` deep link — `apps/desktop/src/onboarding/`
- [x] T019 **Research R1/R2 verification** — record confirmed ElevenLabs details and OpenRouter details (ADR-008) in `research.md` and contract files

**Checkpoint**: foundation ready; user stories can begin.

---

## Phase 3: User Story 1 — Dictate clean text anywhere (P1) 🎯 MVP
**Goal**: Hold Ctrl+Shift → speak → release → clean text at cursor < 1 s.
**Independent Test**: 20 scripted phrases in a text editor, all inserted correctly < 1 s.

### Tests (write first)
- [x] T020 [P] [US1] Hotkey state machine unit tests (press/release/cancel/repeat) — `src-tauri/src/hotkey/state.rs`
- [x] T021 [P] [US1] Resampler + chunker unit tests (48k/44.1k → 16k) — `src-tauri/src/audio/tests.rs`
- [x] T022 [P] [US1] Contract test `/v1/session/start` (quota, token, keyterms) with mocked ElevenLabs — `apps/api/test/contract/session-start.test.ts`
- [x] T023 [P] [US1] Contract test `/v1/session/{id}/end` (clamp, idempotent) — `apps/api/test/contract/session-end.test.ts`
- [x] T024 [P] [US1] Mock Scribe WS server (partials, commit, drop) — `apps/desktop/test/mocks/scribeServer.ts`
- [x] T025 [P] [US1] Local dictation cleanup unit tests (fillers, self-corrections, casing) — `apps/desktop/src/services/cleanup.test.ts`

### Implementation
- [x] T026 [US1] Tray + pre-created non-activating overlay window — `src-tauri/src/main.rs`, `tauri.conf.json`
- [x] T027 [US1] Windows hotkey backend (`WH_KEYBOARD_LL`) — `src-tauri/src/hotkey/windows.rs` (ADR-010)
- [x] T028 [US1] Audio capture (cpal) + resample + ring buffer — `src-tauri/src/audio/`
- [x] T029 [US1] Limits module: rate limit, daily/monthly quota, maxSessionSeconds — `apps/api/src/modules/limits/`
- [x] T030 [US1] ElevenLabs token client — `apps/api/src/lib/elevenlabs/token.ts`
- [x] T031 [US1] `POST /v1/session/start` — `apps/api/src/modules/session/start.ts`
- [x] T032 [US1] `POST /v1/session/{id}/end` + `usage_daily` upsert — `apps/api/src/modules/session/end.ts`
- [x] T033 [US1] Abandoned-session sweeper — `apps/api/src/modules/session/sweeper.ts`
- [x] T034 [US1] Token cache with background pre-fetch — `apps/desktop/src/services/tokenCache.ts`
- [x] T035 [US1] Scribe WS client (stream, partials, manual commit, one retry with buffer replay) — `apps/desktop/src/services/scribeClient.ts`
- [x] T036 [US1] Local dictation cleanup — `apps/desktop/src/services/cleanup.ts`
- [x] T037 [US1] Insert module: clipboard save → paste → restore in finally — `src-tauri/src/insert/`
- [x] T038 [US1] Overlay states Hidden/Listening/Transcribing/Inserting/Inserted/Error — `apps/desktop/src/overlay/`
- [x] T039 [US1] Onboarding permissions (Windows microphone access; no Accessibility step on Windows) — `apps/desktop/src/onboarding/permissions.ts`
- [x] T040 [US1] Timing harness for 20 phrases + Phase 1 gate report — `eval/timing/`, `eval/results/` *(harness built; the gate run itself needs a real ElevenLabs key and a person dictating the 20 phrases)*

**Checkpoint**: US1 independently functional — Phase 1 gate.

---

## Phase 4: User Story 2 — Structured AI prompt (P1)
**Goal**: App-aware rewrite into structured prompt with fallbacks, ≤ 3 s p95.
**Independent Test**: 10 requests in Cursor; structured, faithful, ≤ 3 s p95.

### Tests (write first)
- [x] T041 [P] [US2] Mock OpenRouter SSE server (normal, 5xx, slow TTFT, cut stream) — `apps/api/test/mocks/openrouter.ts`
- [x] T042 [P] [US2] Contract test `/v1/rewrite` events per `rewrite-sse.md` — `apps/api/test/contract/rewrite.test.ts`
- [x] T043 [P] [US2] Fallback-on-TTFT unit test — `apps/api/test/unit/rewrite-fallback.test.ts`
- [x] T044 [P] [US2] Log redaction test (no transcript in logs) — `apps/api/test/unit/redaction.test.ts`
- [x] T045 [P] [US2] Mode resolver unit tests — `apps/desktop/src/services/modeResolver.test.ts`

### Implementation
- [x] T046 [P] [US2] Prompt template: `prompt.md` + shared rules — `packages/prompts/src/`
- [x] T047 [P] [US2] Dictation template (minimal LLM pass) — `packages/prompts/src/dictation.md`
- [x] T048 [US2] OpenRouter streaming client, keep-alive pool, per-attempt 1.5 s TTFT deadline — `apps/api/src/lib/openrouter/`
- [x] T049 [US2] Startup validation of model slugs vs OpenRouter `/models` — `apps/api/src/modules/config/validateSlugs.ts`
- [x] T050 [US2] `POST /v1/rewrite` SSE (meta/token/fallback/done/error, abort on disconnect) — `apps/api/src/modules/rewrite/`
- [x] T051 [P] [US2] Active-app detection (Windows) — `src-tauri/src/active_app/windows.rs`
- [x] T052 [US2] Mode resolver + built-in app map — `apps/desktop/src/services/modeResolver.ts`
- [x] T053 [US2] Rewrite SSE client with timers — `apps/desktop/src/services/rewriteClient.ts`
- [x] T054 [US2] Overlay Rewriting state with streamed tokens + mode badge — `apps/desktop/src/overlay/`
- [x] T055 [US2] Raw-transcript fallback path — `apps/desktop/src/services/pipeline.ts`
- [ ] T056 [US2] Eval dataset (30+ incl. Indian English, Hinglish, injection) + Lemon baseline — `eval/dataset/` *(partial: 32 synthetic text cases done; recorded dictations + Lemon baseline need the owner)*
- [x] T057 [US2] Quality scorer (rules + LLM judge) — `eval/scorer/`
- [ ] T058 [US2] Balanced-model timing/quality run → ADR-002 — `docs/adr/ADR-002-balanced-model.md` *(tooling ready; run needs an OpenRouter key)*
- [x] T059 [US2] CI eval gate on `packages/prompts/**` and preset config changes — `.github/workflows/eval.yml`

**Checkpoint**: US1 + US2 — Phase 2 gate (prompt p95 < 3 s, quality ≥ Lemon).

---

## Phase 5: User Story 3 — Email & Slack (P2)
- [x] T060 [P] [US3] Email/Slack template with tone + thread rules — `packages/prompts/src/templates/email.md`, `chat.md`
- [x] T061 [P] [US3] Eval cases for email/slack — `eval/dataset/email.ts` *(13 synthetic cases; recorded versions still pending with T056)*
- [x] T062 [US3] Browser title → app id mapping (Gmail, Outlook web, Slack web) — `src-tauri/src/active_app/browser_map.rs`
- [x] T063 [US3] Optional `threadContext` plumbing (never stored) — opt-in selected-text capture via UI Automation (`src-tauri/src/selection/`), pipeline + `/v1/rewrite`

## Phase 6: User Story 4 — Personalisation (P2)
- [ ] T064 [P] [US4] Contract tests settings + dictionary — `apps/api/test/contract/settings.test.ts`, `dictionary.test.ts`
- [ ] T065 [US4] `GET/PUT /v1/settings` with Redis cache + plan preset check — `apps/api/src/modules/settings/`
- [ ] T066 [US4] `GET/POST/DELETE /v1/dictionary` with plan cap — `apps/api/src/modules/dictionary/`
- [ ] T067 [P] [US4] Settings UI: General (hotkey recorder, insert mode, language, mic) — `apps/desktop/src/settings/General.tsx`
- [ ] T068 [P] [US4] Settings UI: Modes + per-app overrides — `apps/desktop/src/settings/Modes.tsx`
- [ ] T069 [P] [US4] Settings UI: Preset cards (locked by plan) — `apps/desktop/src/settings/Preset.tsx`
- [ ] T070 [P] [US4] Dictionary UI — `apps/desktop/src/settings/Dictionary.tsx`
- [ ] T071 [US4] Review-before-insert state (Enter/Esc) — `apps/desktop/src/overlay/review.ts`
- [ ] T072 [US4] Rebindable hotkey support — `src-tauri/src/hotkey/binding.rs`

## Phase 7: User Story 6 — Trust & data control (P2)
- [ ] T073 [P] [US6] Privacy page + terms — `apps/web/src/pages/privacy.*`, `terms.*`
- [ ] T074 [P] [US6] In-app Privacy & Account screen — `apps/desktop/src/settings/Privacy.tsx`
- [ ] T075 [US6] `DELETE /v1/account` cascade + auth identity delete + test — `apps/api/src/modules/account/`
- [ ] T076 [US6] `POST /v1/telemetry` (enum/number-only schema) → Error Reporting / Cloud Logging; backend Error Reporting with body scrubbing — `apps/api/src/modules/telemetry/`, `apps/*/src/telemetry/`
- [ ] T077 [US6] OpenRouter no-train/no-retain routing on every request; document ElevenLabs retention — `apps/api/src/lib/openrouter/`, `research.md`
- [ ] T078 [US6] Privacy audit script (search Cloud Logging, Error Reporting, BigQuery, DB for test phrases) — `eval/privacy-audit/`

## Phase 8: User Story 7 — Safe updates (P3)
- [ ] ~~T079~~ Removed — macOS out of scope (ADR-010)
- [ ] ~~T080~~ Removed — macOS out of scope (ADR-010)
- [ ] T081 [US7] `GET /v1/client-config` + client poll, forced-update + kill-switch UI — `apps/api/src/modules/config/`, `apps/desktop/src/updates/`
- [ ] T082 [US7] Tauri updater with signed manifests + staged rollout bucket — `apps/desktop/src-tauri/`, `apps/desktop/src/updates/`
- [ ] T083 [US7] Release workflow: unsigned Windows `.msi` + `.exe`, SHA-256 checksums (ADR-007) — `.github/workflows/release.yml`
- [ ] T084 [US7] Installer + update manifest hosting on Cloud Storage + Cloud CDN; install guide for the SmartScreen prompt — `infra/`, `apps/web/`

## Phase 9: User Story 5 — Usage, limits & upgrade (P3)
- [ ] T085 [P] [US5] `GET /v1/usage` + Usage & Plan screen — `apps/api/src/modules/usage/`, `apps/desktop/src/settings/Usage.tsx`
- [ ] T086 [US5] Quota-hit overlay state with Upgrade CTA — `apps/desktop/src/overlay/`
- [ ] T087 [US5] Razorpay Plans ↔ Sayvox plans mapping (ADR-003) — `apps/api/src/modules/billing/plans.ts`
- [ ] T088 [US5] Razorpay subscription create/cancel client — `apps/api/src/modules/billing/razorpay.ts`
- [ ] T089 [US5] `POST /v1/billing/checkout` — `apps/api/src/modules/billing/checkout.ts`
- [ ] T090 [US5] `POST /v1/billing/webhook` signature verify + idempotency + plan update — `apps/api/src/modules/billing/webhook.ts`
- [ ] T091 [US5] Apply free-tier caps from ADR-004 (10 min/day, 120 min/month, Balanced + Cheapest, 25 terms) to seed — `apps/api/drizzle/seed.ts`

## Phase 10: Polish & cross-cutting (launch)
- [ ] T092 [P] Cloud Monitoring dashboards + alerts for every signal in architecture §16 — `infra/observability/`
- [ ] T093 [P] Text-free product events via `/v1/telemetry` + BigQuery log sink — `apps/desktop/src/telemetry/analytics.ts`, `infra/`
- [ ] T094 Terraform for Cloud Run, Cloud SQL, Memorystore, Secret Manager, Artifact Registry; GitHub Actions via Workload Identity Federation; staging deploy + smoke test + manual prod approval + auto-rollback — `infra/terraform/`, `.github/workflows/deploy.yml`
- [ ] T095 Load balancer + Cloud Armor WAF + rate limiting — `infra/terraform/edge.tf`
- [ ] T096 Weekly audio reconciliation vs ElevenLabs usage — `apps/api/src/jobs/reconcile.ts`
- [ ] T097 Provider spend caps + Google Cloud budget alert + daily spend alert (2× 7-day avg) — `infra/observability/`
- [ ] T098 k6 load test at 3× expected peak — `eval/load/`
- [ ] T099 Kill switch + rollback drill — `docs/runbooks/kill-switch.md`
- [ ] T100 Landing page + downloads + pricing — `apps/web/`
- [ ] T101 Run `quickstart.md` end-to-end on Windows 10 and Windows 11

---

## Dependencies & Execution Order
- Setup (T001–T009) → Foundational (T010–T019) → user stories.
- T019 (provider verification) blocks T022, T030, T035 (Scribe) and T041, T048–T050 (OpenRouter).
- US1 → US2 (rewrite builds on session pipeline) → US3, US4, US6 can run in parallel → US7 → US5 → Polish.
- Phase gates (constitution): Phase 1 gate after T040; Phase 2 gate after T059; Beta gate after T084 + T092; Launch gate after T098.

## Parallel Example (US1 tests)
```
T020, T021, T022, T023, T024, T025 — all different files, run together
```

## Implementation Strategy
1. **MVP first**: Setup → Foundational → US1 → validate Phase 1 gate.
2. Add US2 → validate Phase 2 gate → demo.
3. Add US3/US4/US6 in parallel → US7 (Windows, updates) → private beta.
4. US5 + Polish → public launch.
