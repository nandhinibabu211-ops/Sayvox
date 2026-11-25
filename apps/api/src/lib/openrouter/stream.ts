import type { ChatMessage } from "@sayvox/prompts";

/**
 * One streamed OpenRouter chat completion for ONE model (contracts/rewrite-sse.md,
 * research R2). The caller walks the preset's models itself, because the lowest reasoning
 * effort differs per model and our 1.5 s first-token deadline isn't an OpenRouter feature.
 */

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  reasoningEffort: ReasoningEffort;
  maxTokens?: number;
  temperature?: number;
}

export type StreamItem =
  | { type: "token"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "error"; code: string };

export class UpstreamHttpError extends Error {
  constructor(readonly status: number) {
    super(`openrouter HTTP ${status}`);
    this.name = "UpstreamHttpError";
  }
}

export interface OpenRouterClientOptions {
  apiKey: string | undefined;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export function requestBody(req: CompletionRequest): Record<string, unknown> {
  return {
    model: req.model,
    stream: true,
    max_tokens: req.maxTokens ?? 600,
    temperature: req.temperature ?? 0.2,
    reasoning: { effort: req.reasoningEffort, exclude: true },
    // Only providers that neither collect data nor retain prompts (Constitution I).
    provider: { data_collection: "deny", zdr: true },
    messages: req.messages,
  };
}

/** Parse OpenRouter SSE into tokens / usage / error items. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamItem> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line || line.startsWith(":")) continue; // keep-alive ": OPENROUTER PROCESSING"
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        let chunk: {
          error?: { code?: unknown };
          choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[];
          usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
        };
        try {
          chunk = JSON.parse(data) as typeof chunk;
        } catch {
          continue;
        }
        if (chunk.error) {
          yield { type: "error", code: String(chunk.error.code ?? "unknown") };
          return;
        }
        const text = chunk.choices?.[0]?.delta?.content;
        if (typeof text === "string" && text.length > 0) yield { type: "token", text };
        if (chunk.usage) {
          yield {
            type: "usage",
            inputTokens: Number(chunk.usage.prompt_tokens ?? 0),
            outputTokens: Number(chunk.usage.completion_tokens ?? 0),
          };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export type StreamCompletion = (
  req: CompletionRequest,
  signal: AbortSignal,
) => AsyncIterable<StreamItem>;

export function createOpenRouterClient(opts: OpenRouterClientOptions): StreamCompletion {
  const base = opts.baseUrl ?? OPENROUTER_BASE;
  const fetchFn = opts.fetchFn ?? fetch;
  return async function* stream(req, signal) {
    if (!opts.apiKey) throw new Error("OPENROUTER_API_KEY is not configured");
    const res = await fetchFn(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        "content-type": "application/json",
        "x-title": "Sayvox",
      },
      body: JSON.stringify(requestBody(req)),
      signal,
    });
    if (!res.ok || !res.body) {
      // Don't read the error body into logs: it can echo the prompt.
      await res.body?.cancel().catch(() => {});
      throw new UpstreamHttpError(res.status);
    }
    yield* parseSse(res.body);
  };
}
