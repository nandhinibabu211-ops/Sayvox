import { describe, expect, it } from "vitest";
import { REVIEW_TIMEOUT_MS, ReviewGate } from "./review";

function gate() {
  const capture: boolean[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const g = new ReviewGate({
    captureKeys: (a) => capture.push(a),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => void ((h as { cleared: boolean }).cleared = true),
  });
  return { g, capture, timers };
}

describe("ReviewGate (T071)", () => {
  it("captures Enter/Esc only while open", async () => {
    const { g, capture, timers } = gate();
    const p = g.wait();
    expect(g.active).toBe(true);
    expect(capture).toEqual([true]);
    g.decide("insert");
    await expect(p).resolves.toBe("insert");
    expect(capture).toEqual([true, false]);
    expect(timers[0]!.cleared).toBe(true);
    expect(g.active).toBe(false);
  });

  it("discards after the timeout", async () => {
    const { g, capture, timers } = gate();
    const p = g.wait();
    expect(timers[0]!.ms).toBe(REVIEW_TIMEOUT_MS);
    timers[0]!.fn();
    await expect(p).resolves.toBe("discard");
    expect(capture).toEqual([true, false]);
  });

  it("only the first decision counts", async () => {
    const { g, capture } = gate();
    const p = g.wait();
    g.decide("discard");
    g.decide("insert");
    await expect(p).resolves.toBe("discard");
    expect(capture).toEqual([true, false]);
  });

  it("a new review discards the open one", async () => {
    const { g } = gate();
    const first = g.wait();
    const second = g.wait();
    await expect(first).resolves.toBe("discard");
    g.decide("insert");
    await expect(second).resolves.toBe("insert");
  });
});
