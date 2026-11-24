# Epic 2 — Backend Core & Auth

**Phase:** 2 · **Goal:** Production-shaped stateless API with auth, data model, session lifecycle, settings, dictionary and usage endpoints.

---

## Story 2.1 — Database schema and migrations
As a developer, I want the Postgres schema defined in code, so that environments are reproducible.

**Acceptance Criteria**
1. Drizzle schema + migrations for `users`, `plans`, `subscriptions`, `settings`, `dictionary_terms`, `sessions`, `usage_daily` per `specs/001-voice-to-prompt-mvp/data-model.md`.
2. No column stores transcript or rewrite text.
3. Seed creates `free` and `pro` plans.
4. Least-privilege DB role for the API (no DDL rights in prod).

## Story 2.2 — Authentication
As a user, I want to sign in once and stay signed in, so that the app just works.

**Acceptance Criteria**
1. Client signs in via Google Identity Platform (email or Google account) in the system browser, returns via `sayvox://auth` deep link.
2. Tokens stored in OS keychain (macOS Keychain / Windows Credential Manager).
3. API verifies JWT via JWKS on every `/v1/*` route except `/healthz`, `/v1/client-config`, `/v1/billing/webhook`.
4. First authenticated request lazily creates `users` + default `settings` rows.
5. Expired/invalid tokens → `401 UNAUTHENTICATED`; client refreshes silently.

## Story 2.3 — Rate limits and quotas
As the operator, I want per-user limits, so that cost is bounded.

**Acceptance Criteria**
1. Redis token-bucket rate limit per user (default 30 session starts/min).
2. Daily and monthly audio-minute quotas checked from Redis counters (reconciled from `usage_daily`).
3. Exceeded → `429 RATE_LIMITED` or `402 QUOTA_EXCEEDED` with reset time.
4. Each session receives `maxSessionSeconds` (default 300 s).

## Story 2.4 — `POST /v1/session/start`
As a user, I want recording to start instantly, so that my first words are captured.

**Acceptance Criteria**
1. Auth → quota check → insert `sessions` row (`status=started`) → mint Scribe single-use token → return `SessionStartResponse` incl. keyterms and language hint.
2. p95 < 150 ms excluding ElevenLabs latency is measured; with provider call p95 < 250 ms in staging.
3. Client token cache pre-fetches one session after each use and on app start.
4. Unused pre-fetched sessions older than token TTL are marked `abandoned` by a sweeper.
5. Removes the dev-only endpoint from Story 1.5.

## Story 2.5 — `POST /v1/session/{id}/end`
**Acceptance Criteria**
1. Accepts `SessionEndRequest`; validates session ownership.
2. Updates session row with audio seconds, timings and status; upserts `usage_daily`; increments Redis counters.
3. Clamps reported `audioSeconds` to `maxSessionSeconds`.
4. Idempotent on repeated calls.

## Story 2.6 — Settings API and client UI
**Acceptance Criteria**
1. `GET/PUT /v1/settings` with Zod validation; cached in Redis (5 min TTL, invalidated on write).
2. Client caches settings at start and on change; Settings UI (General, Modes, Preset) per `docs/front-end-spec.md`.
3. Plan-disallowed presets rejected with `403` and shown locked in UI.

## Story 2.7 — Dictionary API and UI
**Acceptance Criteria**
1. `GET/POST/DELETE /v1/dictionary`; case-insensitive uniqueness; term ≤ 64 chars.
2. Plan `dictionary_limit` enforced.
3. Terms returned as keyterms by `/session/start`.
4. Dictionary UI shows count/limit.

## Story 2.8 — Usage API and UI
**Acceptance Criteria**
1. `GET /v1/usage` returns today and period minutes used, limits and reset times.
2. Usage & Plan screen shows progress bars.

## Story 2.9 — Client config endpoint
**Acceptance Criteria**
1. `GET /v1/client-config` returns `minClientVersion`, `killSwitch`, `rolloutFlags`.
2. Client checks on start and every 30 min; enforces forced-update and kill-switch states.
