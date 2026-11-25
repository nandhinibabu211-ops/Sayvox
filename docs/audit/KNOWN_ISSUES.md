# Known issues

Open items found or confirmed by the 2026-11-25 audit, most severe first. Security IDs
refer to SECURITY_AUDIT.md.

| ID | Severity | Issue | Owner action / fix |
| --- | --- | --- | --- |
| KI-02 | High (blocker) | Updater public key is a placeholder; no release can be built | Generate the key pair (release.md step 2) |
| KI-03 | High (blocker) | Privacy policy and terms are drafts without legal review | Legal review, then remove the draft banner |
| KI-04 | High (blocker) | Staging is deployed (2026-11-25, cheap shape, smoke passes) but without provider keys; prod is not created; Identity Platform not configured | Add staging keys; prod setup only with owner approval |
| KI-05 | Medium | Pro plan price and limits are placeholders (`seed.ts`); Razorpay plan ids not created | Decide pricing; create the Razorpay plan; set `RAZORPAY_PLAN_IDS` |
| KI-06 | Medium | `db:setup` runs on every deploy and **overwrites** plan rows from `seed.ts`, so prices changed in the database are reset | Treat `seed.ts` as the source of truth for plans (document); change plans by code |
| KI-07 | Medium | Quality never measured: no recorded audio, no Tamil-English cases, no Lemon baseline, eval gate has never run with a key (T056, T058) | Record consented phrases; add Tamil-English cases; record Lemon outputs; run the eval |
| KI-08 | Medium | No edge WAF / rate limit until a domain exists (SEC-09) | Get a domain; follow deploy.md "Edge" |
| KI-09 | Low | No `cargo audit` in CI | Add a `cargo audit` job |
| KI-10 | Low | Moderate `pnpm audit` advisories in dev tools (esbuild via drizzle-kit, glob/minimatch via testcontainers) | Upgrade when the tools release fixes |
| KI-11 | Low | Terraform uses Postgres 17; dev compose and integration tests use 16 | Align (move tests and compose to 17) |
| KI-13 | Low | ElevenLabs usage API: STT series label unconfirmed; endpoint marked deprecated (research R11) | Check on the first reconcile run |
| KI-14 | Low | Account deletion SCANs Redis by pattern; slow on a large keyspace | Fine at launch scale; index user keys later |
| KI-15 | Low | Plan/suspension changes take up to 60 s (user cache) | Accepted |
| KI-16 | Medium | Audio proxy (ADR-011) adds a network hop; latency and Cloud Run bandwidth cost not yet measured | Include in the T040 timing run and the load test |
| KI-17 | Low | An API instance restart ends the dictations it carries (charged first); the client retries once on a new session | Accepted; Cloud Run drains on deploy |
| KI-18 | Medium | Staging differs from prod: us-west1 (prod us-east4), AlloyDB Express preview without backups and with ~20 s wake-up, Redis on a single VM | Accepted for cost; latency and load tests must be judged with that in mind |
| KI-20 | Low | Google sign-in not configured (needs the owner's OAuth consent screen + client); the button is hidden until then. A broad "auto created by Firebase" browser key exists in the project, unused | deploy.md "Sign-in" |
| KI-19 | Low | The local gcloud (577) predates AlloyDB Express and misparsed `--container api --image ... --quiet` | Update gcloud; deploy.yml now uses `--flag=value` |

## Fixed in this audit

| Fix | Files |
| --- | --- |
| SEC-03: audio metered by a `/v1/stream` proxy; usage no longer client-reported (ADR-011) | `modules/stream/*`, `modules/session/routes.ts`, `drizzle/0004_session_metered_at.sql`, desktop `scribeClient.ts`, CSP, Terraform timeout, privacy page, tests |
| SEC-01: rewrites capped at 2 per session | `modules/limits/store.ts`, `modules/rewrite/routes.ts`, `server.ts`, `lib/redis/keys.ts`, tests |
| SEC-02: `users.email` no longer UNIQUE | `schema.ts`, `drizzle/0003_users_email_not_unique.sql`, `test/integration/audit-fixes.test.ts` |
| SEC-04: release CSP pinned to the API origin | `.github/workflows/release.yml` |
| SEC-05: `@grpc/grpc-js` pinned to a fixed version | `pnpm-workspace.yaml` overrides |
| Quickstart: correct Node/pnpm versions, real script names, removed non-existent `OPENROUTER_FORCE_*` switches | `specs/001-voice-to-prompt-mvp/quickstart.md` |
