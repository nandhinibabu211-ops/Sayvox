// Post-deploy smoke test (T094). Usage: node infra/scripts/smoke.mjs <base-url>
//
// Always: health, public client config, auth required, webhook signature enforced.
// With SMOKE_EMAIL + SMOKE_PASSWORD + FIREBASE_WEB_API_KEY (a dedicated staging test user,
// stored as GitHub environment secrets): signs in and runs one real session start/end,
// which mints a real single-use Scribe token. No audio or text is sent.
// Exits non-zero on the first failure.

const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!/^https?:\/\//.test(base)) {
  console.error("usage: node infra/scripts/smoke.mjs <base-url>");
  process.exit(2);
}

let failed = 0;
async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${Date.now() - started} ms)`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function expectStatus(res, ...codes) {
  if (!codes.includes(res.status))
    throw new Error(`HTTP ${res.status}, expected ${codes.join(" or ")}`);
}

const get = (path, init) =>
  fetch(`${base}${path}`, { signal: AbortSignal.timeout(10_000), ...init });

await check("GET /healthz", async () => {
  const res = await get("/healthz");
  expectStatus(res, 200);
});

await check("GET /v1/client-config", async () => {
  const res = await get("/v1/client-config", { headers: { "x-client-version": "0.1.0" } });
  expectStatus(res, 200);
  const body = await res.json();
  for (const key of ["minClientVersion", "latestClientVersion", "killSwitch"]) {
    if (!(key in body)) throw new Error(`missing ${key}`);
  }
  if (body.killSwitch) console.log("     note: kill switch is ON");
});

await check("GET /v1/usage requires sign-in", async () => {
  const res = await get("/v1/usage");
  expectStatus(res, 401);
});

await check("POST /v1/billing/webhook rejects a bad signature", async () => {
  const res = await get("/v1/billing/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-razorpay-signature": "0".repeat(64),
      "x-razorpay-event-id": "smoke",
    },
    body: "{}",
  });
  expectStatus(res, 400, 503);
});

const { SMOKE_EMAIL, SMOKE_PASSWORD, FIREBASE_WEB_API_KEY } = process.env;
if (SMOKE_EMAIL && SMOKE_PASSWORD && FIREBASE_WEB_API_KEY) {
  let idToken = "";
  await check("sign in as the smoke-test user", async () => {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(FIREBASE_WEB_API_KEY)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: SMOKE_EMAIL,
          password: SMOKE_PASSWORD,
          returnSecureToken: true,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    expectStatus(res, 200);
    idToken = (await res.json()).idToken;
  });
  if (idToken) {
    const auth = {
      authorization: `Bearer ${idToken}`,
      "content-type": "application/json",
      "x-client-version": "0.1.0",
    };
    let sessionId = "";
    await check("POST /v1/session/start (real Scribe token)", async () => {
      const res = await get("/v1/session/start", { method: "POST", headers: auth, body: "{}" });
      expectStatus(res, 200);
      const body = await res.json();
      if (!body.scribeToken) throw new Error("no scribe token");
      sessionId = body.sessionId;
    });
    if (sessionId) {
      await check("POST /v1/session/:id/end", async () => {
        const res = await get(`/v1/session/${sessionId}/end`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({
            audioSeconds: 0,
            insertResult: "discarded",
            timings: { sttCommitMs: 0, releaseToInsertMs: 0 },
          }),
        });
        expectStatus(res, 204);
      });
    }
  }
} else {
  console.log(
    "skip authenticated session check (SMOKE_EMAIL / SMOKE_PASSWORD / FIREBASE_WEB_API_KEY not set)",
  );
}

process.exit(failed ? 1 : 0);
