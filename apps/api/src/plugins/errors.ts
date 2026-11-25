import { ERROR_STATUS, type ErrorCode, type ErrorEnvelope } from "@sayvox/shared";
import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { serverErrorEntry } from "../lib/errorReporting";

const VERSION = process.env["npm_package_version"] ?? "0.0.0";

/** Throw this from routes and plugins; the handler maps it to the contract's error envelope. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly resetAt: Date | undefined;

  constructor(code: ErrorCode, message: string, opts: { resetAt?: Date } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.resetAt = opts.resetAt;
  }
}

const STATUS_CODE: Partial<Record<number, ErrorCode>> = {
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  429: "RATE_LIMITED",
};

export function errorBody(
  code: ErrorCode,
  message: string,
  requestId: string,
  resetAt?: Date,
): ErrorEnvelope {
  return {
    error: { code, message, requestId, ...(resetAt ? { resetAt: resetAt.toISOString() } : {}) },
  };
}

/** Installs the not-found and error handlers on the root instance. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((req, reply) => {
    reply.code(ERROR_STATUS.NOT_FOUND).send(errorBody("NOT_FOUND", "Route not found", req.id));
  });

  app.setErrorHandler((err: FastifyError | ApiError | ZodError, req, reply) => {
    if (err instanceof ApiError) {
      if (err.status >= 500) req.log.error({ errCode: err.code }, "request failed");
      return reply.code(err.status).send(errorBody(err.code, err.message, req.id, err.resetAt));
    }
    if (err instanceof ZodError) {
      // Report which fields failed, never their values (they may contain user text).
      const fields = [...new Set(err.issues.map((i) => i.path.join(".") || "(root)"))];
      return reply
        .code(400)
        .send(errorBody("VALIDATION_FAILED", `Invalid fields: ${fields.join(", ")}`, req.id));
    }
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    // Unexpected failure: report to Error Reporting with a scrubbed stack (no message, no
    // request body — either could carry user text).
    if (status >= 500) req.log.error(serverErrorEntry(err, VERSION), "request failed");
    const code: ErrorCode =
      status >= 500 ? "INTERNAL" : (STATUS_CODE[status] ?? "VALIDATION_FAILED");
    // Never echo messages for 5xx (may carry upstream payloads) or parser errors (may echo body).
    const message =
      status >= 500
        ? "Internal error"
        : code === "VALIDATION_FAILED"
          ? "Invalid request"
          : err.message;
    return reply.code(status).send(errorBody(code, message, req.id));
  });
}
