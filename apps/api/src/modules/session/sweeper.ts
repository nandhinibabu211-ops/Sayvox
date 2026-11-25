import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../../lib/db/client";
import { sessions } from "../../lib/db/schema";
import { SCRIBE_TOKEN_TTL_MS } from "../../lib/elevenlabs/token";
import { MAX_SESSION_SECONDS } from "../limits/policy";

/**
 * A `started` session older than token TTL + max session length can no longer be used:
 * it was a pre-fetched session that was never pressed, or the client crashed before
 * `/end`. Mark it `abandoned` (Story 2.4 AC 4). Idempotent, so every instance may run it.
 */
export const ABANDON_AFTER_MS = SCRIBE_TOKEN_TTL_MS + MAX_SESSION_SECONDS * 1000;

export async function sweepAbandonedSessions(db: Db, at: Date = new Date()): Promise<number> {
  const cutoff = new Date(at.getTime() - ABANDON_AFTER_MS);
  const rows = await db
    .update(sessions)
    .set({ status: "abandoned", endedAt: at })
    .where(and(eq(sessions.status, "started"), lt(sessions.startedAt, cutoff)))
    .returning({ id: sessions.id });
  return rows.length;
}

/** Run every minute in-process (Cloud Scheduler can replace this later). */
export function startSweeper(
  db: Db,
  onError: (err: unknown) => void,
  everyMs = 60_000,
): () => void {
  const timer = setInterval(() => {
    sweepAbandonedSessions(db).catch(onError);
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
