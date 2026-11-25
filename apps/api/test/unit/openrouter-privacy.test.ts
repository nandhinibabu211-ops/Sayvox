import { describe, expect, it } from "vitest";
import { createOpenRouterClient, type StreamCompletion } from "../../src/lib/openrouter/stream";

describe("OpenRouter privacy routing (T077)", () => {
  it("every outbound request is restricted to no-training, zero-retention providers", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    const client = createOpenRouterClient({ apiKey: "k", fetchFn });
    const models = [
      "anthropic/claude-haiku-5.5",
      "openai/gpt-6-luna",
      "google/gemini-3.5-flash-lite",
    ];
    for (const model of models) {
      const req = {
        model,
        reasoningEffort: "none",
        messages: [{ role: "user", content: "x" }],
      } as unknown as Parameters<StreamCompletion>[0];
      for await (const item of client(req, new AbortController().signal)) void item;
    }
    expect(bodies).toHaveLength(models.length);
    for (const b of bodies) expect(b["provider"]).toEqual({ data_collection: "deny", zdr: true });
  });
});
