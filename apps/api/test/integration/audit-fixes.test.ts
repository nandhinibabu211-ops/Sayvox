import type { StartedRedisContainer } from "@testcontainers/redis";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { users } from "../../src/lib/db/schema";
import { createUserResolver } from "../../src/modules/auth/users";
import { claimRewrite } from "../../src/modules/limits/store";
import { startPostgres, startRedis, type PgFixture } from "./helpers";

// Regression tests for bugs found in the production-readiness audit (docs/audit).

let pg: PgFixture;
let redisContainer: StartedRedisContainer;
let redis: Redis;

beforeAll(async () => {
  [pg, redisContainer] = await Promise.all([startPostgres(), startRedis()]);
  redis = new Redis(redisContainer.getConnectionUrl());
}, 120_000);

afterAll(async () => {
  redis.disconnect();
  await Promise.all([pg.stop(), redisContainer.stop()]);
});

describe("two identities with the same email (audit SEC-02)", () => {
  it("both sign in: users are keyed by uid, not email", async () => {
    const resolve = createUserResolver(pg.handle.db, { cacheMs: 0 });
    const a = await resolve({
      sub: "uid-password",
      email: "same@example.com",
      emailVerified: false,
    });
    const b = await resolve({ sub: "uid-google", email: "same@example.com", emailVerified: true });
    expect(a.id).not.toBe(b.id);
    const rows = await pg.handle.db.select().from(users).where(eq(users.email, "same@example.com"));
    expect(rows).toHaveLength(2);
  });

  it("an email change to one another account uses still signs in", async () => {
    const resolve = createUserResolver(pg.handle.db, { cacheMs: 0 });
    await resolve({ sub: "uid-x", email: "x@example.com", emailVerified: true });
    await resolve({ sub: "uid-y", email: "y@example.com", emailVerified: true });
    const moved = await resolve({ sub: "uid-y", email: "x@example.com", emailVerified: true });
    expect(moved.email).toBe("x@example.com");
  });
});

describe("rewrite cap per session (audit SEC-01)", () => {
  it("allows two rewrites per session, then refuses, with a TTL", async () => {
    const id = "3f1c2a4e-8b7d-4c1a-9e2f-1a2b3c4d5e6f";
    expect(await claimRewrite(redis, id)).toBe(true);
    expect(await claimRewrite(redis, id)).toBe(true);
    expect(await claimRewrite(redis, id)).toBe(false);
    expect(await redis.ttl(`rw:${id}`)).toBeGreaterThan(0);
    expect(await claimRewrite(redis, "00000000-0000-4000-8000-000000000000")).toBe(true);
  });
});
