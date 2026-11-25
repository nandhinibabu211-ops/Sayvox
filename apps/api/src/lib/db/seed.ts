import { sql } from "drizzle-orm";
import type { Db } from "./client";
import { plans } from "./schema";

/**
 * Plans. `free` follows ADR-004 (10 min/day, 120 min/month, Balanced + Cheapest, 25 terms).
 * `pro` values are PLACEHOLDERS until the owner sets paid-plan prices and limits (Phase 4).
 */
export const PLAN_SEED = [
  {
    id: "free",
    name: "Free",
    monthlyAudioMinutes: 120,
    dailyCapMinutes: 10,
    allowedPresets: ["balanced", "cheapest"] as ("fastest" | "balanced" | "cheapest")[],
    dictionaryLimit: 25,
    priceCents: 0,
    currency: "INR",
  },
  {
    id: "pro",
    name: "Pro",
    monthlyAudioMinutes: 900,
    dailyCapMinutes: 120,
    allowedPresets: ["fastest", "balanced", "cheapest"] as ("fastest" | "balanced" | "cheapest")[],
    dictionaryLimit: 500,
    priceCents: 0,
    currency: "INR",
  },
];

/** Idempotent: re-running updates limits in place. */
export async function seedPlans(db: Db): Promise<void> {
  await db
    .insert(plans)
    .values(PLAN_SEED)
    .onConflictDoUpdate({
      target: plans.id,
      set: {
        name: sql`excluded.name`,
        monthlyAudioMinutes: sql`excluded.monthly_audio_minutes`,
        dailyCapMinutes: sql`excluded.daily_cap_minutes`,
        allowedPresets: sql`excluded.allowed_presets`,
        dictionaryLimit: sql`excluded.dictionary_limit`,
        priceCents: sql`excluded.price_cents`,
        currency: sql`excluded.currency`,
      },
    });
}
