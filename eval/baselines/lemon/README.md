# Lemon baseline (Story 4.1 AC 3)

The product goal is quality **≥ Lemon** on the same phrases. To compare:

1. Dictate each case in `eval/dataset/cases.ts` with Lemon into the same kind of target app.
2. Save Lemon's output as `<case id>.txt` in this folder (plain text, exactly what Lemon inserted).
3. Run `pnpm --filter @sayvox/eval quality --judge`: cases with a baseline file get a pairwise judgement, randomised A/B.

The gate passes when, per model, wins + ties ≥ losses against Lemon.

Only consented test phrases go here, never real user dictations (Constitution I). The folder is empty until someone with Lemon access records the baseline.
