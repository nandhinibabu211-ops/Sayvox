# Security and privacy audit

Audited 2026-11-25 by reading the code paths listed below. No penetration test or deployed
environment was available (nothing is deployed), so findings are from source review plus
the automated tests.

## Findings

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| SEC-03 | **High** | Usage is client-reported: server-side quota can be bypassed by a modified client | **Open: needs owner decision** |
| SEC-01 | High | Unlimited `/v1/rewrite` calls per open session (LLM cost abuse) | **Fixed** |
| SEC-07 | High (release blocker) | Updater public key not set | Open (owner action) |
| SEC-02 | Medium | `users.email` UNIQUE breaks sign-in for two identities with one email | **Fixed** |
| SEC-04 | Medium | Release CSP allowed `localhost:8787` and only legacy `*.a.run.app` hosts | **Fixed** |
| SEC-09 | Medium | No WAF / edge rate limit until a domain exists | Open (accepted until domain, ADR-009) |
| SEC-08 | Medium (launch blocker) | Privacy policy and terms are drafts, not legally reviewed | Open (owner action) |
| SEC-05 | Low | Dependency advisories | Partly fixed |
| SEC-06 | Low | Unverified email addresses get a free account | Open (accepted; see SEC-03) |
| SEC-10 | Low | `DATABASE_URL` uses `sslmode=no-verify` | Open (accepted) |
| SEC-11 | Low | Terraform state holds generated DB/Redis credentials | Open (documented) |
| SEC-12 | Low | Suspended/plan-changed users keep the cached state up to 60 s | Open (accepted) |

### SEC-03 (High, open): quota relies on client-reported audio seconds

**What:** Audio goes from the app straight to ElevenLabs with a single-use token; the API
never sees it. Usage is recorded from `audioSeconds` in `POST /v1/session/:id/end`, clamped
to `[0, min(maxSessionSeconds, wall clock)]` (`modules/limits/policy.ts:43`). Abandoned
sessions are swept with **0 seconds** (`modules/session/sweeper.ts`).

**Failure scenario:** a modified client (the source is public) reports `audioSeconds: 0`, or
never calls `/end`. Each session still streams up to `maxSessionSeconds` (≥ 5 min) of real,
billed Scribe audio. With the 30 sessions/min rate limit one free account can stream
continuously, unbilled against its quota, paid for by Sayvox. Weekly reconciliation (T096)
detects the total drift, not the user.

**Remediation (pick one, owner decision):**
1. Charge every un-ended or zero-reported session a minimum (e.g. the token's
   `maxSessionSeconds`, refunded on a plausible `/end`). Simple; overcharges prefetched,
   unused sessions unless prefetch is changed to not create sessions.
2. Proxy the audio WebSocket through the API to meter it exactly. Accurate; adds latency
   and Cloud Run cost; against architecture R1.
3. Per-user anomaly detection: flag accounts whose reported audio is far below sessions ×
   typical length, and suspend. Cheap; reactive.

Also lower the per-user concurrent open sessions to 2 to bound the damage now.
Until one of these ships, keep the ElevenLabs usage-based billing cap low
(kill-switch.md "Cost").

### SEC-01 (High, fixed): rewrite loop on one open session

