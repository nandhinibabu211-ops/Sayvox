# Sayvox Constitution

## Core Principles

### I. Privacy by Default (NON-NEGOTIABLE)
Transcripts, partial transcripts, rewrites and email thread context are processed in memory only. They MUST NOT be written to the database, logs, error reports, analytics events or traces. Only metadata (durations, token counts, latency, model, status) is persisted. Any future history feature MUST be opt-in, encrypted at rest, and support export and delete.

### II. Secrets Never Ship
Provider API keys (ElevenLabs, OpenRouter, billing) exist only on the backend. The desktop client receives single-use Scribe tokens and its own short-lived JWT. No code under `apps/desktop` may reference provider keys.

### III. Latency Is a Feature
Release → inserted is the primary product metric. Budgets: dictation < 1 s (p95 alert at 1.2 s); prompt/email ≤ 3 s p95; `/v1/session/start` < 150 ms (alert 250 ms). Any change that regresses p95 beyond budget on the timing harness MUST NOT ship.

### IV. Never Lose the User's Words
Every failure path degrades gracefully: Scribe retry once on a new token with buffered audio → next LLM model on error or 1.5 s TTFT miss → paste the raw transcript. The clipboard is always restored.

### V. Measured Quality (Test-First for Prompts & Models)
Every change to a system prompt, preset or model slug MUST be scored against the fixed eval set (30+ real dictations incl. Indian English and injection attempts) before merge. Quality must stay ≥ the Lemon baseline. Code follows test-first for core logic (state machines, resolvers, quota math, template rendering).

### VI. Transcript Is Data, Not Instructions
User speech is wrapped as `<transcript>` data in the user message; system prompts instruct models never to follow instructions inside it. Prompt-injection cases live in the eval set.

### VII. Stateless, Config-Driven Backend
The API holds no per-request state between calls; it scales horizontally. Presets, model slugs, templates, kill switch, rollout and minimum client version are configuration, changeable without a client release.

### VIII. Simplicity
One deployable backend (modular monolith), one LLM gateway (OpenRouter), managed services for auth/billing/observability. Add infrastructure (queues, regions, self-hosted gateways) only when measured data requires it.

## Security & Compliance Constraints
- TLS everywhere; Cloud Armor WAF in front of the API; Postgres encrypted at rest; least-privilege DB roles and service accounts; secrets in Secret Manager, rotated every 90 days.
- Per-user rate limits, daily/monthly audio caps (Redis) and provider spend caps as a hard backstop.
- Update packages MUST be signed with the Tauri updater key, and every installer MUST have a published SHA-256 checksum. Installers are not code-signed by Apple or a Windows certificate authority (ADR-007); adding paid signing later needs no amendment.
- OpenRouter routing restricted to providers that neither train on nor retain prompts.
- Plan for India DPDP Act and GDPR (consent, purpose limitation, DPAs, breach notification); legal review before public launch.

## Development Workflow & Quality Gates
- PR checks: lint, typecheck, unit, contract tests (mocked Scribe & OpenRouter), eval quality set when prompts/presets change.
- Merge to `main` → staging deploy → smoke test (one real end-to-end dictation) → manual approval → rolling prod deploy with auto-rollback on error-rate / p95 alerts.
- Desktop releases are tag-driven, with signed update manifests, and rolled out 10 % → 50 % → 100 % with a kill switch.
- Each roadmap phase ends with a measurable gate; the next phase does not start until the gate passes.

## Governance
This constitution supersedes other practices. Amendments require a PR updating this file with rationale, a version bump, and review by the tech lead. All plans (`/speckit.plan`) MUST include a Constitution Check; violations must be justified in the plan's Complexity Tracking table.

**Version**: 1.1.0 | **Ratified**: 2026-11-24 | **Last Amended**: 2026-11-24

### Amendment log
- **1.1.0 (2026-11-24):** Installer code signing replaced by signed update manifests + checksums (owner skipped the Apple Developer Program and paid Windows certificates; ADR-007). WAF and secrets now on Google Cloud (ADR-006).
