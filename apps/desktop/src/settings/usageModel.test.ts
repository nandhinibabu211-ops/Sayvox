import type { UsageResponse } from "@sayvox/shared";
import { describe, expect, it } from "vitest";
import { canCancel, meters, offerSummary, priceLabel, subscriptionLine } from "./usageModel";

const base: UsageResponse = {
  planId: "free",
  planName: "Free",
  todayMinutes: 4.5,
  dailyCapMinutes: 10,
  periodMinutes: 96,
  monthlyMinutes: 120,
  dailyResetAt: "2026-11-26T00:00:00.000Z",
  periodResetAt: "2026-12-01T00:00:00.000Z",
  subscription: null,
  upgrades: [],
  billingAvailable: true,
};
const TZ = "Asia/Kolkata";

describe("meters", () => {
  it("shows used / limit with levels at 80 % and 100 %", () => {
    const [today, month] = meters(base, TZ);
    expect(today).toMatchObject({ text: "4.5 of 10 min", percent: 45, level: "ok" });
    expect(month).toMatchObject({ text: "96 of 120 min", percent: 80, level: "warn" });
    const [full] = meters({ ...base, todayMinutes: 12 }, TZ);
    expect(full).toMatchObject({ percent: 100, level: "full" });
  });

  it("shows reset times in the user's time zone (UTC midnight = 5:30 am IST)", () => {
    const [today, month] = meters(base, TZ);
    expect(today!.resets).toMatch(/26 Nov.*5:30/);
    expect(month!.resets).toBe("Resets 1 Dec");
  });
});

describe("prices and offers", () => {
  const offer = {
    planId: "pro",
    name: "Pro",
    priceCents: 49_900,
    currency: "INR",
    dailyCapMinutes: 120,
    monthlyMinutes: 900,
  };

  it("formats INR without paise for whole amounts", () => {
    expect(priceLabel(offer)).toBe("₹499 / month");
  });

  it("doesn't show ₹0 while prices are placeholders", () => {
    expect(priceLabel({ ...offer, priceCents: 0 })).toBe("Price shown at checkout");
  });

  it("summarises limits", () => {
    expect(offerSummary(offer)).toBe("120 min a day, 900 min a month, all presets");
  });
});

describe("subscription line", () => {
  const sub = (s: Partial<NonNullable<UsageResponse["subscription"]>>) => ({
    ...base,
    planName: "Pro",
    subscription: {
      status: "active" as const,
      currentPeriodEnd: "2026-12-25T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      ...s,
    },
  });

  it("covers each status", () => {
    expect(subscriptionLine(base)).toBeNull();
    expect(subscriptionLine(sub({}), TZ)).toBe("Pro renews on 25 Dec.");
    expect(subscriptionLine(sub({ cancelAtPeriodEnd: true }), TZ)).toBe(
      "Cancelled. Pro stays until 25 Dec.",
    );
    expect(subscriptionLine(sub({ status: "past_due" }))).toMatch(/didn't go through/);
    expect(subscriptionLine(sub({ status: "halted" }))).toMatch(/paused/);
    expect(subscriptionLine(sub({ status: "incomplete" }))).toMatch(/Waiting/);
  });

  it("offers cancel only for an active, not-yet-cancelled subscription", () => {
    expect(canCancel(sub({}))).toBe(true);
    expect(canCancel(sub({ cancelAtPeriodEnd: true }))).toBe(false);
    expect(canCancel(sub({ status: "past_due" }))).toBe(false);
    expect(canCancel(base)).toBe(false);
  });
});
