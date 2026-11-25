import { and, eq, sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { Db } from "../../lib/db/client";
import { sessions, usageDaily } from "../../lib/db/schema";
import { sttCostUsd } from "../limits/policy";
import { addUsedSeconds } from "../limits/store";

/**
 * Charge the audio the proxy metered for one session (audit SEC-03). This is the only place
 * usage is added: `/v1/session/:id/end` records the result and timings but no longer trusts
 * the client's `audioSeconds`. Runs once per session (tickets are single-use); the
 * `metered_at IS NULL` guard makes a repeat a no-op anyway.
 */
export interface ChargeInput {
  userId: string;
  sessionId: string;
  seconds: number;
  keytermsUsed: boolean;
  at: Date;
}

export type ChargeAudio = (c: ChargeInput) => Promise<void>;

export function createAudioCharger(db: Db, redis: Redis): ChargeAudio {
  return async ({ userId, sessionId, seconds, keytermsUsed, at }) => {
    const s = Math.round(Math.max(0, seconds) * 100) / 100;
    const charged = await db.transaction(async (tx) => {
      const updated = await tx
        .update(sessions)
        .set({ audioSeconds: s.toFixed(2), meteredAt: at })
        .where(
          and(
            eq(sessions.id, sessionId),
            eq(sessions.userId, userId),
            sql`${sessions.meteredAt} IS NULL`,
          ),
        )
        .returning({ id: sessions.id });
      if (updated.length === 0) return false;
      if (s > 0) {
        await tx
          .insert(usageDaily)
          .values({
            userId,
            day: at.toISOString().slice(0, 10),
            audioSeconds: s.toFixed(2),
            sttCostUsd: sttCostUsd(s, keytermsUsed).toFixed(5),
          })
          .onConflictDoUpdate({
            target: [usageDaily.userId, usageDaily.day],
            set: {
              audioSeconds: sql`${usageDaily.audioSeconds} + excluded.audio_seconds`,
              sttCostUsd: sql`${usageDaily.sttCostUsd} + excluded.stt_cost_usd`,
            },
          });
      }
      return true;
    });
    if (charged) await addUsedSeconds(redis, userId, s, at);
  };
}
