import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env";
import { ConfigService } from "../../src/modules/config/service";
import { compareVersions, rolloutBucket } from "../../src/modules/config/semver";

const baseEnv = {
  DATABASE_URL: "postgres://x",
  REDIS_URL: "redis://x",
  GCP_PROJECT_ID: "sayvox-app-2026",
};

/** Tiny in-memory stand-in for the two Redis calls ConfigService makes. */
function fakeRedis(store: Record<string, string>, opts: { fail?: boolean } = {}): Redis {
  return {
    get: async (k: string) => {
      if (opts.fail) throw new Error("redis down");
      return store[k] ?? null;
    },
  } as unknown as Redis;
}

describe("loadEnv", () => {
  it("applies defaults and parses preset lists", () => {
    const env = loadEnv({ ...baseEnv, PRESET_CHEAPEST: "a/x, b/y" });
    expect(env.PORT).toBe(8787);
    expect(env.KILL_SWITCH).toBe(false);
    expect(env.PRESET_CHEAPEST).toEqual(["a/x", "b/y"]);
  });

  it("names invalid variables without printing values", () => {
    expect(() => loadEnv({ ...baseEnv, PORT: "secret-value-99999999" })).toThrow(/PORT/);
    expect(() => loadEnv({ ...baseEnv, PORT: "secret-value-99999999" })).not.toThrow(
      /secret-value/,
    );
  });

  it("requires the database and redis urls", () => {
    expect(() => loadEnv({ GCP_PROJECT_ID: "p" })).toThrow(/DATABASE_URL.*REDIS_URL/);
  });
});

describe("semver + rollout", () => {
  it("compares versions", () => {
    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
  });

  it("buckets install ids stably into 0–99", () => {
    const b = rolloutBucket("install-abc");
    expect(b).toBe(rolloutBucket("install-abc"));
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(100);
  });
});

describe("ConfigService", () => {
  const env = loadEnv(baseEnv);

  it("uses env defaults when Redis has no overrides", async () => {
    const svc = new ConfigService(env, fakeRedis({}));
    const cfg = await svc.clientConfig("install-1");
    expect(cfg).toMatchObject({ killSwitch: false, minClientVersion: "0.1.0", inRollout: true });
    expect((await svc.presets()).balanced[0]).toBe(env.PRESET_BALANCED[0]);
  });

  it("applies Redis overrides for kill switch, min version and presets", async () => {
    const svc = new ConfigService(
      env,
      fakeRedis({
        "cfg:client": JSON.stringify({ killSwitch: true, minClientVersion: "0.3.0" }),
        "cfg:presets": JSON.stringify({ balanced: ["openai/gpt-6-luna"] }),
      }),
    );
    expect((await svc.clientConfig()).killSwitch).toBe(true);
    expect(await svc.isOutdated("0.2.9")).toBe(true);
    expect(await svc.isOutdated("0.3.0")).toBe(false);
    expect((await svc.presets()).balanced).toEqual(["openai/gpt-6-luna"]);
    expect((await svc.presets()).fastest).toEqual(env.PRESET_FASTEST);
  });

  it("ignores malformed overrides", async () => {
    const svc = new ConfigService(env, fakeRedis({ "cfg:client": "{not json" }));
    expect((await svc.clientConfig()).killSwitch).toBe(false);
  });

  it("falls back to env when Redis is down", async () => {
    const svc = new ConfigService(env, fakeRedis({}, { fail: true }));
    expect((await svc.clientConfig()).killSwitch).toBe(false);
  });

  it("caches overrides for cacheMs", async () => {
    const store: Record<string, string> = {};
    let t = 0;
    const svc = new ConfigService(env, fakeRedis(store), 10_000, () => t);
    expect((await svc.clientConfig()).killSwitch).toBe(false);
    store["cfg:client"] = JSON.stringify({ killSwitch: true });
    t = 5_000;
    expect((await svc.clientConfig()).killSwitch).toBe(false);
    t = 10_001;
    expect((await svc.clientConfig()).killSwitch).toBe(true);
  });

  it("uses each model's lowest reasoning effort (Gemini Flash-Lite can't turn it off)", () => {
    const svc = new ConfigService(env, fakeRedis({}));
    expect(svc.reasoningEffort("google/gemini-3.5-flash-lite")).toBe("minimal");
    expect(svc.reasoningEffort("anthropic/claude-haiku-5.5")).toBe("none");
    expect(svc.reasoningEffort("openai/gpt-6-luna")).toBe("none");
  });

  it("rejects a malformed reasoning map", () => {
    expect(() => loadEnv({ ...baseEnv, MODEL_REASONING_EFFORT: "{bad" })).toThrow(
      /MODEL_REASONING_EFFORT/,
    );
    expect(() => loadEnv({ ...baseEnv, MODEL_REASONING_EFFORT: '{"x":"extreme"}' })).toThrow(
      /MODEL_REASONING_EFFORT/,
    );
  });

  it("puts a fixed fraction of installs in a partial rollout", async () => {
    const svc = new ConfigService(
      env,
      fakeRedis({ "cfg:client": JSON.stringify({ rolloutPercent: 10 }) }),
    );
    let inside = 0;
    for (let i = 0; i < 2000; i++) if ((await svc.clientConfig(`install-${i}`)).inRollout) inside++;
    expect(inside / 2000).toBeGreaterThan(0.06);
    expect(inside / 2000).toBeLessThan(0.14);
  });
});
