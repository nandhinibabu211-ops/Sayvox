import { and, gte, lt, sql } from "drizzle-orm";
import type { Db } from "../lib/db/client";
import { usageDaily } from "../lib/db/schema";

/**
 * Weekly audio reconciliation (T096): the audio seconds Sayvox recorded (usage_daily) vs the
 * speech-to-text minutes ElevenLabs reports for the same window. A gap means quota or cost
 * accounting is off (sessions not ended, keys used elsewhere, client bugs).
 *
 * Only totals are compared; nothing per user leaves the database. Known gaps: deleted
 * accounts take their usage rows with them (ON DELETE CASCADE), and sessions still open at
 * the window edge land in the next window, so small drift is normal.
 */

export interface Window {
  /** Inclusive, UTC midnight. */
  from: Date;
  /** Exclusive, UTC midnight. */
  to: Date;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** The 7 full UTC days before `now`. */
export function lastWeek(now: Date): Window {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { from: new Date(to.getTime() - 7 * 86_400_000), to };
}

export async function recordedAudioSeconds(db: Db, w: Window): Promise<number> {
  const [row] = await db
    .select({ s: sql<string | null>`sum(${usageDaily.audioSeconds})` })
    .from(usageDaily)
    .where(and(gte(usageDaily.day, day(w.from)), lt(usageDaily.day, day(w.to))));
  return Number(row?.s ?? 0);
}

const STT_KEY = /speech[ _-]?to[ _-]?text|\bstt\b|transcri/i;

/**
 * ElevenLabs usage stats, `minutes_used` broken down by product type (research R1 / T096).
 * Returns null when no speech-to-text series is present, so the job reports "unknown"
 * instead of a false alarm. The endpoint is marked deprecated in the docs; if it stops
 * answering, this returns null and the runbook says to compare in the dashboard by hand.
 */
export async function providerSttMinutes(opts: {
  apiKey: string;
  window: Window;
  fetchFn?: typeof fetch;
}): Promise<number | null> {
  const q = new URLSearchParams({
    start_unix: String(opts.window.from.getTime()),
    end_unix: String(opts.window.to.getTime()),
    metric: "minutes_used",
    breakdown_type: "product_type",
    aggregation_interval: "cumulative",
  });
  const res = await (opts.fetchFn ?? fetch)(
    `https://api.elevenlabs.io/v1/usage/character-stats?${q.toString()}`,
    { headers: { "xi-api-key": opts.apiKey }, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) return null;
  const body = (await res.json()) as { usage?: Record<string, unknown> };
  const series = Object.entries(body.usage ?? {}).find(([k]) => STT_KEY.test(k))?.[1];
  if (!Array.isArray(series)) return null;
  return series.reduce<number>((sum, v) => sum + (typeof v === "number" ? v : 0), 0);
}

export interface Reconciliation {
  job: "reconcile";
  from: string;
  to: string;
  recordedMinutes: number;
  providerMinutes: number | null;
  /** (provider - recorded) / provider, in percent; null when unknown. */
  driftPct: number | null;
  status: "ok" | "drift" | "unknown";
}

/** Drift above `tolerancePct` (default 5 %) in either direction is reported. */
export function reconcile(
  w: Window,
  recordedSeconds: number,
  providerMinutes: number | null,
  tolerancePct = 5,
): Reconciliation {
  const recordedMinutes = Math.round((recordedSeconds / 60) * 10) / 10;
  const base = { job: "reconcile" as const, from: day(w.from), to: day(w.to), recordedMinutes };
  if (providerMinutes === null) {
    return { ...base, providerMinutes, driftPct: null, status: "unknown" };
  }
  const driftPct =
    providerMinutes === 0
      ? recordedMinutes === 0
        ? 0
        : -100
      : Math.round(((providerMinutes - recordedMinutes) / providerMinutes) * 1000) / 10;
  return {
    ...base,
    providerMinutes,
    driftPct,
    status: Math.abs(driftPct) > tolerancePct ? "drift" : "ok",
  };
}
