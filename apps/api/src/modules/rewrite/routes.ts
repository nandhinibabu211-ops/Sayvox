import { buildMessages, TEMPLATE_VERSION } from "@sayvox/prompts";
import { RewriteRequest } from "@sayvox/shared";
import type { FastifyInstance } from "fastify";
import { llmTtftDuration, rewriteCounter } from "../../lib/otel/metrics";
import type { StreamCompletion } from "../../lib/openrouter/stream";
import { ApiError } from "../../plugins/errors";
import { requireUser } from "../auth/plugin";
import type { ConfigService } from "../config/service";
import { llmCostUsd, type ModelPrice } from "../config/validateSlugs";
import { orchestrate } from "./orchestrate";
import type { RewriteStore } from "./store";

export interface RewriteDeps {
  store: RewriteStore;
  config: ConfigService;
  complete: StreamCompletion;
  prices: () => Map<string, ModelPrice>;
  heartbeatMs?: number;
  ttftMs?: number;
  totalMs?: number;
  now?: () => Date;
}

/**
 * POST /v1/rewrite (Story 3.3, contracts/rewrite-sse.md): streams `meta`, `token`*,
 * `fallback`*, then exactly one of `done` / `error`. Validation and ownership errors are
 * normal JSON error envelopes sent before the stream starts.
 */
export function registerRewriteRoutes(app: FastifyInstance, deps: RewriteDeps): void {
  const now = deps.now ?? (() => new Date());

  app.post("/v1/rewrite", async (req, reply) => {
    const user = requireUser(req);
    const body = RewriteRequest.parse(req.body);

    const status = await deps.store.sessionStatus(user.id, body.sessionId);
    if (status === null) throw new ApiError("NOT_FOUND", "Session not found");
    if (status !== "started") throw new ApiError("CONFLICT", "Session already ended");

    const preset = await deps.store.preset(user.id);
    const models = (await deps.config.presets())[preset];
    const { messages } = buildMessages({
      mode: body.mode,
      targetApp: body.targetApp,
      transcript: body.transcript,
      threadContext: body.threadContext,
    });

    // From here on we own the socket and speak SSE.
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      // Don't let proxies buffer the stream (Cloud Run / load balancer).
      "x-accel-buffering": "no",
      "x-request-id": req.id,
    });
    const write = (event: string, data: unknown) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    let lastWrite = Date.now();
    const heartbeat = setInterval(
      () => {
        if (Date.now() - lastWrite >= (deps.heartbeatMs ?? 5_000) && !res.writableEnded) {
          res.write(": ping\n\n");
          lastWrite = Date.now();
        }
      },
      Math.min(deps.heartbeatMs ?? 5_000, 1_000),
    );

    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on("close", onClose);

    write("meta", {
      sessionId: body.sessionId,
      mode: body.mode,
      preset,
      model: models[0],
      templateVersion: TEMPLATE_VERSION,
    });

    let fallbackUsed = false;
    try {
      for await (const ev of orchestrate({
        models,
        messages,
        effortFor: (slug) => deps.config.reasoningEffort(slug),
        complete: deps.complete,
        signal: abort.signal,
        ...(deps.ttftMs ? { ttftMs: deps.ttftMs } : {}),
        ...(deps.totalMs ? { totalMs: deps.totalMs } : {}),
      })) {
        lastWrite = Date.now();
        if (ev.event === "fallback") {
          fallbackUsed = true;
          req.log.warn(
            { from: ev.data.from, to: ev.data.to, reason: ev.data.reason },
            "rewrite fallback",
          );
        }
        if (ev.event === "done") {
          write("done", ev.data);
          llmTtftDuration().record(ev.data.ttftMs, { mode: body.mode });
          rewriteCounter().add(1, { mode: body.mode, outcome: fallbackUsed ? "fallback" : "ok" });
          await deps.store
            .record(
              user.id,
              body.sessionId,
              {
                mode: body.mode,
                targetApp: body.targetApp,
                modelUsed: ev.data.model,
                fallbackUsed,
                inputTokens: ev.data.inputTokens,
                outputTokens: ev.data.outputTokens,
                ttftMs: ev.data.ttftMs,
                totalMs: ev.data.totalMs,
                llmCostUsd: llmCostUsd(
                  deps.prices().get(ev.data.model),
                  ev.data.inputTokens,
                  ev.data.outputTokens,
                ),
              },
              now(),
            )
            .catch((err: unknown) =>
              req.log.error({ errName: (err as Error).name }, "rewrite record failed"),
            );
          continue;
        }
        if (ev.event === "error") {
          req.log.warn({ code: ev.data.code }, "rewrite failed");
          rewriteCounter().add(1, { mode: body.mode, outcome: "error" });
          await deps.store
            .record(
              user.id,
              body.sessionId,
              {
                mode: body.mode,
                targetApp: body.targetApp,
                modelUsed: null,
                fallbackUsed: true,
                inputTokens: 0,
                outputTokens: 0,
                ttftMs: null,
                totalMs: 0,
                llmCostUsd: 0,
              },
              now(),
            )
            .catch(() => {});
        }
        write(ev.event, ev.data);
      }
    } catch (err) {
      req.log.error({ errName: (err as Error).name }, "rewrite crashed");
      write("error", { code: "PROVIDER_UNAVAILABLE", message: "Rewrite failed" });
    } finally {
      clearInterval(heartbeat);
      res.off("close", onClose);
      if (!res.writableEnded) res.end();
    }
  });
}
