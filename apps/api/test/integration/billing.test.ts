import { CheckoutResponse, UsageResponse } from "@sayvox/shared";
import type { StartedRedisContainer } from "@testcontainers/redis";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";
import { settings, subscriptions, usageDaily, users } from "../../src/lib/db/schema";
import { createLogger } from "../../src/lib/logger";
import type { RazorpayClient, RazorpaySubscription } from "../../src/lib/razorpay/client";
import { createUserResolver } from "../../src/modules/auth/users";
import { PlanMap } from "../../src/modules/billing/plans";
import { createSubscriptionCanceller } from "../../src/modules/billing/routes";
import { startPostgres, startRedis, type PgFixture } from "./helpers";

const SECRET = "whsec_test";
const RZ_PLAN = "plan_ProMonthly";
let pg: PgFixture;
let redisC: StartedRedisContainer;
let redis: Redis;
let clock = new Date("2026-11-25T10:00:00Z");
let seq = 0;

/** In-memory Razorpay: enough for checkout / cancel. */
function fakeRazorpay() {
  const subs = new Map<string, RazorpaySubscription>();
  const calls: string[] = [];
  const client: RazorpayClient = {
    async createSubscription(i) {
      const id = `sub_${++seq}`;
      const s: RazorpaySubscription = {
        id,
        plan_id: i.planId,
        status: "created",
        current_end: null,
        short_url: `https://rzp.io/i/${id}`,
        notes: i.notes,
      };
      subs.set(id, s);
      calls.push(`create:${i.planId}:${i.totalCount}`);
      return s;
    },
    async fetchSubscription(id) {
      return subs.get(id)!;
    },
    async cancelSubscription(id, atCycleEnd) {
      calls.push(`cancel:${id}:${atCycleEnd}`);
      return subs.get(id)!;
    },
  };
  return { client, subs, calls };
}

function app(opts: { razorpay?: RazorpayClient | null } = {}) {
  const planMap = new PlanMap({ pro: RZ_PLAN });
  const razorpay = opts.razorpay === null ? undefined : (opts.razorpay ?? fakeRazorpay().client);
  return buildApp({
    logger: createLogger({ level: "silent" }),
    auth: {
      verify: async (t) => ({ sub: t, email: `${t}@example.com`, emailVerified: true }),
      resolveUser: createUserResolver(pg.handle.db, { cacheMs: 0 }),
    },
    usage: {
      db: pg.handle.db,
      redis,
      planMap,
      billingAvailable: Boolean(razorpay),
      now: () => clock,
    },
    billing: {
      db: pg.handle.db,
      redis,
      razorpay,
      planMap,
      webhookSecret: SECRET,
      totalCount: 120,
      now: () => clock,
    },
  });
}

const auth = (u: string) => ({ authorization: `Bearer ${u}` });

async function userBySub(sub: string) {
  const [u] = await pg.handle.db.select().from(users).where(eq(users.authProviderId, sub));
  return u!;
}

/** POST a signed webhook exactly as Razorpay would. */
function webhook(
  a: ReturnType<typeof app>,
  event: string,
  entity: Partial<RazorpaySubscription> & { id: string },
  opts: { eventId?: string; createdAt?: number; secret?: string } = {},
) {
  const body = JSON.stringify({
    entity: "event",
    event,
    contains: ["subscription"],
    created_at: opts.createdAt ?? Math.floor(clock.getTime() / 1000),
    payload: {
      subscription: { entity: { plan_id: RZ_PLAN, current_end: 1_767_225_600, ...entity } },
    },
  });
  return a.inject({
    method: "POST",
    url: "/v1/billing/webhook",
    headers: {
      "content-type": "application/json",
      "x-razorpay-signature": createHmac("sha256", opts.secret ?? SECRET)
        .update(body)
        .digest("hex"),
      "x-razorpay-event-id": opts.eventId ?? `evt_${++seq}`,
    },
    payload: body,
  });
}

/** Sign up a user and run checkout, returning the new Razorpay subscription id. */
async function checkout(a: ReturnType<typeof app>, sub: string): Promise<string> {
  const res = await a.inject({
    method: "POST",
    url: "/v1/billing/checkout",
    headers: auth(sub),
    payload: { planId: "pro" },
  });
  expect(res.statusCode).toBe(200);
  return CheckoutResponse.parse(res.json()).url.split("/").pop()!;
}

beforeAll(async () => {
  [pg, redisC] = await Promise.all([startPostgres(), startRedis()]);
  redis = new Redis(redisC.getConnectionUrl());
});
afterAll(async () => {
  await redis?.quit();
  await Promise.all([pg?.stop(), redisC?.stop()]);
});
beforeEach(async () => {
  clock = new Date("2026-11-25T10:00:00Z");
  await redis.flushall();
});

