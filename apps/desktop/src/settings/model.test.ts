import { describe, expect, it } from "vitest";
import {
  addOverride,
  appLabel,
  chordFor,
  dictionaryCounter,
  HotkeyRecorder,
  languageSetting,
  languageValue,
  MAX_OVERRIDES,
  parseAppId,
  presetCards,
  removeOverride,
} from "./model";

function record(keys: string[]) {
  const r = new HotkeyRecorder();
  let out = null;
  for (const k of keys) {
    const [kind, key] = k.split(" ") as ["down" | "up", string];
    out = kind === "down" ? r.keyDown(key) : r.keyUp(key);
  }
  return out;
}

describe("hotkey recorder (T067/T072)", () => {
  it("records a supported two-modifier chord in canonical order", () => {
    expect(record(["down Shift", "down Control", "up Shift", "up Control"])).toEqual({
      hotkey: "Ctrl+Shift",
    });
    expect(record(["down Alt", "down Control", "up Alt", "up Control"])).toEqual({
      hotkey: "Ctrl+Alt",
    });
    expect(record(["down Meta", "down Shift", "up Meta", "up Shift"])).toEqual({
      hotkey: "Shift+Win",
    });
  });

  it("waits until every key is up", () => {
    const r = new HotkeyRecorder();
    r.keyDown("Control");
    r.keyDown("Shift");
    expect(r.keyUp("Shift")).toBeNull();
    expect(r.keyUp("Control")).toEqual({ hotkey: "Ctrl+Shift" });
  });

  it("refuses letters, AltGr, single keys, three keys and Alt+Win", () => {
    expect(record(["down Control", "down k", "up k", "up Control"])).toMatchObject({
      error: expect.stringContaining("modifier keys only"),
    });
    expect(record(["down AltGraph", "up AltGraph"])).toMatchObject({
      error: expect.stringContaining("AltGr"),
    });
    expect(record(["down Control", "up Control"])).toMatchObject({
      error: expect.stringContaining("exactly two"),
    });
    expect(
      record(["down Control", "down Shift", "down Alt", "up Alt", "up Shift", "up Control"]),
    ).toMatchObject({ error: expect.stringContaining("exactly two") });
    expect(record(["down Alt", "down Meta", "up Alt", "up Meta"])).toMatchObject({
      error: expect.stringContaining("isn't supported"),
    });
  });

  it("starts fresh after each attempt", () => {
    const r = new HotkeyRecorder();
    r.keyDown("x");
    expect(r.keyUp("x")).toMatchObject({ error: expect.any(String) });
    r.keyDown("Alt");
    r.keyDown("Shift");
    r.keyUp("Alt");
    expect(r.keyUp("Shift")).toEqual({ hotkey: "Alt+Shift" });
  });

  it("chordFor only knows the supported pairs", () => {
    expect(chordFor(new Set(["Ctrl", "Win"]))).toBe("Ctrl+Win");
    expect(chordFor(new Set(["Alt", "Win"]))).toBeNull();
  });
});

describe("language", () => {
  it("maps auto to null and back", () => {
    expect(languageValue({ languageHint: null })).toBe("auto");
    expect(languageSetting("auto")).toBeNull();
    expect(languageSetting("hinglish")).toBe("hinglish");
  });
});

describe("modes and overrides (T068)", () => {
  it("normalises app ids and rejects junk", () => {
    expect(parseAppId("  Slack.EXE ")).toEqual({ id: "slack.exe" });
    expect(parseAppId("web:gmail")).toEqual({ id: "web:gmail" });
    expect(parseAppId("")).toMatchObject({ error: expect.any(String) });
    expect(parseAppId("C:\\apps\\x.exe")).toMatchObject({ error: expect.any(String) });
  });

  it("adds, replaces and removes overrides, capped at 100", () => {
    const a = addOverride({}, "slack.exe", "email");
    expect(a).toEqual({ "slack.exe": "email" });
    expect(addOverride(a as Record<string, "email">, "slack.exe", "dictation")).toEqual({
      "slack.exe": "dictation",
    });
    expect(removeOverride({ "slack.exe": "email", "x.exe": "prompt" }, "slack.exe")).toEqual({
      "x.exe": "prompt",
    });
    const full = Object.fromEntries(
      Array.from({ length: MAX_OVERRIDES }, (_, i) => [`a${i}.exe`, "prompt" as const]),
    );
    expect(addOverride(full, "new.exe", "email")).toMatchObject({ error: expect.any(String) });
    expect(addOverride(full, "a1.exe", "email")).not.toHaveProperty("error");
  });

  it("labels web apps", () => {
    expect(appLabel("web:gmail")).toBe("Gmail (web)");
    expect(appLabel("cursor.exe")).toBe("cursor.exe");
  });
});

describe("preset cards (T069)", () => {
  it("locks presets outside the plan and marks the selected one", () => {
    const cards = presetCards({
      preset: "balanced",
      plan: { id: "free", allowedPresets: ["balanced", "cheapest"], dictionaryLimit: 25 },
    });
    expect(cards.map((c) => [c.id, c.locked, c.selected])).toEqual([
      ["fastest", true, false],
      ["balanced", false, true],
      ["cheapest", false, false],
    ]);
    expect(cards.find((c) => c.recommended)?.id).toBe("balanced");
  });
});

describe("dictionary counter (T070)", () => {
  it("shows n / limit and when it's full", () => {
    expect(dictionaryCounter(3, 25)).toEqual({ text: "3 / 25", full: false });
    expect(dictionaryCounter(25, 25).full).toBe(true);
  });
});
