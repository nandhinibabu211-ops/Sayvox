import {
  type CancelSubscriptionResponse,
  CheckoutRequest,
  type CheckoutResponse,
} from "@sayvox/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { Db } from "../../lib/db/client";
import { billingEvents, plans, settings, subscriptions, users } from "../../lib/db/schema";
import {
  type RazorpayClient,
  RazorpayError,
  type RazorpaySubscription,
  verifyWebhookSignature,
} from "../../lib/razorpay/client";
import { keys } from "../../lib/redis/keys";
import { ApiError } from "../../plugins/errors";
import { requireUser } from "../auth/plugin";
import { ENTITLED, entitledPlan, type PlanMap, storedStatus } from "./plans";

export interface BillingDeps {
  db: Db;
  redis: Redis;
  /** Undefined until Razorpay keys are configured: checkout then returns 503. */
  razorpay: RazorpayClient | undefined;
  planMap: PlanMap;
  webhookSecret: string | undefined;
  totalCount: number;
  now?: () => Date;
}

const PROVIDER = "razorpay";
const LINK_TTL_S = 24 * 3600;

interface WebhookEvent {
  event?: string;
  created_at?: number;
  payload?: { subscription?: { entity?: RazorpaySubscription } };
}

const noteValue = (notes: RazorpaySubscription["notes"], key: string): string | undefined =>
  notes && !Array.isArray(notes) && typeof notes[key] === "string" ? notes[key] : undefined;

/**
 * Recompute the user's plan from all their subscriptions (T090). On a downgrade, a preset
 * the new plan doesn't allow falls back to Balanced (Story 6.4).
 */
async function applyEntitlement(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  userId: string,
) {
  const subs = await tx
    .select({
      planId: subscriptions.planId,
      status: subscriptions.status,
      createdAt: subscriptions.createdAt,
    })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId));
  const planId = entitledPlan(subs);
  await tx.update(users).set({ planId }).where(eq(users.id, userId));
  const [plan] = await tx
    .select({ allowedPresets: plans.allowedPresets })
    .from(plans)
    .where(eq(plans.id, planId));
  const [s] = await tx
    .select({ preset: settings.preset })
    .from(settings)
    .where(eq(settings.userId, userId));
  if (plan && s && !plan.allowedPresets.includes(s.preset)) {
    await tx
      .update(settings)
      .set({ preset: "balanced", updatedAt: new Date() })
      .where(eq(settings.userId, userId));
  }
  return planId;
}

