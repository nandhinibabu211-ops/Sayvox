# Performance and reliability report

**No performance target has been measured.** Every number below needs a real ElevenLabs
key, a real OpenRouter key, a Windows PC with a microphone, or a deployed staging
environment, and the audit had none of these. This report lists the targets, how each is
measured, and what was verified in code.

| Metric | Target | How it is measured | Result | Status |
| --- | --- | --- | --- | --- |
| Audio capture latency | part of release → insert | `eval/timing` harness (client timings) | not run | BLOCKED |
| Speech-to-text (Scribe commit, through the API proxy, ADR-011) | p95 feeds release→insert | `stt_commit_ms` metric, timing harness | not run; proxy hop adds unmeasured latency | BLOCKED |
| Release → inserted, dictation | p50 < 1 s, alert p95 > 1.2 s | `release_to_insert_ms` + T040 harness (20 phrases) | not run (Phase 1 gate) | BLOCKED |
| AI first token | 1.5 s per-attempt deadline | `llm_ttft_ms` | not run | BLOCKED |
| Release → inserted, prompt/email | p95 ≤ 3 s | timing harness, T058 | not run (Phase 2 gate) | BLOCKED |
| Text insertion | clipboard paste + restore | Windows only | not run | BLOCKED |
| `/v1/session/start` server time | < 150 ms, alert p95 > 250 ms | `session_start_ms` | not run | BLOCKED |
| Memory / CPU (desktop idle and dictating) | not specified | Task Manager / ETW on Win 10/11 | not run | BLOCKED |
| 3× peak load, error rate < 1 % (SC-007) | k6 `eval/load/dictation.js` | not run: no staging, no expected-peak number | BLOCKED |

## Reliability behaviour verified in code and tests

| Scenario | Expected | Status | Evidence |
| --- | --- | --- | --- |
| Provider timeout (OpenRouter) | next model after 1.5 s without a first token; 8 s total | PASS (auto) | `rewrite-fallback.test.ts` |
| All models fail | raw transcript inserted with a notice | PASS (auto) | pipeline tests |
| Scribe drop mid-dictation | one reconnect with buffered audio replay | PASS (auto) | `scribeClient` tests vs mock server |
| Network interruption at token mint | 2 s timeout → 503 `PROVIDER_UNAVAILABLE` | PASS (auto) | token tests |
| Retry behaviour | no blind retries of non-idempotent calls; session end idempotent | PASS (review + tests) | session tests |
| Long recordings | capped by `maxSessionSeconds` (≤ remaining quota) at ElevenLabs and in the clamp | PASS (auto) | limits tests |
| Redis unavailable | env/DB fallbacks; rewrite cap fails open | PASS (auto) | config/limits tests |
| Client disconnect during rewrite | upstream request aborted | PASS (auto) | rewrite route test |
| Rollout gone bad | deploy watches 5xx/p95 for 10 min, rolls back | Written, never run | `deploy.yml`, `watch-rollout.mjs` |

## Before launch

1. Run T040 (20 phrases, real key) and T058 (balanced model) and record p50/p95 here.
2. Decide the expected peak and run `docs/runbooks/load-test.md` on staging.
3. Measure desktop memory/CPU idle and during a 60 s dictation on Windows 10 and 11.
