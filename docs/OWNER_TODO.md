# Owner to-do (manual steps only)

Everything that can be done without these is done (as of 2026-11-26). Do them roughly in
this order; each line says where the detailed steps are.

1. **Add the staging API keys** (ElevenLabs, OpenRouter; low spend caps). In a terminal:
   `gcloud secrets versions add sayvox-staging-elevenlabs-api-key --data-file=- --project sayvox-app-2026`
   and the same for `sayvox-staging-openrouter-api-key` (paste, Enter, Ctrl+Z, Enter).
   Then tell Claude: it sets `provider_keys_ready = true`, re-applies, and tests dictation.
2. **Set provider spend caps**: OpenRouter key credit limit; ElevenLabs usage-based billing
   limit. Write the amounts in `docs/runbooks/kill-switch.md` "Cost".
3. **Updater signing key**: generated, public key is in `tauri.conf.json` (2026-11-26). Still
   to do: add the private key file's contents and its password as GitHub repository secrets
   `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, keep an offline backup,
   and create the `release-updates` environment with yourself as required reviewer
   (`docs/runbooks/release.md` steps 1–3).
4. **Test on Windows 10 and Windows 11**: GitHub → Actions → "Staging test installer" →
   Run workflow, download the artifact, install, follow `specs/001-voice-to-prompt-mvp/quickstart.md`
   section 3 (after step 1, so dictation works).
5. **Record quality material**: dictate the 20 timing phrases (`eval/timing/phrases-phase1.md`),
   record consented test phrases (including Tamil-English), and save Lemon's output for each
   case in `eval/baselines/lemon/`.
6. **Google sign-in** (optional): Google Cloud console → Google Auth Platform → consent
   screen + Web OAuth client, then Identity Platform → Providers → Google
   (`docs/runbooks/deploy.md` "Sign-in").
7. **Error Reporting notifications**: Google Cloud console → Error Reporting → Configure
   notifications → your email.
8. **Pricing**: decide Pro price and limits; create the plan in Razorpay (test mode first)
   and give Claude the plan id and test keys.
9. **Expected peak users** for the load test (a number), so Claude can run it on staging.
10. **Legal review** of the privacy policy and terms.
11. **Production go-ahead**: approve the cost (about US$100–150/month), then add required
    reviewers to the GitHub `production` environment. Claude creates prod and sets
    `PROD_ENABLED=true`.
12. **A domain** (optional, later): enables the load balancer + Cloud Armor (WAF).
