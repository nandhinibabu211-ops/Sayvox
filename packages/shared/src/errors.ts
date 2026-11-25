import { z } from "zod";

/** Error codes from contracts/openapi.yaml `Error.error.code`. */
export const ErrorCode = z.enum([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "CONFLICT",
  "QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "CLIENT_OUTDATED",
  "KILL_SWITCH",
  "PROVIDER_UNAVAILABLE",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** HTTP status for each error code. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  QUOTA_EXCEEDED: 402,
  RATE_LIMITED: 429,
  CLIENT_OUTDATED: 426,
  KILL_SWITCH: 503,
  PROVIDER_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    requestId: z.string(),
    resetAt: z.iso.datetime().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
