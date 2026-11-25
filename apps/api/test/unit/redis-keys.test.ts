import { describe, expect, it } from "vitest";
import { keys, utcDay, utcMonth } from "../../src/lib/redis/keys";

describe("redis keys", () => {
  const u = "3f1c2a4e-8b7d-4c1a-9e2f-1a2b3c4d5e6f";

  it("buckets quota keys by UTC day and month", () => {
    // 23:30 in India (UTC+5:30) on Nov 30 is still 18:00 UTC Nov 30.
    const at = new Date("2026-11-30T18:00:00Z");
    expect(keys.quotaDay(u, at)).toBe(`quota:day:${u}:20261130`);
    expect(keys.quotaMonth(u, at)).toBe(`quota:month:${u}:202611`);
  });

  it("rolls over at UTC midnight, not local midnight", () => {
    expect(utcDay(new Date("2026-12-01T00:00:00Z"))).toBe("20261201");
    expect(utcMonth(new Date("2026-11-30T23:59:59Z"))).toBe("202611");
  });

  it("lists every per-user key pattern for deletion", () => {
    expect(keys.userPatterns(u)).toEqual([`rl:${u}`, `quota:*:${u}:*`, `settings:${u}`]);
  });
});
