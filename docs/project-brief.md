# Project Brief: Sayvox — Voice-to-Prompt Dictation

> BMAD artifact · Analyst output · v1.0 · 2026-11-24
> Source: `Voice-to-Prompt Dictation App — Production System Architecture (1).md` (2026-11-23, TBT Developers)

## 1. Executive Summary

Sayvox is a hold-to-talk desktop app for macOS and Windows. The user holds **Ctrl+Shift**, speaks, releases, and gets either clean dictation or a structured AI prompt / email / Slack message typed at the cursor in whatever app is focused.

- **Problem:** Typing long prompts, emails and messages is slow; existing dictation is either raw (fillers, no punctuation) or slow, and does not shape text for the target tool (an AI coding assistant, Gmail, Slack).
- **Target market:** Knowledge workers, developers and founders who write to AI tools and colleagues all day, with a strong focus on Indian English and Hinglish speakers that mainstream dictation handles poorly.
- **Value proposition:** Sub-second dictation and 1.5–3 s structured rewrites, inserted directly where the user is typing, with no transcripts stored.

## 2. Problem Statement

- Users spend a large part of their day composing prompts for AI tools (Cursor, ChatGPT, Claude) and messages (Gmail, Slack). Typing is the bottleneck.
- Built-in OS dictation is inaccurate on names, jargon and Indian English, leaves fillers and self-corrections in, and does not structure output.
- Competing tools (benchmark: **Lemon**) are either slower, less accurate on accents, or store user content.
- Privacy is a blocker: users dictate code, client details and emails and do not want them retained.

## 3. Proposed Solution

A small native-feeling client (Tauri) plus a thin stateless backend:

1. Hotkey down → backend issues a single-use ElevenLabs Scribe v3 Live token (pre-fetched).
2. Audio streams directly from the client to Scribe; partial transcripts appear in a "notch" overlay.
3. Hotkey up → manual commit → final transcript.
4. Mode is chosen from the active app (Dictation / Prompt / Email-Slack). Dictation may skip the LLM.
5. Backend rewrites via OpenRouter (streamed, with model fallbacks) and streams tokens back.
6. Client pastes at the cursor via clipboard and restores the clipboard.

**Differentiators:** release-to-insert speed, app-aware rewriting, Indian-English accuracy through keyterms and language hints, no-storage privacy by default, ~US$1–4 per user per month cost base.

## 4. Target Users

### Primary — "AI-heavy builder"
Developers, PMs and founders who write many prompts per day to AI tools. Value structured prompt output (role, goal, context, constraints, output format) and speed.

### Secondary — "Communicator"
Sales, support and operations staff writing many emails and Slack messages; value tone-matching and filler removal.

### Segment focus
Indian English and Hinglish speakers; users who rely on product/brand names (e.g. "Zoho", "Zia") via a custom dictionary.

## 5. Goals & Success Metrics

### Business objectives
- Private beta with 50+ users for two weeks (Phase 3 gate).
- Public launch with paid plans; unit cost ≤ ~$1.06 light / ≤ ~$3.82 heavy user per month.

### User success metrics
- Release → inserted: **< 1 s** dictation; **1.5–3 s p95** prompt and email modes.
- Accuracy ≥ Lemon on a fixed test set of 30+ real dictations incl. Indian English.
- Users never lose words: on total failure the raw transcript is pasted.

### KPIs
| KPI | Target |
| --- | --- |
| p95 release→insert, dictation | ≤ 1.2 s (alert threshold) |
| p95 release→insert, prompt | ≤ 3 s |
| p95 `/v1/session/start` | ≤ 150 ms target, alert at 250 ms |
| Crash-free sessions | > 99.5 % |
| LLM fallback rate | < 5 % |
| Scribe disconnect rate | < 1 % |
| API error rate | < 1 % |

## 6. MVP Scope

### Must have
- Global hold-to-talk hotkey (Ctrl+Shift), mic capture, overlay with live partials.
- Scribe v3 Live streaming with backend-minted single-use tokens, manual commit on release.
- Three modes: Dictation, Prompt, Email/Slack; active-app detection with per-app overrides.
- Backend: auth, `/session/start`, `/rewrite` (SSE), `/session/{id}/end`, settings, dictionary, usage.
- OpenRouter integration with Fastest / Balanced / Cheapest presets and fallbacks.
- Paste at cursor with clipboard restore; optional "review before insert".
- Failure fallbacks (Scribe retry, model fallback, raw transcript paste).
- Metadata-only metering; no transcript storage.

### Out of scope for MVP
- Transcript history (open decision; opt-in and encrypted if ever added).
- Linux client, mobile clients.
- Self-hosted LiteLLM gateway.
- Multi-region backend.
- Team/enterprise admin, SSO, SOC 2.

### MVP success criteria
Phase 2 gate: prompt-mode p95 < 3 s; output quality judged ≥ Lemon on the same phrases.

## 7. Post-MVP Vision
- **Phase 3 (private beta):** macOS + Windows builds (not code-signed, ADR-007), auto-update, quotas, dashboards, privacy page, account deletion.
- **Phase 4 (launch):** billing (Razorpay), plan limits, staged rollouts, kill switch, load test at 3× peak.
- **Long term:** additional regions (EU/Asia), more modes (e.g. code comments, tickets), team plans, optional encrypted history, self-hosted LLM gateway.

## 8. Technical Considerations
- **Platforms:** macOS (universal binary, self-signed, not notarized) and Windows (unsigned) — ADR-007.
- **Client:** Tauri (Rust core + web UI); Electron fallback.
- **Backend:** TypeScript + Fastify, stateless containers on Google Cloud Run (`us-east4`).
- **Data:** Cloud SQL for PostgreSQL, Memorystore for Redis.
- **Services:** ElevenLabs Scribe v3 Live, OpenRouter (ADR-008), Google Identity Platform, Razorpay, Google Cloud Monitoring / Error Reporting / BigQuery, Cloud Armor (ADR-006).

## 9. Constraints & Assumptions
- **Budget:** ElevenLabs Starter ($6/mo) during build → Creator ($22/mo) at launch; OpenRouter prepaid with 5.5 % fee.
- **Assumption:** ElevenLabs endpoint paths, v3 Live model ID and message names must be confirmed in the API reference before coding.
- **Assumption:** OpenRouter model slugs (GPT-6 Luna, Claude Haiku 5.5, Gemini 3.5 Flash-Lite) are kept in config and verified against the live model list.
- **Constraint:** Provider concurrency (ElevenLabs streams) is the first scaling limit.

## 10. Risks & Open Questions

### Key risks
- ElevenLabs concurrency caps at peak hours.
- macOS Accessibility permission friction blocking paste.
- Unsigned installers: Windows SmartScreen and macOS Gatekeeper warnings raise install drop-off (ADR-007).
- Prompt injection via dictated text.
- Client-side audio metering can drift from provider billing.

### Decisions (see `docs/adr/`)
1. Desktop framework — **Tauri** (ADR-001).
2. Balanced default model — pending timing test (ADR-002).
3. Billing — **Razorpay only** (ADR-003).
4. Free tier — **10 min/day, 120 min/month, Balanced + Cheapest** (ADR-004).
5. History — **no storage** (ADR-005).
6. Infrastructure — **Google Cloud** (ADR-006).
7. Code signing — **none paid** (ADR-007).
8. LLM provider — **OpenRouter** (ADR-008).

## 11. Next Steps
Hand off to **PM** to produce `docs/prd.md`, then **Architect** for `docs/architecture.md`, **UX** for `docs/front-end-spec.md`, and **SM** to shard epics into stories.
