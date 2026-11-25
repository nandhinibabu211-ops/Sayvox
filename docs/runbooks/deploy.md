# API infrastructure and deploys (T094, T095, T092, T093, T097)

Terraform: `infra/terraform` (API), `infra/observability` (dashboards, alerts, events sink,
budget), `infra/downloads` (installers, see release.md). Workflow:
`.github/workflows/deploy.yml`.

## One-time setup

Order matters: downloads (creates the Workload Identity pool) → API staging → API prod →
observability.

1. **State bucket** (private; the state holds generated connection strings):
   ```bash
   gcloud storage buckets create gs://sayvox-app-2026-tfstate --location=us-east4 --uniform-bucket-level-access
   gcloud storage buckets update gs://sayvox-app-2026-tfstate --versioning
   ```
2. **Downloads** (if not done for release.md): creates the `github` WIF pool.
3. **Staging**:
   ```bash
   terraform -chdir=infra/terraform init -backend-config="bucket=sayvox-app-2026-tfstate" -backend-config="prefix=api/staging"
   terraform -chdir=infra/terraform apply -var-file=staging.tfvars
   ```
   Before the first apply, check `otel_collector_image` against the latest tag in Google's
   "Cloud Run OpenTelemetry sidecar" guide. The service starts on a placeholder image.
4. **Provider keys** (staging keys with low caps). The `owner_secrets` output lists the
   secrets; add a version to each, typing the key into the prompt rather than the command line:
   ```bash
   gcloud secrets versions add sayvox-staging-elevenlabs-api-key --data-file=-
   gcloud secrets versions add sayvox-staging-openrouter-api-key --data-file=-
   ```
   Billing: set `billing_enabled = true` and `razorpay_plan_ids` in the tfvars, apply, then
   add the three Razorpay secrets (test keys in staging; the API refuses `rzp_test_` in prod).
5. **GitHub.** Settings → Environments → `staging`: add every `github_vars` output as a
   variable, plus `FIREBASE_WEB_API_KEY`. Optional secrets `SMOKE_EMAIL` /
   `SMOKE_PASSWORD` for a dedicated staging test user (enables the real session check in
   the smoke test). Then the repository variable `DEPLOY_ENABLED=true`.
6. **Prod**: the same with `prefix=api/prod`, `prod.tfvars`, prod keys, and a
   `production` environment with **required reviewers** (this is the manual approval).
7. **Observability**, per environment:
   ```bash
   terraform -chdir=infra/observability init -backend-config="bucket=sayvox-app-2026-tfstate" -backend-config="prefix=observability/prod"
   terraform -chdir=infra/observability apply -var env=prod -var alert_email=ALERT_EMAIL -var billing_account=BILLING_ACCOUNT_ID
   ```
   Then in the console: Error Reporting → Configure notifications → the same email (new crash
   types, section 16). The budget needs the Billing Account Administrator or Costs Manager role.
8. **Desktop**: set the desktop build's `API_BASE_URL` (release.md) to the prod `api_url`.
9. Set the provider spend caps (kill-switch.md "Cost").

## Staging as built (2026-11-25): cheap, serverless shape

Owner decision: staging must be cheap. `staging.tfvars` uses `region = us-west1`,
`database = alloydb_express`, `redis = vm`, `provider_keys_ready = false`. Cost is roughly
US$7–10/month (mostly the PSC endpoint); AlloyDB Express compute is free while paused and
50 compute-hours/month are free for 12 months.

