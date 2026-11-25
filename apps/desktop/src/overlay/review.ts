/**
 * Review-before-insert (Story 3.6 AC 2, T071): a finished rewrite waits for Enter (insert)
 * or Esc (discard). Rust consumes the two keys globally only while a review is open, so
 * they don't reach the target app; the overlay itself never takes focus. A review with no
 * answer is discarded after 60 s.
 */

export type ReviewDecision = "insert" | "discard";

export const REVIEW_TIMEOUT_MS = 60_000;
export const REVIEW_HINT = "Enter to insert · Esc to discard";

export interface ReviewDeps {
  /** Turn global Enter/Esc capture on or off (Rust `review_keys`). */
  captureKeys: (active: boolean) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class ReviewGate {
  private open: { resolve: (d: ReviewDecision) => void; timer: unknown } | undefined;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: ReviewDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get active(): boolean {
    return this.open !== undefined;
  }

  /** Open a review and wait for the user. A review already open is discarded first. */
  wait(timeoutMs = REVIEW_TIMEOUT_MS): Promise<ReviewDecision> {
    this.decide("discard");
    return new Promise<ReviewDecision>((resolve) => {
      const timer = this.setTimer(() => this.decide("discard"), timeoutMs);
      this.open = { resolve, timer };
      this.deps.captureKeys(true);
    });
  }

  /** Enter / Esc from Rust, an overlay click, or a new press (discard). No-op if closed. */
  decide(d: ReviewDecision): void {
    const o = this.open;
    if (!o) return;
    this.open = undefined;
    this.clearTimer(o.timer);
    this.deps.captureKeys(false);
    o.resolve(d);
  }
}
