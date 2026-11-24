# ADR-004: Free tier limits

**Status:** Accepted, revisit with beta data (Story 5.5) · 2026-11-24 · Decided by: owner delegated the choice

## Decision
| Limit | Free plan |
| --- | --- |
| Daily audio cap | 10 minutes |
| Monthly audio cap | 120 minutes (2 hours) |
| Presets | Balanced, Cheapest (Fastest is paid-only) |
| Dictionary terms | 25 |

## Rationale
- Speech-to-text is the main cost: $0.22 per audio hour (+ ~$0.08/hr with custom words). Two hours a month is about $0.60 at most, plus ~$0.10 of rewrites, so a maxed-out free user costs under ~$0.75/month.
- 10 minutes a day covers dozens of short dictations, enough to judge the product.
- Fastest costs about 4× the LLM line, so it stays paid.

## Consequences
- Seed data for the `free` plan uses these values.
- Check them against real beta usage before public launch and update this ADR.
