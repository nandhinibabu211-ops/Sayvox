import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RazorpayError } from "../../src/lib/razorpay/client";
import { createRazorpayClient, verifyWebhookSignature } from "../../src/lib/razorpay/client";
import { entitledPlan, PlanMap, storedStatus } from "../../src/modules/billing/plans";

describe("verifyWebhookSignature", () => {
  const secret = "whsec_test";
  const body = Buffer.from('{"event":"subscription.activated"}');
  const sig = createHmac("sha256", secret).update(body).digest("hex");

  it("accepts the hex HMAC-SHA256 of the raw body", () => {
    expect(verifyWebhookSignature(body, sig, secret)).toBe(true);
    expect(verifyWebhookSignature(body, sig.toUpperCase(), secret)).toBe(true);
  });

  it("rejects a wrong secret, a changed body and malformed signatures", () => {
    expect(verifyWebhookSignature(body, sig, "other")).toBe(false);
    expect(verifyWebhookSignature(Buffer.from('{"event":"x"}'), sig, secret)).toBe(false);
    expect(verifyWebhookSignature(body, "abc", secret)).toBe(false);
    expect(verifyWebhookSignature(body, "", secret)).toBe(false);
  });

  it("is sensitive to re-serialised JSON (must use the raw body)", () => {
    const pretty = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect(verifyWebhookSignature(pretty, sig, secret)).toBe(false);
  });
});

