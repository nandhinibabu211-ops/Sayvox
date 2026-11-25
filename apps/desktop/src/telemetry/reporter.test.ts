import { TelemetryBatch } from "@sayvox/shared";
import { describe, expect, it } from "vitest";
import { errorCodeOf, MAX_QUEUE, TelemetryReporter } from "./reporter";

function harness(opts: { signedIn?: boolean; fail?: boolean } = {}) {
  const sent: TelemetryBatch[] = [];
  const timers: (() => void)[] = [];
  const r = new TelemetryReporter({
    send: async (b) => {
      if (opts.fail) throw new TypeError("offline");
      sent.push(b);
    },
    signedIn: async () => opts.signedIn ?? true,
    clientVersion: "0.1.0",
    os: () => "windows11",
    now: () => new Date("2026-11-25T10:00:00Z"),
    setTimer: (fn) => timers.push(fn),
  });
  return { r, sent, timers };
}

describe("TelemetryReporter (T076)", () => {
  it("sends a crash with a code and scrubbed stack, never the message", async () => {
    const { r, sent, timers } = harness();
    const err = new TypeError("could not paste 'meet priya on friday'");
    err.stack = `TypeError: could not paste 'meet priya on friday'\n    at insert (pipeline.ts:9:3)`;
    r.crash(err, "insert");
    timers[0]!();
    await new Promise((res) => setTimeout(res, 0));
    expect(sent).toHaveLength(1);
    const batch = TelemetryBatch.parse(sent[0]); // the server schema accepts it
    expect(batch.items[0]).toMatchObject({
      kind: "crash",
      errorCode: "TYPE_ERROR",
      module: "insert",
      stack: "TypeError\nat insert (pipeline.ts:9:3)",
    });
    expect(JSON.stringify(sent)).not.toContain("priya");
  });

  it("deduplicates repeated crashes and sends in batches of at most 50", async () => {
    const { r, sent } = harness();
    const err = new Error("x");
    for (let i = 0; i < 5; i++) r.crash(err);
    for (let i = 0; i < MAX_QUEUE + 10; i++) r.event("quota_hit");
    await r.flush();
    await new Promise((res) => setTimeout(res, 0));
    for (const b of sent) expect(b.items.length).toBeLessThanOrEqual(MAX_QUEUE);
    expect(sent.flatMap((b) => b.items).filter((i) => i.kind === "crash")).toHaveLength(1);
  });

  it("sends nothing when signed out, and swallows network errors", async () => {
    const out = harness({ signedIn: false });
    out.r.event("dictation_started");
    await out.r.flush();
    expect(out.sent).toEqual([]);
    const off = harness({ fail: true });
    off.r.event("dictation_started");
    await expect(off.r.flush()).resolves.toBeUndefined();
  });

  it("maps error names to codes", () => {
    expect(errorCodeOf(new TypeError("x"))).toBe("TYPE_ERROR");
    expect(errorCodeOf(new DOMException("x", "NotAllowedError"))).toBe("NOT_ALLOWED_ERROR");
    expect(errorCodeOf("boom")).toBe("STRING");
    expect(errorCodeOf(undefined)).toBe("UNDEFINED");
  });
});
