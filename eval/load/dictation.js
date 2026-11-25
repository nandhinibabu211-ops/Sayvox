// k6 load test at 3x expected peak (T098, SC-007, architecture section 14).
//
//   k6 run -e BASE_URL=https://<staging-api> -e TOKENS_FILE=tokens.json -e PEAK=50 eval/load/dictation.js
//
// One virtual user = one person dictating in a loop: session start -> ~6 s of "speech" ->
// (for REWRITE_SHARE of presses) an AI rewrite -> session end. Real single-use Scribe
// tokens are minted (no audio is streamed, so no STT cost); rewrites call OpenRouter with a
// synthetic transcript and do cost tokens. Staging only: see docs/runbooks/load-test.md.
//
// TOKENS_FILE: JSON array of Identity Platform ID tokens for staging load-test users on a
// plan with high limits (each VU picks one, so per-user rate limits are not the bottleneck).
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE = (__ENV.BASE_URL || "").replace(/\/$/, "");
if (!BASE) throw new Error("BASE_URL is required");
if (/prod/i.test(BASE) && __ENV.ALLOW_PROD !== "yes") throw new Error("refusing to load-test prod");

const PEAK = Number(__ENV.PEAK || 50); // expected peak simultaneous dictations
const TARGET = PEAK * 3;
const REWRITE_SHARE = Number(__ENV.REWRITE_SHARE || 0.3);
const TOKENS = JSON.parse(open(__ENV.TOKENS_FILE || "tokens.json"));
if (!Array.isArray(TOKENS) || TOKENS.length === 0)
  throw new Error("TOKENS_FILE must be a non-empty JSON array");

const sessionStart = new Trend("sayvox_session_start_ms", true);
const rewriteTotal = new Trend("sayvox_rewrite_ms", true);
const quotaHits = new Counter("sayvox_quota_hits");

export const options = {
  scenarios: {
    peak: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2m", target: PEAK },
        { duration: "3m", target: TARGET },
        { duration: "10m", target: TARGET }, // hold 3x peak
        { duration: "1m", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    // SC-007: error rate < 1 % at 3x peak. Quota answers (429) are counted separately.
    http_req_failed: ["rate<0.01"],
    // Server target < 150 ms, alert at 250 ms; allow for the network from the k6 machine.
    sayvox_session_start_ms: ["p(95)<400"],
    // Section 16: prompt-mode release -> inserted p95 < 3 s; the rewrite is most of it.
    sayvox_rewrite_ms: ["p(95)<3000"],
  },
};

// 429 (quota / rate limit) is an expected answer, not a failure of the service.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 429));

const TRANSCRIPT =
  "um so can you write a function that takes a list of orders and returns the total per customer " +
  "sorted by the biggest spender first and uh skip cancelled orders";

export default function () {
  const token = TOKENS[(__VU - 1) % TOKENS.length];
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-client-version": "0.1.0",
  };

  const start = http.post(`${BASE}/v1/session/start`, "{}", {
    headers,
    tags: { name: "session_start" },
  });
  sessionStart.add(start.timings.duration);
  if (start.status === 429) {
    quotaHits.add(1);
    sleep(5);
    return;
  }
  if (!check(start, { "session started": (r) => r.status === 200 })) {
    sleep(1);
    return;
  }
  const { sessionId } = start.json();

  const speakSeconds = 3 + Math.random() * 6;
  sleep(speakSeconds);

  const rewrite = Math.random() < REWRITE_SHARE;
  let releaseToInsertMs = 300;
  if (rewrite) {
    const res = http.post(
      `${BASE}/v1/rewrite`,
      JSON.stringify({ sessionId, transcript: TRANSCRIPT, mode: "prompt", targetApp: "code.exe" }),
      { headers, tags: { name: "rewrite" }, timeout: "15s" },
    );
    rewriteTotal.add(res.timings.duration);
    check(res, { "rewrite finished": (r) => r.status === 200 && r.body.includes("event: done") });
    releaseToInsertMs = Math.round(res.timings.duration) + 100;
  }

  const end = http.post(
    `${BASE}/v1/session/${sessionId}/end`,
    JSON.stringify({
      audioSeconds: Math.round(speakSeconds * 10) / 10,
      mode: rewrite ? "prompt" : "dictation",
      targetApp: rewrite ? "code.exe" : "notepad.exe",
      insertResult: "inserted",
      timings: { sttCommitMs: 250, releaseToInsertMs },
    }),
    { headers, tags: { name: "session_end" } },
  );
  check(end, { "session ended": (r) => r.status === 204 });

  // Think time between presses.
  sleep(5 + Math.random() * 15);
}
