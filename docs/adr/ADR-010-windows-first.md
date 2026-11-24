# ADR-010: Windows first

**Status:** Accepted · 2026-11-24 · Decided by: project owner

## Context
The architecture planned Phase 1 on macOS. The development machine is Windows, and no Mac is available for testing hotkeys, overlay focus, permissions or paste.

## Decision
Phase 1 (proof of concept) and Phase 2 (MVP) are built and tested on **Windows 10/11**. macOS support moves to Phase 3 (Story 5.1, now "macOS client parity").

## Consequences
- Epic 1 and Epic 3 native modules are written for Windows first: `WH_KEYBOARD_LL` hotkey hook, `WS_EX_NOACTIVATE` overlay, `SendInput` Ctrl+V paste, foreground-process app detection.
- Native code stays behind per-OS traits so macOS can be added without touching the shared logic.
- A Mac (real hardware) is needed before Phase 3 to build and test the macOS client.
- Windows test apps for manual checks: Notepad, Word, Chrome/Edge (Gmail), Slack, Teams, VS Code, Cursor, Windows Terminal.