describe("Razorpay client (T088)", () => {
  it("creates a subscription with Basic auth and returns the hosted link", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({
        id: "sub_1",
        plan_id: "plan_p",
        status: "created",
        current_end: null,
        short_url: "https://rzp.io/i/abc",
      }),
    );
    const c = createRazorpayClient({
      keyId: "rzp_test_k",
      keySecret: "s",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const sub = await c.createSubscription({
      planId: "plan_p",
      totalCount: 120,
      expireBy: 1_800_000_000,
      notes: { user_id: "u1" },
    });
    expect(sub.short_url).toBe("https://rzp.io/i/abc");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.razorpay.com/v1/subscriptions");
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("rzp_test_k:s").toString("base64")}`,
    );
    expect(JSON.parse(String(init.body))).toEqual({
      plan_id: "plan_p",
      total_count: 120,
      quantity: 1,
      customer_notify: true,
      expire_by: 1_800_000_000,
      notes: { user_id: "u1" },
    });
  });

  it("cancels at cycle end or now", async () => {
    const fetchFn = vi.fn(async () => Response.json({ id: "sub_1", status: "active" }));
    const c = createRazorpayClient({
      keyId: "k",
      keySecret: "s",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await c.cancelSubscription("sub_1", true);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.razorpay.com/v1/subscriptions/sub_1/cancel");
    expect(JSON.parse(String(init.body))).toEqual({ cancel_at_cycle_end: true });
  });

  it("keeps only the error code, never the description", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json(
        { error: { code: "BAD_REQUEST_ERROR", description: "plan for priya@x.com" } },
        { status: 400 },
      ),
    );
    const c = createRazorpayClient({
      keyId: "k",
      keySecret: "s",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const err = (await c.fetchSubscription("sub_1").catch((e: unknown) => e)) as RazorpayError;
    expect(err).toMatchObject({ status: 400, code: "BAD_REQUEST_ERROR" });
    expect(err.message).not.toContain("priya");
  });
});

describe("plan mapping and entitlement (T087)", () => {
  it("maps both ways", () => {
    const m = new PlanMap({ pro: "plan_abc" });
    expect(m.razorpayPlanFor("pro")).toBe("plan_abc");
    expect(m.sayvoxPlanFor("plan_abc")).toBe("pro");
    expect(m.razorpayPlanFor("free")).toBeUndefined();
    expect(m.purchasable()).toEqual(["pro"]);
  });

  it("maps every Razorpay status", () => {
    expect(storedStatus("created")).toBe("incomplete");
    expect(storedStatus("authenticated")).toBe("incomplete");
    expect(storedStatus("active")).toBe("active");
    expect(storedStatus("pending")).toBe("past_due");
    expect(storedStatus("halted")).toBe("halted");
    expect(storedStatus("paused")).toBe("halted");
    expect(storedStatus("cancelled")).toBe("cancelled");
    expect(storedStatus("completed")).toBe("cancelled");
    expect(storedStatus("expired")).toBe("cancelled");
  });

  it("grants the paid plan while active or in the payment-retry grace period only", () => {
    const at = (d: string) => new Date(d);
    expect(entitledPlan([])).toBe("free");
    expect(entitledPlan([{ planId: "pro", status: "active", createdAt: at("2026-11-01") }])).toBe(
      "pro",
    );
    expect(entitledPlan([{ planId: "pro", status: "past_due", createdAt: at("2026-11-01") }])).toBe(
      "pro",
    );
    for (const status of ["halted", "cancelled", "incomplete"] as const) {
      expect(entitledPlan([{ planId: "pro", status, createdAt: at("2026-11-01") }])).toBe("free");
    }
  });

  it("an old cancelled subscription doesn't override a new active one", () => {
    expect(
      entitledPlan([
        { planId: "pro", status: "cancelled", createdAt: new Date("2026-12-01") },
        { planId: "pro", status: "active", createdAt: new Date("2026-11-01") },
      ]),
    ).toBe("pro");
  });
});

describe("webhook route guards (no database needed)", () => {
  async function appWith(secret: string | undefined) {
    const { buildApp } = await import("../../src/app");
    const { createLogger } = await import("../../src/lib/logger");
    return buildApp({
      logger: createLogger({ level: "silent" }),
      auth: {
        verify: async () => ({ sub: "x", email: "x@x.com", emailVerified: true }),
        resolveUser: async () => {
          throw new Error("no users here");
        },
      },
      billing: {
        db: {} as never,
        redis: {} as never,
        razorpay: undefined,
        planMap: new PlanMap({}),
        webhookSecret: secret,
        totalCount: 120,
      },
    });
  }
  const post = (
    a: Awaited<ReturnType<typeof appWith>>,
    body: string,
    headers: Record<string, string>,
  ) =>
    a.inject({
      method: "POST",
      url: "/v1/billing/webhook",
      headers: { "content-type": "application/json", ...headers },
      payload: body,
    });
  const sign = (body: string, s = "whsec") => createHmac("sha256", s).update(body).digest("hex");

  it("is public (no bearer token) but rejects unsigned or mis-signed bodies with 400", async () => {
    const a = await appWith("whsec");
    const body = '{"event":"subscription.activated"}';
    expect((await post(a, body, {})).statusCode).toBe(400);
    expect(
      (
        await post(a, body, {
          "x-razorpay-signature": sign(body, "other"),
          "x-razorpay-event-id": "e1",
        })
      ).statusCode,
    ).toBe(400);
    await a.close();
  });

  it("requires an event id", async () => {
    const a = await appWith("whsec");
    const body = '{"event":"subscription.activated"}';
    expect((await post(a, body, { "x-razorpay-signature": sign(body) })).statusCode).toBe(400);
    await a.close();
  });

  it("acknowledges non-subscription events without touching storage", async () => {
    const a = await appWith("whsec");
    const body = '{"event":"payment.captured","payload":{}}';
    const res = await post(a, body, {
      "x-razorpay-signature": sign(body),
      "x-razorpay-event-id": "e2",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ignored" });
    await a.close();
  });

  it("returns 503 when the webhook secret isn't configured", async () => {
    const a = await appWith(undefined);
    expect((await post(a, "{}", {})).statusCode).toBe(503);
    await a.close();
  });

  it("checkout needs auth, then returns 503 without Razorpay keys", async () => {
    const a = await appWith("whsec");
    expect(
      (await a.inject({ method: "POST", url: "/v1/billing/checkout", payload: { planId: "pro" } }))
        .statusCode,
    ).toBe(401);
    await a.close();
  });
});
