# ADR-010: Windows only

**Status:** Accepted · 2026-11-24 · Decided by: project owner ("Windows ku mattum start pannu, macOS ku vennam")
**Supersedes:** the earlier version of this ADR ("Windows first; macOS in Phase 3").

## Context
The architecture planned macOS and Windows. The development machine is Windows, and no Mac is available.

## Decision
Sayvox targets **Windows 10/11 only**. macOS is out of scope for every phase (PoC, MVP, beta, launch). It is not deferred to a later phase; adding it later needs a new ADR.

## Consequences
- All native modules are Windows only: `WH_KEYBOARD_LL` hotkey hook, `WS_EX_NOACTIVATE` overlay, `SendInput` Ctrl+V paste, foreground-process app detection, Credential Manager for tokens.
- Story 5.1 (macOS client parity) is removed. No Mac hardware is needed.
- ADR-007's macOS self-signing, Gatekeeper and permission-persistence work no longer applies; only the unsigned Windows installer and SmartScreen guidance remain.
- Native code can still sit behind small traits for testability, but no macOS implementation is planned.
- Windows test apps for manual checks: Notepad, Word, Chrome/Edge (Gmail), Slack, Teams, VS Code, Cursor, Windows Terminal.
- Spec Kit and BMAD docs drop macOS from target platforms, CI matrices, telemetry enums and install guides.
