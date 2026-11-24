# Epic 5 — Beta Readiness

**Phase:** 3 · **Goal:** Ship builds on both OSes (signed update manifests; installers not code-signed, ADR-007) to 50+ beta users with monitoring, privacy and account controls.
**Gate:** 50+ beta users for two weeks, crash-free sessions > 99.5 %, no p95 regressions.

---

## Story 5.1 — macOS client parity (ADR-010)
**Acceptance Criteria**
1. `CGEventTap` hotkey for Ctrl+Shift hold; non-activating `NSPanel` overlay; app runs as a menu-bar (Accessory) app.
2. Audio capture, active-app detection (bundle id), Cmd+V paste with clipboard restore; Microphone, Accessibility and Input Monitoring permission onboarding.
3. All Epic 1/3 behaviours pass on macOS 13+ (Apple Silicon and Intel), tested on real hardware.

## Story 5.2 — Release build pipeline (no paid signing)
**Acceptance Criteria**
1. On version tag, CI builds a macOS universal `.dmg` signed with a stable self-signed certificate (not notarized) and an unsigned Windows `.msi`/`.exe` (ADR-007).
2. Artifacts and SHA-256 checksums uploaded to Cloud Storage behind Cloud CDN.
3. macOS Accessibility and Microphone permissions survive an app update (verified).
4. Install guide documents the macOS "Open Anyway" and Windows SmartScreen "Run anyway" steps.

## Story 5.3 — Auto-update with staged rollout
**Acceptance Criteria**
1. Tauri updater with signed manifests.
2. Rollout percentage from `/v1/client-config` (10 → 50 → 100 %), bucketed by stable install id.
3. Min supported version forces update.

## Story 5.4 — Observability
**Acceptance Criteria**
1. Backend errors to Google Cloud Error Reporting; client crashes via `POST /v1/telemetry`; request bodies and text never included.
2. OTel metrics → Cloud Monitoring dashboards for every signal in architecture §16.
3. Alerts configured in Cloud Monitoring with the thresholds listed there.
4. Text-free product events via `POST /v1/telemetry` → Cloud Logging → BigQuery: `dictation_started`, `dictation_inserted`, `mode_changed`, `fallback_used`, `quota_hit`.

## Story 5.5 — Free-tier caps (ADR-004)
**Acceptance Criteria**
1. Free plan daily cap and allowed presets decided and recorded.
2. Enforced server-side and shown in Usage screen.

## Story 5.6 — Privacy page, terms and in-app disclosure
**Acceptance Criteria**
1. `apps/web` privacy page: audio → ElevenLabs, text → LLM provider via OpenRouter, nothing stored.
2. Terms of service page; consent captured at sign-up (DPDP/GDPR).
3. OpenRouter routing restricted to no-train/no-retain providers; ElevenLabs zero-retention plan status documented.

## Story 5.7 — Account deletion
**Acceptance Criteria**
1. `DELETE /v1/account` removes user, settings, dictionary terms, sessions, usage rows, cancels subscription, deletes auth identity.
2. UI with typed confirmation; signs out locally and clears keychain.

## Story 5.8 — Beta program
**Acceptance Criteria**
1. Invite-only allowlist; feedback channel; weekly metrics review against gate.