describe("GET /v1/usage (T085)", () => {
  it("reports minutes used, limits, resets and upgrade offers", async () => {
    const a = app();
    await a.inject({ method: "GET", url: "/v1/usage", headers: auth("u-usage") }); // create user
    const u = await userBySub("u-usage");
    await pg.handle.db.insert(usageDaily).values([
      { userId: u.id, day: "2026-11-25", audioSeconds: "270.00", requests: 9 },
      { userId: u.id, day: "2026-11-03", audioSeconds: "1800.00", requests: 40 },
    ]);
    await redis.flushall();
    const res = await a.inject({ method: "GET", url: "/v1/usage", headers: auth("u-usage") });
    expect(res.statusCode).toBe(200);
    const body = UsageResponse.parse(res.json());
    expect(body).toMatchObject({
      planId: "free",
      planName: "Free",
      todayMinutes: 4.5,
      dailyCapMinutes: 10,
      periodMinutes: 34.5,
      monthlyMinutes: 120,
      dailyResetAt: "2026-11-26T00:00:00.000Z",
      periodResetAt: "2026-12-01T00:00:00.000Z",
      subscription: null,
      billingAvailable: true,
    });
    expect(body.upgrades.map((p) => p.planId)).toEqual(["pro"]);
    await a.close();
  });

  it("offers no upgrades while billing isn't configured", async () => {
    const a = app({ razorpay: null });
    const body = UsageResponse.parse(
      (await a.inject({ method: "GET", url: "/v1/usage", headers: auth("u-nobill") })).json(),
    );
    expect(body).toMatchObject({ billingAvailable: false, upgrades: [] });
    await a.close();
  });
});

describe("POST /v1/billing/checkout (T089)", () => {
  it("creates a Razorpay subscription and returns its hosted link", async () => {
    const rz = fakeRazorpay();
    const a = app({ razorpay: rz.client });
    const id = await checkout(a, "u-co");
    expect(rz.calls).toEqual([`create:${RZ_PLAN}:120`]);
    expect(rz.subs.get(id)!.notes).toMatchObject({ sayvox_plan: "pro" });
    const [row] = await pg.handle.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.providerSubId, id));
    expect(row).toMatchObject({ status: "incomplete", planId: "pro" });
    expect((await userBySub("u-co")).planId).toBe("free"); // not paid yet
    await a.close();
  });

  it("returns 503 while billing isn't configured, 400 for an unknown plan", async () => {
    const off = app({ razorpay: null });
    expect(
      (
        await off.inject({
          method: "POST",
          url: "/v1/billing/checkout",
          headers: auth("u-x"),
          payload: { planId: "pro" },
        })
      ).statusCode,
    ).toBe(503);
    await off.close();
    const on = app();
    expect(
      (
        await on.inject({
          method: "POST",
          url: "/v1/billing/checkout",
          headers: auth("u-x"),
          payload: { planId: "free" },
        })
      ).statusCode,
    ).toBe(400);
    await on.close();
  });

  it("refuses a second subscription while one is active (409)", async () => {
    const a = app();
    const id = await checkout(a, "u-twice");
    await webhook(a, "subscription.activated", { id, status: "active" });
    const res = await a.inject({
      method: "POST",
      url: "/v1/billing/checkout",
      headers: auth("u-twice"),
      payload: { planId: "pro" },
    });
    expect(res.statusCode).toBe(409);
    await a.close();
  });
});

