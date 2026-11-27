import type {
  InsertMode,
  Mode,
  RewriteRequest,
  SessionEndRequest,
  SessionStartResponse,
} from "@sayvox/shared";
import { ReviewGate, type ReviewDecision } from "../overlay/review";
import { errorFor, type OverlayState } from "../overlay/state";
import { ApiError } from "./apiClient";
import { cleanup, ScribeError } from "@sayvox/client";
import type { CommitResult, RewriteDone, ScribeStreamOptions } from "@sayvox/client";
import { DEFAULT_PREFS, nextMode, resolveMode, type ModePrefs } from "./modeResolver";
import { SessionExpiredError } from "./session";

/** Messages from Rust over the dictation channel (src-tauri/src/dictation.rs). */
export type DictationEvent =
  /** `translate`: the translate shortcut was held, so this press goes to English. */
  | { kind: "press"; t: number; app?: string; translate?: boolean }
  | { kind: "release"; t: number; audioSeconds: number }
  | { kind: "cancel"; t: number }
  /** Opt-in reply context: text selected in the target app at press (T063). */
  | { kind: "context"; threadContext: string }
  /** Enter (accept) / Esc while a rewrite waits for review (T071). */
  | { kind: "review"; accept: boolean }
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
  newScribe: (opts: ScribeStreamOptions) => ScribeLike;
  insert: (text: string) => Promise<InsertOutcome>;
  /** Rust monotonic clock (same clock as event `t`). */
  now: () => Promise<number>;
  endSession: (sessionId: string, body: SessionEndRequest) => Promise<void>;
  onState: (s: OverlayState) => void;
  clientVersion: string;
  /** Stream an AI rewrite (prompt / email modes). Rejects on any failure. */
  rewrite?: (req: RewriteRequest, onToken: (soFar: string) => void) => Promise<RewriteDone>;
  /** User's default mode and per-app overrides (Settings → Modes, Story 2.6). */
  modePrefs?: () => ModePrefs;
  /** Settings → General: insert at once, or wait for Enter / Esc after a rewrite. */
  insertMode?: () => InsertMode;
  /** Turn Rust's global Enter/Esc capture on or off (`review_keys`). */
  reviewKeys?: (active: boolean) => void;
  /** Injected in tests; built from `reviewKeys` otherwise. */
  reviewGate?: ReviewGate;
  /**
   * Kill switch or forced update from `/v1/client-config` (T081): when set, a press shows
   * this error at once and no session is started.
   */
  blocked?: () => Extract<OverlayState, { kind: "error" }> | null;
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
  app: string;
  mode: Mode;
  /** Never logged or stored; sent once with the rewrite and then dropped. */
  threadContext?: string;
}

/** Server error text for quota errors ("Monthly limit reached"); undefined otherwise. */
function quotaMessage(err: unknown): string | undefined {
  return err instanceof ApiError && err.code === "QUOTA_EXCEEDED" ? err.message : undefined;
}

