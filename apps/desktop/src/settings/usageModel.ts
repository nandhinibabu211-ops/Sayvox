import type { PlanOffer, UsageResponse } from "@sayvox/shared";

/** Pure view model for Settings → Usage & Plan (T085). */

export interface Meter {
  label: string;
  used: number;
  limit: number;
  /** 0–100, clamped. */
  percent: number;
  level: "ok" | "warn" | "full";
  text: string;
  resets: string;
}

const fmtMin = (m: number) => (Number.isInteger(m) ? String(m) : m.toFixed(1));

function meter(label: string, used: number, limit: number, resets: string): Meter {
  const percent = limit > 0 ? Math.min(100, Math.max(0, (used / limit) * 100)) : 100;
  return {
    label,
    used,
    limit,
    percent: Math.round(percent),
    level: percent >= 100 ? "full" : percent >= 80 ? "warn" : "ok",
    text: `${fmtMin(used)} of ${limit} min`,
    resets,
  };
}

const dateFmt = (iso: string, timeZone?: string) =>
  new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    ...(timeZone ? { timeZone } : {}),
  });

const timeFmt = (iso: string, timeZone?: string) =>
  new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });

export function meters(u: UsageResponse, timeZone?: string): Meter[] {
  return [
    meter(
      "Today",
      u.todayMinutes,
      u.dailyCapMinutes,
      `Resets ${timeFmt(u.dailyResetAt, timeZone)}`,
    ),
    meter(
      "This month",
      u.periodMinutes,
      u.monthlyMinutes,
      `Resets ${dateFmt(u.periodResetAt, timeZone)}`,
    ),
  ];
}

/** "₹499 / month", or a neutral line while prices are still placeholders (0). */
export function priceLabel(p: PlanOffer): string {
  if (p.priceCents <= 0) return "Price shown at checkout";
  const amount = p.priceCents / 100;
  const formatted = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: p.currency,
    maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  }).format(amount);
  return `${formatted} / month`;
}

export function offerSummary(p: PlanOffer): string {
  return `${p.dailyCapMinutes} min a day, ${p.monthlyMinutes} min a month, all presets`;
}

/** One line about the subscription, or null on the free plan. */
export function subscriptionLine(u: UsageResponse, timeZone?: string): string | null {
  const s = u.subscription;
  if (!s) return null;
  const end = s.currentPeriodEnd ? dateFmt(s.currentPeriodEnd, timeZone) : null;
  switch (s.status) {
    case "active":
      if (s.cancelAtPeriodEnd)
        return end ? `Cancelled. ${u.planName} stays until ${end}.` : "Cancelled.";
      return end ? `${u.planName} renews on ${end}.` : `${u.planName} is active.`;
    case "past_due":
      return "Your last payment didn't go through. Razorpay will retry; update your card to keep your plan.";
    case "halted":
      return "Payments failed and your plan was paused. Update your card in the Razorpay link to restore it.";
    case "incomplete":
      return "Waiting for your payment to finish…";
    case "cancelled":
      return null;
  }
}

export const canCancel = (u: UsageResponse) =>
  u.subscription?.status === "active" && !u.subscription.cancelAtPeriodEnd;
