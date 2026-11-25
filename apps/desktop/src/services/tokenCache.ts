import type { SessionStartResponse } from "@sayvox/shared";

/**
 * Holds one pre-fetched session (Story 2.4 AC 3) so pressing the hotkey never waits on
 * `/v1/session/start`. Scribe tokens expire 15 min after minting and are single-use, so a
 * session is handed out exactly once and dropped a minute before expiry.
 */
export class TokenCache {
  private cached: SessionStartResponse | undefined;
  /** In-flight prefetch. `claimed` = a take() already owns its result, so don't cache it. */
  private slot: { promise: Promise<SessionStartResponse>; claimed: boolean } | undefined;

  constructor(
    private readonly startSession: () => Promise<SessionStartResponse>,
    private readonly now: () => number = Date.now,
    private readonly marginMs = 60_000,
  ) {}

  private fresh(s: SessionStartResponse | undefined): s is SessionStartResponse {
    return !!s && Date.parse(s.expiresAt) - this.marginMs > this.now();
  }

  /** Fill the cache in the background (app start, wake, after each use). Never throws. */
  prefetch(): void {
    if (this.fresh(this.cached) || this.slot) return;
    const slot = { promise: this.startSession(), claimed: false };
    this.slot = slot;
    slot.promise
      .then((s) => {
        if (!slot.claimed) this.cached = s;
      })
      .catch(() => {
        // Offline / quota: the next take() surfaces the error to the user.
      })
      .finally(() => {
        if (this.slot === slot) this.slot = undefined;
      });
  }

  /** A session for this press: cached, the in-flight prefetch, or a fresh request. */
  async take(): Promise<SessionStartResponse> {
    let s = this.cached;
    this.cached = undefined;
    if (!this.fresh(s)) {
      const slot = this.slot;
      if (slot) {
        slot.claimed = true;
        this.slot = undefined;
        s = await slot.promise;
      } else {
        s = await this.startSession();
      }
    }
    this.prefetch();
    return s;
  }

  /** Drop the cached session (e.g. after a dictionary change, so keyterms are current). */
  invalidate(): void {
    this.cached = undefined;
    if (this.slot) this.slot.claimed = true;
    this.slot = undefined;
  }
}
