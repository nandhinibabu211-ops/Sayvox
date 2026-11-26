# Architecture Decision Records

| ADR | Decision | Status | Date |
| --- | --- | --- | --- |
| [ADR-001](ADR-001-desktop-framework.md) | Tauri v2 for the desktop client | Accepted | 2026-11-24 |
| [ADR-002](ADR-002-balanced-model.md) | Balanced preset primary model | Pending: one eval run with an OpenRouter key (T058) | — |
| [ADR-003](ADR-003-billing.md) | Razorpay as the only billing provider | Accepted | 2026-11-24 |
| [ADR-004](ADR-004-free-tier.md) | Free tier: 10 min/day, 120 min/month, Balanced + Cheapest | Accepted (revisit after beta) | 2026-11-24 |
| [ADR-005](ADR-005-history.md) | No transcript history; no text storage | Accepted | 2026-11-24 |
| [ADR-006](ADR-006-google-cloud.md) | Google Cloud for all infrastructure | Accepted | 2026-11-24 |
| [ADR-007](ADR-007-code-signing.md) | No paid code signing (unsigned Windows installers) | Accepted | 2026-11-24 |
| [ADR-009](ADR-009-temporary-domains.md) | Temporary Google domains (`run.app`, `web.app`); load balancer + Cloud Armor deferred | Accepted | 2026-11-24 |
| [ADR-010](ADR-010-windows-first.md) | Windows 10/11 only; macOS out of scope | Accepted | 2026-11-24 |
| [ADR-008](ADR-008-llm-gateway.md) | LLM provider: OpenRouter (no Vertex AI, no Gemini API) | Accepted | 2026-11-24 |
| [ADR-011](ADR-011-metered-audio-proxy.md) | Audio goes through a metering proxy in the API | Accepted | 2026-11-25 |
| [ADR-012](ADR-012-openrouter-speech-to-text.md) | Speech-to-text through OpenRouter (Whisper turbo, Scribe v2 fallback) | Accepted | 2026-11-26 |
