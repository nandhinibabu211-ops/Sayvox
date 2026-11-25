import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOpenRouterClient, parseSse, requestBody } from "../../src/lib/openrouter/stream";
import { orchestrate, type OrchestratedEvent } from "../../src/modules/rewrite/orchestrate";
import { startMockOpenRouter, type MockOpenRouter } from "../mocks/openrouter";

let mock: MockOpenRouter;
const HAIKU = "anthropic/claude-haiku-5.5";
const LUNA = "openai/gpt-6-luna";
const FLASH = "google/gemini-3.5-flash-lite";
const MESSAGES = [
  { role: "system" as const, content: "S" },
  { role: "user" as const, content: "<transcript>x</transcript>" },
];

beforeAll(async () => {
  mock = await startMockOpenRouter();
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.behaviours.clear();
  mock.requests.length = 0;
  mock.aborted.length = 0;
});

async function run(
  models: string[],
  opts: { ttftMs?: number; totalMs?: number; signal?: AbortSignal } = {},
): Promise<OrchestratedEvent[]> {
  const complete = createOpenRouterClient({ apiKey: "or-key", baseUrl: mock.baseUrl });
  const out: OrchestratedEvent[] = [];
  for await (const e of orchestrate({
    models,
    messages: MESSAGES,
    effortFor: (m) => (m === FLASH ? "minimal" : "none"),
    complete,
    ttftMs: opts.ttftMs ?? 300,
    totalMs: opts.totalMs ?? 3_000,
    ...(opts.signal ? { signal: opts.signal } : {}),
  })) {
    out.push(e);
  }
  return out;
}

const kinds = (events: OrchestratedEvent[]) => events.map((e) => e.event);
const text = (events: OrchestratedEvent[]) =>
  events.flatMap((e) => (e.event === "token" ? [e.data.text] : [])).join("");

describe("request shape (contracts/rewrite-sse.md)", () => {
  it("sends one model with its own reasoning effort and privacy routing", async () => {
    await run([HAIKU]);
    const r = mock.requests[0]!;
    expect(r.auth).toBe("Bearer or-key");
    expect(r.body).toMatchObject({
      model: HAIKU,
      stream: true,
      max_tokens: 600,
      temperature: 0.2,
      reasoning: { effort: "none", exclude: true },
      provider: { data_collection: "deny", zdr: true },
    });
    expect(r.body["models"]).toBeUndefined();
  });

  it("uses 'minimal' for Gemini Flash-Lite, which can't turn reasoning off", () => {
    expect(
      requestBody({ model: FLASH, messages: MESSAGES, reasoningEffort: "minimal" }),
    ).toMatchObject({
      reasoning: { effort: "minimal" },
    });
  });
});

describe("orchestrate (T043)", () => {
  it("streams tokens then done with usage and timings", async () => {
    const events = await run([HAIKU, LUNA]);
    expect(kinds(events).filter((k) => k !== "token")).toEqual(["done"]);
    expect(text(events)).toContain("Goal: Fix the login bug.");
    const done = events.at(-1)!;
    expect(done).toMatchObject({ event: "done", data: { model: HAIKU, inputTokens: 812 } });
  });

  it("falls back on a missed first-token deadline and aborts the slow request", async () => {
    mock.behaviours.set(HAIKU, { kind: "slow", firstTokenAfterMs: 1_000 });
    const events = await run([HAIKU, LUNA], { ttftMs: 200 });
    expect(events[0]).toEqual({
      event: "fallback",
      data: { from: HAIKU, to: LUNA, reason: "timeout" },
    });
    expect(events.at(-1)).toMatchObject({ event: "done", data: { model: LUNA } });
    await new Promise((r) => setTimeout(r, 50));
    expect(mock.aborted).toContain(HAIKU);
  });

  it("falls back on HTTP 5xx", async () => {
    mock.behaviours.set(HAIKU, { kind: "status", status: 502 });
    const events = await run([HAIKU, LUNA]);
    expect(events[0]).toMatchObject({ event: "fallback", data: { reason: "error" } });
    expect(events.at(-1)).toMatchObject({ event: "done", data: { model: LUNA } });
  });

  it("falls back when a model answers with nothing", async () => {
    mock.behaviours.set(HAIKU, { kind: "empty" });
    const events = await run([HAIKU, LUNA]);
    expect(kinds(events)[0]).toBe("fallback");
  });

  it("walks the whole preset: Haiku → Luna → Flash-Lite", async () => {
    mock.behaviours.set(HAIKU, { kind: "status", status: 503 });
    mock.behaviours.set(LUNA, { kind: "slow", firstTokenAfterMs: 1_000 });
    const events = await run([HAIKU, LUNA, FLASH], { ttftMs: 200 });
    expect(events.filter((e) => e.event === "fallback").map((e) => e.data)).toEqual([
      { from: HAIKU, to: LUNA, reason: "error" },
      { from: LUNA, to: FLASH, reason: "timeout" },
    ]);
    expect(events.at(-1)).toMatchObject({ event: "done", data: { model: FLASH } });
    expect(mock.requests.find((r) => r.model === FLASH)!.body["reasoning"]).toEqual({
      effort: "minimal",
      exclude: true,
    });
  });

  it("ends with error when every model fails", async () => {
    mock.behaviours.set(HAIKU, { kind: "status", status: 500 });
    mock.behaviours.set(LUNA, { kind: "status", status: 429 });
    const events = await run([HAIKU, LUNA]);
    expect(events.at(-1)).toEqual({
      event: "error",
      data: { code: "PROVIDER_UNAVAILABLE", message: "All models failed" },
    });
  });

  it("never splices a second model onto a partial answer (cut stream)", async () => {
    mock.behaviours.set(HAIKU, { kind: "cut", tokens: ["Role: ", "You are"] });
    const events = await run([HAIKU, LUNA]);
    expect(kinds(events)).toEqual(["token", "token", "error"]);
    expect(mock.requests.map((r) => r.model)).toEqual([HAIKU]);
  });

  it("an in-stream error after tokens also ends with error", async () => {
    mock.behaviours.set(HAIKU, { kind: "midError", tokens: ["Goal: "] });
    const events = await run([HAIKU, LUNA]);
    expect(kinds(events)).toEqual(["token", "error"]);
  });

  it("respects the total budget", async () => {
    mock.behaviours.set(HAIKU, {
      kind: "normal",
      tokens: ["a", "b", "c", "d", "e"],
      tokenDelayMs: 150,
    });
    const events = await run([HAIKU], { ttftMs: 1_000, totalMs: 300 });
    expect(events.at(-1)).toMatchObject({ event: "error" });
  });

  it("stops quietly and aborts upstream when the client disconnects", async () => {
    mock.behaviours.set(HAIKU, { kind: "normal", tokens: ["a", "b", "c", "d"], tokenDelayMs: 100 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const events = await run([HAIKU, LUNA], { ttftMs: 1_000, signal: ac.signal });
    expect(kinds(events).every((k) => k === "token")).toBe(true);
    expect(mock.requests).toHaveLength(1);
  });
});

describe("parseSse", () => {
  it("skips keep-alive comments and stops at [DONE]", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          enc.encode(': OPENROUTER PROCESSING\n\ndata: {"choices":[{"delta":{"content":"Hi"}}]}\n'),
        );
        c.enqueue(
          enc.encode('\ndata: [DONE]\n\ndata: {"choices":[{"delta":{"content":"late"}}]}\n\n'),
        );
        c.close();
      },
    });
    const items = [];
    for await (const i of parseSse(body)) items.push(i);
    expect(items).toEqual([{ type: "token", text: "Hi" }]);
  });
});