`/v1/rewrite` only checked that the session was `started` (open up to ~20 min) and had no
rate limit, so a client could call it repeatedly with 20 000-character transcripts, each a
paid OpenRouter call. **Fix:** `claimRewrite` (`modules/limits/store.ts`) counts rewrites per
session in Redis (cap 2, TTL 30 min; the app sends one per press and never retries); the
route returns `429 RATE_LIMITED` before calling any model. Redis failures fail open (logged)
so dictation keeps working. Tests: `test/unit/rewrite-route.test.ts` ("refuses another
rewrite…"), `test/integration/audit-fixes.test.ts` (real Redis, runs in CI).

### SEC-02 (Medium, fixed): email uniqueness

Users are resolved by Identity Platform uid, but `users.email` was UNIQUE. If Identity
Platform ever allows two accounts per email (a project setting), or a user changes their
email to one used by another Sayvox account, the upsert fails and every request from that
user returns 500 (and someone could squat an email to lock its owner out). The email is not
read anywhere as an identifier. **Fix:** migration `0003_users_email_not_unique.sql` drops
the constraint. Test: `test/integration/audit-fixes.test.ts`.

### SEC-04 (Medium, fixed): release CSP

The webview CSP allowed `http://localhost:8787` (dev) and `https://*.a.run.app` (legacy
Cloud Run URLs only). Current Cloud Run URLs are `<service>-<number>.<region>.run.app`,
which that pattern does not match, so a release pointed at one would block every API call;
widening to `*.run.app` would allow any Cloud Run service. **Fix:** `release.yml` now writes
the CSP into `tauri.release.conf.json` with exactly the `API_BASE_URL` origin (https
required) and no localhost. Dry-run verified locally on a copy.

### SEC-07 (release blocker): updater key

`tauri.conf.json` `plugins.updater.pubkey` is the placeholder. The app reports the updater
as not configured and `release.yml` refuses to build, so this fails safe, but no release can
ship until the owner generates the key pair (release.md step 2).

### SEC-09 (Medium): no edge protection yet

Cloud Armor and the HTTPS load balancer exist in Terraform but need a domain (ADR-009). Until
then the run.app URL is public with only in-app per-user limits (Redis) and Cloud Run's own
DDoS protection. Unauthenticated routes are `/healthz`, `/v1/client-config` and the signed
webhook.

### SEC-05 (Low): dependencies

`pnpm audit` found 1 high, 3 moderate, 1 low, all in dev tooling or code not used at runtime:
- `@grpc/grpc-js` (high + low) via `firebase` → Firestore, which the web pages don't use.
  **Fixed** with a pnpm override to `^1.13.6`.
- `esbuild` (drizzle-kit dev CLI), `glob` and `minimatch` (testcontainers): dev only, not in
  the API image's runtime path; left as is (overriding across majors risks breaking the tools).
Rust: `cargo audit` is not installed here; add it to CI (KI-09).

### SEC-06, SEC-10, SEC-11, SEC-12 (Low)

- **SEC-06:** `email_verified` is not required. Identity is the uid, so there is no takeover
  risk; the cost is free-tier farming with throwaway accounts, which matters mostly because of
  SEC-03.
- **SEC-10:** Cloud SQL requires TLS (`ENCRYPTED_ONLY`) over a private IP; the client
  encrypts without verifying the server certificate. Acceptable inside the VPC; pin the
  Cloud SQL CA later.
- **SEC-11:** the GCS state bucket must stay private (deploy.md step 1 says so).
- **SEC-12:** user and plan caches are 60 s, so a suspension or downgrade takes up to a minute.

## Areas reviewed with no issue found

| Area | Result |
| --- | --- |
| JWT verification | RS256 only, issuer + audience = project, `exp`/`iat`/`sub` required, 5 s clock tolerance; emulator tokens only when not staging/production and the server refuses to start if the emulator host is set there |
| API authorization | every `/v1` route authenticated unless explicitly public; unknown `/v1` paths also need auth; every user-owned query filters by `user_id` (sessions, rewrite, dictionary, settings, billing) |
| Deleted accounts | Redis tombstone refuses still-valid tokens for 2 h; deletion idempotent and retryable |
| Input validation | Zod on every body/param; strict telemetry schema; transcript ≤ 20 000, thread context ≤ 8 000, terms 1–64 chars (DB CHECK too) |
| Rate limits | per-user token bucket on session start (30/min); rewrites now capped per session |
| Webhook | HMAC-SHA256 over the raw body, timing-safe compare, event-id dedupe, out-of-order guard, deleted users resolve to "unknown" |
| Secrets | provider keys only in `apps/api`; CI guard fails if they appear under `apps/desktop`; Secret Manager in Terraform; no keys in the repo (`git grep` clean) |
| Windows Credential Manager | tokens stored via `keyring`, size-capped; sign-in tokens arrive by loopback POST (never in a URL) with one-time state + Origin check |
| Transcript redaction | logger redacts transcript/text/body/content/audio fields to 3 levels and auth headers; request URLs logged without query; Zod errors never echo values |
| Retention | no table stores transcript, partial, rewrite or thread text (schema comment + tests); OpenRouter requests carry `data_collection: deny` + zero data retention |
| Update signatures | Tauri updater verifies signatures with the embedded public key (once set); installers unsigned by decision (ADR-007) with published SHA-256 |
| Webview permissions | opener limited to the sign-in site, Windows mic settings and Razorpay checkout hosts |
| Telemetry | events carry no user id and no text (`analytics.test.ts` checks a secret phrase never appears) |

## Not verified (blocked)

- Behaviour of the deployed stack (TLS, IAM, Cloud Armor, Secret Manager access): nothing deployed.
- The privacy audit script (T078) against real Cloud Logging / BigQuery: no logs exist.
- ElevenLabs retention settings on the production account (owner's dashboard).
