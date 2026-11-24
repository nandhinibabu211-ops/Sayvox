# ADR-007: No paid code signing

**Status:** Accepted · 2026-11-24 · Decided by: project owner (skip Apple Developer Program; Windows signing only if free)

## Findings
- **Windows:** no free code-signing certificate fits a commercial, closed-source app. SignPath Foundation is free only for open-source projects; Azure Trusted Signing and Authenticode/EV certificates are paid. → **Skipped.**
- **macOS:** Developer ID signing and notarization require the paid Apple Developer Program. → **Skipped.**

## Decision
- macOS builds are signed with a free **self-signed code-signing certificate** (created in Keychain Access, kept in CI secrets), not notarized.
- Windows builds ship **unsigned**.
- Update packages stay signed with **Tauri's updater key** (free), so auto-updates can't be tampered with.
- Every download has a published SHA-256 checksum.

## Consequences
- **macOS:** Gatekeeper blocks the first launch. Users must allow it in System Settings → Privacy & Security → "Open Anyway". The install guide must show this step.
- **macOS permissions:** Accessibility and Microphone grants are tied to the app's signature. A stable self-signed certificate should keep them across updates (ad-hoc signing would reset them on every update). **Must be verified in Story 5.2.**
- **Windows:** SmartScreen shows "Windows protected your PC". Users click "More info → Run anyway". Some antivirus tools may flag unsigned installers.
- Expect more install drop-off than signed builds. Revisit before public launch; switching later is a CI-only change.
- Constitution amended to v1.1.0 to reflect this.
