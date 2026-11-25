import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedPlans } from "../../src/lib/db/seed";
import {
  dictionaryTerms,
  plans,
  sessions,
  settings,
  usageDaily,
  users,
} from "../../src/lib/db/schema";
import { startPostgres, type PgFixture } from "./helpers";

let pg: PgFixture;

beforeAll(async () => {
  pg = await startPostgres();
});

afterAll(async () => {
  await pg?.stop();
});

describe("migrations + seed", () => {
  it("seeds free plan per ADR-004", async () => {
    const [free] = await pg.handle.db.select().from(plans).where(eq(plans.id, "free"));
    expect(free).toMatchObject({
      dailyCapMinutes: 10,
      monthlyAudioMinutes: 120,
      dictionaryLimit: 25,
      allowedPresets: ["balanced", "cheapest"],
    });
  });

  it("seed is idempotent", async () => {
    await seedPlans(pg.handle.db);
    const rows = await pg.handle.db.select().from(plans);
    expect(rows.map((r) => r.id).sort()).toEqual(["free", "pro"]);
  });
});

describe("constraints", () => {
  it("rejects duplicate dictionary terms case-insensitively", async () => {
    const [u] = await pg.handle.db
      .insert(users)
      .values({ email: "dup@example.com", authProviderId: "dup-sub" })
      .returning();
    await pg.handle.db.insert(dictionaryTerms).values({ userId: u!.id, term: "Zoho" });
    await expect(
      pg.handle.db.insert(dictionaryTerms).values({ userId: u!.id, term: "zoho" }),
    ).rejects.toThrow();
  });

  it("rejects dictionary terms over 64 chars", async () => {
    const [u] = await pg.handle.db
      .insert(users)
      .values({ email: "long@example.com", authProviderId: "long-sub" })
      .returning();
    await expect(
      pg.handle.db.insert(dictionaryTerms).values({ userId: u!.id, term: "x".repeat(65) }),
    ).rejects.toThrow();
  });
});

describe("account deletion cascade (Story 5.7)", () => {
  it("deleting a user removes every user-owned row", async () => {
    const db = pg.handle.db;
    const [u] = await db
      .insert(users)
      .values({ email: "gone@example.com", authProviderId: "gone-sub" })
      .returning();
    const userId = u!.id;
    await db.insert(settings).values({ userId });
    await db.insert(dictionaryTerms).values({ userId, term: "Zia" });
    await db.insert(sessions).values({ userId, status: "completed", audioSeconds: "3.20" });
    await db
      .insert(usageDaily)
      .values({ userId, day: "2026-11-25", audioSeconds: "3.20", requests: 1 });

    await db.delete(users).where(eq(users.id, userId));

    for (const [table, col] of [
      [settings, settings.userId],
      [dictionaryTerms, dictionaryTerms.userId],
      [sessions, sessions.userId],
      [usageDaily, usageDaily.userId],
    ] as const) {
      const [{ n }] = (await db
        .select({ n: sql<number>`count(*)::int` })
        .from(table)
        .where(eq(col, userId))) as [{ n: number }];
      expect(n).toBe(0);
    }
  });
});
