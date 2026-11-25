# ADR-009: Temporary domains

**Status:** Accepted · 2026-11-24 · Decided by: project owner ("use temporary domain")
**Amended 2026-11-26:** web pages moved from Firebase Hosting to Cloud Run, sign-in uses Google Cloud Identity Platform directly (owner: "could you use google cloud instead of firebase").

## Decision
Until a custom domain is bought, use Google's free domains in Google Cloud project `sayvox-app-2026`:

| Use | Temporary address |
| --- | --- |
| API | Cloud Run service URL, `https://sayvox-api-<hash>-<region>.a.run.app` (known after first deploy) |
| Website, sign-in page, install guide | Cloud Run service `sayvox-<env>-web`, `https://sayvox-<env>-web-<project number>.<region>.run.app` (staging: `https://sayvox-staging-web-264655228768.us-west1.run.app`) |
| Installers and update manifests | Cloud Storage public URL, `https://storage.googleapis.com/<release-bucket>/…` |

## Consequences
- The External Application Load Balancer + Cloud Armor from ADR-006 needs a domain for a managed TLS certificate, so it is **deferred** until a custom domain exists. Until then the API is reached directly at its `run.app` URL; Cloud Run's built-in protection applies, and per-user rate limits in Redis stay in place.
- Cloud CDN for installers is deferred with the load balancer; files are served straight from Cloud Storage.
- The API base URL and the update-manifest URL are build-time config in the desktop app, so moving to a custom domain later needs one new release (old builds keep working while the `run.app` URL stays live).
- Razorpay webhooks and the Identity Platform authorized domains point at these URLs and must be updated when the domain changes.
