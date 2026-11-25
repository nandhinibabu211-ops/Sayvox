import { describe, expect, it, vi } from "vitest";
import { lastWeek, providerSttMinutes, reconcile } from "../../src/jobs/reconcile";
import { checkSpend, spendWindow } from "../../src/jobs/spend";

const NOW = new Date("2026-11-25T09:30:00Z");

describe("reconcile (T096)", () => {
  const w = lastWeek(NOW);

  it("covers the 7 full UTC days before today", () => {
    expect(w.from.toISOString()).toBe("2026-11-18T00:00:00.000Z");
    expect(w.to.toISOString()).toBe("2026-11-25T00:00:00.000Z");
  });

  it("is ok within 5 %, drift beyond, unknown without a provider figure", () => {
    expect(reconcile(w, 600 * 60, 620)).toMatchObject({
      recordedMinutes: 600,
      driftPct: 3.2,
      status: "ok",
    });
    expect(reconcile(w, 500 * 60, 600)).toMatchObject({ driftPct: 16.7, status: "drift" });
    expect(reconcile(w, 700 * 60, 600)).toMatchObject({ status: "drift" });
    expect(reconcile(w, 60, null)).toMatchObject({
      providerMinutes: null,
      driftPct: null,
      status: "unknown",
    });
    expect(reconcile(w, 0, 0)).toMatchObject({ driftPct: 0, status: "ok" });
  });

  it("reads the speech-to-text series from ElevenLabs usage stats", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ time: [1], usage: { text_to_speech: [9], speech_to_text: [400, 20.5] } }),
    );
    const minutes = await providerSttMinutes({ apiKey: "k", window: w, fetchFn });
    expect(minutes).toBe(420.5);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("metric=minutes_used");
    expect(url).toContain(`start_unix=${w.from.getTime()}`);
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("k");
  });

  it("returns null when there is no STT series or the call fails", async () => {
    const none = vi.fn(async () => Response.json({ usage: { All: [5] } }));
    expect(await providerSttMinutes({ apiKey: "k", window: w, fetchFn: none })).toBeNull();
    const fail = vi.fn(async () => new Response("", { status: 422 }));
    expect(await providerSttMinutes({ apiKey: "k", window: w, fetchFn: fail })).toBeNull();
  });
});

describe("daily spend check (T097)", () => {
  const days = (yesterday: number, prev: number) =>
    new Map([
      ["2026-11-24", yesterday],
      ...[17, 18, 19, 20, 21, 22, 23].map((d) => [`2026-11-${d}`, prev] as [string, number]),
    ]);

  it("uses yesterday and the 7 days before it", () => {
    const w = spendWindow(NOW);
    expect(w.from.toISOString().slice(0, 10)).toBe("2026-11-17");
    expect(w.to.toISOString().slice(0, 10)).toBe("2026-11-25");
  });

  it("alerts above 2x the 7-day average", () => {
    expect(checkSpend(NOW, days(9, 4))).toMatchObject({
      spendUsd: 9,
      avg7Usd: 4,
      ratio: 2.25,
      alert: true,
    });
    expect(checkSpend(NOW, days(7, 4))).toMatchObject({ alert: false });
  });

  it("stays quiet under the floor and on the first day of data", () => {
    expect(checkSpend(NOW, days(0.5, 0.1))).toMatchObject({ alert: false });
    expect(checkSpend(NOW, new Map([["2026-11-24", 3]]))).toMatchObject({
      ratio: null,
      alert: true,
    });
  });
});
