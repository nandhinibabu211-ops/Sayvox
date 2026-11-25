# End-to-end, quality, API and billing test report

Run 2026-11-25. **Environment available to the audit:** source code, local Node/Rust
toolchains, GitHub Actions (with Docker for integration tests), read-only `gcloud`.
**Not available:** provider keys (ElevenLabs, OpenRouter, Razorpay), Identity Platform
test users, any deployed environment, Windows 10/11 test machines, a microphone session,
the Lemon baseline. Every test that needs one of those is **BLOCKED**, not passed.

Status: PASS = ran and met the expectation · FAIL = ran and did not ·
BLOCKED = could not run (reason given) · PASS (auto) = covered by an automated test against
mocks/containers, not real providers.

## 1. User journey (audit phase 2)

| # | Test | Expected | Actual | Status | Evidence | Fix |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Install application | Installer from install page runs on Win 10/11 | No release built (updater key unset, no bucket) | BLOCKED | KI-02, gcloud: no buckets | — |
| 2 | Sign up / sign in | Browser sign-in, tokens stored in Credential Manager | Callback logic tested; no Identity Platform tenant config verified | PASS (auto) / BLOCKED live | `auth_callback.rs` tests (state, Origin, body cap) | — |
| 3 | Authenticate API calls | Valid token accepted; expired/invalid → 401 | As expected | PASS (auto) | `test/unit/auth*.test.ts`, integration `users.test.ts` | — |
| 4 | Microphone permission | Denied → overlay "Microphone access is off" + settings link | Mapping tested | PASS (auto) / BLOCKED on Windows | `overlay/state.ts` `permissionDenied` | — |
| 5 | Select microphone | Chosen device used | Settings UI code present | BLOCKED | needs real devices | — |
| 6 | Press Ctrl+Shift | Hold starts, release stops, other keys cancel | State machine tested | PASS (auto) / BLOCKED on Windows | `hotkey/state.rs` tests | — |
| 7 | Start recording | 16 kHz mono frames | Resampler/chunker tested | PASS (auto) / BLOCKED live | `audio/dsp.rs` tests | — |
| 8 | Stream to ElevenLabs (through the API proxy) | Partials then commit; audio metered | Against mock Scribe server only | PASS (auto) / BLOCKED live | `scribeClient` tests, `stream-proxy.test.ts`, `integration/stream.test.ts` | Audio proxy (SEC-03) |
| 9 | Receive transcription | Final text | mock only | BLOCKED live | no ElevenLabs key | — |
| 10 | Clean transcription | fillers/self-corrections removed | As expected | PASS (auto) | `cleanup.test.ts` | — |
| 11 | Structured prompt via OpenRouter | SSE meta → tokens → done | Against mock OpenRouter | PASS (auto) / BLOCKED live | `rewrite-route.test.ts`, `rewrite-fallback.test.ts` | Rewrite cap per session (SEC-01) |
| 12 | Detect active app | exe + browser title → mode | Mapping tested | PASS (auto) / BLOCKED on Windows | `active_app` tests, `modeResolver.test.ts` | — |
| 13 | Insert at cursor, clipboard restored | Text pasted, clipboard unchanged | Ordering tested | PASS (auto) / BLOCKED on Windows | `insert` tests | — |
| 14 | Review before insert | Enter inserts, Esc discards | State tested | PASS (auto) | `review.rs`, pipeline tests | — |
| 15 | Save/retrieve settings | Persisted, cached, plan-checked | As expected | PASS (auto) | integration `settings.test.ts` (CI) | — |
| 16 | Usage limits | Daily/monthly caps enforced from server-metered audio | As expected, also when the client reports 0 | PASS (auto) | integration `session.test.ts`, `stream.test.ts` | SEC-03 fixed |
| 17 | Subscription and payment | Checkout link, webhook activates plan | Against fake Razorpay only | PASS (auto) / BLOCKED live | integration `billing.test.ts` (CI) | — |
| 18 | Application update | Signed update installs after idle | Updater not configured | BLOCKED | KI-02 | — |
| — | Whole workflow in one run | Steps 1–18 on a real PC | Not possible | BLOCKED | T101 open | — |

## 2. AI quality (audit phase 3)

The eval set is 33 prompt/email/chat/dictation/injection cases plus 13 email cases, all
**synthetic text transcripts**. There are **no recorded audio samples** and **no Lemon
outputs** (`eval/baselines/lemon/` holds only a README).

| Test | Expected | Actual | Status | Evidence |
| --- | --- | --- | --- | --- |
| Transcription accuracy (Indian English, accents, noise, long sentences, names, numbers) | Measured WER on recorded audio | No audio dataset exists; no ElevenLabs key | BLOCKED | `eval/dataset` is text-only |
| Tamil-English mixed speech | Cases + measurement | **No Tamil-English cases** (Hinglish only) | BLOCKED (gap) | case ids in `eval/dataset/cases.ts` |
| Prompt quality (prompt, email, Slack, self-corrections, fillers, names/numbers, technical terms) | Rule checks + LLM judge pass | Scorer works on fixtures; never run against real models | BLOCKED | `eval/run.ts` needs `OPENROUTER_API_KEY`; scorer tests pass (30) |
| Prompt injection (5 cases incl. Hinglish) | Faithful rewrite, no obeying | Template wraps transcript as data; never measured on real models | PASS (auto: template) / BLOCKED live | prompts tests; `inject-*` cases |
| Empty / unclear speech | No insert, or minimal | Cleanup tested for empty input | PASS (auto) | `cleanup.test.ts`, pipeline tests |
| Comparison with Lemon | wins + ties ≥ losses | Baseline missing | BLOCKED | T056 open |

**No quality target is claimed as met.**