export function registerBillingRoutes(app: FastifyInstance, deps: BillingDeps): void {
  const { db, redis, planMap } = deps;
  const now = deps.now ?? (() => new Date());

  const requireRazorpay = (): RazorpayClient => {
    if (!deps.razorpay) throw new ApiError("PROVIDER_UNAVAILABLE", "Payments aren't available yet");
    return deps.razorpay;
  };

  const providerFailed = (req: FastifyRequest, err: unknown): never => {
    if (err instanceof RazorpayError) {
      req.log.warn({ providerStatus: err.status, providerCode: err.code }, "razorpay call failed");
      throw new ApiError("PROVIDER_UNAVAILABLE", "Payment service unavailable; try again");
    }
    throw err;
  };

  // T089: create a Razorpay subscription and hand back its hosted payment link.
  app.post("/v1/billing/checkout", async (req): Promise<CheckoutResponse> => {
    const user = requireUser(req);
    const { planId } = CheckoutRequest.parse(req.body);
    const razorpay = requireRazorpay();
    const razorpayPlan = planMap.razorpayPlanFor(planId);
    if (!razorpayPlan) throw new ApiError("VALIDATION_FAILED", "That plan can't be bought");

    const [current] = await db
      .select({ id: subscriptions.providerSubId })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, user.id), inArray(subscriptions.status, [...ENTITLED])))
      .limit(1);
    if (current) throw new ApiError("CONFLICT", "You already have an active subscription");

    const sub = await razorpay
      .createSubscription({
        planId: razorpayPlan,
        totalCount: deps.totalCount,
        expireBy: Math.floor(now().getTime() / 1000) + LINK_TTL_S,
        notes: { user_id: user.id, sayvox_plan: planId },
      })
      .catch((err: unknown) => providerFailed(req, err));
    if (!sub.short_url) throw new ApiError("PROVIDER_UNAVAILABLE", "Payment link unavailable");

    await db.insert(subscriptions).values({
      userId: user.id,
      provider: PROVIDER,
      providerSubId: sub.id,
      status: storedStatus(sub.status),
      planId,
      createdAt: now(),
    });
    return { url: sub.short_url };
  });

  // Cancel at the end of the paid period; the plan stays until then.
  app.post("/v1/billing/cancel", async (req): Promise<CancelSubscriptionResponse> => {
    const user = requireUser(req);
    const razorpay = requireRazorpay();
    const [row] = await db
      .select({ id: subscriptions.providerSubId, currentPeriodEnd: subscriptions.currentPeriodEnd })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, user.id), inArray(subscriptions.status, [...ENTITLED])))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);
    if (!row) throw new ApiError("NOT_FOUND", "No active subscription");
    await razorpay
      .cancelSubscription(row.id, true)
      .catch((err: unknown) => providerFailed(req, err));
    await db
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: true })
      .where(eq(subscriptions.providerSubId, row.id));
    return { currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null };
  });

  // T090: Razorpay webhook. Needs the raw body for the signature, so it gets its own
  // JSON parser in an encapsulated scope. Public (no user token); trusted by signature.
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) =>
      done(null, body),
    );

    scope.post("/v1/billing/webhook", { config: { public: true } }, async (req, reply) => {
      if (!deps.webhookSecret)
        throw new ApiError("PROVIDER_UNAVAILABLE", "Webhooks not configured");
      const raw = req.body as Buffer;
      const sig = req.headers["x-razorpay-signature"];
      if (
        !Buffer.isBuffer(raw) ||
        typeof sig !== "string" ||
        !verifyWebhookSignature(raw, sig, deps.webhookSecret)
      ) {
        req.log.warn("razorpay webhook rejected: bad signature");
        throw new ApiError("VALIDATION_FAILED", "Invalid signature");
      }
      const eventId = req.headers["x-razorpay-event-id"];
      if (typeof eventId !== "string" || !eventId || eventId.length > 128) {
        throw new ApiError("VALIDATION_FAILED", "Missing event id");
      }
      let ev: WebhookEvent;
      try {
        ev = JSON.parse(raw.toString("utf8")) as WebhookEvent;
      } catch {
        throw new ApiError("VALIDATION_FAILED", "Invalid JSON");
      }
      const entity = ev.payload?.subscription?.entity;
      if (!ev.event?.startsWith("subscription.") || !entity?.id) {
        return reply.code(200).send({ status: "ignored" });
      }

      const outcome = await db.transaction(async (tx) => {
        // Idempotency: retries carry the same event id. Payloads are never stored.
        const fresh = await tx
          .insert(billingEvents)
          .values({ provider: PROVIDER, eventId })
          .onConflictDoNothing()
          .returning({ id: billingEvents.eventId });
        if (fresh.length === 0) return "duplicate" as const;

        let [row] = await tx
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.providerSubId, entity.id))
          .for("update");
        if (!row) {
          // Created outside our checkout (or our insert was lost): find the user via notes.
          const userId = noteValue(entity.notes, "user_id");
          const planId = planMap.sayvoxPlanFor(entity.plan_id);
          if (!userId || !planId || !/^[0-9a-f-]{36}$/.test(userId)) return "unknown" as const;
          const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId));
          if (!u) return "unknown" as const;
          [row] = await tx
            .insert(subscriptions)
            .values({
              userId,
              provider: PROVIDER,
              providerSubId: entity.id,
              status: "incomplete",
              planId,
            })
            .returning();
        }
        if (!row) return "unknown" as const;

        // Webhooks can arrive out of order; never let an older event undo a newer one.
        const eventAt = new Date((ev.created_at ?? Math.floor(now().getTime() / 1000)) * 1000);
        if (row.lastEventAt && row.lastEventAt.getTime() > eventAt.getTime())
          return "stale" as const;

        const status = storedStatus(entity.status);
        await tx
          .update(subscriptions)
          .set({
            status,
            currentPeriodEnd: entity.current_end
              ? new Date(entity.current_end * 1000)
              : row.currentPeriodEnd,
            lastEventAt: eventAt,
            ...(status === "cancelled" ? { cancelAtPeriodEnd: false } : {}),
          })
          .where(eq(subscriptions.providerSubId, entity.id));
        const planId = await applyEntitlement(tx, row.userId);
        return { userId: row.userId, planId, status };
      });

      if (typeof outcome === "object") {
        // Settings response carries plan info and the preset may have been reset.
        await redis.del(keys.settings(outcome.userId)).catch(() => {});
        req.log.info(
          { event: ev.event, status: outcome.status, planId: outcome.planId },
          "subscription updated",
        );
      } else {
        req.log.info({ event: ev.event, outcome }, "razorpay webhook skipped");
      }
      return reply.code(200).send({ status: typeof outcome === "object" ? "applied" : outcome });
    });
  });
}

/** For account deletion: cancel now, and treat "already over" as done. */
export function createSubscriptionCanceller(razorpay: RazorpayClient) {
  return async (subs: { provider: string; providerSubId: string }[]): Promise<void> => {
    for (const s of subs) {
      if (s.provider !== PROVIDER) continue;
      try {
        await razorpay.cancelSubscription(s.providerSubId, false);
      } catch (err) {
        if (!(err instanceof RazorpayError) || err.status !== 400) throw err;
        const current = await razorpay.fetchSubscription(s.providerSubId);
        if (!["cancelled", "completed", "expired"].includes(current.status)) throw err;
      }
    }
  };
}
