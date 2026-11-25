import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Razorpay Subscriptions API (ADR-003, T088). Verified against razorpay.com/docs on
 * 2026-11-25: `POST /v1/subscriptions` → `short_url` for the hosted authorisation payment;
 * `POST /v1/subscriptions/:id/cancel` with `cancel_at_cycle_end`; HTTP Basic with key id +
 * secret. Keys exist only on the backend (Constitution II).
 */

const BASE = "https://api.razorpay.com/v1";

export type RazorpayStatus =
  | "created"
  | "authenticated"
  | "active"
  | "pending"
  | "halted"
  | "cancelled"
  | "completed"
  | "expired"
  | "paused";

export interface RazorpaySubscription {
  id: string;
  plan_id: string;
  status: RazorpayStatus;
  /** Unix seconds: end of the current billing cycle (null before the first charge). */
  current_end: number | null;
  short_url?: string;
  notes?: Record<string, string> | unknown[];
}

export class RazorpayError extends Error {
  constructor(
    readonly status: number | "timeout" | "network",
    readonly code?: string,
  ) {
    super(`razorpay request failed: ${status}${code ? ` ${code}` : ""}`);
    this.name = "RazorpayError";
  }
}

export interface CreateSubscription {
  planId: string;
  /** Billing cycles to charge (Razorpay requires a count or an end date). */
  totalCount: number;
  /** Unix seconds: the payment link stops working after this. */
  expireBy: number;
  /** ≤ 15 pairs; we set user_id and sayvox_plan so webhooks can find the user. */
  notes: Record<string, string>;
}

export interface RazorpayClient {
  createSubscription(input: CreateSubscription): Promise<RazorpaySubscription>;
  fetchSubscription(id: string): Promise<RazorpaySubscription>;
  /** `atCycleEnd` true: keep the plan until the period ends; false: cancel now. */
  cancelSubscription(id: string, atCycleEnd: boolean): Promise<RazorpaySubscription>;
}

export function createRazorpayClient(opts: {
  keyId: string;
  keySecret: string;
  fetchFn?: typeof fetch;
  baseUrl?: string;
}): RazorpayClient {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = opts.baseUrl ?? BASE;
  const auth = `Basic ${Buffer.from(`${opts.keyId}:${opts.keySecret}`).toString("base64")}`;

  async function call(method: "GET" | "POST", path: string, body?: unknown) {
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, {
        method,
        headers: { authorization: auth, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new RazorpayError((err as Error).name === "TimeoutError" ? "timeout" : "network");
    }
    const json = (await res.json().catch(() => ({}))) as {
      error?: { code?: string };
    } & RazorpaySubscription;
    // Error descriptions can echo request data; keep only the code.
    if (!res.ok) throw new RazorpayError(res.status, json.error?.code);
    return json;
  }

  return {
    createSubscription: (i) =>
      call("POST", "/subscriptions", {
        plan_id: i.planId,
        total_count: i.totalCount,
        quantity: 1,
        customer_notify: true,
        expire_by: i.expireBy,
        notes: i.notes,
      }),
    fetchSubscription: (id) => call("GET", `/subscriptions/${encodeURIComponent(id)}`),
    cancelSubscription: (id, atCycleEnd) =>
      call("POST", `/subscriptions/${encodeURIComponent(id)}/cancel`, {
        cancel_at_cycle_end: atCycleEnd,
      }),
  };
}

/**
 * Webhook signature: hex HMAC-SHA256 of the *raw* request body with the webhook secret,
 * sent in `X-Razorpay-Signature`. Constant-time compare.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signature: string,
  secret: string,
): boolean {
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
