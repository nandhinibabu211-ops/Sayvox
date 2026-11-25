# Release runbook (Stories 5.2, 5.3, 6.6)

How a desktop release goes from a tag to every user, and how to stop or roll it back.
Workflow: `.github/workflows/release.yml`. Hosting: `infra/downloads/`.

## One-time setup

1. **Hosting.** `terraform -chdir=infra/downloads init` then
   `terraform -chdir=infra/downloads apply -var github_repo=<owner>/<repo>`. Copy the
   `github_vars` output into GitHub → Settings → Variables (`RELEASE_BUCKET`,
   `GCP_WIF_PROVIDER`, `GCP_RELEASE_SERVICE_ACCOUNT`). Also set `API_BASE_URL` and
   `FIREBASE_WEB_API_KEY` (the public web key).
2. **Updater key pair** (ADR-007: installers unsigned, updates signed).
   ```powershell
   pnpm --filter @sayvox/desktop tauri signer generate -w $HOME\.tauri\sayvox-updater.key
   ```
   - Put the **public** key in `apps/desktop/src-tauri/tauri.conf.json` →
     `plugins.updater.pubkey` (replace `REPLACE_WITH_UPDATER_PUBLIC_KEY`) and commit it.
     Until then builds report the updater as not configured and the release workflow fails.
   - Put the **private** key file's contents and its password in GitHub secrets
     `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Keep an offline
     backup: losing it means existing installs can never auto-update again.
3. **Approval gate.** GitHub → Settings → Environments → `release-updates` → required
   reviewers. The `publish` job waits there.

## Shipping version X.Y.Z

1. Bump `version` in `apps/desktop/src-tauri/tauri.conf.json` and
   `apps/desktop/package.json` (the workflow refuses a tag that doesn't match), merge.
2. Set the rollout to 10 % **before** the update goes live:
   `pnpm --filter @sayvox/api cfg:set rolloutPercent=10 latestClientVersion=X.Y.Z`
3. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. The `build` job uploads `releases/vX.Y.Z/` (installers, `.sig`, `SHA256SUMS.txt`,
   staging copy of `latest.json`). Install that `.exe` on a clean Windows 10 and Windows 11
   VM following only the install page.
5. Approve `publish`. It copies `latest.json` to `updates/latest.json` (the updater
   endpoint) and the installers to `releases/latest/` (the install page links).
6. Watch for 24 h before each step up (Cloud Monitoring, Error Reporting for
   `sayvox-desktop` version X.Y.Z): crash rate, release → inserted p95, Scribe/rewrite
   error rates, session-end `failed` share. Each must be no worse than the previous version.
   - Good → `cfg:set rolloutPercent=50`, wait 24 h, check again → `cfg:set rolloutPercent=100`.
   - Bad → stop (below).

Clients in the rollout download in the background and install after 10 idle minutes
(never during a dictation), or on the next start.

## Stopping a bad release

- **Halt the rollout:** `cfg:set rolloutPercent=0`. Installs that already updated stay on
  X.Y.Z; nobody else gets it.
- **Roll back:** re-publish the previous good version's manifest:
  ```bash
  gcloud storage cp gs://$BUCKET/releases/vPREV/latest.json gs://$BUCKET/updates/latest.json --cache-control="no-cache, max-age=0"
  ```
  Tauri only installs *newer* versions, so users already on X.Y.Z need a new, higher
  version (X.Y.Z+1) built from the good code. Ship that through the normal steps.
- **Force everyone off a broken version:** after X.Y.Z+1 is live,
  `cfg:set minClientVersion=X.Y.Z+1`. Older clients show the blocking "Update required"
  window and the API refuses their sessions (`CLIENT_OUTDATED`).
- **Pause the whole service:**
  `cfg:set killSwitch=true "killSwitchMessage=Back in 15 minutes"`; undo with
  `cfg:unset killSwitch killSwitchMessage`. Clients see it within 30 min (on next poll or
  wake) and the API refuses new sessions within 10 s.

Every `cfg:set` prints a JSON audit line; paste it into the incident log.

In staging and prod Redis is private (Memorystore), so run these through the
`sayvox-<env>-cfg` Cloud Run job instead of `pnpm cfg:set` from a laptop: see
`kill-switch.md` "The levers".
