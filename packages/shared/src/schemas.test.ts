import { describe, expect, it } from "vitest";
import {
  AddDictionaryTermRequest,
  ERROR_STATUS,
  ErrorCode,
  RewriteRequest,
  SessionEndRequest,
  Settings,
  TelemetryBatch,
} from "./index";

const uuid = "3f1c2a4e-8b7d-4c1a-9e2f-1a2b3c4d5e6f";

describe("RewriteRequest", () => {
  it("accepts a valid request", () => {
    const r = RewriteRequest.safeParse({
      sessionId: uuid,
      transcript: "let's meet friday",
      mode: "prompt",
      targetApp: "Cursor.exe",
    });
    expect(r.success).toBe(true);
  });

  it("rejects transcripts over 20 000 chars", () => {
    const r = RewriteRequest.safeParse({
      sessionId: uuid,
      transcript: "a".repeat(20_001),
      mode: "dictation",
      targetApp: "notepad.exe",
    });
    expect(r.success).toBe(false);
  });

  it("rejects target apps that look like window titles with odd characters", () => {
    const r = RewriteRequest.safeParse({
      sessionId: uuid,
      transcript: "hi",
      mode: "email",
      targetApp: "Inbox (3) — priya@example.com",
    });
    expect(r.success).toBe(false);
  });
});

describe("SessionEndRequest", () => {
  it("requires timings", () => {
    expect(SessionEndRequest.safeParse({ audioSeconds: 3, insertResult: "inserted" }).success).toBe(
      false,
    );
  });
});

describe("Settings", () => {
  it("caps app overrides at 100", () => {
    const overrides = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`app${i}.exe`, "prompt"]),
    );
    const r = Settings.safeParse({
      preset: "balanced",
      defaultMode: "dictation",
      appModeOverrides: overrides,
      insertMode: "auto",
      languageHint: null,
      hotkey: "Ctrl+Shift",
    });
    expect(r.success).toBe(false);
  });
});

describe("TelemetryBatch", () => {
  it("accepts a text-free event", () => {
    const r = TelemetryBatch.safeParse({
      items: [
        { kind: "event", name: "dictation_inserted", at: "2026-11-25T10:00:00Z", os: "windows11" },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown (possibly free-text) fields", () => {
    const r = TelemetryBatch.safeParse({
      items: [
        {
          kind: "event",
          name: "dictation_inserted",
          at: "2026-11-25T10:00:00Z",
          transcript: "should never be sent",
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("rejects macOS (Windows only, ADR-010)", () => {
    const r = TelemetryBatch.safeParse({
      items: [
        {
          kind: "crash",
          at: "2026-11-25T10:00:00Z",
          clientVersion: "0.1.0",
          os: "macos",
          errorCode: "PANIC",
        },
      ],
    });
    expect(r.success).toBe(false);
  });
});

describe("ERROR_STATUS", () => {
  it("has a status for every error code", () => {
    for (const code of ErrorCode.options) {
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("Settings (US4)", () => {
  const base = {
    preset: "balanced",
    defaultMode: "dictation",
    appModeOverrides: {},
    insertMode: "review",
    languageHint: "hinglish",
    hotkey: "Ctrl+Alt",
  };

  it("accepts the supported hotkeys and language hints", () => {
    expect(Settings.safeParse(base).success).toBe(true);
  });

  it("rejects unsupported hotkeys (single keys, letters)", () => {
    expect(Settings.safeParse({ ...base, hotkey: "Ctrl" }).success).toBe(false);
    expect(Settings.safeParse({ ...base, hotkey: "Ctrl+Shift+K" }).success).toBe(false);
  });

  it("accepts Tamil and Tanglish, and the translate mode", () => {
    for (const languageHint of ["ta", "tanglish"]) {
      expect(Settings.safeParse({ ...base, languageHint }).success).toBe(true);
    }
    expect(Settings.safeParse({ ...base, defaultMode: "translate" }).success).toBe(true);
  });

  it("takes a translate shortcut that differs from the dictation one (or none)", () => {
    expect(Settings.safeParse({ ...base, translateHotkey: "Alt+Shift" }).success).toBe(true);
    expect(Settings.safeParse({ ...base, translateHotkey: null }).success).toBe(true);
    expect(Settings.safeParse({ ...base, translateHotkey: "Ctrl+Alt" }).success).toBe(false);
  });

  it("rejects unknown language hints", () => {
    expect(Settings.safeParse({ ...base, languageHint: "klingon" }).success).toBe(false);
  });
});

describe("AddDictionaryTermRequest", () => {
  it("trims and collapses spaces", () => {
    expect(AddDictionaryTermRequest.parse({ term: "  Zoho   CRM " }).term).toBe("Zoho CRM");
  });

  it("rejects empty, too long and control-character terms", () => {
    expect(AddDictionaryTermRequest.safeParse({ term: "   " }).success).toBe(false);
    expect(AddDictionaryTermRequest.safeParse({ term: "x".repeat(65) }).success).toBe(false);
    expect(AddDictionaryTermRequest.safeParse({ term: "Zo\u0007ho" }).success).toBe(false);
  });
});
