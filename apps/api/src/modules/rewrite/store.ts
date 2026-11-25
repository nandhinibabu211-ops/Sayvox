import type { Mode, Preset } from "@sayvox/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../lib/db/client";
import { sessions, settings, usageDaily } from "../../lib/db/schema";

export interface RewriteResult {
  mode: Mode;
  targetApp: string;
  modelUsed: string | null;
  fallbackUsed: boolean;
  inputTokens: number;
  outputTokens: number;
  ttftMs: number | null;
  totalMs: number;
  llmCostUsd: number;
}

/** What /v1/rewrite needs from storage; a DB implementation below, fakes in tests. */
export interface RewriteStore {
  /** The session's status if it belongs to `userId`, else null. */
  sessionStatus(userId: string, sessionId: string): Promise<string | null>;
  preset(userId: string): Promise<Preset>;
  record(userId: string, sessionId: string, result: RewriteResult, at: Date): Promise<void>;
}

export function createDbRewriteStore(db: Db): RewriteStore {
  return {
    async sessionStatus(userId, sessionId) {
      const [row] = await db
        .select({ status: sessions.status })
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
      return row?.status ?? null;
    },
    async preset(userId) {
      const [row] = await db
        .select({ preset: settings.preset })
        .from(settings)
        .where(eq(settings.userId, userId));
      return row?.preset ?? "balanced";
    },
    async record(userId, sessionId, r, at) {
      // Metadata only (Constitution I): no transcript or rewrite text.
      await db.transaction(async (tx) => {
        await tx
          .update(sessions)
          .set({
            mode: r.mode,
            targetApp: r.targetApp,
            modelUsed: r.modelUsed,
            fallbackUsed: r.fallbackUsed,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            ttftMs: r.ttftMs,
            totalMs: r.totalMs,
          })
          .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
        if (r.llmCostUsd > 0) {
          await tx
            .insert(usageDaily)
            .values({
              userId,
              day: at.toISOString().slice(0, 10),
              llmCostUsd: r.llmCostUsd.toFixed(5),
            })
            .onConflictDoUpdate({
              target: [usageDaily.userId, usageDaily.day],
              set: { llmCostUsd: sql`${usageDaily.llmCostUsd} + excluded.llm_cost_usd` },
            });
        }
      });
    },
  };
}
