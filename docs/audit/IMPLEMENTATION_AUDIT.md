# Implementation audit (T001–T101)

Audited 2026-11-25 on branch `audit/production-readiness` (stacked on Phase 10, PR #9).
Method: read the code behind each task, ran every local check, and read CI results. A task
counts as **Implemented** when its code exists, is wired in, and has passing tests; that
does not mean it was proven against real providers (see END_TO_END_TEST_REPORT.md).

## Summary

| Status | Tasks |
| --- | --- |
| Implemented and tested (code + passing automated tests) | 86 |
| Implemented, depends on infrastructure that does not exist yet (Terraform, CI deploy, runbooks) | 8 (T084, T092–T097, T099) |
| Partial: tooling done, the required *run* never happened | 4 (T040, T056, T058, T098) |
| Not done | 1 (T101) |
| Removed by decision (macOS, ADR-010) | 2 (T079, T080) |

**None of the four constitution phase gates has been run:** Phase 1 (T040 timing with a real
ElevenLabs key), Phase 2 (T058 balanced-model run), Beta (T084 + T092 on real infrastructure)
and Launch (T098 load test).

## Evidence used

- `pnpm check --force`: 18/18 turbo tasks pass. Unit/contract tests: api 127, desktop 136,
  eval 30, shared 19, prompts 15, web 9.
- Rust (`cargo fmt --check`, `clippy -D warnings`, `cargo test`): 67 tests pass (Phase 10 run;
  no Rust changed since). Windows CI job green.
- CI on PR #9 head `f6ece23`: 10/10 checks pass, including API integration tests (Postgres +
  Redis via testcontainers), API container build, and Terraform fmt + validate for all three roots.
- `gcloud`, read-only: project `sayvox-app-2026` exists and is ACTIVE; Cloud Run and Cloud SQL
  APIs are **disabled**, no buckets. Nothing is deployed.
- No `apps/api/.env` and no provider keys on the audit machine; Docker daemon not running.

## Task by task

Legend: ✅ implemented + tested · 🟡 implemented, unverified against real infrastructure ·
🟠 partial · ❌ not done · ⛔ removed.

### Setup and foundation (T001–T019)

| Task | Status | Evidence / notes |
| --- | --- | --- |
| T001 workspace + Turborepo | ✅ | `turbo.json`, pnpm 10 workspace; `pnpm check` runs 18 tasks |
| T002 Tauri v2 app | ✅ | `apps/desktop`, vite build passes |
| T003 Fastify API + `/healthz` | ✅ | `app.ts:70`; smoke script calls it |
| T004 shared Zod schemas | ✅ | `packages/shared`, 19 tests |
| T005 prompts package | ✅ | 15 tests |
| T006 lint/format configs | ✅ | eslint, prettier, clippy, rustfmt all run in CI |
| T007 CI | ✅ | `ci.yml` (now also Terraform + image jobs) |
| T008 docker-compose + `.env.example` | ✅ | Postgres 16 + Redis 7 |
| T009 logger redaction | ✅ | `lib/logger.ts`, redaction tests |
| T010 Drizzle schema | ✅ | Audit fix: `users.email` was UNIQUE although identity is the uid (SEC-02), migration 0003 |
| T011 migrations + seed | ✅ | 4 migrations; seed is re-applied on every deploy (see KNOWN_ISSUES KI-06) |
| T012 Redis keys | ✅ | `lib/redis/keys.ts` |
| T013 error envelope | ✅ | 5xx never echo messages; validation errors name fields, not values |
| T014 JWT auth | ✅ | RS256 only, issuer/audience/exp checked, emulator tokens refused in staging/prod |
| T015 config (presets, kill switch, min version) | ✅ | env defaults + Redis override, 10 s cache |
| T016 OTel bootstrap | ✅ | metrics export only when an OTLP endpoint is set |
| T017 client API + Credential Manager | ✅ | `credentials/mod.rs` (keyring) |
| T018 sign-in via browser + deep link | ✅ | loopback POST with one-time state + Origin check (`auth_callback.rs`) |
| T019 provider research | ✅ | research R1/R2 recorded 2026-11-25 |

### US1 Dictation (T020–T040)

| Task | Status | Evidence / notes |
| --- | --- | --- |
| T020–T025 tests and mocks | ✅ | hotkey, resampler, session contract, Scribe mock, cleanup tests |
| T026 tray + overlay | ✅ | code + build; not run on a real desktop in this audit |
| T027 `WH_KEYBOARD_LL` hotkey | ✅ | state-machine tests; real Windows behaviour unverified (T101) |
| T028 audio capture | ✅ | DSP tests; real microphones unverified |
| T029 limits | ✅ | quota/rate tests. SEC-03 (client-reported usage) fixed by the audio proxy, ADR-011 |
| T030 ElevenLabs token client | ✅ | unit tests with fake fetch; never called with a real key |
| T031–T033 session start/end/sweeper | ✅ | integration tests in CI |
| T034–T036 token cache, Scribe client, cleanup | ✅ | unit tests against the mock Scribe server |
| T037 insert with clipboard restore | ✅ | Rust tests of the ordering; real paste unverified (T101) |
| T038–T039 overlay states, onboarding | ✅ | tests; UI not exercised manually |
| T040 timing harness + Phase 1 gate | 🟠 | harness and report exist; **gate never run** (needs key + a person dictating) |

