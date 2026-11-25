import type { ChatMessage } from "@sayvox/prompts";

/**
 * Minimal OpenRouter client for the eval (same request shape as production:
 * apps/api/src/lib/openrouter/stream.ts, contracts/rewrite-sse.md). Streams so we can
 * measure time to first token.
 */

export const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

/** Lowest reasoning effort per model (research R2). */
export const EFFORT: Record<string, "none" | "minimal"> = {
  "google/gemini-3.5-flash-lite": "minimal",
};

export interface Completion {
  text: string;
  ttftMs: number;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
}

export async function complete(
  model: string,
  messages: ChatMessage[],
  opts: { apiKey: string; fetchFn?: typeof fetch; maxTokens?: number; temperature?: number },
): Promise<Completion> {
  const started = performance.now();
  const res = await (opts.fetchFn ?? fetch)(OPENROUTER, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
      "x-title": "Sayvox eval",
    },
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: opts.maxTokens ?? 600,
      temperature: opts.temperature ?? 0.2,
      reasoning: { effort: EFFORT[model] ?? "none", exclude: true },
      provider: { data_collection: "deny", zdr: true },
      messages,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok || !res.body) throw new Error(`${model}: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let ttftMs = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      const chunk = JSON.parse(data) as {
        error?: { message?: string };
        choices?: { delta?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      if (chunk.error) throw new Error(`${model}: ${chunk.error.message ?? "stream error"}`);
      const t = chunk.choices?.[0]?.delta?.content;
      if (t) {
        if (!text) ttftMs = performance.now() - started;
        text += t;
      }
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? 0;
        outputTokens = chunk.usage.completion_tokens ?? 0;
      }
    }
  }
  return {
    text: text.trim(),
    ttftMs: Math.round(ttftMs),
    totalMs: Math.round(performance.now() - started),
    inputTokens,
    outputTokens,
  };
}