function errorCode(err: unknown): string {
  if (err instanceof SessionExpiredError) return "SESSION_EXPIRED";
  if (err instanceof ApiError) return err.code;
  // ElevenLabs `quota_exceeded` is OUR provider account running out, not the user's plan:
  // telling the user to upgrade would be wrong, so it's a generic service error.
  if (err instanceof ScribeError) return "scribe";
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
  private readonly review: ReviewGate;

  constructor(private readonly deps: PipelineDeps) {
    this.schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
    this.review = deps.reviewGate ?? new ReviewGate({ captureKeys: (on) => deps.reviewKeys?.(on) });
  }

  /** Overlay buttons in the review state (same as Enter / Esc). */
  decideReview(d: ReviewDecision): void {
    this.review.decide(d);
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
        return this.press(ev.app ?? "unknown", ev.translate === true);
      case "release":
        return this.release(ev.t, ev.audioSeconds);
      case "cancel":
        return this.cancel();
      case "review":
        this.review.decide(ev.accept ? "insert" : "discard");
        return;
      case "context":
        if (this.active && !this.active.ended) this.active.threadContext = ev.threadContext;
        return;
      case "audioError":
        // Cancel first: it hides the overlay, which would wipe the error straight away.
        this.cancel();
        this.fail(errorFor(ev.code));
        return;
    }
  }

  /** Overlay badge click: switch mode for the current press only (Story 3.4 AC 3). */
  cycleMode(): void {
    const a = this.active;
    if (!a || a.ended) return;
    a.mode = nextMode(a.mode);
    this.show({ kind: "listening", partial: a.partial, mode: a.mode });
  }

  private press(app: string, translate = false): void {
    // A new dictation while one waits for review: the user moved on, so discard it.
    this.review.decide("discard");
    if (this.active && !this.active.ended) this.cancel();
    const blocked = this.deps.blocked?.();
    if (blocked) {
      this.active = undefined;
      this.fail(blocked);
      return;
    }
    const session = this.deps.takeSession();
    // The translate shortcut wins over the app's mode: anything said comes out in English.
    const mode = translate
      ? "translate"
      : resolveMode(app, this.deps.modePrefs?.() ?? DEFAULT_PREFS);
    const a: Active = {
      session,
      pending: [],
      partial: "",
      ended: false,
      app,
      mode,
      scribe: session.then((s) => {
        const scribe = this.deps.newScribe({
          ticket: s.streamTicket,
          refreshTicket: async () => (await this.deps.takeSession()).streamTicket,
          onPartial: (text) => {
            if (this.active !== a || a.ended) return;
            a.partial = text;
            this.show({ kind: "listening", partial: text, mode: a.mode });
          },
        });
        scribe.start();
        return scribe;
      }),
    };
    this.active = a;
    this.show({ kind: "listening", partial: "", mode });
    a.scribe.catch((err: unknown) => {
      if (this.active === a && !a.ended) {
        a.ended = true;
        this.fail(errorFor(errorCode(err), quotaMessage(err)));
      }
    });
  }

  private async release(releaseT: number, audioSeconds: number): Promise<void> {
    const a = this.active;
    if (!a || a.ended) return;
    a.ended = true;
    this.show({ kind: "transcribing", partial: a.partial, mode: a.mode });

    let session: SessionStartResponse;
    let result: CommitResult;
    try {
      session = await a.session;
      const scribe = await a.scribe;
      for (const c of a.pending.splice(0)) scribe.sendChunk(c);
      result = await scribe.commit();
    } catch (err) {
      this.fail(errorFor(errorCode(err), quotaMessage(err)));
      const s = await a.session.catch(() => undefined);
      if (s) void this.end(a, s.sessionId, audioSeconds, "failed", 0, 0);
      return;
    }

    // Local cleanup is both the dictation result and the raw fallback for AI modes.
    const cleaned = cleanup(result.text, session.keyterms);
    if (!cleaned) {
      this.show({ kind: "hidden" });
      void this.end(a, session.sessionId, audioSeconds, "discarded", result.commitMs, 0);
      return;
    }

    let text = cleaned;
    let notice: string | undefined;
    let reviewMs = 0;
    const rewritten = a.mode !== "dictation" && this.deps.rewrite !== undefined;
    if (rewritten && this.deps.rewrite) {
      this.show({ kind: "rewriting", text: "", mode: a.mode });
      try {
        const done = await this.deps.rewrite(
          {
            sessionId: session.sessionId,
            transcript: result.text,
            mode: a.mode,
            targetApp: a.app,
            // Reply context only matters for email; the server ignores it for chat apps.
            ...(a.mode === "email" && a.threadContext ? { threadContext: a.threadContext } : {}),
          },
          (soFar) => this.show({ kind: "rewriting", text: soFar, mode: a.mode }),
        );
        if (done.text) text = done.text;
        delete a.threadContext;
      } catch {
        // Never lose the words: paste the cleaned transcript instead (T055).
        notice = "Inserted your original text; AI rewrite was unavailable.";
      }
    }

    // Review before insert applies to AI rewrites (front-end spec §3.2: Rewriting → Review).
    if (rewritten && this.deps.insertMode?.() === "review") {
      const opened = await this.deps.now();
      this.show(
        notice
          ? { kind: "review", text, mode: a.mode, notice }
          : { kind: "review", text, mode: a.mode },
      );
      const decision = await this.review.wait();
      reviewMs = Math.max(0, (await this.deps.now()) - opened);
      if (decision === "discard") {
        // A new press may already own the overlay; only hide if this one still does.
        if (this.active === a) this.show({ kind: "hidden" });
        void this.end(a, session.sessionId, audioSeconds, "discarded", result.commitMs, 0);
        return;
      }
    }

    this.show({ kind: "inserting", text });
    const outcome = await this.deps
      .insert(text)
      .catch((e: unknown): InsertOutcome => ({ failed: { reason: String(e) } }));
    // Time the user spent reviewing isn't Sayvox latency.
    const releaseToInsertMs = Math.max(
      0,
      Math.round((await this.deps.now()) - releaseT - reviewMs),
    );

    if (outcome === "inserted") {
      this.show(notice ? { kind: "inserted", text, notice } : { kind: "inserted", text });
      this.schedule(() => this.show({ kind: "hidden" }), notice ? 2_500 : 800);
      void this.end(
        a,
        session.sessionId,
        audioSeconds,
        notice ? "raw_fallback" : "inserted",
        result.commitMs,
        releaseToInsertMs,
      );
    } else {
      // Paste impossible or failed: keep the words on screen with a Copy button.
      this.show({ kind: "blocked", text });
      void this.end(
        a,
        session.sessionId,
        audioSeconds,
        "failed",
        result.commitMs,
        releaseToInsertMs,
      );
    }
  }

  private cancel(): void {
    const a = this.active;
    if (!a || a.ended) return;
    a.ended = true;
    void a.scribe.then((s) => s.abort()).catch(() => {});
    this.show({ kind: "hidden" });
    void a.session.then((s) => this.end(a, s.sessionId, 0, "discarded", 0, 0)).catch(() => {});
  }

  private fail(state: Extract<OverlayState, { kind: "error" }>): void {
    this.show(state);
    // Microphone problems need the user to act: leave time to read and click.
    this.schedule(() => this.show({ kind: "hidden" }), state.micProblem ? 10_000 : 3_000);
  }

  private end(
    a: Active,
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
        mode: a.mode,
        targetApp: a.app,
        timings: { sttCommitMs, releaseToInsertMs },
        clientVersion: this.deps.clientVersion,
      })
      .catch(() => {
        // Metering is best-effort from the client; the sweeper closes orphaned sessions.
      });
  }
}
