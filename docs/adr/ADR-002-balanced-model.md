# ADR-002: Balanced preset primary model

**Status:** PENDING — needs one eval run with an OpenRouter key (Story 4.4 / T058) · 2026-11-25

## Context
The Balanced preset (default for most users) starts with either Claude Haiku 5.5 or GPT-6 Luna. Both cost the same on OpenRouter ($0.10 / $0.50 per 1M input/output tokens, research R2) and both allow reasoning to be turned off, so the choice comes down to latency and quality on our cases.

Current default (until decided): `anthropic/claude-haiku-5.5` → `openai/gpt-6-luna` → `google/gemini-3.5-flash-lite` (`PRESET_BALANCED` in `apps/api/src/config/env.ts`).

## How to decide
```powershell
$env:OPENROUTER_API_KEY = "<eval key with a low credit limit>"
pnpm --filter @sayvox/eval quality --models anthropic/claude-haiku-5.5,openai/gpt-6-luna --judge
```
This writes `eval/results/quality-<date>.json` with, per model: rule pass rate, injection failures, judge scores (faithfulness/format/tone), wins/ties/losses vs Lemon (once baselines exist), and TTFT / total latency p50/p95.

Pick the model that:
1. passes the gate (≥ 95 % rules, zero injection failures, judge faithfulness ≥ 4, wins + ties ≥ losses vs Lemon), then
2. has the lower total-latency p95 (prompt mode must stay under 3 s release → inserted), then
3. has the higher judge faithfulness on a tie.

Run from the same region as production (us-east4) if possible: latency from India will be higher than real users in the US-East-adjacent path.

## Decision
_To be filled in with the run's numbers._

## Consequences
- Update `PRESET_BALANCED` default (or set `cfg:presets` in Redis) to the winner first, the other second, Gemini 3.5 Flash-Lite third.
- Re-run the eval gate whenever templates or presets change (CI: `.github/workflows/eval.yml`).
