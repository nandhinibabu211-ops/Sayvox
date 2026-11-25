import { metrics, type Counter, type Histogram } from "@opentelemetry/api";
import type { FastifyInstance } from "fastify";

/**
 * Metric instruments (architecture section 16). Alerts and dashboards on them live in
 * infra/observability (T092); keep names in sync with infra/observability/main.tf.
 */
let httpDuration: Histogram | undefined;

function instruments() {
  if (!httpDuration) {
    httpDuration = metrics.getMeter("sayvox-api").createHistogram("http_server_duration_ms", {
      description: "Server-side request duration",
      unit: "ms",
      advice: { explicitBucketBoundaries: [5, 10, 25, 50, 100, 150, 250, 500, 1000, 3000, 8000] },
    });
  }
  return { httpDuration };
}

let sessionStart: Histogram | undefined;
let releaseToInsert: Histogram | undefined;
let sttCommit: Histogram | undefined;

const LATENCY_BUCKETS = [25, 50, 100, 150, 250, 400, 600, 800, 1000, 1200, 1500, 2000, 3000, 5000];

/** Server time of /v1/session/start (target < 150 ms, alert p95 > 250 ms). */
export function sessionStartDuration(): Histogram {
  sessionStart ??= metrics.getMeter("sayvox-api").createHistogram("session_start_ms", {
    unit: "ms",
    advice: { explicitBucketBoundaries: LATENCY_BUCKETS },
  });
  return sessionStart;
}

/** Client-reported release → inserted (the primary product metric, Constitution III). */
export function releaseToInsertDuration(): Histogram {
  releaseToInsert ??= metrics.getMeter("sayvox-api").createHistogram("release_to_insert_ms", {
    unit: "ms",
    advice: { explicitBucketBoundaries: LATENCY_BUCKETS },
  });
  return releaseToInsert;
}

export function sttCommitDuration(): Histogram {
  sttCommit ??= metrics.getMeter("sayvox-api").createHistogram("stt_commit_ms", {
    unit: "ms",
    advice: { explicitBucketBoundaries: LATENCY_BUCKETS },
  });
  return sttCommit;
}

let llmTtft: Histogram | undefined;
let rewrites: Counter | undefined;
let sessionEnds: Counter | undefined;

/** Time to first rewrite token (alerting uses the fallback share, T092). */
export function llmTtftDuration(): Histogram {
  llmTtft ??= metrics.getMeter("sayvox-api").createHistogram("llm_ttft_ms", {
    unit: "ms",
    advice: { explicitBucketBoundaries: LATENCY_BUCKETS },
  });
  return llmTtft;
}

/** Every rewrite by outcome: ok, fallback (a fallback model answered) or error (raw insert). */
export function rewriteCounter(): Counter {
  rewrites ??= metrics.getMeter("sayvox-api").createCounter("rewrite_total");
  return rewrites;
}

/**
 * Every ended session by insert result and whether Scribe had to reconnect (the
 * disconnect signal in architecture section 16).
 */
export function sessionEndCounter(): Counter {
  sessionEnds ??= metrics.getMeter("sayvox-api").createCounter("session_end_total");
  return sessionEnds;
}

/** Test hook: drop cached instruments after swapping the global meter provider. */
export function resetInstruments(): void {
  httpDuration = undefined;
  sessionStart = undefined;
  releaseToInsert = undefined;
  sttCommit = undefined;
  llmTtft = undefined;
  rewrites = undefined;
  sessionEnds = undefined;
}

/**
 * Record every response by route *template* (e.g. /v1/session/:id/end), never the raw URL,
 * so ids and query strings don't explode metric cardinality or leak data.
 */
export function registerHttpMetrics(app: FastifyInstance): void {
  app.addHook("onResponse", async (req, reply) => {
    instruments().httpDuration.record(reply.elapsedTime, {
      "http.route": req.routeOptions.url ?? "unmatched",
      "http.request.method": req.method,
      "http.response.status_class": `${Math.floor(reply.statusCode / 100)}xx`,
    });
  });
}
