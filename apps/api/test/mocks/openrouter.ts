import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Mock OpenRouter (T041): streams chat completions in OpenRouter's SSE format, with
 * per-model behaviour so fallback paths can be exercised.
 */
export type Behaviour =
  | { kind: "normal"; tokens?: string[]; tokenDelayMs?: number }
  | { kind: "status"; status: number }
  /** Wait before the first token (TTFT miss). */
  | { kind: "slow"; firstTokenAfterMs: number; tokens?: string[] }
  /** Send some tokens, then drop the connection. */
  | { kind: "cut"; tokens: string[] }
  /** Send some tokens, then an in-stream error chunk (finish_reason "error"). */
  | { kind: "midError"; tokens: string[] }
  /** 200 with no content tokens. */
  | { kind: "empty" };

export interface MockOpenRouter {
  baseUrl: string;
  behaviours: Map<string, Behaviour>;
  requests: { model: string; body: Record<string, unknown>; auth: string | undefined }[];
  aborted: string[];
  close: () => Promise<void>;
}

const DEFAULT_TOKENS = ["Role: ", "You are a senior ", "engineer.\n", "Goal: Fix the login bug."];

function sse(res: ServerResponse, obj: unknown): void {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function delta(text: string) {
  return { choices: [{ index: 0, delta: { content: text } }] };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startMockOpenRouter(): Promise<MockOpenRouter> {
  const mock: MockOpenRouter = {
    baseUrl: "",
    behaviours: new Map(),
    requests: [],
    aborted: [],
    close: async () => {},
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/api/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [
            {
              id: "anthropic/claude-haiku-5.5",
              pricing: { prompt: "0.0000001", completion: "0.0000005" },
            },
            { id: "openai/gpt-6-luna", pricing: { prompt: "0.0000001", completion: "0.0000005" } },
            {
              id: "google/gemini-3.5-flash-lite",
              pricing: { prompt: "0.0000003", completion: "0.0000025" },
            },
          ],
        }),
      );
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      const model = String(body["model"]);
      mock.requests.push({ model, body, auth: req.headers.authorization });
      const b = mock.behaviours.get(model) ?? { kind: "normal" };
      let closed = false;
      res.on("close", () => {
        if (!res.writableEnded) {
          closed = true;
          mock.aborted.push(model);
        }
      });

      if (b.kind === "status") {
        res.statusCode = b.status;
        res.end(JSON.stringify({ error: { code: b.status, message: "upstream says no" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": OPENROUTER PROCESSING\n\n");

      if (b.kind === "slow") await sleep(b.firstTokenAfterMs);
      if (closed) return;
      const tokens =
        b.kind === "normal" || b.kind === "slow"
          ? (b.tokens ?? DEFAULT_TOKENS)
          : b.kind === "empty"
            ? []
            : b.tokens;
      for (const t of tokens) {
        if (closed) return;
        sse(res, delta(t));
        if (b.kind === "normal" && b.tokenDelayMs) await sleep(b.tokenDelayMs);
      }
      if (b.kind === "cut") {
        // Let the tokens reach the client before the connection drops.
        await sleep(50);
        res.destroy();
        return;
      }
      if (b.kind === "midError") {
        sse(res, {
          error: { code: "server_error", message: "boom" },
          choices: [{ delta: {}, finish_reason: "error" }],
        });
        res.end();
        return;
      }
      sse(res, {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 812, completion_tokens: tokens.length * 3 },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  mock.baseUrl = `http://127.0.0.1:${port}/api/v1`;
  mock.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return mock;
}
