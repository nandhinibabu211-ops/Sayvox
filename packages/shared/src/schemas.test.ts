import { describe, expect, it } from "vitest";
import {
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
