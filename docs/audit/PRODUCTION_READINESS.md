# Production readiness

**Status: NOT READY**

Assessed 2026-11-25 from source review, every local check, CI results and a read-only look
at the Google Cloud project. The code base is in good shape: 336 automated tests, strict
input validation, careful privacy handling, and infrastructure as code that validates. But
production readiness is about the running system, and none of it has run for real.

## Why not ready

1. **Nothing is deployed or integrated.** In `sayvox-app-2026` the Cloud Run and Cloud SQL
   APIs are disabled and no buckets exist. No call has ever been made to ElevenLabs,
   OpenRouter, Razorpay or the production Identity Platform with real credentials.
2. **No release can be built.** The updater public key is a placeholder (KI-02).
3. **Critical tests are blocked, not passed:** the whole user journey on Windows 10 and 11
   (T101), the Phase 1 and Phase 2 latency/quality gates (T040, T058), the Lemon comparison
   (no baseline exists), and the 3× peak load test (T098).
4. **Legal:** privacy policy and terms are unreviewed drafts (KI-03).

## Path to "ready after fixes"

| Step | Who | Unblocks |
| --- | --- | --- |
| Generate the updater key pair; set GitHub secrets | owner | releases |
| Pro price and limits; Razorpay plan (test mode first) | owner | billing tests |
| Provider keys (staging, low caps); Identity Platform test users | owner | live tests |
| `deploy.md` one-time setup for staging; first deploy | owner + Claude | API live tests, smoke |
| Run T040 and T058 with real keys; record Lemon baseline; add Tamil-English cases | owner dictates, Claude runs | quality and latency gates |
| T101 on a Windows 10 and a Windows 11 PC | owner | Windows sign-off |
| Load test at 3× peak on staging; kill-switch drill | Claude with owner approval | launch gate |
| Legal review of privacy and terms | owner | launch |
| Prod setup and deploy | **only with explicit owner approval** | release |

## What is verified

- All unit/contract tests (336), integration tests (CI), TypeScript, ESLint, Prettier, Rust
  fmt/clippy/tests, API container build, Terraform validate: **pass**.
- Security review of auth, authorization, validation, webhook, secrets, redaction, retention,
  deletion, telemetry: no open issue except those listed (SECURITY_AUDIT.md).
- Fixed in this audit: client-reported usage (SEC-03, high, now metered by an audio proxy,
  ADR-011), rewrite cost loop (SEC-01, high), email uniqueness 500s (SEC-02), release CSP
  (SEC-04), plus a dependency pin and a corrected quickstart. The proxy's extra latency is
  unmeasured (KI-16).

See IMPLEMENTATION_AUDIT.md, END_TO_END_TEST_REPORT.md, SECURITY_AUDIT.md,
PERFORMANCE_REPORT.md and KNOWN_ISSUES.md for the evidence.
