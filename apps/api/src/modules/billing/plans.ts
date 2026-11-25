import type { RazorpayStatus } from "../../lib/razorpay/client";

/**
 * Razorpay plan ↔ Sayvox plan mapping (T087). Razorpay plans are created in the Razorpay
 * dashboard (test mode first); their ids go in `RAZORPAY_PLAN_IDS` as
 * `{"pro":"plan_XXXX"}`. Nothing here hard-codes prices: the Razorpay plan holds the
 * amount, `plans.price_cents` is for display.
 */
export class PlanMap {
  private readonly toRazorpay: ReadonlyMap<string, string>;
  private readonly toSayvox: ReadonlyMap<string, string>;

  constructor(map: Record<string, string>) {
    this.toRazorpay = new Map(Object.entries(map));
    this.toSayvox = new Map(Object.entries(map).map(([s, r]) => [r, s]));
  }

  razorpayPlanFor(sayvoxPlanId: string): string | undefined {
    return this.toRazorpay.get(sayvoxPlanId);
  }

  sayvoxPlanFor(razorpayPlanId: string): string | undefined {
    return this.toSayvox.get(razorpayPlanId);
  }

  /** Sayvox plans that can be bought right now. */
  purchasable(): string[] {
    return [...this.toRazorpay.keys()];
  }
}

export type StoredStatus = "active" | "past_due" | "cancelled" | "incomplete" | "halted";

/**
 * Razorpay status → our stored status (data-model.md `subscriptions.status`).
 * `pending` (a renewal charge failed, Razorpay is retrying) keeps the plan as a grace
 * period; `halted` (retries exhausted) and `paused` don't.
 */
export function storedStatus(s: RazorpayStatus): StoredStatus {
  switch (s) {
    case "created":
    case "authenticated":
      return "incomplete";
    case "active":
      return "active";
    case "pending":
      return "past_due";
    case "halted":
    case "paused":
      return "halted";
    case "cancelled":
    case "completed":
    case "expired":
      return "cancelled";
  }
}

/** Statuses that grant the paid plan. */
export const ENTITLED: readonly StoredStatus[] = ["active", "past_due"];

/** Statuses that may still charge the customer (cancel these on account deletion). */
export const LIVE: readonly StoredStatus[] = ["active", "past_due", "incomplete", "halted"];

export interface SubscriptionRow {
  planId: string;
  status: StoredStatus;
  createdAt: Date;
}

/** The plan a user should be on, given all their subscriptions. */
export function entitledPlan(subs: readonly SubscriptionRow[], freePlan = "free"): string {
  const live = subs
    .filter((s) => ENTITLED.includes(s.status))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return live[0]?.planId ?? freePlan;
}
