import { describe, expect, it } from "vitest";
import { RewriteFailed, streamRewrite } from "./rewriteClient";

const REQ = {
  sessionId: "3f1c2a4e-8b7d-4c1a-9e2f-1a2b3c4d5e6f",
  transcript: "fix the login bug",
  mode: "prompt" as const,
  targetApp: "cursor.exe",
};

/** A Response whose body arrives in the given pieces (to test split SSE frames). */
function sseResponse(pieces: string[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const p of pieces) c.enqueue(enc.encode(p));
        c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const ev = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe("streamRewrite (T053)", () => {
  it("streams tokens and resolves on done, across split frames and heartbeats", async () => {
    const body =
      ev("meta", {
        sessionId: REQ.sessionId,
        mode: "prompt",
        preset: "balanced",
        model: "m",
        templateVersion: "x",
      }) +
      ": ping\n\n" +
      ev("token", { text: "Goal: " }) +
      ev("token", { text: "fix login." }) +
      ev("done", {
        model: "anthropic/claude-haiku-5.5",
        inputTokens: 1,
        outputTokens: 2,
        ttftMs: 420,
        totalMs: 900,
      });
    const pieces = [body.slice(0, 37), body.slice(37, 120), body.slice(120)];
    const seen: string[] = [];
    let sentBody = "";
    const r = await streamRewrite(
      {
        fetch: async (_p, init) => {
          sentBody = String(init.body);
          return sseResponse(pieces);
        },
      },
      REQ,
      (_t, soFar) => seen.push(soFar),
    );
    expect(r).toEqual({
      text: "Goal: fix login.",
      model: "anthropic/claude-haiku-5.5",
      ttftMs: 420,
      totalMs: 900,
      fallbackUsed: false,
    });
    expect(seen).toEqual(["Goal: ", "Goal: fix login."]);
    expect(JSON.parse(sentBody)).toEqual(REQ);
  });

  it("notes a fallback", async () => {
    const r = await streamRewrite(
      {
        fetch: async () =>
          sseResponse([
            ev("fallback", { from: "a", to: "b", reason: "timeout" }) +
              ev("token", { text: "x" }) +
              ev("done", { model: "b", inputTokens: 0, outputTokens: 0, ttftMs: 1, totalMs: 2 }),
          ]),
      },
      REQ,
      () => {},
    );
    expect(r.fallbackUsed).toBe(true);
  });

  it("rejects on an error event", async () => {
    const p = streamRewrite(
      {
        fetch: async () =>
          sseResponse([
            ev("token", { text: "x" }),
            ev("error", { code: "PROVIDER_UNAVAILABLE", message: "m" }),
          ]),
      },
      REQ,
      () => {},
    );
    await expect(p).rejects.toMatchObject({ reason: "provider" });
  });

  it("rejects when the stream ends without a terminal event", async () => {
    const p = streamRewrite(
      { fetch: async () => sseResponse([ev("token", { text: "x" })]) },
      REQ,
      () => {},
    );
    await expect(p).rejects.toMatchObject({ reason: "incomplete" });
  });

  it("rejects on network failure", async () => {
    const p = streamRewrite(
      {
        fetch: async () => {
          throw new TypeError("Failed to fetch");
        },
      },
      REQ,
      () => {},
    );
    await expect(p).rejects.toBeInstanceOf(RewriteFailed);
  });
});