## 3. API and database (audit phase 4)

All rows below ran in CI (`API integration tests`, Postgres 16 + Redis 7 containers) or as
unit tests, at PR #9 head `f6ece23` (10/10 checks green). The new audit tests in
`audit-fixes.test.ts` run in this branch's CI.

| Area | Cases covered | Status | Evidence |
| --- | --- | --- | --- |
| Authentication | missing/invalid/expired token → 401; deleted account → 401; unknown `/v1` path needs auth | PASS (auto) | auth unit tests |
| Session start/end | quota day/month, rate limit 429 + Retry-After, kill switch, outdated client, provider failure → 503, idempotent end, clamp, ownership 404 | PASS (auto) | `session.test.ts` |
| Rewrite streaming | event order, fallback on TTFT/5xx/empty, raw fallback, disconnect abort, ended session 409, oversize 400, **cap 429** | PASS (auto) | `rewrite-route.test.ts` (10) |
| Settings / dictionary | preset by plan 403, cap 403, duplicate 409 (case-insensitive), concurrent adds serialised | PASS (auto) | `settings.test.ts` |
| Usage | minutes, resets, offers | PASS (auto) | `billing.test.ts` |
| Billing / webhooks | bad signature 400, missing event id 400, duplicate → "duplicate", out-of-order → "stale", pending/halted/reactivate, notes lookup, unknown | PASS (auto) | `billing.test.ts` (unit + integration) |
| Account deletion | cascade, identity delete, Razorpay cancel, tombstone, retry | PASS (auto) | `account.test.ts` |
| Client config / telemetry | public config, rollout bucket, strict telemetry schema, scrubbed stacks | PASS (auto) | `client-config.test.ts`, `telemetry.test.ts` |
| Invalid input | Zod 400 naming fields only | PASS (auto) | `errors.test.ts` |
| Duplicate requests | session end, webhooks, dictionary | PASS (auto) | as above |
| Concurrent first sign-in | upsert converges | PASS (auto) | `users.test.ts` |
| Same email, two identities | both sign in | PASS (auto, new) | `audit-fixes.test.ts` (SEC-02 fix) |
| Redis down | settings/config fall back to env/DB; quota rebuilt from Postgres | PASS (auto) | config + limits tests |
| Database down | 5xx without leaking details | Partly: error envelope tested; no fault-injection test | PASS (auto: envelope) |
| Network failures to providers | token mint timeout → 503; OpenRouter timeout → fallback | PASS (auto) | token + fallback tests |
| Migrations | 0000–0003 apply on a fresh DB; seed idempotent | PASS (auto) | integration `startPostgres` runs all migrations every test file |
| Indexes / constraints | user-scoped indexes, sweep partial index, dictionary unique + length CHECK, settings jsonb CHECK, FK cascades | Reviewed | `schema.ts`, `drizzle/*.sql` |

## 4. Billing and usage (audit phase 8)

| Test | Expected | Actual | Status |
| --- | --- | --- | --- |
| Free plan limits (10/day, 120/month, 2 presets, 25 terms) | Enforced | Seed + tests | PASS (auto) |
| Pro plan limits | Defined | **Placeholders** in seed (KI-05) | FAIL (not defined) |
| Daily and monthly quota | 429/403 at the cap | As expected for honest clients | PASS (auto) |
| Server-side quota cannot be bypassed | Modified client still limited | Usage metered by the proxy; client `audioSeconds` ignored; cap enforced while streaming | PASS (auto) |
| Razorpay checkout | `short_url` returned | Fake client only | BLOCKED (no keys) |
| Successful / failed payments | active / past_due → halted | Webhook tests | PASS (auto) / BLOCKED live |
| Duplicate webhooks | Ignored | As expected | PASS (auto) |
| Cancellation | At period end; plan kept | As expected | PASS (auto) / BLOCKED live |
| Plan changes | Preset reset if not allowed | As expected | PASS (auto) |
| Usage reconciliation | Drift reported | Unit tests; provider series label unconfirmed | PASS (auto) / BLOCKED live |

## 5. Windows compatibility (audit phase 7)

Every item (fresh install, startup, mic permission, global shortcut, tray, clipboard,
insertion, sleep/wake, restart, uninstall, update) is **BLOCKED** on both Windows 10 and
Windows 11: no test machines, and no installer can be built until the updater key is set.
CI compiles and tests the Rust code on `windows-latest` (Server 2022/2025) only.
Known OS caveats already documented on the install page: SmartScreen warning for the unsigned
installer, Windows 11 Smart App Control may block it outright, elevated target apps refuse
paste (the overlay offers copy instead).

## 6. Final gate commands (audit phase 10)

| Check | Result | Evidence |
| --- | --- | --- |
| Unit + contract tests | PASS: 336 tests (api 127, desktop 136, eval 30, shared 19, prompts 15, web 9) | `pnpm check --force` |
| Integration tests | PASS in CI | PR #9 run; audit tests run on this branch's PR |
| End-to-end tests | BLOCKED | none exist against real providers; T101 open |
| TypeScript checks | PASS | `pnpm check` (typecheck in every package) |
| Rust checks | PASS: fmt, clippy `-D warnings`, 67 tests | local + Windows CI |
| Lint | PASS | `pnpm check` |
| Production builds | PASS: API image (CI), web (vite), desktop frontend (vite). Tauri release bundle not built | CI `api-image`, local builds |
| Terraform | PASS: fmt + validate, 3 roots (CI). Never planned/applied | CI |
| Security scans | `pnpm audit`: 3 moderate (dev-only) after fix; secret scan clean; no `cargo audit` | SECURITY_AUDIT.md |
| Load test | BLOCKED: no staging | PERFORMANCE_REPORT.md |
