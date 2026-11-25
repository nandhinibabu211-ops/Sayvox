import { and, gte, lt, sql } from "drizzle-orm";
import type { Db } from "../lib/db/client";
import { usageDaily } from "../lib/db/schema";

/**
 * Daily spend check (T097, architecture section 16): yesterday's provider cost (ElevenLabs
 * STT + OpenRouter LLM, as recorded in usage_daily) vs the 7 days before it. More than 2x
 * the 7-day average raises an alert through a log-based metric (infra/observability).
 * A small floor keeps the first quiet days of launch from paging anyone.
 */

export interface SpendCheck {
  job: "spend";
  day: string;
  spendUsd: number;
  avg7Usd: number;
  ratio: number | null;
  alert: boolean;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function dailySpend(db: Db, from: Date, to: Date): Promise<Map<string, number>> {
  const rows = await db
    .select({
      day: usageDaily.day,
      usd: sql<string>`sum(${usageDaily.sttCostUsd} + ${usageDaily.llmCostUsd})`,
    })
    .from(usageDaily)
    .where(and(gte(usageDaily.day, iso(from)), lt(usageDaily.day, iso(to))))
    .groupBy(usageDaily.day);
  return new Map(rows.map((r) => [r.day, Number(r.usd)]));
}

export function checkSpend(
  now: Date,
  byDay: Map<string, number>,
  opts: { factor?: number; floorUsd?: number } = {},
): SpendCheck {
  const factor = opts.factor ?? 2;
  const floorUsd = opts.floorUsd ?? 1;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayAt = (n: number) => iso(new Date(today - n * 86_400_000));
  const spendUsd = byDay.get(dayAt(1)) ?? 0;
  let prev = 0;
  for (let n = 2; n <= 8; n++) prev += byDay.get(dayAt(n)) ?? 0;
  const avg7Usd = prev / 7;
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    job: "spend",
    day: dayAt(1),
    spendUsd: round(spendUsd),
    avg7Usd: round(avg7Usd),
    ratio: avg7Usd > 0 ? Math.round((spendUsd / avg7Usd) * 100) / 100 : null,
    alert: spendUsd >= floorUsd && spendUsd > factor * avg7Usd,
  };
}

/** The 8 days the check needs: yesterday and the 7 before it. */
export function spendWindow(now: Date): { from: Date; to: Date } {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { from: new Date(to.getTime() - 8 * 86_400_000), to };
}
