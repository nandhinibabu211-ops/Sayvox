import { describe, expect, it } from "vitest";
import { nextMode, resolveMode } from "./modeResolver";

describe("resolveMode (T045)", () => {
  it("maps AI tools to prompt mode", () => {
    expect(resolveMode("cursor.exe")).toBe("prompt");
    expect(resolveMode("code.exe")).toBe("prompt");
    expect(resolveMode("web:chatgpt")).toBe("prompt");
    expect(resolveMode("web:claude")).toBe("prompt");
  });

  it("maps mail and chat apps to email mode", () => {
    expect(resolveMode("web:gmail")).toBe("email");
    expect(resolveMode("olk.exe")).toBe("email");
    expect(resolveMode("slack.exe")).toBe("email");
    expect(resolveMode("web:teams")).toBe("email");
  });

  it("falls back to the user's default for unknown apps", () => {
    expect(resolveMode("notepad.exe")).toBe("dictation");
    expect(resolveMode("chrome.exe", { defaultMode: "prompt", overrides: {} })).toBe("prompt");
    expect(resolveMode("unknown")).toBe("dictation");
  });

  it("per-app overrides win over the built-in map", () => {
    const prefs = {
      defaultMode: "dictation" as const,
      overrides: { "slack.exe": "dictation" as const },
    };
    expect(resolveMode("slack.exe", prefs)).toBe("dictation");
    expect(resolveMode("cursor.exe", prefs)).toBe("prompt");
  });

  it("is case-insensitive", () => {
    expect(resolveMode("Cursor.EXE")).toBe("prompt");
  });
});

describe("nextMode", () => {
  it("cycles dictation → prompt → email → dictation", () => {
    expect(nextMode("dictation")).toBe("prompt");
    expect(nextMode("prompt")).toBe("email");
    expect(nextMode("email")).toBe("dictation");
  });
});
