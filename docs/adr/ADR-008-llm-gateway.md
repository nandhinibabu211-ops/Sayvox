# ADR-008: LLM provider for rewrites

**Status:** Accepted · 2026-11-24 · Decided by: project owner

## Context
Rewrites need an LLM API. The owner's ChatGPT subscription doesn't include API access. Vertex AI is not required and won't be used.

## Options considered
- **A. OpenRouter:** one API for GPT-6 Luna, Claude Haiku 5.5 and Gemini 3.5 Flash-Lite, with fallback across providers; new account with prepaid credits (5.5 % fee on credit purchases); can be restricted to providers that don't train on or keep prompts.
- **B. Gemini API** (Google AI Studio key in the owner's Google Cloud project): no new vendor, but Gemini models only, so a Google outage affects every preset; paid tier required for privacy.

## Decision
**Option A — OpenRouter.**

## Consequences
- Presets and fallbacks stay as designed (architecture §7): Fastest, Balanced, Cheapest across three model families.
- Owner action: create an OpenRouter account, buy credits, create separate API keys for dev, staging and prod with spend limits. Keys go in Google Secret Manager only.
- Requests restrict routing to providers that don't train on or keep prompts (verify the exact field in research R2).
- ADR-002 (Balanced primary: Claude Haiku 5.5 vs GPT-6 Luna) is now unblocked and decided by the Story 4.4 timing test.
