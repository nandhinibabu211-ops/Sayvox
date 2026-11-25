import type { PlanOffer, UsageResponse } from "@sayvox/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Db } from "../../lib/db/client";
import { plans, subscriptions } from "../../lib/db/schema";
import { ApiError } from "../../plugins/errors";
import { requireUser } from "../auth/plugin";
import { LIVE, type PlanMap } from "../billing/plans";
import { getUsedSeconds } from "../limits/store";

export interface UsageDeps {
  db: Db;
  redis: Redis;
  planMap: PlanMap;
  billingAvailable: boolean;
  now?: () => Date;
}

const minutes = (seconds: number) => Math.round((seconds / 60) * 10) / 10;

/** GET /v1/usage (Story 2.8, T085). Quotas use UTC days and calendar months. */
export function registerUsageRoutes(app: FastifyInstance, deps: UsageDeps): void {
  const now = deps.now ?? (() => new Date());

  app.get("/v1/usage", async (req): Promise<UsageResponse> => {
    const user = requireUser(req);
    const at = now();
    const [allPlans, used, subs] = await Promise.all([
      deps.db.select().from(plans),
      getUsedSeconds(deps.redis, deps.db, user.id, at),
      deps.db
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, user.id), inArray(subscriptions.status, [...LIVE])))
        .orderBy(desc(subscriptions.createdAt))
        .limit(1),
    ]);
    const plan = allPlans.find((p) => p.id === user.planId);
    if (!plan) throw new ApiError("INTERNAL", "Unknown plan");
    const sub = subs[0];

    const upgrades: PlanOffer[] = deps.billingAvailable
      ? deps.planMap
          .purchasable()
          .filter((id) => id !== plan.id)
          .flatMap((id) => {
            const p = allPlans.find((x) => x.id === id);
            return p
              ? [
                  {
                    planId: p.id,
                    name: p.name,
                    priceCents: p.priceCents,
                    currency: p.currency,
                    dailyCapMinutes: p.dailyCapMinutes,
                    monthlyMinutes: p.monthlyAudioMinutes,
                  },
                ]
              : [];
          })
      : [];

    return {
      planId: plan.id,
      planName: plan.name,
      todayMinutes: minutes(used.day),
      dailyCapMinutes: plan.dailyCapMinutes,
      periodMinutes: minutes(used.month),
      monthlyMinutes: plan.monthlyAudioMinutes,
      dailyResetAt: new Date(
        Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1),
      ).toISOString(),
      periodResetAt: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)).toISOString(),
      subscription: sub
        ? {
            status: sub.status,
            currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          }
        : null,
      upgrades,
      billingAvailable: deps.billingAvailable,
    };
  });
}