### US2 AI rewrite (T041–T059)

| Task | Status | Evidence / notes |
| --- | --- | --- |
| T041–T045 mocks and tests | ✅ | mock OpenRouter (5xx, slow, cut stream), redaction test |
| T046–T047 templates | ✅ | prompts tests |
| T048–T050 OpenRouter client, slug check, `/v1/rewrite` | ✅ | Audit fix SEC-01: unlimited rewrites per open session; capped at 2 |
| T051–T055 active app, resolver, SSE client, overlay, raw fallback | ✅ | tests |
| T056 eval dataset + Lemon baseline | 🟠 | 33 + 13 synthetic **text** cases. **No Lemon outputs** (`eval/baselines/lemon` has only a README), no recorded audio, no Tamil-English cases |
| T057 scorer | ✅ | 30 eval tests |
| T058 balanced-model run → ADR-002 | 🟠 | **never run** (no OpenRouter key) |
| T059 CI eval gate | ✅ | `eval.yml`; skips without a key, so it has never actually gated |

### US3 Email & Slack (T060–T063)

| Task | Status | Evidence / notes |
| --- | --- | --- |
| T060–T063 | ✅ | template, 13 cases, browser-title mapping, opt-in thread context (never stored) |

### US4 Personalise (T064–T072)

| Task | Status | Evidence / notes |
| --- | --- | --- |
| T064–T066 settings + dictionary API | ✅ | integration tests; plan preset and dictionary caps enforced server-side, adds serialised per user |
| T067–T072 settings UI, review, rebindable hotkey | ✅ | unit tests; UI not exercised manually |

### US6 Privacy (T073–T078)

| Task | Status | Evidence / notes |
| --- | --- | --- |
| T073 privacy + terms pages | ✅ | **drafts, pending legal review** (launch blocker, KI-03) |
| T074–T076 privacy screen, deletion, telemetry | ✅ | deletion idempotent; tombstone stops resurrection by old tokens |
| T077 OpenRouter no-train/no-retain | ✅ | request shape test (`data_collection: deny`, ZDR) |
| T078 privacy audit script | ✅ | `eval/privacy-audit`; needs deployed logs to run |
| T079, T080 | ⛔ | macOS removed (ADR-010) |

### US7 Windows distribution (T081–T084)

| Task | Status | Evidence / notes |
| --- | --- | --- |
| T081 client config + kill switch UI | ✅ | tests |
| T082 updater with signed manifests | ✅ | **updater public key is still `REPLACE_WITH_UPDATER_PUBLIC_KEY`**; release workflow refuses to build until set (KI-02) |
| T083 release workflow | ✅ | Audit fix SEC-04: release CSP now pinned to the API origin |
| T084 installer hosting | 🟡 | Terraform exists; bucket not created; download links on the site 404 today |

### US5 Billing (T085–T091)

| Task | Status | Evidence / notes |
| --- | --- | --- |
| T085–T091 | ✅ | webhook signature, dedupe, ordering, grace, cancel: unit + integration tests. **Never run against Razorpay** (no keys or plan ids). Pro price/limits are placeholders (KI-05) |

### Polish (T092–T101)

| Task | Status | Evidence / notes |
| --- | --- | --- |
| T092, T093, T097 observability, events, spend | 🟡 | applied on staging (dashboard, 4 alerts, events sink, ₹2,000 budget); app-metric alerts wait for real traffic |
| T094 Terraform + deploy pipeline | 🟡 | staging applied and live (cheap shape); staging auto-deploy on; prod not created (`PROD_ENABLED` off) |
| T095 LB + Cloud Armor | 🟡 | off until a domain exists (ADR-009) |
| T096 reconciliation | 🟡 | unit tests; ElevenLabs STT series label unconfirmed (research R11) |
| T098 load test | 🟠 | script + runbook; **never run** |
| T099 kill-switch drill | ✅ | staging drill 2026-11-26: kill switch, forced update, rollout halt, API rollback all pass (kill-switch.md log); desktop reaction not yet observed |
| T100 landing page | ✅ | builds; Pro shows "Coming soon" |
| T101 quickstart on Windows 10/11 | ❌ | not done; needs real machines. Quickstart corrected in this audit (wrong Node/pnpm versions, non-existent scripts and env switches) |

## Placeholders, TODOs, duplicates

- No `TODO`/`FIXME`/`HACK` in source.
- Production-relevant placeholders: updater public key (KI-02), Pro plan price and limits in
  `apps/api/src/lib/db/seed.ts` (KI-05), the spend-cap amounts and expected peak in the
  runbooks (blank by design until the owner decides).
- No mock used in place of production code: mocks live under `test/` only; the server
  wires the real ElevenLabs, OpenRouter, Razorpay and Identity Platform clients.
- No duplicate implementations found. `LIVE` subscription statuses were already de-duplicated
  into `billing/plans.ts` in Phase 9.
