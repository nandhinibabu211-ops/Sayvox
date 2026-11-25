import type { SessionStartResponse } from "@sayvox/shared";
import { describe, expect, it, vi } from "vitest";
import { TokenCache } from "./tokenCache";

const NOW = 1_800_000_000_000;
let n = 0;
const session = (expiresInMs = 15 * 60_000): SessionStartResponse => ({
  sessionId: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  streamTicket: `${String(n).padStart(43, "t")}`,
  expiresAt: new Date(NOW + expiresInMs).toISOString(),
  keyterms: [],
  languageHint: null,
  maxSessionSeconds: 300,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("TokenCache", () => {
  it("serves the pre-fetched session instantly, then refills", async () => {
    const start = vi.fn(async () => session());
    const c = new TokenCache(start, () => NOW);
    c.prefetch();
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    const s = await c.take();
    expect(s.streamTicket).toHaveLength(43);
    await flush();
    expect(start).toHaveBeenCalledTimes(2); // refilled for the next press
  });

  it("never hands out the same single-use token twice", async () => {
    const c = new TokenCache(
      vi.fn(async () => session()),
      () => NOW,
    );
    c.prefetch();
    await flush();
    const a = await c.take();
    await flush();
    const b = await c.take();
    expect(a.streamTicket).not.toBe(b.streamTicket);
  });

  it("fetches a fresh session when the cached one is about to expire", async () => {
    const start = vi.fn().mockResolvedValueOnce(session(30_000)).mockResolvedValue(session());
    const c = new TokenCache(start, () => NOW);
    c.prefetch();
    await flush();
    const s = await c.take();
    expect(Date.parse(s.expiresAt)).toBeGreaterThan(NOW + 60_000);
  });

  it("shares one in-flight request", async () => {
    const start = vi.fn(async () => session());
    const c = new TokenCache(start, () => NOW);
    c.prefetch();
    c.prefetch();
    await Promise.all([c.take(), flush()]);
    expect(start).toHaveBeenCalledTimes(2); // one shared fetch + one refill
  });

  it("a press during an in-flight prefetch claims it, and the next press gets a different token", async () => {
    const start = vi.fn(async () => session());
    const c = new TokenCache(start, () => NOW);
    c.prefetch();
    const a = await c.take(); // claims the in-flight prefetch
    await flush();
    const b = await c.take();
    expect(a.streamTicket).not.toBe(b.streamTicket);
  });

  it("surfaces errors on take but not on prefetch", async () => {
    const start = vi.fn(async () => {
      throw new Error("offline");
    });
    const c = new TokenCache(start, () => NOW);
    expect(() => c.prefetch()).not.toThrow();
    await expect(c.take()).rejects.toThrow("offline");
  });
});
