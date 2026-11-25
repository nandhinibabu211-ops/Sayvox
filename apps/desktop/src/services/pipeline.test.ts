import type { SessionEndRequest, SessionStartResponse } from "@sayvox/shared";
import { describe, expect, it, vi } from "vitest";
import type { OverlayState } from "../overlay/state";
import { ApiError } from "./apiClient";
import { DictationPipeline, type InsertOutcome, type ScribeLike } from "./pipeline";
import { ScribeError } from "./scribeClient";

const SESSION: SessionStartResponse = {
  sessionId: "3f1c2a4e-8b7d-4c1a-9e2f-1a2b3c4d5e6f",
  scribeToken: "sutkn_1",
  expiresAt: "2026-11-25T10:15:00Z",
  keyterms: ["Zoho"],
  languageHint: null,
  maxSessionSeconds: 300,
};

function harness(
  opts: {
    transcript?: string | Error;
    insert?: InsertOutcome;
    takeSession?: () => Promise<SessionStartResponse>;
  } = {},
) {
  const states: OverlayState[] = [];
  const ends: SessionEndRequest[] = [];
  const sent: ArrayBuffer[] = [];
  const scribe: ScribeLike & { aborted: boolean } = {
    aborted: false,
    start: vi.fn(),
    sendChunk: (c) => sent.push(c),
    commit: vi.fn(async () => {
      if (opts.transcript instanceof Error) throw opts.transcript;
      return {
        text: opts.transcript ?? "um so let's meet on Thursday no wait Friday",
        commitMs: 210,
        retried: false,
      };
    }),
    abort() {
      this.aborted = true;
    },
  };
  const insert = vi.fn(async () => opts.insert ?? ("inserted" as InsertOutcome));
  let clock = 0;
  const p = new DictationPipeline({
    takeSession: opts.takeSession ?? (async () => SESSION),
    newScribe: () => scribe,
    insert,
    now: async () => clock,
    endSession: async (_id, body) => {
      ends.push(body);
    },
    onState: (s) => states.push(s),
    clientVersion: "0.1.0",
    schedule: (fn) => fn(),
  });
  return { p, states, ends, sent, scribe, insert, setClock: (t: number) => (clock = t) };
}

const chunk = () => new ArrayBuffer(5_120);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("DictationPipeline (US1)", () => {
  it("press → chunks → release → cleaned text pasted, timings reported", async () => {
    const h = harness();
    await h.p.onEvent({ kind: "press", t: 0 });
    h.p.onChunk(chunk());
    h.p.onChunk(chunk());
    h.setClock(1_640);
    await h.p.onEvent({ kind: "release", t: 1_000, audioSeconds: 0.95 });

    expect(h.sent).toHaveLength(2);
    expect(h.insert).toHaveBeenCalledWith("So let's meet on Friday.");
    expect(h.states.map((s) => s.kind)).toEqual([
      "listening",
      "transcribing",
      "inserting",
      "inserted",
      "hidden",
    ]);
    await tick();
    expect(h.ends).toEqual([
      expect.objectContaining({
        audioSeconds: 0.95,
        insertResult: "inserted",
        timings: { sttCommitMs: 210, releaseToInsertMs: 640 },
      }),
    ]);
  });

  it("forwards chunks that arrive before the session is ready, in order", async () => {
    let resolve!: (s: SessionStartResponse) => void;
    const h = harness({ takeSession: () => new Promise((r) => (resolve = r)) });
    await h.p.onEvent({ kind: "press", t: 0 });
    const a = chunk();
    const b = new ArrayBuffer(10);
    h.p.onChunk(a);
    h.p.onChunk(b);
    resolve(SESSION);
    await h.p.onEvent({ kind: "release", t: 500, audioSeconds: 0.5 });
    expect(h.sent).toEqual([a, b]);
  });

  it("cancel aborts the stream, hides, and reports the session as discarded", async () => {
    const h = harness();
    await h.p.onEvent({ kind: "press", t: 0 });
    await tick();
    await h.p.onEvent({ kind: "cancel", t: 120 });
    await tick();
    expect(h.scribe.aborted).toBe(true);
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.states.at(-1)).toEqual({ kind: "hidden" });
    expect(h.ends[0]!.insertResult).toBe("discarded");
  });

  it("keeps the text on screen when the target is elevated", async () => {
    const h = harness({ insert: "blockedElevated" });
    await h.p.onEvent({ kind: "press", t: 0 });
    await h.p.onEvent({ kind: "release", t: 400, audioSeconds: 0.4 });
    expect(h.states.at(-1)).toEqual({ kind: "blocked", text: "So let's meet on Friday." });
  });

  it("filler-only speech inserts nothing", async () => {
    const h = harness({ transcript: "um uh" });
    await h.p.onEvent({ kind: "press", t: 0 });
    await h.p.onEvent({ kind: "release", t: 400, audioSeconds: 0.4 });
    await tick();
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.ends[0]!.insertResult).toBe("discarded");
  });

  it("shows the quota error when session start is refused", async () => {
    const h = harness({
      takeSession: async () => {
        throw new ApiError(402, "QUOTA_EXCEEDED", "Daily limit reached");
      },
    });
    await h.p.onEvent({ kind: "press", t: 0 });
    await tick();
    expect(h.states).toContainEqual(expect.objectContaining({ kind: "error", action: "upgrade" }));
  });

  it("reports a failed Scribe commit without pasting", async () => {
    const h = harness({ transcript: new ScribeError("connection") });
    await h.p.onEvent({ kind: "press", t: 0 });
    await h.p.onEvent({ kind: "release", t: 400, audioSeconds: 0.4 });
    await tick();
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.states).toContainEqual(expect.objectContaining({ kind: "error" }));
    expect(h.ends[0]!.insertResult).toBe("failed");
  });

  it("microphone permission errors point to Windows settings", async () => {
    const h = harness();
    await h.p.onEvent({ kind: "press", t: 0 });
    await h.p.onEvent({ kind: "audioError", code: "permissionDenied" });
    expect(h.states).toContainEqual(
      expect.objectContaining({ kind: "error", action: "openMicSettings" }),
    );
  });
});
