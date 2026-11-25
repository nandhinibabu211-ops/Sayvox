# ADR-007: No paid code signing

**Status:** Accepted · 2026-11-24 (amended for Windows only, ADR-010) · Decided by: project owner (Windows signing only if free; no Apple Developer Program)

## Findings
- **Windows:** no free code-signing certificate fits a commercial, closed-source app. SignPath Foundation is free only for open-source projects; Azure Trusted Signing and Authenticode/EV certificates are paid. → **Skipped.**
- **macOS:** not applicable — Sayvox is Windows only (ADR-010).

## Decision
- Windows installers (`.msi` and NSIS `.exe`) ship **unsigned**.
- Update packages stay signed with **Tauri's updater key** (free), so auto-updates can't be tampered with.
- Every download has a published SHA-256 checksum.

## Consequences
- SmartScreen shows "Windows protected your PC". Users click "More info → Run anyway". The install guide must show this step.
- Some antivirus tools may flag unsigned installers; track reports during beta.
- Expect more install drop-off than signed builds. Revisit before public launch; switching to paid signing later is a CI-only change.
- Constitution v1.1.0 reflects this.