describe("POST /v1/billing/webhook (T090)", () => {
  it("activation upgrades the plan; usage shows the subscription", async () => {
    const a = app();
    const id = await checkout(a, "u-act");
    const res = await webhook(a, "subscription.activated", { id, status: "active" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "applied" });
    expect((await userBySub("u-act")).planId).toBe("pro");
    const usage = UsageResponse.parse(
      (await a.inject({ method: "GET", url: "/v1/usage", headers: auth("u-act") })).json(),
    );
    expect(usage).toMatchObject({
      planId: "pro",
      dailyCapMinutes: 120,
      subscription: {
        status: "active",
        currentPeriodEnd: "2026-01-01T00:00:00.000Z",
        cancelAtPeriodEnd: false,
      },
      upgrades: [],
    });
    await a.close();
  });

  it("rejects a bad signature and changes nothing", async () => {
    const a = app();
    const id = await checkout(a, "u-sig");
    const res = await webhook(
      a,
      "subscription.activated",
      { id, status: "active" },
      { secret: "wrong" },
    );
    expect(res.statusCode).toBe(400);
    expect((await userBySub("u-sig")).planId).toBe("free");
    await a.close();
  });

  it("is idempotent on the event id", async () => {
    const a = app();
    const id = await checkout(a, "u-dup");
    await webhook(a, "subscription.activated", { id, status: "active" }, { eventId: "evt_same" });
    // Simulate a later cancel being delivered, then a retry of the old activation.
    await webhook(
      a,
      "subscription.cancelled",
      { id, status: "cancelled" },
      { createdAt: Math.floor(clock.getTime() / 1000) + 60 },
    );
    const retry = await webhook(
      a,
      "subscription.activated",
      { id, status: "active" },
      { eventId: "evt_same" },
    );
    expect(retry.json()).toEqual({ status: "duplicate" });
    expect((await userBySub("u-dup")).planId).toBe("free");
    await a.close();
  });

  it("ignores an older event that arrives after a newer one", async () => {
    const a = app();
    const id = await checkout(a, "u-order");
    const t = Math.floor(clock.getTime() / 1000);
    await webhook(a, "subscription.cancelled", { id, status: "cancelled" }, { createdAt: t + 100 });
    const late = await webhook(
      a,
      "subscription.activated",
      { id, status: "active" },
      { createdAt: t },
    );
    expect(late.json()).toEqual({ status: "stale" });
    expect((await userBySub("u-order")).planId).toBe("free");
    await a.close();
  });

  it("keeps the plan while a renewal is retried (pending), drops it when halted and resets a paid-only preset", async () => {
    const a = app();
    const id = await checkout(a, "u-dun");
    const t = Math.floor(clock.getTime() / 1000);
    await webhook(a, "subscription.activated", { id, status: "active" }, { createdAt: t });
    const u = await userBySub("u-dun");
    await pg.handle.db.update(settings).set({ preset: "fastest" }).where(eq(settings.userId, u.id));

    await webhook(a, "subscription.pending", { id, status: "pending" }, { createdAt: t + 10 });
    expect((await userBySub("u-dun")).planId).toBe("pro");

    await webhook(a, "subscription.halted", { id, status: "halted" }, { createdAt: t + 20 });
    expect((await userBySub("u-dun")).planId).toBe("free");
    const [s] = await pg.handle.db.select().from(settings).where(eq(settings.userId, u.id));
    expect(s!.preset).toBe("balanced");

    // Customer fixes their card: Razorpay reactivates.
    await webhook(a, "subscription.activated", { id, status: "active" }, { createdAt: t + 30 });
    expect((await userBySub("u-dun")).planId).toBe("pro");
    await a.close();
  });

  it("finds the user from notes when the subscription wasn't created by our checkout", async () => {
    const a = app();
    await a.inject({ method: "GET", url: "/v1/usage", headers: auth("u-notes") });
    const u = await userBySub("u-notes");
    await webhook(a, "subscription.activated", {
      id: "sub_external",
      status: "active",
      notes: { user_id: u.id },
    });
    expect((await userBySub("u-notes")).planId).toBe("pro");
    await a.close();
  });

  it("acknowledges unrelated events and unknown subscriptions without changing anything", async () => {
    const a = app();
    expect(
      (await webhook(a, "subscription.activated", { id: "sub_nobody", status: "active" })).json(),
    ).toEqual({ status: "unknown" });
    await a.close();
  });
});

describe("cancellation", () => {
  it("POST /v1/billing/cancel cancels at period end; the plan stays until the cancelled webhook", async () => {
    const rz = fakeRazorpay();
    const a = app({ razorpay: rz.client });
    const id = await checkout(a, "u-cancel");
    await webhook(a, "subscription.activated", { id, status: "active" });
    const res = await a.inject({
      method: "POST",
      url: "/v1/billing/cancel",
      headers: auth("u-cancel"),
    });
    expect(res.statusCode).toBe(200);
    expect(rz.calls).toContain(`cancel:${id}:true`);
    expect((await userBySub("u-cancel")).planId).toBe("pro");
    const usage = UsageResponse.parse(
      (await a.inject({ method: "GET", url: "/v1/usage", headers: auth("u-cancel") })).json(),
    );
    expect(usage.subscription).toMatchObject({ cancelAtPeriodEnd: true });

    await webhook(
      a,
      "subscription.cancelled",
      { id, status: "cancelled" },
      { createdAt: Math.floor(clock.getTime() / 1000) + 5 },
    );
    expect((await userBySub("u-cancel")).planId).toBe("free");
    await a.close();
  });

  it("returns 404 without an active subscription", async () => {
    const a = app();
    expect(
      (await a.inject({ method: "POST", url: "/v1/billing/cancel", headers: auth("u-none") }))
        .statusCode,
    ).toBe(404);
    await a.close();
  });

  it("account deletion cancels immediately and tolerates already-cancelled subscriptions", async () => {
    const rz = fakeRazorpay();
    const s1 = await rz.client.createSubscription({
      planId: RZ_PLAN,
      totalCount: 1,
      expireBy: 0,
      notes: {},
    });
    const cancel = createSubscriptionCanceller({
      ...rz.client,
      cancelSubscription: async (id, atEnd) => {
        rz.calls.push(`cancel:${id}:${atEnd}`);
        if (id === "sub_gone") {
          const { RazorpayError } = await import("../../src/lib/razorpay/client");
          throw new RazorpayError(400, "BAD_REQUEST_ERROR");
        }
        return rz.subs.get(id)!;
      },
      fetchSubscription: async (id) =>
        id === "sub_gone"
          ? { id, plan_id: RZ_PLAN, status: "cancelled", current_end: null }
          : rz.subs.get(id)!,
    });
    await cancel([
      { provider: "razorpay", providerSubId: s1.id },
      { provider: "razorpay", providerSubId: "sub_gone" },
    ]);
    expect(rz.calls).toEqual(
      expect.arrayContaining([`cancel:${s1.id}:false`, "cancel:sub_gone:false"]),
    );
  });
});
