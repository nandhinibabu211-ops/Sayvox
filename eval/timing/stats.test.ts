import { describe, expect, it } from "vitest";
import { gate, parseJsonl, percentile, type TimingRecord } from "./stats";

const rec = (ms: number, result: TimingRecord["result"] = "inserted"): TimingRecord => ({
  releaseToInsertMs: ms,
  sttCommitMs: Math.round(ms / 3),
  audioSeconds: 2,
  result,
});

describe("percentile", () => {
  it("uses nearest rank", () => {
    const v = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    expect(percentile(v, 50)).toBe(100);
    expect(percentile(v, 95)).toBe(190);
    expect(percentile([5], 95)).toBe(5);
  });
});

describe("gate", () => {
  it("passes when the last 20 were all inserted under 1 s", () => {
    const r = gate(Array.from({ length: 20 }, (_, i) => rec(500 + i * 20)));
    expect(r).toMatchObject({ phrases: 20, failures: 0, overBudget: 0, pass: true });
    expect(r.releaseToInsert.p95).toBe(860);
  });

  it("fails if any phrase is at or over the budget", () => {
    const records = Array.from({ length: 20 }, () => rec(600));
    records[7] = rec(1_000);
    expect(gate(records).pass).toBe(false);
  });

  it("fails if any phrase wasn't inserted", () => {
    const records = Array.from({ length: 20 }, () => rec(600));
    records[3] = rec(600, "failed");
    expect(gate(records)).toMatchObject({ failures: 1, pass: false });
  });

  it("fails with fewer than 20 phrases", () => {
    expect(gate(Array.from({ length: 19 }, () => rec(400))).pass).toBe(false);
  });

  it("only judges the most recent 20", () => {
    const records = [rec(5_000), ...Array.from({ length: 20 }, () => rec(400))];
    expect(gate(records).pass).toBe(true);
  });
});

describe("parseJsonl", () => {
  it("ignores blank lines and discarded taps", () => {
    const text = `${JSON.stringify(rec(500))}\n\n${JSON.stringify(rec(0, "discarded"))}\r\n`;
    expect(parseJsonl(text)).toHaveLength(1);
  });
});
