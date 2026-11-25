import { randomUUID } from "node:crypto";
import { ERROR_STATUS, type ErrorCode, type ErrorEnvelope } from "@sayvox/shared";
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from "fastify";

export interface BuildAppOptions {
  logger: FastifyBaseLogger;
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

const STATUS_CODE: Partial<Record<number, ErrorCode>> = {
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  429: "RATE_LIMITED",
};

function errorBody(code: ErrorCode, message: string, requestId: string): ErrorEnvelope {
  return { error: { code, message, requestId } };
}

export function buildApp({ logger }: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && SAFE_REQUEST_ID.test(incoming)
        ? incoming
        : randomUUID();
    },
    disableRequestLogging: false,
    bodyLimit: 64 * 1024,
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(ERROR_STATUS.NOT_FOUND).send(errorBody("NOT_FOUND", "Route not found", req.id));
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status >= 500) req.log.error({ errCode: err.code, errName: err.name }, "request failed");
    const code: ErrorCode =
      status >= 500 ? "INTERNAL" : (STATUS_CODE[status] ?? "VALIDATION_FAILED");
    // Never echo err.message for 5xx: it may contain upstream payloads.
    reply
      .code(status)
      .send(errorBody(code, status >= 500 ? "Internal error" : err.message, req.id));
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  return app;
}
