// Watch a fresh Cloud Run rollout and fail if it looks bad (T094 auto-rollback).
//
//   node infra/scripts/watch-rollout.mjs <project> <service> <revision> [minutes=10]
//
// Every minute: the revision's 5xx share (Cloud Run request_count) and p95 latency
// (request_latencies) over the last 5 minutes, using an access token from
// `gcloud auth print-access-token` (GITHUB WIF credentials in deploy.yml). Fails when the
// 5xx share > 1 % with at least 20 requests, or p95 > 3 s, two checks in a row (section 16).
// The workflow then shifts traffic back to the previous revision.
import { execSync } from "node:child_process";

const [project, service, revision, minutesArg] = process.argv.slice(2);
if (!project || !service || !revision) {
  console.error("usage: watch-rollout.mjs <project> <service> <revision> [minutes]");
  process.exit(2);
}
const minutes = Number(minutesArg ?? 10);
const token = () => execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();

async function series(metric, aligner, reducer, extra = "") {
  const end = new Date();
  const start = new Date(end.getTime() - 5 * 60_000);
  const q = new URLSearchParams({
    filter: `metric.type="run.googleapis.com/${metric}" AND resource.labels.service_name="${service}" AND resource.labels.revision_name="${revision}"${extra}`,
    "interval.startTime": start.toISOString(),
    "interval.endTime": end.toISOString(),
    "aggregation.alignmentPeriod": "300s",
    "aggregation.perSeriesAligner": aligner,
    "aggregation.crossSeriesReducer": reducer,
  });
  const res = await fetch(
    `https://monitoring.googleapis.com/v3/projects/${project}/timeSeries?${q}`,
    {
      headers: { authorization: `Bearer ${token()}` },
    },
  );
  if (!res.ok) throw new Error(`monitoring API ${res.status}`);
  const body = await res.json();
  const point = body.timeSeries?.[0]?.points?.[0]?.value;
  return point ? Number(point.int64Value ?? point.doubleValue ?? 0) : 0;
}

let strikes = 0;
for (let i = 1; i <= minutes; i++) {
  await new Promise((r) => setTimeout(r, 60_000));
  const [total, errors, p95] = await Promise.all([
    series("request_count", "ALIGN_DELTA", "REDUCE_SUM"),
    series(
      "request_count",
      "ALIGN_DELTA",
      "REDUCE_SUM",
      ' AND metric.labels.response_code_class="5xx"',
    ),
    series("request_latencies", "ALIGN_DELTA", "REDUCE_PERCENTILE_95"),
  ]).catch((err) => {
    console.log(`minute ${i}: could not read metrics (${err.message}); not counted`);
    return [0, 0, 0];
  });
  const share = total > 0 ? errors / total : 0;
  const bad = (total >= 20 && share > 0.01) || p95 > 3000;
  strikes = bad ? strikes + 1 : 0;
  console.log(
    `minute ${i}: ${total} requests, ${(share * 100).toFixed(2)} % 5xx, p95 ${Math.round(p95)} ms${bad ? "  <-- over limit" : ""}`,
  );
  if (strikes >= 2) {
    console.log("rollout unhealthy two checks in a row");
    process.exit(1);
  }
}
console.log("rollout healthy");
