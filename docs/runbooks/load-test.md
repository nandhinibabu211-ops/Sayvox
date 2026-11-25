# Load test at 3× peak (T098, SC-007, launch gate)

Script: `eval/load/dictation.js` (k6). Run against **staging** only; the script refuses a
URL containing "prod" unless `ALLOW_PROD=yes`.

## Before

1. Decide the expected peak of simultaneous dictations (`PEAK`). Without launch data, use
   expected daily active users × 5 %. Write it here: `PEAK = ____`.
2. Make staging prod-like for the run: `min_instances` / `max_instances` and the Cloud SQL
   and Memorystore sizes as in `prod.tfvars` (apply, then revert after).
3. Check the staging ElevenLabs plan allows `3 × PEAK` concurrent tokens, and the staging
   OpenRouter key has credit for about `3 × PEAK × 15 min / 15 s × REWRITE_SHARE` rewrites
   (~3 600 at PEAK 50). Each rewrite costs real tokens.
4. Create load-test users in the staging Identity Platform tenant (one per 5 VUs is enough)
   on a plan whose daily cap won't stop the run (insert a `loadtest` plan with high limits
   in staging and set those users to it). Collect their ID tokens (valid 1 h) into
   `tokens.json` as a JSON array. Keep the file out of git.

## Run

```bash
k6 run -e BASE_URL=https://<staging api_url> -e TOKENS_FILE=tokens.json -e PEAK=50 eval/load/dictation.js
```

16 minutes: ramp to peak, ramp to 3× peak, hold 10 min, ramp down. Watch the Sayvox
(staging) dashboard at the same time.

## Pass

- `http_req_failed` < 1 % (429 answers are counted in `sayvox_quota_hits`, not as failures;
  if there are many, the test users' plan is too small).
- `sayvox_session_start_ms` p95 < 400 ms from the k6 machine (dashboard server p95 < 250 ms).
- `sayvox_rewrite_ms` p95 < 3 s.
- No alert fires on the staging dashboard; Cloud SQL CPU < 70 %; no Scribe token errors.

If ElevenLabs refuses tokens first, that is scaling order 1 (architecture section 17):
upgrade the tier before launch rather than tuning the API.

## Results

| Date | PEAK | VUs | Failed % | Start p95 | Rewrite p95 | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |
