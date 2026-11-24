# Epic 6 — Monetization & Launch

**Phase:** 4 · **Goal:** Paid plans, safe rollout controls and capacity for public launch.
**Gate:** load test at 3× expected peak simultaneous dictations.

---

## Story 6.1 — Razorpay integration (ADR-003)
**Acceptance Criteria**
1. `razorpay` billing module: Razorpay Plans mapped to Sayvox plans, subscription creation and cancellation.
2. Razorpay test mode used in dev and staging; live keys only in prod Secret Manager.

## Story 6.2 — Checkout and upgrade flow
**Acceptance Criteria**
1. `POST /v1/billing/checkout` returns hosted checkout URL; opened in system browser.
2. Upgrade buttons in overlay (quota hit) and Usage screen.

## Story 6.3 — Billing webhooks
**Acceptance Criteria**
1. `POST /v1/billing/webhook` verifies signatures, is idempotent (event id store), updates `subscriptions` and `users.plan_id`.
2. Handles created, renewed, past_due, cancelled.

## Story 6.4 — Plan limits enforcement
**Acceptance Criteria**
1. Monthly/daily minutes, presets and dictionary size enforced per plan; cache invalidated on plan change.

## Story 6.5 — Provider capacity and spend controls
**Acceptance Criteria**
1. ElevenLabs plan sized to expected peak concurrency; concurrency limit documented.
2. Spend caps set in the ElevenLabs and OpenRouter dashboards and a Google Cloud budget alert; daily spend alert at 2× 7-day average.
3. Weekly reconciliation job compares client-reported audio seconds with ElevenLabs usage.

## Story 6.6 — Kill switch and staged rollout drill
**Acceptance Criteria**
1. Kill switch toggled in staging and prod-canary; clients pause within 30 min (or on next press after config poll).
2. Rollback of a bad client release rehearsed.

## Story 6.7 — Load test
**Acceptance Criteria**
1. k6 scenario simulates 3× expected peak simultaneous sessions against staging (`/session/start`, `/rewrite` with mocked or capped providers).
2. p95 targets and error rate < 1 % hold; report saved to `eval/results/load-<date>.md`.

## Story 6.8 — Launch site and downloads
**Acceptance Criteria**
1. Landing page with download buttons (OS-detected), pricing, privacy, terms.
2. Installers served from Cloud CDN with checksums; site on Firebase Hosting; install guide for the unsigned-installer prompts.
