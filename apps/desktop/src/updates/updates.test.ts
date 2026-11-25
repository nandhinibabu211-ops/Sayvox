import type { ClientConfig } from "@sayvox/shared";
import { describe, expect, it } from "vitest";
import {
  CLIENT_CONFIG_CACHE_KEY,
  ClientConfigWatcher,
  gateOf,
  POLL_MS,
  trayText,
} from "./clientConfig";
import { AUTO_INSTALL_IDLE_MS, UpdateController, type CheckResult } from "./updater";

const CFG: ClientConfig = {
  minClientVersion: "0.1.0",
  latestClientVersion: "0.2.0",
  killSwitch: false,
  rolloutPercent: 10,
  inRollout: true,
  updateRequired: false,
};

function memory(init: Record<string, string> = {}) {
  const data = { ...init };
  return {
    data,
    get: (k: string) => data[k] ?? null,
    set: (k: string, v: string) => void (data[k] = v),
  };
}

describe("service gate (T081)", () => {
  it("kill switch wins over a forced update", () => {
    expect(gateOf(null)).toEqual({ kind: "ok" });
    expect(gateOf({ ...CFG, updateRequired: true })).toEqual({
      kind: "updateRequired",
      minVersion: "0.1.0",
    });
    expect(
      gateOf({ ...CFG, updateRequired: true, killSwitch: true, killSwitchMessage: "Back at 3pm" }),
    ).toEqual({ kind: "paused", message: "Back at 3pm" });
    expect(trayText({ kind: "paused", message: "Back at 3pm" }, "Ctrl + Shift")).toContain(
      "paused",
    );
    expect(trayText({ kind: "ok" }, "Ctrl + Alt")).toBe("Sayvox: hold Ctrl + Alt to dictate");
  });
});

describe("ClientConfigWatcher (T081)", () => {
  it("starts from the cache so an offline restart still honours the kill switch", () => {
    const storage = memory({
      [CLIENT_CONFIG_CACHE_KEY]: JSON.stringify({ ...CFG, killSwitch: true }),
    });
    const w = new ClientConfigWatcher({ fetchConfig: async () => CFG, storage });
    expect(w.gate.kind).toBe("paused");
  });

  it("caches fresh config, keeps the last one when offline", async () => {
    const storage = memory();
    let online = true;
    const w = new ClientConfigWatcher({
      fetchConfig: async () => {
        if (!online) throw new TypeError("offline");
        return CFG;
      },
      storage,
    });
    const seen: ClientConfig[] = [];
    w.subscribe((c) => seen.push(c));
    await w.poll();
    online = false;
    await w.poll();
    expect(w.current).toEqual(CFG);
    expect(seen).toHaveLength(1);
    expect(JSON.parse(storage.data[CLIENT_CONFIG_CACHE_KEY]!)).toEqual(CFG);
  });

  it("polls every 30 min and right after a wake from sleep", async () => {
    let t = 0;
    let polls = 0;
    const w = new ClientConfigWatcher({
      fetchConfig: async () => {
        polls++;
        return CFG;
      },
      storage: memory(),
      now: () => t,
      setInterval: () => 0,
    });
    w.start();
    expect(polls).toBe(1);
    for (let i = 1; i <= 29; i++) {
      t = i * 60_000;
      w.tick();
    }
    expect(polls).toBe(1);
    t = POLL_MS;
    w.tick();
    expect(polls).toBe(2);
    t += 2 * 3600_000; // laptop slept for two hours: next tick is late
    w.tick();
    expect(polls).toBe(3);
  });
});

function controller(check: CheckResult, idleMs = Infinity) {
  const calls: string[] = [];
  const states: string[] = [];
  const c = new UpdateController({
    check: async () => {
      calls.push("check");
      return check;
    },
    download: async () => void calls.push("download"),
    install: async () => void calls.push("install"),
    idleMs: () => idleMs,
    onState: (s) => states.push(s.kind),
  });
  return { c, calls, states };
}

describe("UpdateController (T082)", () => {
  it("doesn't check outside the rollout", async () => {
    const { c, calls } = controller({ status: "available", version: "0.2.0" });
    await c.onConfig({ ...CFG, inRollout: false });
    expect(calls).toEqual([]);
  });

  it("checks when forced even outside the rollout, but never auto-installs then", async () => {
    const { c, calls, states } = controller({ status: "available", version: "0.2.0" });
    await c.onConfig({ ...CFG, inRollout: false, updateRequired: true });
    expect(calls).toEqual(["check", "download"]);
    expect(states).toEqual(["downloading", "ready"]);
    expect(await c.maybeInstall()).toBe(false);
  });

  it("downloads in the background and installs only after 10 idle minutes", async () => {
    let idle = 60_000;
    const calls: string[] = [];
    const c = new UpdateController({
      check: async () => ({ status: "available", version: "0.2.0" }),
      download: async () => void calls.push("download"),
      install: async () => void calls.push("install"),
      idleMs: () => idle,
    });
    await c.onConfig(CFG);
    expect(c.current).toEqual({ kind: "ready", version: "0.2.0" });
    expect(await c.maybeInstall()).toBe(false);
    idle = AUTO_INSTALL_IDLE_MS;
    expect(await c.maybeInstall()).toBe(true);
    expect(calls).toEqual(["download", "install"]);
  });

  it("doesn't re-download a version that's already ready", async () => {
    const { c, calls } = controller({ status: "available", version: "0.2.0" }, 0);
    await c.onConfig(CFG);
    await c.onConfig(CFG);
    expect(calls).toEqual(["check", "download", "check"]);
  });

  it("stops checking in builds without an updater key", async () => {
    const { c, calls } = controller({ status: "notConfigured" });
    await c.onConfig(CFG);
    await c.onConfig(CFG);
    expect(calls).toEqual(["check"]);
    expect(c.current.kind).toBe("notConfigured");
  });

  it("reports failures without throwing", async () => {
    const c = new UpdateController({
      check: async () => {
        throw new Error("network");
      },
      download: async () => {},
      install: async () => {},
      idleMs: () => Infinity,
    });
    await expect(c.onConfig(CFG)).resolves.toBeUndefined();
    expect(c.current.kind).toBe("failed");
  });
});
