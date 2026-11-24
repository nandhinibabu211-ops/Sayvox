# Data Model: Voice-to-Prompt Dictation

Postgres 16. All timestamps `timestamptz` UTC. **No entity stores transcript, partial, rewrite or thread text.**

## Entities

### users
| Column | Type | Constraints |
| --- | --- | --- |
| id | uuid | PK, default `gen_random_uuid()` |
| email | text | unique, not null |
| auth_provider_id | text | unique, not null (Identity Platform user id / `sub`) |
| plan_id | text | FK → plans.id, default `'free'` |
| status | enum `user_status` (`active`, `suspended`, `deleted`) | default `active` |
| region | text | nullable (billing routing) |
| consented_at | timestamptz | set at sign-up consent (Story 5.6) |
| terms_version | text | version of terms/privacy accepted (Story 5.6) |
| created_at | timestamptz | default now() |

### plans
| Column | Type | Constraints |
| --- | --- | --- |
| id | text | PK (`free`, `pro`, …) |
| name | text | not null |
| monthly_audio_minutes | int | not null |
| daily_cap_minutes | int | not null |
| allowed_presets | text[] | subset of `fastest`,`balanced`,`cheapest` |
| dictionary_limit | int | not null |
| price_cents | int | not null |
| currency | char(3) | not null |

### subscriptions
| Column | Type | Constraints |
| --- | --- | --- |
| user_id | uuid | FK → users.id ON DELETE CASCADE |
| provider | text, default `'razorpay'` | only Razorpay today (ADR-003) |
| provider_sub_id | text | unique |
| status | enum (`active`, `past_due`, `cancelled`, `incomplete`) | |
| current_period_end | timestamptz | |
| PK | (user_id, provider_sub_id) | |

### settings
| Column | Type | Constraints |
| --- | --- | --- |
| user_id | uuid | PK, FK → users.id ON DELETE CASCADE |
| preset | enum `preset` (`fastest`,`balanced`,`cheapest`) | default `balanced`; must be in plan.allowed_presets |
| default_mode | enum `mode` (`dictation`,`prompt`,`email`) | default `dictation` |
| app_mode_overrides | jsonb | `{ "<appId>": "<mode>" }`, ≤ 100 keys |
| insert_mode | enum (`auto`,`review`) | default `auto` |
| language_hint | text | nullable (`auto` when null) |
| hotkey | text | default `Ctrl+Shift` |
| updated_at | timestamptz | |

### dictionary_terms
| Column | Type | Constraints |
| --- | --- | --- |
| id | uuid | PK |
| user_id | uuid | FK ON DELETE CASCADE, indexed |
| term | text | 1–64 chars, trimmed |
| created_at | timestamptz | |
| unique | (user_id, lower(term)) | |
Count per user ≤ `plans.dictionary_limit`.

### sessions
| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| user_id | uuid | FK ON DELETE CASCADE |
| started_at / ended_at | timestamptz | |
| mode | mode | nullable until rewrite/end |
| target_app | text | app id only (bundle id / exe) |
| audio_seconds | numeric(8,2) | clamped ≤ max_session_seconds |
| model_used | text | nullable (dictation fast path) |
| fallback_used | bool | default false |
| input_tokens / output_tokens | int | |
| ttft_ms / total_ms | int | backend LLM timings |
| stt_commit_ms / release_to_insert_ms | int | client timings |
| status | enum (`started`,`completed`,`raw_fallback`,`failed`,`abandoned`) | |
| client_version | text | |
| region | text | API region |
Index: `(user_id, started_at desc)`; partial index on `status='started'` for sweeper.

### usage_daily
| Column | Type | Notes |
| --- | --- | --- |
| user_id | uuid | FK ON DELETE CASCADE |
| day | date | UTC |
| audio_seconds | numeric(10,2) | |
| requests | int | |
| llm_cost_usd | numeric(10,5) | |
| stt_cost_usd | numeric(10,5) | |
| PK | (user_id, day) | |

### billing_events (idempotency)
| Column | Type | Notes |
| --- | --- | --- |
| provider | text | |
| event_id | text | |
| received_at | timestamptz | |
| PK | (provider, event_id) | payload not stored |

## State transitions — Session
```
started ──(end: inserted)──────────▶ completed
started ──(end: raw_fallback)──────▶ raw_fallback
started ──(end: failed/discarded)──▶ failed
started ──(sweeper: TTL expired)───▶ abandoned
```

## Redis keys
| Key | Type | TTL | Purpose |
| --- | --- | --- | --- |
| `rl:{userId}` | token bucket | 60 s | session-start rate limit |
| `quota:day:{userId}:{yyyymmdd}` | int (seconds) | 48 h | daily audio |
| `quota:month:{userId}:{yyyymm}` | int (seconds) | 40 d | monthly audio |
| `settings:{userId}` | JSON | 5 min | settings + keyterms cache |
| `cfg:client` | JSON | none | kill switch, min version, rollout |
| `cfg:presets` | JSON | none | preset → model slug overrides |

## Validation rules
- `transcript` (request only) ≤ 20 000 chars; never persisted.
- `targetApp` ≤ 200 chars, `[A-Za-z0-9._\- ]`.
- `audioSeconds` 0 ≤ x ≤ `maxSessionSeconds`.
- Account deletion cascades every user-owned table; auth identity deleted via provider API.
