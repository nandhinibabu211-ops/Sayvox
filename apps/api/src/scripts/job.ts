/* eslint-disable no-console -- CLI script: one structured JSON line for Cloud Logging */
import { lastWeek, providerSttMinutes, recordedAudioSeconds, reconcile } from "../jobs/reconcile";
import { checkSpend, dailySpend, spendWindow } from "../jobs/spend";
import { createDb } from "../lib/db/client";

/**
 * Scheduled jobs (Cloud Run jobs + Cloud Scheduler, infra/terraform/jobs.tf):
 *   job.ts reconcile   weekly audio reconciliation vs ElevenLabs (T096)
 *   job.ts spend       daily spend vs 7-day average (T097)
 * Each prints one JSON line; log-based metrics in infra/observability alert on it.
 */
const command = process.argv[2];
const url = process.env["DATABASE_URL"];
if (!url || !["reconcile", "spend"].includes(command ?? "")) {
  console.error("usage: DATABASE_URL=... job.ts <reconcile|spend>");
  process.exit(1);
}

const { db, close } = createDb(url, 1);
try {
  const now = new Date();
  if (command === "reconcile") {
    const w = lastWeek(now);
    const apiKey = process.env["ELEVENLABS_API_KEY"];
    const [recorded, provider] = await Promise.all([
      recordedAudioSeconds(db, w),
      apiKey ? providerSttMinutes({ apiKey, window: w }).catch(() => null) : null,
    ]);
    const r = reconcile(w, recorded, provider);
    console.log(
      JSON.stringify({
        severity: r.status === "drift" ? "WARNING" : "INFO",
        message: "reconcile",
        ...r,
      }),
    );
  } else {
    const { from, to } = spendWindow(now);
    const s = checkSpend(now, await dailySpend(db, from, to));
    console.log(JSON.stringify({ severity: s.alert ? "WARNING" : "INFO", message: "spend", ...s }));
  }
} finally {
  await close();
}
