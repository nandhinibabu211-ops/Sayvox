import { DictionaryList, SettingsResponse } from "@sayvox/shared";
import type { StartedRedisContainer } from "@testcontainers/redis";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";
import { users } from "../../src/lib/db/schema";
import { createLogger } from "../../src/lib/logger";
import { createUserResolver } from "../../src/modules/auth/users";
import { startPostgres, startRedis, type PgFixture } from "./helpers";

let pg: PgFixture;
let redisC: StartedRedisContainer;
let redis: Redis;

function app() {
  return buildApp({
    logger: createLogger({ level: "silent" }),
    auth: {
      verify: async (t) => ({ sub: t, email: `${t}@example.com`, emailVerified: true }),
      resolveUser: createUserResolver(pg.handle.db, { cacheMs: 0 }),
    },
    settings: { db: pg.handle.db, redis },
  });
}

const auth = (u: string) => ({ authorization: `Bearer ${u}` });
const SETTINGS = {
  preset: "cheapest",
  defaultMode: "prompt",
  appModeOverrides: { "slack.exe": "dictation" },
  insertMode: "review",
  languageHint: "hinglish",
  hotkey: "Ctrl+Alt",
};

beforeAll(async () => {
  [pg, redisC] = await Promise.all([startPostgres(), startRedis()]);
  redis = new Redis(redisC.getConnectionUrl());
});
afterAll(async () => {
  await redis?.quit();
  await Promise.all([pg?.stop(), redisC?.stop()]);
});
beforeEach(async () => {
  await redis.flushall();
});

describe("GET/PUT /v1/settings (T064/T065)", () => {
  it("returns defaults plus what the plan allows", async () => {
    const a = app();
    const res = await a.inject({ method: "GET", url: "/v1/settings", headers: auth("s-defaults") });
    expect(res.statusCode).toBe(200);
    const body = SettingsResponse.parse(res.json());
    expect(body).toMatchObject({
      preset: "balanced",
      defaultMode: "dictation",
      insertMode: "auto",
      languageHint: null,
      hotkey: "Ctrl+Shift",
      plan: { id: "free", allowedPresets: ["balanced", "cheapest"], dictionaryLimit: 25 },
    });
    await a.close();
  });

  it("saves every field and busts the cache", async () => {
    const a = app();
    await a.inject({ method: "GET", url: "/v1/settings", headers: auth("s-save") }); // warms cache
    const put = await a.inject({
      method: "PUT",
      url: "/v1/settings",
      headers: auth("s-save"),
      payload: SETTINGS,
    });
    expect(put.statusCode).toBe(200);
    const res = await a.inject({ method: "GET", url: "/v1/settings", headers: auth("s-save") });
    expect(res.json()).toMatchObject(SETTINGS);
    await a.close();
  });

  it("rejects a preset the plan doesn't include with 403 (shown locked in the UI)", async () => {
    const a = app();
    const res = await a.inject({
      method: "PUT",
      url: "/v1/settings",
      headers: auth("s-locked"),
      payload: { ...SETTINGS, preset: "fastest" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain("Fastest");
    await a.close();
  });

  it("paid plans may pick Fastest", async () => {
    const a = app();
    await a.inject({ method: "GET", url: "/v1/settings", headers: auth("s-pro") });
    await pg.handle.db
      .update(users)
      .set({ planId: "pro" })
      .where(eq(users.authProviderId, "s-pro"));
    const res = await a.inject({
      method: "PUT",
      url: "/v1/settings",
      headers: auth("s-pro"),
      payload: { ...SETTINGS, preset: "fastest" },
    });
    expect(res.statusCode).toBe(200);
    await a.close();
  });

  it("rejects unsupported hotkeys and language hints", async () => {
    const a = app();
    for (const bad of [{ hotkey: "Ctrl" }, { hotkey: "Ctrl+Shift+K" }, { languageHint: "xx" }]) {
      const res = await a.inject({
        method: "PUT",
        url: "/v1/settings",
        headers: auth("s-bad"),
        payload: { ...SETTINGS, ...bad },
      });
      expect(res.statusCode).toBe(400);
    }
    await a.close();
  });
});

describe("/v1/dictionary (T064/T066)", () => {
  it("adds, lists and deletes terms", async () => {
    const a = app();
    const add = await a.inject({
      method: "POST",
      url: "/v1/dictionary",
      headers: auth("d-crud"),
      payload: { term: "  Zoho  CRM " },
    });
    expect(add.statusCode).toBe(201);
    expect(add.json().term).toBe("Zoho CRM");
    await a.inject({
      method: "POST",
      url: "/v1/dictionary",
      headers: auth("d-crud"),
      payload: { term: "Zia" },
    });

    const list = DictionaryList.parse(
      (await a.inject({ method: "GET", url: "/v1/dictionary", headers: auth("d-crud") })).json(),
    );
    expect(list.terms.map((t) => t.term)).toEqual(["Zoho CRM", "Zia"]);
    expect(list.limit).toBe(25);

    const del = await a.inject({
      method: "DELETE",
      url: `/v1/dictionary/${add.json().id}`,
      headers: auth("d-crud"),
    });
    expect(del.statusCode).toBe(204);
    const after = (
      await a.inject({ method: "GET", url: "/v1/dictionary", headers: auth("d-crud") })
    ).json();
    expect(after.terms.map((t: { term: string }) => t.term)).toEqual(["Zia"]);
    await a.close();
  });

  it("rejects duplicates case-insensitively with 409", async () => {
    const a = app();
    await a.inject({
      method: "POST",
      url: "/v1/dictionary",
      headers: auth("d-dup"),
      payload: { term: "Zoho" },
    });
    const dup = await a.inject({
      method: "POST",
      url: "/v1/dictionary",
      headers: auth("d-dup"),
      payload: { term: "ZOHO" },
    });
    expect(dup.statusCode).toBe(409);
    await a.close();
  });

  it("enforces the plan limit with a clear message, even for concurrent adds", async () => {
    const a = app();
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        a.inject({
          method: "POST",
          url: "/v1/dictionary",
          headers: auth("d-limit"),
          payload: { term: `term${i}` },
        }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(25);
    const refused = results.find((r) => r.statusCode === 403)!;
    expect(refused.json().error.message).toBe("Dictionary limit reached (25 terms on your plan)");
    await a.close();
  });

  it("can't delete another user's term", async () => {
    const a = app();
    const add = await a.inject({
      method: "POST",
      url: "/v1/dictionary",
      headers: auth("d-owner"),
      payload: { term: "Secret" },
    });
    const res = await a.inject({
      method: "DELETE",
      url: `/v1/dictionary/${add.json().id}`,
      headers: auth("d-other"),
    });
    expect(res.statusCode).toBe(404);
    await a.close();
  });

  it("rejects empty and over-long terms", async () => {
    const a = app();
    for (const term of ["   ", "x".repeat(65)]) {
      const res = await a.inject({
        method: "POST",
        url: "/v1/dictionary",
        headers: auth("d-bad"),
        payload: { term },
      });
      expect(res.statusCode).toBe(400);
    }
    await a.close();
  });
});
