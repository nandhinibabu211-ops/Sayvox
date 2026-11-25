import type { SessionEndRequest, SessionStartResponse } from "@sayvox/shared";
import { errorFor, type OverlayState } from "../overlay/state";
import { ApiError } from "./apiClient";
import { cleanup } from "./cleanup";
import type { CommitResult, ScribeOptions } from "./scribeClient";
import { ScribeError } from "./scribeClient";
import { SessionExpiredError } from "./session";

/** Messages from Rust over the dictation channel (src-tauri/src/dictation.rs). */
export type DictationEvent =
  | { kind: "press"; t: number }
  | { kind: "release"; t: number; audioSeconds: number }
  | { kind: "cancel"; t: number }
  | { kind: "audioError"; code: string };

export type InsertOutcome = "inserted" | "blockedElevated" | { failed: { reason: string } };

export interface ScribeLike {
  start(): void;
  sendChunk(pcm: ArrayBuffer): void;
  commit(): Promise<CommitResult>;
  abort(): void;
}

export interface PipelineDeps {
  takeSession: () => Promise<SessionStartResponse>;
  newScribe: (opts: ScribeOptions) => ScribeLike;
  insert: (text: string) => Promise<InsertOutcome>;
  /** Rust monotonic clock (same clock as event `t`). */
  now: () => Promise<number>;
  endSession: (sessionId: string, body: SessionEndRequest) => Promise<void>;
  onState: (s: OverlayState) => void;
  clientVersion: string;
  /** Local timing log for the Phase 1 gate (debug builds); numbers only. */
  recordTiming?: (r: {
    releaseToInsertMs: number;
    sttCommitMs: number;
    audioSeconds: number;
    result: SessionEndRequest["insertResult"];
  }) => void;
  /** Pause before hiding after success / error (ms). */
  schedule?: (fn: () => void, ms: number) => void;
}

interface Active {
  session: Promise<SessionStartResponse>;
  scribe: Promise<ScribeLike>;
  pending: ArrayBuffer[];
  partial: string;
  ended: boolean;
}

function errorCode(err: unknown): string {
  if (err instanceof SessionExpiredError) return "SESSION_EXPIRED";
  if (err instanceof ApiError) return err.code;
  if (err instanceof ScribeError)
    return err.providerType === "quota_exceeded" ? "QUOTA_EXCEEDED" : "scribe";
  if (err instanceof TypeError) return "offline";
  return "unknown";
}

/**
 * One dictation at a time: press → stream → release → commit → cleanup → paste → report.
 * The user's words are never lost: if paste is impossible the text stays in the overlay.
 */
export class DictationPipeline {
  private active: Active | undefined;
  private readonly schedule: (fn: () => void, ms: number) => void;

  constructor(private readonly deps: PipelineDeps) {
    this.schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
  }

  private show(s: OverlayState): void {
    this.deps.onState(s);
  }

  /** Raw PCM chunk from Rust. */
  onChunk(pcm: ArrayBuffer): void {
    const a = this.active;
    if (!a || a.ended) return;
    a.pending.push(pcm);
    void a.scribe
      .then((s) => {
        for (const c of a.pending.splice(0)) s.sendChunk(c);
      })
      .catch(() => {});
  }

  async onEvent(ev: DictationEvent): Promise<void> {
    switch (ev.kind) {
      case "press":
        return this.press();
      case "release":
        return this.release(ev.t, ev.audioSeconds);
      case "cancel":
        return this.cancel();
      case "audioError":
        this.fail(errorFor(ev.code));
        this.cancel();
        return;
    }
  }

  private press(): void {
    if (this.active && !this.active.ended) this.cancel();
    const session = this.deps.takeSession();
    const a: Active = {
      session,
      pending: [],
      partial: "",
      ended: false,
      scribe: session.then((s) => {
        const scribe = this.deps.newScribe({
          token: s.scribeToken,
          keyterms: s.keyterms,
          languageHint: s.languageHint ?? null,
          refreshToken: async () => (await this.deps.takeSession()).scribeToken,
          onPartial: (text) => {
            if (this.active !== a || a.ended) return;
            a.partial = text;
            this.show({ kind: "listening", partial: text });
          },
        });
        scribe.start();
        return scribe;
      }),
    };
    this.active = a;
    this.show({ kind: "listening", partial: "" });
    a.scribe.catch((err: unknown) => {
      if (this.active === a && !a.ended) {
        a.ended = true;
        this.fail(errorFor(errorCode(err)));
      }
    });
  }

  private async release(releaseT: number, audioSeconds: number): Promise<void> {
    const a = this.active;
    if (!a || a.ended) return;
    a.ended = true;
    this.show({ kind: "transcribing", partial: a.partial });

    let session: SessionStartResponse;
    let result: CommitResult;
    try {
      session = await a.session;
      const scribe = await a.scribe;
      for (const c of a.pending.splice(0)) scribe.sendChunk(c);
      result = await scribe.commit();
    } catch (err) {
      this.fail(errorFor(errorCode(err)));
      const s = await a.session.catch(() => undefined);
      if (s) void this.end(s.sessionId, audioSeconds, "failed", 0, 0);
      return;
    }

    const text = cleanup(result.text, session.keyterms);
    if (!text) {
      this.show({ kind: "hidden" });
      void this.end(session.sessionId, audioSeconds, "discarded", result.commitMs, 0);
      return;
    }

    this.show({ kind: "inserting", text });
    const outcome = await this.deps
      .insert(text)
      .catch((e: unknown): InsertOutcome => ({ failed: { reason: String(e) } }));
    const releaseToInsertMs = Math.max(0, Math.round((await this.deps.now()) - releaseT));

    if (outcome === "inserted") {
      this.show({ kind: "inserted", text });
      this.schedule(() => this.show({ kind: "hidden" }), 800);
      void this.end(
        session.sessionId,
        audioSeconds,
        "inserted",
        result.commitMs,
        releaseToInsertMs,
      );
    } else {
      // Paste impossible or failed: keep the words on screen with a Copy button.
      this.show({ kind: "blocked", text });
      void this.end(session.sessionId, audioSeconds, "failed", result.commitMs, releaseToInsertMs);
    }
  }

  private cancel(): void {
    const a = this.active;
    if (!a || a.ended) return;
    a.ended = true;
    void a.scribe.then((s) => s.abort()).catch(() => {});
    this.show({ kind: "hidden" });
    void a.session.then((s) => this.end(s.sessionId, 0, "discarded", 0, 0)).catch(() => {});
  }

  private fail(state: Extract<OverlayState, { kind: "error" }>): void {
    this.show(state);
    this.schedule(() => this.show({ kind: "hidden" }), 3_000);
  }

  private end(
    sessionId: string,
    audioSeconds: number,
    insertResult: SessionEndRequest["insertResult"],
    sttCommitMs: number,
    releaseToInsertMs: number,
  ): Promise<void> {
    if (insertResult !== "discarded") {
      try {
        this.deps.recordTiming?.({
          releaseToInsertMs,
          sttCommitMs,
          audioSeconds,
          result: insertResult,
        });
      } catch {
        // Timing log is best-effort.
      }
    }
    return this.deps
      .endSession(sessionId, {
        audioSeconds,
        insertResult,
        mode: "dictation",
        timings: { sttCommitMs, releaseToInsertMs },
        clientVersion: this.deps.clientVersion,
      })
      .catch(() => {
        // Metering is best-effort from the client; the sweeper closes orphaned sessions.
      });
  }
}
