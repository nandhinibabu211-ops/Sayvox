import type { SessionEndRequest, SessionStartResponse } from "@sayvox/shared";
import { describe, expect, it, vi } from "vitest";
import type { OverlayState } from "../overlay/state";
import { ApiError } from "./apiClient";
import type { ModePrefs } from "./modeResolver";
import { DictationPipeline, type InsertOutcome, type ScribeLike } from "./pipeline";
import { RewriteFailed, ScribeError, type RewriteDone } from "@sayvox/client";

const SESSION: SessionStartResponse = {
  sessionId: "3f1c2a4e-8b7d-4c1a-9e2f-1a2b3c4d5e6f",
  streamTicket: "t".repeat(43),
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
    rewrite?: (req: unknown, onToken: (soFar: string) => void) => Promise<RewriteDone>;
    insertMode?: "auto" | "review";
    modePrefs?: ModePrefs;
    blocked?: () => { kind: "error"; message: string } | null;
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
  const reviewKeys: boolean[] = [];
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
    ...(opts.rewrite ? { rewrite: opts.rewrite } : {}),
    schedule: (fn) => fn(),
    ...(opts.insertMode ? { insertMode: () => opts.insertMode! } : {}),
    ...(opts.modePrefs ? { modePrefs: () => opts.modePrefs! } : {}),
    reviewKeys: (on) => reviewKeys.push(on),
    ...(opts.blocked ? { blocked: opts.blocked } : {}),
  });
  return {
    p,
    states,
    ends,
    sent,
    scribe,
    insert,
    reviewKeys,
    setClock: (t: number) => (clock = t),
  };
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

  describe("AI modes (US2)", () => {
    const done = (text: string): RewriteDone => ({
      text,
      model: "anthropic/claude-haiku-5.5",
      ttftMs: 400,
      totalMs: 900,
      fallbackUsed: false,
    });

    it("prompt mode in Cursor streams the rewrite, pastes it, and reports mode + app", async () => {
      const seenReq: unknown[] = [];
      const h = harness({
        transcript: "um fix the login bug in auth dot ts",
        rewrite: async (req, onToken) => {
          seenReq.push(req);
          onToken("Goal: ");
          onToken("Goal: Fix the login bug in `auth.ts`.");
          return done("Goal: Fix the login bug in `auth.ts`.");
        },
      });
      await h.p.onEvent({ kind: "press", t: 0, app: "cursor.exe" });
      expect(h.states[0]).toEqual({ kind: "listening", partial: "", mode: "prompt" });
      await h.p.onEvent({ kind: "release", t: 400, audioSeconds: 2 });
      await tick();

      expect(seenReq[0]).toMatchObject({
        transcript: "um fix the login bug in auth dot ts",
        mode: "prompt",
        targetApp: "cursor.exe",
      });
      expect(
        h.states.filter((s) => s.kind === "rewriting").map((s) => (s as { text: string }).text),
      ).toEqual(["", "Goal: ", "Goal: Fix the login bug in `auth.ts`."]);
      expect(h.insert).toHaveBeenCalledWith("Goal: Fix the login bug in `auth.ts`.");
      expect(h.ends[0]).toMatchObject({
        insertResult: "inserted",
        mode: "prompt",
        targetApp: "cursor.exe",
      });
    });

    it("pastes the cleaned raw transcript when the rewrite fails, and says so (T055)", async () => {
      const h = harness({
        transcript: "um tell priya the invoice is late",
        rewrite: async () => {
          throw new RewriteFailed("provider");
        },
      });
      await h.p.onEvent({ kind: "press", t: 0, app: "web:gmail" });
      await h.p.onEvent({ kind: "release", t: 400, audioSeconds: 2 });
      await tick();
      expect(h.insert).toHaveBeenCalledWith("Tell priya the invoice is late.");
      expect(h.states).toContainEqual(
        expect.objectContaining({ kind: "inserted", notice: expect.any(String) }),
      );
      expect(h.ends[0]).toMatchObject({ insertResult: "raw_fallback", mode: "email" });
    });

    it("dictation mode never calls the rewrite", async () => {
      const rewrite = vi.fn(async () => done("x"));
      const h = harness({ rewrite });
      await h.p.onEvent({ kind: "press", t: 0, app: "notepad.exe" });
      await h.p.onEvent({ kind: "release", t: 400, audioSeconds: 1 });
      expect(rewrite).not.toHaveBeenCalled();
      expect(h.insert).toHaveBeenCalledWith("So let's meet on Friday.");
    });

    it("the badge cycles the mode for this press only", async () => {
      const rewrite = vi.fn(async () => done("Goal: meet Friday."));
      const h = harness({ rewrite });
      await h.p.onEvent({ kind: "press", t: 0, app: "notepad.exe" });
      h.p.cycleMode(); // dictation -> prompt
      expect(h.states.at(-1)).toMatchObject({ kind: "listening", mode: "prompt" });
      await h.p.onEvent({ kind: "release", t: 400, audioSeconds: 1 });
      expect(rewrite).toHaveBeenCalled();
      await h.p.onEvent({ kind: "press", t: 1_000, app: "notepad.exe" });
      expect(h.states.at(-1)).toMatchObject({ kind: "listening", mode: "dictation" });
    });

    it("an empty rewrite falls back to the cleaned transcript", async () => {
      const h = harness({ rewrite: async () => done("") });
      await h.p.onEvent({ kind: "press", t: 0, app: "cursor.exe" });
      await h.p.onEvent({ kind: "release", t: 400, audioSeconds: 1 });
      expect(h.insert).toHaveBeenCalledWith("So let's meet on Friday.");
    });
  });

  describe("reply context (US3, T063)", () => {
    const done = (text: string): RewriteDone => ({
      text,
      model: "m",
      ttftMs: 1,
      totalMs: 2,
      fallbackUsed: false,
    });

    it("sends the selected thread with an email rewrite", async () => {
      const seen: Record<string, unknown>[] = [];
      const h = harness({
        transcript: "say yes friday works",
        rewrite: async (req) => {
          seen.push(req as Record<string, unknown>);
          return done("Hi Priya,\n\nYes, Friday works.\n\nThanks,");
        },
      });
      await h.p.onEvent({ kind: "press", t: 0, app: "olk.exe" });
      await h.p.onEvent({ kind: "context", threadContext: "Can you make Friday at 3?" });
      await h.p.onEvent({ kind: "release", t: 400, audioSeconds: 1 });
      expect(seen[0]).toMatchObject({ mode: "email", threadContext: "Can you make Friday at 3?" });
    });

    it("never sends it outside email mode", async () => {
      const seen: Record<string, unknown>[] = [];
      const h = harness({
        rewrite: async (req) => {
          seen.push(req as Record<string, unknown>);
          return done("Goal: x");
        },
      });
      await h.p.onEvent({ kind: "press", t: 0, app: "cursor.exe" });
      await h.p.onEvent({ kind: "context", threadContext: "secret selected code" });
      await h.p.onEvent({ kind: "release", t: 400, audioSeconds: 1 });
      expect(seen[0]).not.toHaveProperty("threadContext");
    });

    it("a context event after the hold ended is ignored", async () => {
      const seen: Record<string, unknown>[] = [];
      const h = harness({
        rewrite: async (req) => {
          seen.push(req as Record<string, unknown>);
          return done("Hi,\n\nOk.\n\nThanks,");
        },
      });
      await h.p.onEvent({ kind: "press", t: 0, app: "web:gmail" });
      await h.p.onEvent({ kind: "release", t: 400, audioSeconds: 1 });
      await h.p.onEvent({ kind: "context", threadContext: "late selection" });
      expect(seen[0]).not.toHaveProperty("threadContext");
    });
  });

  describe("personalisation (US4)", () => {
    const done = (text: string): RewriteDone => ({
      text,
      model: "m",
      ttftMs: 1,
      totalMs: 2,
      fallbackUsed: false,
    });
    const until = async (pred: () => boolean) => {
      for (let i = 0; i < 50 && !pred(); i++) await tick();
    };

    it("review mode waits for Enter, then inserts; keys are captured only meanwhile", async () => {
      const h = harness({ insertMode: "review", rewrite: async () => done("Goal: meet Friday.") });
      await h.p.onEvent({ kind: "press", t: 0, app: "cursor.exe" });
      h.setClock(500);
      const released = h.p.onEvent({ kind: "release", t: 400, audioSeconds: 1 });
      await until(() => h.states.at(-1)?.kind === "review");
      expect(h.states.at(-1)).toEqual({
        kind: "review",
        text: "Goal: meet Friday.",
        mode: "prompt",
      });
      expect(h.insert).not.toHaveBeenCalled();
      expect(h.reviewKeys).toEqual([true]);
      h.setClock(10_500); // ten seconds reading it
      await h.p.onEvent({ kind: "review", accept: true });
      await released;
      expect(h.reviewKeys).toEqual([true, false]);
      expect(h.insert).toHaveBeenCalledWith("Goal: meet Friday.");
      await tick();
      // Review time isn't counted as latency.
      expect(h.ends[0]).toMatchObject({
        insertResult: "inserted",
        timings: { releaseToInsertMs: 100 },
      });
    });

    it("Esc discards: nothing pasted, session reported as discarded", async () => {
      const h = harness({ insertMode: "review", rewrite: async () => done("Hi Priya,") });
      await h.p.onEvent({ kind: "press", t: 0, app: "web:gmail" });
      const released = h.p.onEvent({ kind: "release", t: 400, audioSeconds: 1 });
      await until(() => h.states.at(-1)?.kind === "review");
      await h.p.onEvent({ kind: "review", accept: false });
      await released;
      await tick();
      expect(h.insert).not.toHaveBeenCalled();
      expect(h.states.at(-1)).toEqual({ kind: "hidden" });
      expect(h.ends[0]).toMatchObject({ insertResult: "discarded", mode: "email" });
      expect(h.reviewKeys).toEqual([true, false]);
    });

    it("a new press discards the review without hiding the new dictation", async () => {
      const h = harness({ insertMode: "review", rewrite: async () => done("Goal: x") });
      await h.p.onEvent({ kind: "press", t: 0, app: "cursor.exe" });
      const released = h.p.onEvent({ kind: "release", t: 400, audioSeconds: 1 });
      await until(() => h.states.at(-1)?.kind === "review");
      await h.p.onEvent({ kind: "press", t: 2_000, app: "notepad.exe" });
      await released;
      expect(h.insert).not.toHaveBeenCalled();
      expect(h.states.at(-1)).toMatchObject({ kind: "listening" });
      expect(h.reviewKeys).toEqual([true, false]);
    });

    it("dictation mode inserts at once even with review on", async () => {
      const h = harness({ insertMode: "review", rewrite: async () => done("x") });
      await h.p.onEvent({ kind: "press", t: 0, app: "notepad.exe" });
      await h.p.onEvent({ kind: "release", t: 400, audioSeconds: 1 });
      expect(h.insert).toHaveBeenCalledWith("So let's meet on Friday.");
      expect(h.reviewKeys).toEqual([]);
    });

    it("uses the user's default mode and per-app overrides from settings", async () => {
      const rewrite = vi.fn(async () => done("Hi team,"));
      const h = harness({
        rewrite,
        modePrefs: { defaultMode: "prompt", overrides: { "cursor.exe": "dictation" } },
      });
      await h.p.onEvent({ kind: "press", t: 0, app: "cursor.exe" });
      expect(h.states.at(-1)).toMatchObject({ mode: "dictation" });
      await h.p.onEvent({ kind: "release", t: 400, audioSeconds: 1 });
      expect(rewrite).not.toHaveBeenCalled();
      await h.p.onEvent({ kind: "press", t: 1_000, app: "notepad.exe" });
      expect(h.states.at(-1)).toMatchObject({ mode: "prompt" });
    });
  });

  describe("safe updates (US7, T081)", () => {
    it("a kill switch or forced update blocks the press before any session starts", async () => {
      let takes = 0;
      let blocked: { kind: "error"; message: string } | null = {
        kind: "error",
        message: "Back in 10 minutes",
      };
      const h = harness({
        takeSession: async () => {
          takes++;
          return SESSION;
        },
        blocked: () => blocked,
      });
      await h.p.onEvent({ kind: "press", t: 0, app: "notepad.exe" });
      await h.p.onEvent({ kind: "release", t: 900, audioSeconds: 0.9 });
      expect(takes).toBe(0);
      expect(h.insert).not.toHaveBeenCalled();
      expect(h.states).toContainEqual({ kind: "error", message: "Back in 10 minutes" });
      blocked = null;
      await h.p.onEvent({ kind: "press", t: 2_000, app: "notepad.exe" });
      expect(takes).toBe(1);
    });
  });

  describe("usage limits (US5, T086)", () => {
    it("a monthly cap says monthly and offers Upgrade", async () => {
      const h = harness({
        takeSession: async () => {
          throw new ApiError(402, "QUOTA_EXCEEDED", "Monthly limit reached");
        },
      });
      await h.p.onEvent({ kind: "press", t: 0 });
      await tick();
      expect(h.states).toContainEqual({
        kind: "error",
        message: "Monthly limit reached.",
        action: "upgrade",
      });
    });

    it("ElevenLabs running out of quota is OUR problem: no Upgrade button for the user", async () => {
      const h = harness({ transcript: new ScribeError("fatal", "quota_exceeded") });
      await h.p.onEvent({ kind: "press", t: 0 });
      await h.p.onEvent({ kind: "release", t: 400, audioSeconds: 1 });
      await tick();
      const err = h.states.find((s) => s.kind === "error");
      expect(err).toBeDefined();
      expect(err).not.toHaveProperty("action", "upgrade");
    });
  });
});
