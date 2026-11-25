import { ErrorEnvelope, SessionStartResponse } from "@sayvox/shared";
import type { StartedRedisContainer } from "@testcontainers/redis";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app";
import { loadEnv } from "../../src/config/env";
import { dictionaryTerms, sessions, settings, usageDaily, users } from "../../src/lib/db/schema";
import { ProviderError } from "../../src/lib/elevenlabs/token";
import { createLogger } from "../../src/lib/logger";
import { createUserResolver } from "../../src/modules/auth/users";
import { ConfigService } from "../../src/modules/config/service";
import { sweepAbandonedSessions } from "../../src/modules/session/sweeper";
import { startPostgres, startRedis, type PgFixture } from "./helpers";

let pg: PgFixture;
let redisC: StartedRedisContainer;
let redis: Redis;
let clock = new Date("2026-11-25T10:00:00Z");
const mintToken = vi.fn(async ({ maxSessionSeconds }: { maxSessionSeconds: number }) => ({
  token: `sutkn_${maxSessionSeconds}`,
  expiresAt: new Date(clock.getTime() + 15 * 60_000),
}));

function app(opts: { killSwitch?: boolean; rate?: number } = {}) {
  const env = loadEnv({
    DATABASE_URL: "x",
    REDIS_URL: "x",
    GCP_PROJECT_ID: "p",
    MIN_CLIENT_VERSION: "0.2.0",
    KILL_SWITCH: opts.killSwitch ? "true" : "false",
  });
  return buildApp({
    logger: createLogger({ level: "silent" }),
    // Test identity: the bearer token *is* the user id at the identity provider.
    auth: {
      verify: async (t) => ({ sub: t, email: `${t}@example.com`, emailVerified: true }),
      resolveUser: createUserResolver(pg.handle.db, { cacheMs: 0 }),
    },
    session: {
      db: pg.handle.db,
      redis,
      config: new ConfigService(env, redis, 0),
      mintToken,
      region: "us-east4",
      ...(opts.rate ? { rateLimitPerMinute: opts.rate } : {}),
      now: () => clock,
    },
  });
}

const start = (a: ReturnType<typeof app>, user: string, version = "0.3.0") =>
  a.inject({
    method: "POST",
    url: "/v1/session/start",
    headers: { authorization: `Bearer ${user}`, "x-client-version": version },
    payload: {},
  });

const end = (a: ReturnType<typeof app>, user: string, id: string, payload: object) =>
  a.inject({
    method: "POST",
    url: `/v1/session/${id}/end`,
    headers: { authorization: `Bearer ${user}` },
    payload,
  });

const endBody = (audioSeconds: number, insertResult = "inserted") => ({
  audioSeconds,
  insertResult,
  mode: "dictation",
  targetApp: "notepad.exe",
  timings: { sttCommitMs: 210, releaseToInsertMs: 640 },
});

async function userId(sub: string): Promise<string> {
  const [u] = await pg.handle.db.select().from(users).where(eq(users.authProviderId, sub));
  return u!.id;
}

beforeAll(async () => {
  [pg, redisC] = await Promise.all([startPostgres(), startRedis()]);
  redis = new Redis(redisC.getConnectionUrl());
});

afterAll(async () => {
  await redis?.quit();
  await Promise.all([pg?.stop(), redisC?.stop()]);
});

beforeEach(async () => {
  clock = new Date("2026-11-25T10:00:00Z");
  mintToken.mockClear();
  await redis.flushall();
});

