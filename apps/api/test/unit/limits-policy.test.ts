import { describe, expect, it } from "vitest";
import {
  capKeyterms,
  decideQuota,
  MAX_SESSION_SECONDS,
  sttCostUsd,
} from "../../src/modules/limits/policy";

const FREE = { dailyCapMinutes: 10, monthlyAudioMinutes: 120 };
const AT = new Date("2026-11-25T18:30:00Z");

describe("decideQuota", () => {
  it("allows a full-length session with plenty left", () => {
    expect(decideQuota(FREE, { day: 0, month: 0 }, AT)).toEqual({
      ok: true,
      maxSessionSeconds: MAX_SESSION_SECONDS,
    });
  });

  it("caps the session at what's left today", () => {
    expect(decideQuota(FREE, { day: 600 - 42.5, month: 1_000 }, AT)).toEqual({
      ok: true,
      maxSessionSeconds: 42,
    });
  });

  it("refuses at the daily cap with a reset at the next UTC midnight", () => {
    expect(decideQuota(FREE, { day: 600, month: 600 }, AT)).toEqual({
      ok: false,
      scope: "day",
      resetAt: new Date("2026-11-26T00:00:00Z"),
    });
  });

  it("monthly cap wins over daily, resetting on the 1st", () => {
    expect(decideQuota(FREE, { day: 0, month: 7_200 }, AT)).toEqual({
      ok: false,
      scope: "month",
      resetAt: new Date("2026-12-01T00:00:00Z"),
    });
  });

  it("treats under one second left as exhausted", () => {
    expect(decideQuota(FREE, { day: 599.5, month: 0 }, AT).ok).toBe(false);
  });
});

describe("capKeyterms", () => {
  it("keeps at most 100 terms", () => {
    const terms = Array.from({ length: 150 }, (_, i) => `t${i}`);
    expect(capKeyterms(terms)).toHaveLength(100);
    expect(capKeyterms(terms)[0]).toBe("t0");
  });

  it("keeps the total under 1 000 characters, skipping terms that don't fit", () => {
    const terms = ["x".repeat(600), "y".repeat(500), "z".repeat(300), "Zoho"];
    const out = capKeyterms(terms);
    expect(out).toEqual(["x".repeat(600), "z".repeat(300), "Zoho"]);
    expect(out.join("").length).toBeLessThanOrEqual(1_000);
  });
});

describe("sttCostUsd", () => {
  it("charges $0.22/h, plus $0.08/h with keyterms", () => {
    expect(sttCostUsd(3600, false)).toBe(0.22);
    expect(sttCostUsd(3600, true)).toBe(0.3);
    expect(sttCostUsd(18, false)).toBe(0.0011);
  });
});
