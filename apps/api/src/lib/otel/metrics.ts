import { metrics, type Histogram } from "@opentelemetry/api";
import type { FastifyInstance } from "fastify";

/**
 * Metric instruments (architecture §16). More are added by the stories that produce them:
 * session_start_ms (2.4), release_to_insert_ms / stt_commit_ms (2.5), llm_ttft_ms and
 * llm_fallback_total (3.2).
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

/** Test hook: drop cached instruments after swapping the global meter provider. */
export function resetInstruments(): void {
  httpDuration = undefined;
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
