import type { StartedRedisContainer } from "@testcontainers/redis";
import { eq, sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";
import {
  dictionaryTerms,
  sessions,
  settings,
  subscriptions,
  usageDaily,
  users,
} from "../../src/lib/db/schema";
import { createLogger } from "../../src/lib/logger";
import { keys } from "../../src/lib/redis/keys";
import { createUserResolver } from "../../src/modules/auth/users";
import { startPostgres, startRedis, type PgFixture } from "./helpers";

let pg: PgFixture;
let redisC: StartedRedisContainer;
let redis: Redis;

function app(opts: { identityFails?: boolean; deleted?: string[] } = {}) {
  const deleted = opts.deleted ?? [];
  let fail = opts.identityFails ?? false;
  const a = buildApp({
    logger: createLogger({ level: "silent" }),
    auth: {
      verify: async (t) => ({ sub: t, email: `${t}@example.com`, emailVerified: true }),
      resolveUser: createUserResolver(pg.handle.db, { cacheMs: 0 }),
      isDeleted: async (uid) => (await redis.exists(keys.accountDeleted(uid))) === 1,
    },
    settings: { db: pg.handle.db, redis },
    account: {
      db: pg.handle.db,
      redis,
      deleteIdentity: async (uid) => {
        if (fail) {
          fail = false;
          throw new Error("identity platform down");
        }
        deleted.push(uid);
      },
    },
  });
  return { a, deleted };
}

const auth = (u: string) => ({ authorization: `Bearer ${u}` });

async function userId(sub: string): Promise<string | undefined> {
  const [row] = await pg.handle.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.authProviderId, sub));
  return row?.id;
}

/** Rows that reference the user in every user-owned table. */
async function rowCounts(id: string) {
  const db = pg.handle.db;
  const count = async (
    t:
      | typeof settings
      | typeof dictionaryTerms
      | typeof sessions
      | typeof usageDaily
      | typeof subscriptions,
  ) =>
    (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(t)
        .where(eq(t.userId, id))
    )[0]!.n;
  return {
    users: (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(users)
        .where(eq(users.id, id))
    )[0]!.n,
    settings: await count(settings),
    dictionary: await count(dictionaryTerms),
    sessions: await count(sessions),
    usage: await count(usageDaily),
    subscriptions: await count(subscriptions),
  };
}

async function seedUser(sub: string): Promise<string> {
  const { a } = app();
  await a.inject({ method: "GET", url: "/v1/settings", headers: auth(sub) });
  await a.inject({
    method: "POST",
    url: "/v1/dictionary",
    headers: auth(sub),
    payload: { term: "Zoho" },
  });
  await a.close();
  const id = (await userId(sub))!;
  await pg.handle.db.insert(sessions).values({ userId: id, status: "completed" });
  await pg.handle.db
    .insert(usageDaily)
    .values({ userId: id, day: "2026-11-25", audioSeconds: "12" });
  await redis.set(keys.rateLimit(id), "3");
  await redis.set(keys.quotaDay(id, new Date()), "12");
  await redis.set(keys.settings(id), "{}");
  return id;
}

beforeAll(async () => {
  [pg, redisC] = await Promise.all([startPostgres(), startRedis()]);
  redis = new Redis(redisC.getConnectionUrl());
});
afterAll(async () => {
  await redis?.quit();
  await Promise.all([pg?.stop(), redisC?.stop()]);
});

describe("DELETE /v1/account (T075, Story 5.7 AC 1)", () => {
  it("removes every row and key for the user and deletes the identity", async () => {
    const id = await seedUser("acct-1");
    const other = await seedUser("acct-keep");
    const { a, deleted } = app();
    const res = await a.inject({ method: "DELETE", url: "/v1/account", headers: auth("acct-1") });
    expect(res.statusCode).toBe(204);
    expect(deleted).toEqual(["acct-1"]);
    expect(await rowCounts(id)).toEqual({
      users: 0,
      settings: 0,
      dictionary: 0,
      sessions: 0,
      usage: 0,
      subscriptions: 0,
    });
    expect(await redis.keys(`*${id}*`)).toEqual([]);
    // Someone else's data is untouched.
    expect((await rowCounts(other)).dictionary).toBe(1);
    expect(await redis.exists(keys.settings(other))).toBe(1);
    await a.close();
  });

  it("a still-valid token can't recreate the account afterwards", async () => {
    await seedUser("acct-2");
    const { a } = app();
    await a.inject({ method: "DELETE", url: "/v1/account", headers: auth("acct-2") });
    const res = await a.inject({ method: "GET", url: "/v1/settings", headers: auth("acct-2") });
    expect(res.statusCode).toBe(401);
    expect(await userId("acct-2")).toBeUndefined();
    await a.close();
  });

  it("is resumable: a failed step can be retried with the same token", async () => {
    const id = await seedUser("acct-3");
    const { a, deleted } = app({ identityFails: true });
    const first = await a.inject({ method: "DELETE", url: "/v1/account", headers: auth("acct-3") });
    expect(first.statusCode).toBe(500);
    expect((await rowCounts(id)).users).toBe(1); // nothing half-deleted in the DB
    const retry = await a.inject({ method: "DELETE", url: "/v1/account", headers: auth("acct-3") });
    expect(retry.statusCode).toBe(204);
    expect(deleted).toEqual(["acct-3"]);
    expect(await userId("acct-3")).toBeUndefined();
    await a.close();
  });

  it("refuses while a paid subscription is live and no billing client can cancel it", async () => {
    const id = await seedUser("acct-4");
    await pg.handle.db
      .insert(subscriptions)
      .values({ userId: id, providerSubId: "sub_live_1", status: "active", planId: "pro" });
    const { a, deleted } = app();
    const res = await a.inject({ method: "DELETE", url: "/v1/account", headers: auth("acct-4") });
    expect(res.statusCode).toBe(409);
    expect(deleted).toEqual([]);
    expect((await rowCounts(id)).users).toBe(1);
    await a.close();
  });
});
