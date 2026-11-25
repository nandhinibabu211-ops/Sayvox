import type { Settings, SettingsResponse } from "@sayvox/shared";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./apiClient";
import {
  SETTINGS_CACHE_KEY,
  SettingsStore,
  type KeyValue,
  type SettingsApi,
} from "./settingsStore";

const BASE: SettingsResponse = {
  preset: "balanced",
  defaultMode: "dictation",
  appModeOverrides: {},
  insertMode: "auto",
  languageHint: null,
  hotkey: "Ctrl+Shift",
  plan: { id: "free", allowedPresets: ["balanced", "cheapest"], dictionaryLimit: 25 },
};

function memory(init: Record<string, string> = {}): KeyValue & { data: Record<string, string> } {
  const data = { ...init };
  return { data, get: (k) => data[k] ?? null, set: (k, v) => void (data[k] = v) };
}

function fakeApi(opts: { reject?: (s: Settings) => boolean } = {}) {
  let server: SettingsResponse = BASE;
  const puts: Settings[] = [];
  let release: (() => void)[] = [];
  const api: SettingsApi & { puts: Settings[]; hold: boolean; flush: () => void } = {
    puts,
    hold: false,
    flush: () => {
      const r = release;
      release = [];
      r.forEach((f) => f());
    },
    get: async () => server,
    put: async (s) => {
      puts.push(s);
      if (api.hold) await new Promise<void>((r) => release.push(r));
      if (opts.reject?.(s)) throw new ApiError(403, "FORBIDDEN", "Not in your plan");
      server = { ...s, plan: server.plan };
      return server;
    },
  };
  return api;
}

describe("SettingsStore (Story 2.6 AC 2)", () => {
  it("starts from the cache, then hydrates from the server", async () => {
    const cached = { ...BASE, hotkey: "Ctrl+Alt" };
    const storage = memory({ [SETTINGS_CACHE_KEY]: JSON.stringify(cached) });
    const store = new SettingsStore(fakeApi(), storage);
    expect(store.current?.hotkey).toBe("Ctrl+Alt");
    await store.load();
    expect(store.current?.hotkey).toBe("Ctrl+Shift");
    expect(JSON.parse(storage.data[SETTINGS_CACHE_KEY]!).hotkey).toBe("Ctrl+Shift");
  });

  it("ignores a corrupt cache", () => {
    const store = new SettingsStore(fakeApi(), memory({ [SETTINGS_CACHE_KEY]: "{nope" }));
    expect(store.current).toBeNull();
  });

  it("applies changes at once and sends only the settings fields", async () => {
    const api = fakeApi();
    const store = new SettingsStore(api, memory());
    await store.load();
    const seen: string[] = [];
    store.subscribe((s) => seen.push(s.insertMode));
    const p = store.update({ insertMode: "review" });
    expect(store.current?.insertMode).toBe("review");
    await p;
    expect(api.puts[0]).not.toHaveProperty("plan");
    expect(seen).toEqual(["review", "review"]);
  });

  it("rolls back a refused change and keeps the cache at the confirmed value", async () => {
    const api = fakeApi({ reject: (s) => s.preset === "fastest" });
    const storage = memory();
    const store = new SettingsStore(api, storage);
    await store.load();
    await expect(store.update({ preset: "fastest" })).rejects.toThrow("Not in your plan");
    expect(store.current?.preset).toBe("balanced");
    expect(JSON.parse(storage.data[SETTINGS_CACHE_KEY]!).preset).toBe("balanced");
  });

  it("saves changes in order and a failed one doesn't undo a later one", async () => {
    const api = fakeApi({ reject: (s) => s.preset === "fastest" });
    const store = new SettingsStore(api, memory());
    await store.load();
    api.hold = true;
    const a = store.update({ preset: "fastest" });
    const b = store.update({ hotkey: "Alt+Shift" });
    expect(store.current).toMatchObject({ preset: "fastest", hotkey: "Alt+Shift" });
    await vi.waitFor(() => expect(api.puts).toHaveLength(1));
    api.flush();
    await expect(a).rejects.toThrow();
    expect(store.current).toMatchObject({ preset: "balanced", hotkey: "Alt+Shift" });
    await vi.waitFor(() => expect(api.puts).toHaveLength(2));
    api.flush();
    await b;
    expect(store.current).toMatchObject({ preset: "balanced", hotkey: "Alt+Shift" });
    // The second PUT didn't carry the refused preset.
    expect(api.puts[1]?.preset).toBe("balanced");
  });

  it("refuses updates before anything is loaded", async () => {
    const store = new SettingsStore(fakeApi(), memory());
    await expect(store.update({ insertMode: "review" })).rejects.toThrow("not loaded");
  });
});
