# ADR-005: No transcript history

**Status:** Accepted · 2026-11-24 · Decided by: owner delegated the choice

## Decision
Sayvox stores no transcripts, partials or rewrites. No history feature in MVP, beta or launch.

## Rationale
- Strongest privacy promise and simplest DPDP/GDPR position.
- No encryption-at-rest, export or deletion flows to build for text.
- The core loop (dictate → insert) doesn't need history.

## Consequences
- If history is ever added it must be opt-in, encrypted, exportable and deletable (Constitution I), via a new ADR.
