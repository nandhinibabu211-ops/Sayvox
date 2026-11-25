# Kill switch, degradation and rollback (T099)

What to do when Sayvox is broken, too slow or costing too much, and the drill that proves
each lever works before launch. Alerts link here (infra/observability).

## The levers

Runtime config lives in Redis (Memorystore, private), so it is changed through the
`sayvox-<env>-cfg` Cloud Run job, which runs inside the VPC. Every run prints one JSON
audit line to Cloud Logging; paste it into the incident log.

```bash
# alias for the commands below (prod; use sayvox-staging-cfg for staging)
cfg() { gcloud run jobs execute sayvox-prod-cfg --region us-east4 --wait --args="src/scripts/cfg.ts,$(IFS=,; echo "$*")"; }
cfg get
```

Commas separate arguments, so a message cannot contain a comma.

| Lever | Command | Takes effect |
| --- | --- | --- |
| **Pause the service** | `cfg set killSwitch=true "killSwitchMessage=Back in 15 minutes"` | API refuses new sessions within 10 s (`KILL_SWITCH`, the overlay says "Sayvox is temporarily paused."); clients show your message from their next config poll (≤ 30 min, or on wake) |
| Resume | `cfg unset killSwitch killSwitchMessage` | within 10 s |
| Halt a desktop rollout | `cfg set rolloutPercent=0` | next config poll |
| Force an update | `cfg set minClientVersion=X.Y.Z` | clients below it block with "Update required"; API refuses them (`CLIENT_OUTDATED`) |
| Roll back the API | `gcloud run services update-traffic sayvox-prod-api --region us-east4 --to-revisions PREV=100` | seconds |
| Roll back a desktop release | `docs/runbooks/release.md` "Stopping a bad release" | next update check |

Find `PREV` with `gcloud run revisions list --service sayvox-prod-api --region us-east4`
(the deploy workflow also prints it). Database migrations are expand-only within a
release, so the previous revision runs against the new schema.

## Which lever for which alert

| Alert | First look | Lever |
| --- | --- | --- |
| API 5xx > 1 % | Did a deploy just happen? Error Reporting for `sayvox-api` | Roll back the API. Deploys roll themselves back when this happens in the first 10 min |
| Release → inserted p95 high | Dashboard: Scribe commit vs LLM TTFT vs session start | Scribe slow: ElevenLabs status page, nothing to switch. LLM slow: fallbacks already apply; if one provider is down for long, change its preset order |
| LLM fallback > 5 % | OpenRouter status, model in `rewrite fallback` logs | Usually wait; dictation mode is unaffected. Prolonged: change preset order (below) |
| Scribe disconnects > 1 % | ElevenLabs status, concurrency limit (scaling order 1) | Upgrade the ElevenLabs tier; as a last resort pause the service |
| `/v1/session/start` p95 > 250 ms | Cloud SQL / Memorystore CPU, instance count | Raise `max_instances` / `min_instances` in tfvars and apply |
| Spend > 2× 7-day average | `spend` job log line, BigQuery events, abuse by one account? | See "Cost" below |
| Reconciliation drift > 5 % | `reconcile` job log line | Not urgent: compare in the ElevenLabs dashboard; look for sessions never ended or a leaked key |
| New crash type | Error Reporting, version and module | Halt the rollout if it is the new version |

**Model presets.** The ordered model list per preset can be overridden in Redis key
`cfg:presets` (JSON, e.g. `{"balanced":["openai/gpt-6-luna","anthropic/claude-haiku-5.5"]}`).
There is no CLI verb for it yet; until there is, change `PRESET_*` in the Cloud Run service
env and deploy. Every slug must pass the eval gate before it is used in prod.

## Cost

Three caps, outermost first. Set them before launch and write the values here.

1. **OpenRouter key credit limit.** OpenRouter → Keys → the prod key → credit limit
   (monthly). When reached, rewrites fail and the app inserts the raw transcript (dictation
   keeps working). Limit: `____ USD / month`.
2. **ElevenLabs.** Subscription tier plus usage-based billing limit in the ElevenLabs
   dashboard (Subscription → usage-based billing). When reached, Scribe refuses tokens
   and dictation stops: alert fires on API errors. Limit: `____ USD / month`.
3. **Google Cloud budget** (infra/observability `monthly_budget`): emails at 50 %, 90 %,
   100 % and at 100 % forecast. Budgets alert, they do not stop spending. Budget: `____`.

Separate, low-cap keys for staging (architecture section 11).

If spend spikes: check whether one account dominates (`usage_daily` by user, in Cloud SQL
Studio), whether free-tier abuse is happening (many new accounts), and whether a client
bug loops sessions. Pause the service if the cause is unknown and the rate is dangerous.

## Drill (run on staging before launch, then every quarter)

Record start and end times; each step lists what "pass" means.

1. **Kill switch.** Dictate once in the staging build. `cfg set killSwitch=true
   "killSwitchMessage=Drill"`. Within 10 s a new press shows "Sayvox is
   temporarily paused." (`/v1/session/start` returns `KILL_SWITCH`), and after the next
   config poll or a restart the app shows "Drill" (`node infra/scripts/smoke.mjs` shows
   `kill switch is ON`). `cfg unset killSwitch killSwitchMessage`; within 10 s dictation works.
2. **Forced update.** `cfg set minClientVersion=99.0.0`; the app shows "Update required" on
   the next poll or restart. `cfg set minClientVersion=0.1.0`.
3. **Rollout halt.** `cfg set rolloutPercent=0`; `GET /v1/client-config` shows
   `inRollout: false`. Put it back to 100.
4. **API rollback.** Deploy any commit to staging, then
   `update-traffic --to-revisions PREV=100`; smoke passes against the old revision and
   `gcloud run services describe` shows it serving 100 %. Move traffic back to the latest.
5. **Automatic rollback.** Run deploy.yml with a commit whose `/healthz` returns 500 (a
   throwaway branch): the prod job must stop at the smoke step without moving traffic.
   (Do this in staging by temporarily pointing the production environment at staging
   variables, or skip and rely on step 4 plus the workflow review.)
6. **Desktop rollback.** Follow release.md "Roll back" with a staging bucket copy.

Write the results (date, who, times, problems) at the bottom of this file.

## Drill log

| Date | Who | Result | Notes |
| --- | --- | --- | --- |
| | | | |
