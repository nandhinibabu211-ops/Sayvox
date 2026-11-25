import type { CheckoutResponse, UsageResponse } from "@sayvox/shared";
import { openUrl } from "@tauri-apps/plugin-opener";
import { errorMessage, h, type SettingsContext } from "./dom";
import { canCancel, meters, offerSummary, priceLabel, subscriptionLine } from "./usageModel";

/**
 * Settings → Usage & Plan (Story 2.8 / T085, upgrade via Razorpay T089). Payment happens on
 * Razorpay's hosted page in the browser; the plan changes when Razorpay's webhook arrives,
 * so after checkout this screen polls until it does.
 */
const POLL_MS = 5_000;
const POLL_FOR_MS = 10 * 60_000;

export function mountUsage(
  root: HTMLElement,
  ctx: SettingsContext,
): { refresh: () => Promise<void> } {
  const body = h("div", { class: "usage" });
  root.replaceChildren(h("h2", {}, "Usage & Plan"), body);
  let polling: ReturnType<typeof setInterval> | undefined;

  const load = () => ctx.api.json<UsageResponse>("/v1/usage");

  const stopPolling = () => {
    if (polling) clearInterval(polling);
    polling = undefined;
  };

  async function upgrade(planId: string, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    ctx.status("Opening secure checkout in your browser…");
    try {
      const { url } = await ctx.api.json<CheckoutResponse>("/v1/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ planId }),
      });
      await openUrl(url);
      ctx.status("Finish the payment in your browser. This page updates when it's done.");
      const startPlan = (await load().catch(() => null))?.planId;
      const until = Date.now() + POLL_FOR_MS;
      stopPolling();
      polling = setInterval(() => {
        if (Date.now() > until) return stopPolling();
        void load()
          .then((u) => {
            render(u);
            if (u.planId !== startPlan) {
              stopPolling();
              ctx.status(`You're on ${u.planName} now. Thank you!`);
            }
          })
          .catch(() => {});
      }, POLL_MS);
    } catch (err) {
      ctx.status(errorMessage(err));
    } finally {
      button.disabled = false;
    }
  }

  async function cancel(u: UsageResponse, button: HTMLButtonElement): Promise<void> {
    const end = u.subscription?.currentPeriodEnd
      ? new Date(u.subscription.currentPeriodEnd).toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
        })
      : "the end of this billing period";
    if (!window.confirm(`Cancel ${u.planName}? You keep it until ${end}, then move to Free.`))
      return;
    button.disabled = true;
    try {
      await ctx.api.json("/v1/billing/cancel", { method: "POST", body: "{}" });
      ctx.status(`Cancelled. ${u.planName} stays until ${end}.`);
      render(await load());
    } catch (err) {
      ctx.status(errorMessage(err));
      button.disabled = false;
    }
  }

  function render(u: UsageResponse): void {
    const sub = subscriptionLine(u);
    const parts: (Node | null)[] = [
      h("p", {}, "Plan: ", h("strong", {}, u.planName)),
      sub ? h("p", { class: "hint" }, sub) : null,
      ...meters(u).map((m) =>
        h(
          "div",
          { class: `meter ${m.level}` },
          h("div", { class: "row" }, h("span", {}, m.label), h("span", {}, m.text)),
          h("progress", { max: 100, value: m.percent, "aria-label": `${m.label}: ${m.text}` }),
          h("span", { class: "hint" }, m.resets),
        ),
      ),
      ...u.upgrades.map((p) => {
        const button = h("button", { type: "button", class: "primary" }, `Upgrade to ${p.name}`);
        button.addEventListener("click", () => void upgrade(p.planId, button));
        return h(
          "div",
          { class: "card offer" },
          h("strong", {}, p.name),
          h("span", {}, priceLabel(p)),
          h("span", { class: "hint" }, offerSummary(p)),
          button,
          h("span", { class: "hint" }, "Paid securely through Razorpay. Cancel any time."),
        );
      }),
      !u.billingAvailable && u.planId === "free"
        ? h("p", { class: "hint" }, "Paid plans are coming soon.")
        : null,
      canCancel(u)
        ? (() => {
            const b = h("button", { type: "button", class: "link" }, `Cancel ${u.planName}`);
            b.addEventListener("click", () => void cancel(u, b));
            return b;
          })()
        : null,
    ];
    body.replaceChildren(...parts.filter((n): n is Node => n !== null));
  }

  async function refresh(): Promise<void> {
    try {
      render(await load());
    } catch (err) {
      body.replaceChildren(h("p", { class: "hint" }, `Couldn't load usage. ${errorMessage(err)}`));
    }
  }

  void refresh();
  return { refresh };
}
