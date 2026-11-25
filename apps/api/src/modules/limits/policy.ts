/** Pure quota / session-length rules (Story 2.3, 2.5). No I/O, so they're fully unit-tested. */

/** Hard cap on one dictation regardless of plan (Story 2.3 default). */
export const MAX_SESSION_SECONDS = 300;

export interface PlanLimits {
  dailyCapMinutes: number;
  monthlyAudioMinutes: number;
}

export interface UsedSeconds {
  day: number;
  month: number;
}

export type QuotaDecision =
  { ok: true; maxSessionSeconds: number } | { ok: false; scope: "day" | "month"; resetAt: Date };

const nextUtcMidnight = (at: Date) =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1));
const nextUtcMonth = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));

/**
 * Allow a session only if both daily and monthly budgets have audio left, and cap the
 * session at what's left so one hold can't overshoot the quota (enforced by ElevenLabs via
 * `max_session_duration_seconds`). Below 1 s left counts as exhausted.
 */
export function decideQuota(plan: PlanLimits, used: UsedSeconds, at: Date): QuotaDecision {
  const dayLeft = plan.dailyCapMinutes * 60 - used.day;
  const monthLeft = plan.monthlyAudioMinutes * 60 - used.month;
  if (monthLeft < 1) return { ok: false, scope: "month", resetAt: nextUtcMonth(at) };
  if (dayLeft < 1) return { ok: false, scope: "day", resetAt: nextUtcMidnight(at) };
  return {
    ok: true,
    maxSessionSeconds: Math.floor(Math.min(MAX_SESSION_SECONDS, dayLeft, monthLeft)),
  };
}

/** Scribe realtime caps keyterms at 100 terms and 1 000 characters in total (research R1). */
export const KEYTERM_MAX_COUNT = 100;
export const KEYTERM_MAX_CHARS = 1_000;

/** Most recent terms first; stop at whichever limit is hit first. */
export function capKeyterms(termsNewestFirst: string[]): string[] {
  const out: string[] = [];
  let chars = 0;
  for (const t of termsNewestFirst) {
    if (out.length >= KEYTERM_MAX_COUNT) break;
    if (chars + t.length > KEYTERM_MAX_CHARS) continue;
    out.push(t);
    chars += t.length;
  }
  return out;
}

/** STT cost in USD: base rate, plus the keyterm surcharge when keyterms were sent. */
export function sttCostUsd(
  seconds: number,
  keytermsUsed: boolean,
  rates = { perHour: 0.22, keytermsPerHour: 0.08 },
): number {
  const perHour = rates.perHour + (keytermsUsed ? rates.keytermsPerHour : 0);
  return Math.round((seconds / 3600) * perHour * 100_000) / 100_000;
}
