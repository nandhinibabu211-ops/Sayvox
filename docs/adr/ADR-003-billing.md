# ADR-003: Razorpay as the only billing provider

**Status:** Accepted · 2026-11-24 · Decided by: project owner

## Decision
Use Razorpay Subscriptions for all paid plans. Stripe is dropped.

## Consequences
- No `BillingProvider` abstraction with two implementations; one `razorpay` module (simpler, Constitution VIII).
- Charging non-INR cards needs Razorpay's international payments enabled on the account (owner action, Phase 4).
- Webhooks: Razorpay signature (`X-Razorpay-Signature`, HMAC-SHA256 with the webhook secret), idempotent on event id.
- Prices are stored per plan in INR; any USD display is informational unless international pricing is enabled.
