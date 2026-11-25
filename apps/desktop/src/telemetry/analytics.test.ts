import { describe, expect, it, vi } from "vitest";
import { ProductAnalytics } from "./analytics";

function setup() {
  let t = 1_000;
  const emit = vi.fn();
  const a = new ProductAnalytics(emit, () => t);
  return { a, emit, tick: (ms: number) => (t += ms) };
}

describe("product analytics (T093)", () => {
  it("emits started once per press and inserted with mode and duration", () => {
    const { a, emit, tick } = setup();
    a.observe({ kind: "listening", partial: "", mode: "prompt" });
    a.observe({ kind: "listening", partial: "secret words", mode: "prompt" });
    tick(2_400);
    a.observe({ kind: "rewriting", text: "secret", mode: "prompt" });
    a.observe({ kind: "inserted", text: "secret" });
    expect(emit.mock.calls).toEqual([
      ["dictation_started", { mode: "prompt" }],
      ["dictation_inserted", { mode: "prompt", durationMs: 2_400 }],
    ]);
  });

  it("reports a mode switch, a raw fallback and a quota hit", () => {
    const { a, emit } = setup();
    a.observe({ kind: "listening", partial: "", mode: "dictation" });
    a.observe({ kind: "listening", partial: "x", mode: "email" });
    a.observe({ kind: "inserted", text: "x", notice: "AI rewrite failed" });
    a.observe({ kind: "listening", partial: "", mode: "dictation" });
    a.observe({ kind: "error", message: "Daily limit reached.", action: "upgrade" });
    expect(emit.mock.calls.map((c) => c[0])).toEqual([
      "dictation_started",
      "mode_changed",
      "dictation_inserted",
      "fallback_used",
      "dictation_started",
      "quota_hit",
    ]);
  });

  it("never passes text along", () => {
    const { a, emit } = setup();
    a.observe({ kind: "listening", partial: "my password is hunter2", mode: "dictation" });
    a.observe({ kind: "inserted", text: "my password is hunter2" });
    expect(JSON.stringify(emit.mock.calls)).not.toContain("hunter2");
  });

  it("starts fresh after a discarded or blocked press", () => {
    const { a, emit } = setup();
    a.observe({ kind: "listening", partial: "", mode: "dictation" });
    a.observe({ kind: "hidden" });
    a.observe({ kind: "listening", partial: "", mode: "dictation" });
    expect(emit.mock.calls.filter((c) => c[0] === "dictation_started")).toHaveLength(2);
  });
});
