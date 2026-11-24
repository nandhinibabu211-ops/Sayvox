# ADR-006: Google Cloud for all infrastructure

**Status:** Accepted · 2026-11-24 · Decided by: project owner ("use Google Cloud to the fullest extent")

## Decision
Run everything Sayvox hosts on the owner's existing Google Cloud account. Vertex AI is **not** used (see ADR-008).

| Need | Previous plan | Google Cloud service |
| --- | --- | --- |
| API containers | Fly.io / AWS ECS | **Cloud Run**, region `us-east4` (N. Virginia), min 2 instances |
| Container images | — | **Artifact Registry** |
| Postgres | Supabase / RDS | **Cloud SQL for PostgreSQL 16**, automated backups + PITR |
| Redis | Upstash / ElastiCache | **Memorystore for Redis 7** (Cloud Run reaches it over Direct VPC egress) |
| Sign-in | Supabase Auth / Clerk | **Identity Platform** (Firebase Auth): email + Google sign-in, JWTs verified via Google JWKS |
| Secrets | Fly secrets / AWS SM | **Secret Manager** |
| Edge, TLS, WAF, rate limits | Cloudflare | **External Application Load Balancer + Cloud Armor** |
| Installers + update manifests | Cloudflare R2 / S3 | **Cloud Storage + Cloud CDN** |
| Website | Vercel / Cloudflare Pages | **Firebase Hosting** |
| Errors and crashes | Sentry | **Error Reporting** (backend direct; client via `POST /v1/telemetry`) |
| Metrics, dashboards, alerts | Grafana / Datadog | **Cloud Monitoring + Cloud Trace** (OpenTelemetry exporter) |
| Product analytics | PostHog | Text-free events via `POST /v1/telemetry` → Cloud Logging → log sink to **BigQuery** |
| Scheduled jobs | — | **Cloud Scheduler** → Cloud Run jobs (session sweeper, reconciliation) |
| CI/CD | GitHub Actions | GitHub Actions with **Workload Identity Federation** (no long-lived GCP keys) |

## Rationale
- No new vendor accounts or subscriptions for infrastructure; one bill.
- `us-east4` keeps the API close to the ElevenLabs and LLM endpoints, as the original "US-East" plan intended.

## Consequences
- Cloud SQL, Memorystore and the load balancer each have a baseline monthly cost even when idle. Use the smallest tiers for dev/staging.
- Client crash reports and analytics now go through the Sayvox API, which must scrub them (no text fields accepted).
- ElevenLabs is still an outside service (no equivalent swap approved).
