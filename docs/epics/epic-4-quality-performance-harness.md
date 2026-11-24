# Epic 4 — Quality & Performance Harness

**Phase:** 2 · **Goal:** Make quality and latency measurable and gating.
**Gate:** prompt mode p95 < 3 s; output quality judged ≥ Lemon on the same phrases.

---

## Story 4.1 — Transcript test set
**Acceptance Criteria**
1. `eval/dataset/` holds 30+ real dictations (audio + reference transcript + expected-output notes), incl. Indian English, Hinglish, names/jargon ("Zoho", "Zia"), self-corrections and injection attempts.
2. Consent recorded for every contributed sample; no customer data.
3. Lemon outputs captured for the same phrases as baseline.

## Story 4.2 — Quality scorer
**Acceptance Criteria**
1. Rule checks: no preamble, no invented facts (entity overlap), fillers removed, self-corrections applied.
2. LLM-judge pairwise comparison vs Lemon baseline with fixed rubric and seed.
3. Output: per-mode win/tie/loss and WER for raw STT.

## Story 4.3 — Timing harness
**Acceptance Criteria**
1. Replays audio through the real pipeline (staging) and records release→inserted, STT commit, TTFT, total.
2. Reports p50/p95 per mode and model.

## Story 4.4 — Balanced-model decision (ADR-002)
**Acceptance Criteria**
1. Run timing + quality for Claude Haiku 5.5 vs GPT-6 Luna.
2. ADR recorded in `docs/adr/ADR-002-balanced-model.md`; preset config updated.

## Story 4.5 — CI quality gate
**Acceptance Criteria**
1. PRs touching `packages/prompts` or preset config run the eval; merge blocked on regression beyond threshold.
2. Results posted as PR summary.
