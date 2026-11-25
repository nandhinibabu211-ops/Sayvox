# Privacy audit (T078)

Checks that nothing a user says ends up stored anywhere Sayvox writes data
(Constitution I, FR-018). Run it on **staging** before each release and after any change to
logging, telemetry or the database schema.

## 1. Dictate the canaries

On a staging build, signed in as a test account:

1. Run `pnpm --filter @sayvox/eval privacy:audit -- --print-only` to see today's phrases, or
   use the list in `checks.ts` (`DEFAULT_PHRASES`) plus `canary <yyyy mm dd> saffron`.
2. Dictate each phrase **three times**: once in Notepad (Dictation), once in Cursor
   (Prompt) and once in Gmail with reply context on, with the phrase also in the selected
   text (Email).
3. Make at least one dictation fail on purpose (unplug the network mid-rewrite) so the error
   paths and crash reporting run too.
4. Add one canary as a dictionary term, then delete it. (While the term exists it _is_
   expected in `dictionary_terms.term`; after deletion it must be gone.)

## 2. Run the audit

Wait ~5 minutes for log sinks to flush, then run it from **Cloud Shell** (it has `gcloud`,
`bq`, `psql` and Node preinstalled) or another Linux/WSL shell. Windows `.cmd` wrappers for
`gcloud`/`bq` aren't supported, because arguments are passed without a shell.

```bash
export DATABASE_URL="postgres://audit_ro@<staging-db>/sayvox"
pnpm --filter @sayvox/eval privacy:audit -- --project sayvox-staging --dataset sayvox_analytics
```

It searches Cloud Logging, Error Reporting events, every table in the BigQuery dataset, and
every text/json column in Postgres. It needs `gcloud`, `bq` and `psql` on PATH with read
access, and prints only where a phrase was found, never row contents.

**Pass** = every source checked and zero hits. Any `FAIL` or `NOT CHECKED` line blocks the
release; record the result in the release checklist.
