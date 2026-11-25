/** Phase 1 gate maths (Story 1.8 / T040). Pure functions, unit-tested. */

export interface TimingRecord {
  releaseToInsertMs: number;
  sttCommitMs: number;
  audioSeconds: number;
  result: "inserted" | "raw_fallback" | "failed" | "discarded";
}

/** Nearest-rank percentile (p in 0–100). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export interface GateReport {
  phrases: number;
  required: number;
  budgetMs: number;
  releaseToInsert: { p50: number; p95: number; max: number };
  sttCommit: { p50: number; p95: number };
  failures: number;
  overBudget: number;
  pass: boolean;
}

/**
 * Gate: the last `required` dictations were all inserted, each in under `budgetMs`
 * from key release to text on screen (epic 1: 20 phrases, < 1 s).
 */
export function gate(records: TimingRecord[], required = 20, budgetMs = 1_000): GateReport {
  const last = records.slice(-required);
  const r2i = last.map((r) => r.releaseToInsertMs);
  const stt = last.map((r) => r.sttCommitMs);
  const failures = last.filter((r) => r.result !== "inserted").length;
  const overBudget = last.filter((r) => r.releaseToInsertMs >= budgetMs).length;
  return {
    phrases: last.length,
    required,
    budgetMs,
    releaseToInsert: {
      p50: percentile(r2i, 50),
      p95: percentile(r2i, 95),
      max: r2i.length ? Math.max(...r2i) : Number.NaN,
    },
    sttCommit: { p50: percentile(stt, 50), p95: percentile(stt, 95) },
    failures,
    overBudget,
    pass: last.length >= required && failures === 0 && overBudget === 0,
  };
}

export function parseJsonl(text: string): TimingRecord[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TimingRecord)
    .filter((r) => r.result !== "discarded");
}