describe("POST /v1/session/start (T022)", () => {
  it("creates a session and returns a single-use token, keyterms and language hint", async () => {
    const a = app();
    await start(a, "u-start"); // creates the user
    const uid = await userId("u-start");
    await pg.handle.db
      .update(settings)
      .set({ languageHint: "en-IN" })
      .where(eq(settings.userId, uid));
    await pg.handle.db.insert(dictionaryTerms).values([
      { userId: uid, term: "Zoho", createdAt: new Date("2026-11-01") },
      { userId: uid, term: "Zia", createdAt: new Date("2026-11-02") },
    ]);

    const res = await start(a, "u-start");
    expect(res.statusCode).toBe(200);
    const body = SessionStartResponse.parse(res.json());
    expect(body).toMatchObject({
      scribeToken: "sutkn_300",
      keyterms: ["Zia", "Zoho"],
      languageHint: "en-IN",
      maxSessionSeconds: 300,
    });
    const [row] = await pg.handle.db.select().from(sessions).where(eq(sessions.id, body.sessionId));
    expect(row).toMatchObject({ status: "started", keytermsUsed: true, region: "us-east4" });
    await a.close();
  });

  it("caps the session at the remaining daily quota", async () => {
    const a = app();
    await start(a, "u-near-cap");
    const uid = await userId("u-near-cap");
    await pg.handle.db
      .insert(usageDaily)
      .values({ userId: uid, day: "2026-11-25", audioSeconds: "590.00", requests: 50 });
    await redis.flushall(); // force rebuild from Postgres
    const res = await start(a, "u-near-cap");
    expect(res.json().maxSessionSeconds).toBe(10);
    expect(mintToken).toHaveBeenLastCalledWith({ maxSessionSeconds: 10 });
    await a.close();
  });

  it("returns 402 QUOTA_EXCEEDED with resetAt at the daily cap", async () => {
    const a = app();
    await start(a, "u-capped");
    const uid = await userId("u-capped");
    await pg.handle.db
      .insert(usageDaily)
      .values({ userId: uid, day: "2026-11-25", audioSeconds: "600.00", requests: 60 });
    await redis.flushall();
    const res = await start(a, "u-capped");
    expect(res.statusCode).toBe(402);
    expect(ErrorEnvelope.parse(res.json()).error).toMatchObject({
      code: "QUOTA_EXCEEDED",
      resetAt: "2026-11-26T00:00:00.000Z",
    });
    await a.close();
  });

  it("rate limits with 429 and retry-after", async () => {
    const a = app({ rate: 2 });
    expect((await start(a, "u-rate")).statusCode).toBe(200);
    expect((await start(a, "u-rate")).statusCode).toBe(200);
    const res = await start(a, "u-rate");
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    await a.close();
  });

  it("returns 503 KILL_SWITCH when paused", async () => {
    const a = app({ killSwitch: true });
    const res = await start(a, "u-kill");
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("KILL_SWITCH");
    await a.close();
  });

  it("returns 426 CLIENT_OUTDATED below the minimum version", async () => {
    const a = app();
    const res = await start(a, "u-old", "0.1.9");
    expect(res.statusCode).toBe(426);
    expect(res.json().error.code).toBe("CLIENT_OUTDATED");
    await a.close();
  });

  it("returns 503 PROVIDER_UNAVAILABLE when ElevenLabs fails", async () => {
    const a = app();
    mintToken.mockRejectedValueOnce(new ProviderError("elevenlabs", 500));
    const res = await start(a, "u-provider");
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("PROVIDER_UNAVAILABLE");
    await a.close();
  });

  it("requires auth", async () => {
    const a = app();
    const res = await a.inject({ method: "POST", url: "/v1/session/start", payload: {} });
    expect(res.statusCode).toBe(401);
    await a.close();
  });
});

describe("POST /v1/session/:id/end (T023)", () => {
  it("closes the session, records usage and counts against quota", async () => {
    const a = app();
    const { sessionId } = (await start(a, "u-end")).json();
    clock = new Date(clock.getTime() + 8_000);
    const res = await end(a, "u-end", sessionId, endBody(4.2));
    expect(res.statusCode).toBe(204);

    const [row] = await pg.handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row).toMatchObject({
      status: "completed",
      audioSeconds: "4.20",
      releaseToInsertMs: 640,
      targetApp: "notepad.exe",
    });
    const uid = await userId("u-end");
    const [usage] = await pg.handle.db.select().from(usageDaily).where(eq(usageDaily.userId, uid));
    expect(usage).toMatchObject({ audioSeconds: "4.20", requests: 1 });
    await a.close();
  });

  it("clamps audio seconds to wall-clock time since start", async () => {
    const a = app();
    const { sessionId } = (await start(a, "u-clamp")).json();
    clock = new Date(clock.getTime() + 3_000);
    await end(a, "u-clamp", sessionId, endBody(250));
    const [row] = await pg.handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row!.audioSeconds).toBe("3.00");
    await a.close();
  });

  it("is idempotent: a repeated end changes nothing", async () => {
    const a = app();
    const { sessionId } = (await start(a, "u-idem")).json();
    clock = new Date(clock.getTime() + 10_000);
    expect((await end(a, "u-idem", sessionId, endBody(5))).statusCode).toBe(204);
    expect((await end(a, "u-idem", sessionId, endBody(5, "failed"))).statusCode).toBe(204);
    const uid = await userId("u-idem");
    const [usage] = await pg.handle.db.select().from(usageDaily).where(eq(usageDaily.userId, uid));
    expect(usage).toMatchObject({ audioSeconds: "5.00", requests: 1 });
    const [row] = await pg.handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row!.status).toBe("completed");
    await a.close();
  });

  it("returns 404 for another user's session", async () => {
    const a = app();
    const { sessionId } = (await start(a, "u-owner")).json();
    const res = await end(a, "u-intruder", sessionId, endBody(1));
    expect(res.statusCode).toBe(404);
    await a.close();
  });

  it("rejects bodies without timings", async () => {
    const a = app();
    const { sessionId } = (await start(a, "u-bad")).json();
    const res = await end(a, "u-bad", sessionId, { audioSeconds: 1, insertResult: "inserted" });
    expect(res.statusCode).toBe(400);
    await a.close();
  });
});

describe("abandoned-session sweeper (T033)", () => {
  it("marks unused pre-fetched sessions abandoned after token TTL + max session", async () => {
    const a = app();
    const { sessionId } = (await start(a, "u-sweep")).json();
    expect(
      await sweepAbandonedSessions(pg.handle.db, new Date(clock.getTime() + 10 * 60_000)),
    ).toBe(0);
    const n = await sweepAbandonedSessions(pg.handle.db, new Date(clock.getTime() + 21 * 60_000));
    expect(n).toBeGreaterThanOrEqual(1);
    const [row] = await pg.handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row!.status).toBe("abandoned");
    await a.close();
  });
});
