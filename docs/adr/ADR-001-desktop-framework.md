# ADR-001: Tauri v2 for the desktop client

**Status:** Accepted · 2026-11-24 · Decided by: project owner delegated the choice ("choose the best option")

## Context
The client needs a global modifier-only hotkey, low-latency mic capture, a non-focus-stealing overlay and clipboard paste on macOS and Windows. Options: Tauri (Rust core + web UI) or Electron (all JavaScript).

## Decision
Tauri v2.

## Rationale
- Installers of a few MB instead of 100+ MB; faster start, lower memory.
- Rust gives direct access to OS hooks (CGEventTap, `WH_KEYBOARD_LL`), `cpal` audio and native clipboard, which the hotkey and paste stories need anyway.
- Its free built-in updater signs update manifests with its own key, which matters more now that installers are not code-signed (ADR-007).

## Consequences
- The team needs some Rust for the native modules.
- Electron stays the fallback if a Tauri blocker appears in Epic 1.
