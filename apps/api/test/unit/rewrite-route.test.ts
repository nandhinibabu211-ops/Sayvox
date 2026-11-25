import { REWRITE_EVENT_SCHEMAS, type RewriteEventName } from "@sayvox/shared";
import { Writable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";
import { loadEnv } from "../../src/config/env";
import { createLogger } from "../../src/lib/logger";
import { createOpenRouterClient } from "../../src/lib/openrouter/stream";
import { ConfigService } from "../../src/modules/config/service";
import type { RewriteResult, RewriteStore } from "../../src/modules/rewrite/store";
import { startMockOpenRouter, type MockOpenRouter } from "../mocks/openrouter";

const SESSION = "3f1c2a4e-8b7d-4c1a-9e2f-1a2b3c4d5e6f";
const SECRET = "tell priya the zoho invoice is delayed";
const HAIKU = "anthropic/claude-haiku-5.5";
const LUNA = "openai/gpt-6-luna";

let mock: MockOpenRouter;
let logs = "";
const records: RewriteResult[] = [];
let sessionStatus: string | null = "started";
let claimAllowed = true;

const store: RewriteStore = {
  sessionStatus: async (_u, id) => (id === SESSION ? sessionStatus : null),
  preset: async () => "balanced",
  record: async (_u, _s, r) => {
    records.push(r);
  },
};

function makeApp() {
  const env = loadEnv({ DATABASE_URL: "x", REDIS_URL: "x", GCP_PROJECT_ID: "p" });
  const logStream = new Writable({
    write(c, _e, cb) {
      logs += c.toString();
      cb();
    },
  });
  return buildApp({
    logger: createLogger({ level: "info" }, logStream),
    auth: {
      verify: async (t) => ({ sub: t, email: `${t}@x.com`, emailVerified: true }),
      resolveUser: async (id) => ({
        id: `user-${id.sub}`,
        authProviderId: id.sub,
        email: id.email,
        planId: "free",
        status: "active",
      }),
    },
    rewrite: {
      store,
      config: new ConfigService(env, undefined),
      complete: createOpenRouterClient({ apiKey: "k", baseUrl: mock.baseUrl }),
      prices: () => new Map([[HAIKU, { prompt: 0.0000001, completion: 0.0000005 }]]),
      ttftMs: 250,
      totalMs: 3_000,
      claim: async () => claimAllowed,
    },
  });
}

/** Parse an SSE body into [{event, data}] (skipping comments). */
function parseEvents(body: string): { event: string; data: unknown }[] {
  return body
    .split("\n\n")
    .filter((b) => b.includes("event:"))
    .map((b) => {
      const event = /^event: (.+)$/m.exec(b)![1]!;
      const data = JSON.parse(/^data: (.+)$/m.exec(b)![1]!) as unknown;
      return { event, data };
    });
}

const post = (app: ReturnType<typeof makeApp>, payload: object) =>
  app.inject({
    method: "POST",
    url: "/v1/rewrite",
    headers: { authorization: "Bearer u1" },
    payload,
  });

const body = (over: object = {}) => ({
  sessionId: SESSION,
  transcript: SECRET,
  mode: "prompt",
  targetApp: "cursor.exe",
  ...over,
});

beforeAll(async () => {
  mock = await startMockOpenRouter();
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.behaviours.clear();
  mock.requests.length = 0;
  records.length = 0;
  logs = "";
  sessionStatus = "started";
  claimAllowed = true;
});

describe("POST /v1/rewrite (T042, contracts/rewrite-sse.md)", () => {
  it("streams meta, tokens and exactly one terminal done, all matching the shared schemas", async () => {
    const app = makeApp();
    const res = await post(app, body());
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(res.headers["cache-control"]).toBe("no-store");

    const events = parseEvents(res.body);
    expect(events[0]!.event).toBe("meta");
    expect(events[0]!.data).toMatchObject({
      sessionId: SESSION,
      mode: "prompt",
      preset: "balanced",
      model: HAIKU,
    });
    for (const e of events) {
      expect(REWRITE_EVENT_SCHEMAS[e.event as RewriteEventName].safeParse(e.data).success).toBe(
        true,
      );
    }
    const terminal = events.filter((e) => e.event === "done" || e.event === "error");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.event).toBe("done");
    expect(events.filter((e) => e.event === "token").length).toBeGreaterThan(0);

    expect(records[0]).toMatchObject({
      modelUsed: HAIKU,
      fallbackUsed: false,
      mode: "prompt",
      targetApp: "cursor.exe",
    });
    expect(records[0]!.llmCostUsd).toBeGreaterThan(0);
    await app.close();
  });

  it("sends the transcript wrapped as data in the user message, after the fixed system prompt", async () => {
    const app = makeApp();
    await post(app, body());
    const messages = mock.requests[0]!.body["messages"] as { role: string; content: string }[];
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.content).toBe(
      `<target_app>cursor.exe</target_app>\n<transcript>${SECRET}</transcript>`,
    );
    await app.close();
  });

  it("emits fallback then done from the next model", async () => {
    mock.behaviours.set(HAIKU, { kind: "status", status: 503 });
    const app = makeApp();
    const events = parseEvents((await post(app, body())).body);
    expect(events.map((e) => e.event).filter((e) => e !== "token")).toEqual([
      "meta",
      "fallback",
      "done",
    ]);
    expect(events.at(-1)!.data).toMatchObject({ model: LUNA });
    expect(records[0]).toMatchObject({ modelUsed: LUNA, fallbackUsed: true });
    await app.close();
  });

  it("ends with one error event when every model fails", async () => {
    for (const m of [HAIKU, LUNA, "google/gemini-3.5-flash-lite"])
      mock.behaviours.set(m, { kind: "status", status: 500 });
    const app = makeApp();
    const events = parseEvents((await post(app, body())).body);
    expect(events.at(-1)).toEqual({
      event: "error",
      data: { code: "PROVIDER_UNAVAILABLE", message: "All models failed" },
    });
    expect(events.filter((e) => e.event === "done" || e.event === "error")).toHaveLength(1);
    await app.close();
  });

  it("uses the chat template for Slack in email mode", async () => {
    const app = makeApp();
    await post(app, body({ mode: "email", targetApp: "slack.exe" }));
    const system = (mock.requests[0]!.body["messages"] as { content: string }[])[0]!.content;
    expect(system).toContain("chat message");
    await app.close();
  });

  it("returns JSON 404 for an unknown session and 409 for an ended one, before streaming", async () => {
    const app = makeApp();
    const missing = await post(app, body({ sessionId: "00000000-0000-4000-8000-000000000000" }));
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("NOT_FOUND");
    sessionStatus = "completed";
    const ended = await post(app, body());
    expect(ended.statusCode).toBe(409);
    expect(mock.requests).toHaveLength(0);
    await app.close();
  });

  it("refuses another rewrite once the session's cap is used, before calling a model", async () => {
    const app = makeApp();
    claimAllowed = false;
    const res = await post(app, body());
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("RATE_LIMITED");
    expect(mock.requests).toHaveLength(0);
    await app.close();
  });

  it("rejects oversized transcripts with 400", async () => {
    const app = makeApp();
    const res = await post(app, body({ transcript: "a".repeat(20_001) }));
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("aaaa");
    await app.close();
  });

  it("requires auth", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "POST", url: "/v1/rewrite", payload: body() });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("rewrite logs never contain user text (T044, Constitution I)", () => {
  it("success, fallback and failure paths log metadata only", async () => {
    const app = makeApp();
    await post(app, body());
    mock.behaviours.set(HAIKU, { kind: "status", status: 503 });
    await post(app, body());
    for (const m of [HAIKU, LUNA, "google/gemini-3.5-flash-lite"])
      mock.behaviours.set(m, { kind: "status", status: 500 });
    await post(app, body({ threadContext: "priya asked about the zoho invoice" }));
    await app.close();

    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toMatch(/priya|zoho/i);
    expect(logs).not.toContain("Goal: Fix the login bug");
    expect(logs).toContain("rewrite fallback");
  });
});