| Piece | What | Notes |
| --- | --- | --- |
| Database | AlloyDB Express `sayvox-staging` / instance `primary` (PostgreSQL 18) | preview, no SLA, **no backups**; pauses after ~15 min idle, wakes in ~20 s (API connect timeout 30 s) |
| DB access | PSC endpoint `sayvox-staging-alloydb` (10.20.0.3) | Express has no VPC peering |
| Redis | `sayvox-staging-redis` e2-micro VM (free tier), Container-Optimized OS, no external IP | in-memory only; a VM restart empties it (quotas rebuild from Postgres) |
| API | Cloud Run `sayvox-staging-api`, min 0, max 2 | `/health` from outside (Cloud Run's frontend reserves `/healthz`) |

How it was created (repeat in this order for a rebuild):

1. State bucket and `infra/downloads` (one-time setup steps 1–2).
2. `terraform apply` with targets for the network, Redis VM, secrets, registry and IAM
   (Cloud Run needs the secrets to have versions first).
3. AlloyDB Express. `gcloud` 594+ supports it:
   `gcloud beta alloydb clusters create sayvox-staging --region=us-west1 --enable-express --password=...`
   then `gcloud beta alloydb instances create primary --cluster=sayvox-staging --region=us-west1 --instance-type=PRIMARY --cpu-count=1 --allowed-psc-projects=sayvox-app-2026`.
   Older gcloud: the same through the REST API (`v1beta`, `expressConfig.enabled: true`).
   The password is `terraform output -raw db_password` (meets AlloyDB's complexity policy;
   never print it).
4. Put the instance's `pscInstanceConfig.serviceAttachmentLink` (as `projects/...`) into
   `alloydb_psc_attachment`, then `terraform apply` again: PSC endpoint + `DATABASE_URL`.
5. Build the image with Cloud Build, full `terraform apply -var initial_image=<image>`,
   `gcloud run jobs execute sayvox-staging-migrate --wait`, smoke test.

**Sign-in (2026-11-26, Google Cloud, no Firebase):**
- Identity Platform initialized on the project; **email/password** enabled. Authorized
  domains: the staging web origin, `sayvox-app-2026.firebaseapp.com` (Identity Platform's
  auth handler) and `localhost`.
- Browser API key "Sayvox sign-in (browser, staging)", restricted to Identity Toolkit and
  Secure Token (no website restriction: the desktop app refreshes tokens with it). Stored as
  the GitHub staging variable `FIREBASE_WEB_API_KEY`.
- Web pages: Cloud Run `sayvox-staging-web` from `apps/web/Dockerfile`
  (`--build-arg VITE_FIREBASE_API_KEY=...`). GitHub staging variable `WEB_ORIGIN`.
- **Google sign-in (owner, later):** Google Cloud console → Google Auth Platform → configure
  the consent screen and create a *Web application* OAuth client (authorized JavaScript
  origin = the web origin, redirect URI = `https://sayvox-app-2026.firebaseapp.com/__/auth/handler`),
  then Identity Platform → Providers → Google with that client. Rebuild the web image with
  `--build-arg VITE_GOOGLE_SIGNIN=true`.
- The unused "Browser key (auto created by Firebase)" (about 30 APIs) was deleted on
  2026-11-26 at the owner's request; restorable until 2026-12-26 with
  `gcloud services api-keys undelete`.

**Still to do for staging:**
- Provider keys (owner, later): add versions to `sayvox-staging-elevenlabs-api-key` and
  `sayvox-staging-openrouter-api-key`, set `provider_keys_ready = true`, apply. Until then
  `/v1/session/start` answers 503 `PROVIDER_UNAVAILABLE` and rewrites fail over to raw text.
- GitHub `staging` environment variables are set. `DEPLOY_ENABLED` is **not** set: the
  workflow's prod job must have a `production` environment with required reviewers first.
- Observability is applied (2026-11-26, state prefix `observability/staging`): dashboard,
  Cloud Run 5xx, job-failure, spend-spike and reconciliation alerts to the owner's Google Cloud
  email, BigQuery product-events sink, ₹2,000/month project budget. Alerts on the API's own
  metrics (latency, fallback, Scribe reconnects) need those metrics to exist, so they are off
  (`-var app_metric_alerts=false`) until the first real dictations; then re-apply without it.
  Still manual: Error Reporting → Configure notifications (new crash types).

## Every deploy

Merging to `main` with API changes runs deploy.yml:

1. Builds the image once (`apps/api/Dockerfile`), pushes `sayvox-api/api:<sha>`.
2. **Staging**: points the jobs at it, runs migrations (`sayvox-staging-migrate`), deploys,
   smoke tests.
3. Waits for approval on `production`.
4. **Prod**: migrations, new revision with no traffic (tag `candidate`), smoke test against
   that revision, 100 % traffic, then 10 minutes of watching Cloud Run 5xx share and p95.
   Two bad minutes in a row → traffic goes back to the previous revision and the run fails.

Migrations must be backwards compatible with the previous release (add columns/tables, don't
drop or rename in the same release): the old revision serves until traffic moves, and a
rollback runs the old code on the new schema.

Manual rollback: kill-switch.md.

## Edge: load balancer + Cloud Armor (T095)

Needs a domain (ADR-009). When one exists:

1. tfvars: `domain = "api.example.com"`, apply. Point the domain's A record at `edge_ip`;
   the managed certificate goes active once DNS resolves (up to an hour).
2. WAF rules start in **preview** (`waf_preview = true`, logs only). After a week, check
   Cloud Armor logs for rules that would have blocked real traffic, then set
   `waf_preview = false`. Body rules skip `/v1/rewrite` and `/v1/dictionary`, where users'
   speech can look like SQL or script.
3. Per-IP throttle: `rate_limit_per_minute` (default 600). Per-user limits stay in the API.
4. Ship a desktop release with `API_BASE_URL=https://<domain>`, force it with
   `minClientVersion`, then set `lb_only_ingress = true` so the run.app URL no longer
   bypasses Cloud Armor. Update the Razorpay webhook URL to the new domain at the same time.

## Secrets rotation (every 90 days)

Add a new version of each provider key (create the new key at the provider first), deploy
or restart (`gcloud run services update sayvox-prod-api --region us-east4 --update-labels rotated=$(date +%F)`),
confirm traffic is healthy, then revoke the old key at the provider and disable the old
version. Connection strings rotate with `terraform apply -replace=random_password.db`.

## Scheduled jobs

| Job | When | Alert |
| --- | --- | --- |
| `sayvox-<env>-spend` | daily 00:30 UTC | yesterday's provider cost > 2× the 7-day average (and ≥ $1) |
| `sayvox-<env>-reconcile` | Mondays 03:00 UTC | recorded audio vs ElevenLabs STT minutes differ > 5 % |
| `sayvox-<env>-migrate` | each deploy | job failure alert |
| `sayvox-<env>-cfg` | by hand | none (audit lines in Cloud Logging) |

Run one by hand: `gcloud run jobs execute sayvox-prod-spend --region us-east4 --wait`.
If `reconcile` reports `unknown`, ElevenLabs did not return a speech-to-text series (the
usage-stats endpoint is marked deprecated in their docs); compare against the ElevenLabs
usage page by hand and update `apps/api/src/jobs/reconcile.ts`.
