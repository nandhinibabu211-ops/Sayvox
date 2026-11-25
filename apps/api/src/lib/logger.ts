import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

/**
 * Structured logger that can never print user speech (Constitution I).
 * Any field named like transcript/rewrite/text, any request body, and auth headers are
 * redacted at up to three levels of nesting. Keep this list in sync with new payload fields.
 */
const SENSITIVE_KEYS = [
  "transcript",
  "threadContext",
  "partial",
  "rewrite",
  "text",
  "body",
  "content",
  "audio",
] as const;

const REDACT_PATHS = [
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((k) => `*.${k}`),
  ...SENSITIVE_KEYS.map((k) => `*.*.${k}`),
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-razorpay-signature']",
  "headers.authorization",
];

export function createLogger(
  options: Pick<LoggerOptions, "level"> = {},
  destination?: DestinationStream,
): Logger {
  const opts: LoggerOptions = {
    level: options.level ?? process.env["LOG_LEVEL"] ?? "info",
    base: { service: "sayvox-api" },
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    // Fastify's default request serializer has no body; keep it to method/url/id only.
    serializers: {
      req: (req: { id?: string; method?: string; url?: string }) => ({
        id: req.id,
        method: req.method,
        url: req.url?.split("?")[0],
      }),
    },
  };
  return destination ? pino(opts, destination) : pino(opts);
}
