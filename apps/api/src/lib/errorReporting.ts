import { scrubStack } from "@sayvox/shared";

/**
 * Structured log fields that make Cloud Error Reporting group an entry as an error
 * (https://cloud.google.com/error-reporting/docs/formatting-error-messages). Error
 * Reporting reads the stack from `stack_trace`/`message`; when there's no stack it needs a
 * `reportLocation`, so we always give one (the module).
 *
 * Callers pass an already-scrubbed stack; it never contains a message or request body.
 */
export function reportedError(e: {
  service: string;
  version: string;
  stack: string;
  errorCode: string;
  module: string;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    "@type": "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent",
    severity: "ERROR",
    serviceContext: { service: e.service, version: e.version },
    stack_trace: e.stack || `${e.errorCode} (no stack)`,
    context: { reportLocation: { filePath: e.module, functionName: e.errorCode, lineNumber: 0 } },
    errCode: e.errorCode,
    ...e.extra,
  };
}

/** Server-side unexpected error → Error Reporting fields, with the message stripped. */
export function serverErrorEntry(err: unknown, version: string): Record<string, unknown> {
  const e = err as { name?: string; code?: unknown; stack?: string };
  const code = typeof e.code === "string" && /^[A-Z0-9_]{1,64}$/.test(e.code) ? e.code : "INTERNAL";
  return reportedError({
    service: "sayvox-api",
    version,
    stack: scrubStack(e.stack),
    errorCode: code,
    module: e.name ?? "Error",
  });
}
