import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";
import { loadEnv } from "../../src/config/env";
import { createLogger } from "../../src/lib/logger";
import { applyCfgArgs } from "../../src/modules/config/override";
import { ConfigService } from "../../src/modules/config/service";

const env = loadEnv({
  DATABASE_URL: "postgres://x",
  REDIS_URL: "redis://x",
  GCP_PROJECT_ID: "p",
  MIN_CLIENT_VERSION: "0.2.0",
  LATEST_CLIENT_VERSION: "0.3.0",
  ROLLOUT_PERCENT: "10",
});

function app() {
  return buildApp({
    logger: createLogger({ level: "silent" }),
    clientConfig: { config: new ConfigService(env, undefined) },
  });
}

describe("GET /v1/client-config (T081)", () => {
  it("is public and says when this client must update", async () => {
    const a = app();
    const old = await a.inject({
      method: "GET",
      url: "/v1/client-config",
      headers: { "x-client-version": "0.1.9", "x-install-id": crypto.randomUUID() },
    });
    expect(old.statusCode).toBe(200);
    expect(old.json()).toMatchObject({
      minClientVersion: "0.2.0",
      latestClientVersion: "0.3.0",
      killSwitch: false,
      rolloutPercent: 10,
      updateRequired: true,
    });
    expect(old.headers["cache-control"]).toBe("private, max-age=60");
    const current = await a.inject({
      method: "GET",
      url: "/v1/client-config",
      headers: { "x-client-version": "0.2.0" },
    });
    expect(current.json().updateRequired).toBe(false);
    await a.close();
  });

  it("buckets by install id, stable across calls; junk ids aren't bucketed", async () => {
    const a = app();
    const ids = Array.from({ length: 400 }, () => crypto.randomUUID());
    const get = async (id: string) =>
      (
        await a.inject({ method: "GET", url: "/v1/client-config", headers: { "x-install-id": id } })
      ).json().inRollout as boolean;
    const first = await Promise.all(ids.map(get));
    const again = await Promise.all(ids.map(get));
    expect(again).toEqual(first);
    const share = first.filter(Boolean).length / ids.length;
    expect(share).toBeGreaterThan(0.04);
    expect(share).toBeLessThan(0.18);
    expect(await get("not-a-uuid")).toBe(false);
    await a.close();
  });

  it("omits updateRequired without a valid version header", async () => {
    const a = app();
    const res = await a.inject({
      method: "GET",
      url: "/v1/client-config",
      headers: { "x-client-version": "latest please" },
    });
    expect(res.json()).not.toHaveProperty("updateRequired");
    await a.close();
  });
});

describe("cfg:set / cfg:unset (Story 2.9)", () => {
  it("sets typed values and unsets keys", () => {
    const a = applyCfgArgs({}, "set", [
      "killSwitch=true",
      "rolloutPercent=50",
      "killSwitchMessage=Back soon",
    ]);
    expect(a).toEqual({ killSwitch: true, rolloutPercent: 50, killSwitchMessage: "Back soon" });
    expect(applyCfgArgs(a, "unset", ["killSwitch"])).toEqual({
      rolloutPercent: 50,
      killSwitchMessage: "Back soon",
    });
  });

  it("refuses unknown keys and bad values", () => {
    expect(() => applyCfgArgs({}, "set", ["killswitch=true"])).toThrow("unknown key");
    expect(() => applyCfgArgs({}, "set", ["killSwitch=yes"])).toThrow("true or false");
    expect(() => applyCfgArgs({}, "set", ["rolloutPercent=150"])).toThrow("rolloutPercent");
    expect(() => applyCfgArgs({}, "set", ["minClientVersion=latest"])).toThrow("major.minor.patch");
    expect(() => applyCfgArgs({}, "set", [])).toThrow("nothing");
  });
});
