import type { RewriteRequest } from "@sayvox/shared";

/**
 * Client for POST /v1/rewrite (Story 3.6, T053): parses the SSE stream, reports tokens as
 * they arrive and resolves with the full text on `done`. Any `error` event, a stream that
 * ends without a terminal event, or a network failure rejects with RewriteFailed, and the
 * pipeline then pastes the raw transcript (Constitution IV).
 */

export interface RewriteDone {
  text: string;
  model: string;
  ttftMs: number;
  totalMs: number;
  fallbackUsed: boolean;
}

export class RewriteFailed extends Error {
  constructor(readonly reason: "provider" | "network" | "incomplete" | "aborted") {
    super(`rewrite failed: ${reason}`);
    this.name = "RewriteFailed";
  }
}

export interface RewriteTransport {
  fetch(path: string, init: RequestInit): Promise<Response>;
}

export async function streamRewrite(
  api: RewriteTransport,
  req: RewriteRequest,
  onToken: (text: string, soFar: string) => void,
  signal?: AbortSignal,
): Promise<RewriteDone> {
  let res: Response;
  try {
    res = await api.fetch("/v1/rewrite", {
      method: "POST",
      body: JSON.stringify(req),
      headers: { accept: "text/event-stream" },
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new RewriteFailed(signal?.aborted ? "aborted" : "network");
  }
  if (!res.body) throw new RewriteFailed("incomplete");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let fallbackUsed = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const dataLine = /^data: (.+)$/m.exec(block)?.[1];
        if (!event || !dataLine) continue; // ": ping" heartbeats
        const data = JSON.parse(dataLine) as Record<string, unknown>;
        if (event === "token" && typeof data["text"] === "string") {
          text += data["text"];
          onToken(data["text"], text);
        } else if (event === "fallback") {
          fallbackUsed = true;
        } else if (event === "done") {
          return {
            text: text.trim(),
            model: String(data["model"] ?? ""),
            ttftMs: Number(data["ttftMs"] ?? 0),
            totalMs: Number(data["totalMs"] ?? 0),
            fallbackUsed,
          };
        } else if (event === "error") {
          throw new RewriteFailed("provider");
        }
      }
    }
  } catch (err) {
    if (err instanceof RewriteFailed) throw err;
    throw new RewriteFailed(signal?.aborted ? "aborted" : "network");
  } finally {
    reader.releaseLock();
  }
  throw new RewriteFailed("incomplete");
}
