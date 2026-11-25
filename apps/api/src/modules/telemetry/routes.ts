import { scrubStack, TelemetryBatch, type CrashReport, type TelemetryEvent } from "@sayvox/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { requireUser } from "../auth/plugin";
import { reportedError } from "../../lib/errorReporting";

/**
 * `POST /v1/telemetry` (T076): client crash reports → Error Reporting, text-free product
 * events → Cloud Logging (→ BigQuery via a log sink, T093). Both go out as structured log
 * lines on stdout; Cloud Run ships them to Cloud Logging.
 *
 * The schema is strict (enums, numbers, version strings; unknown fields rejected) and the
 * one free-form field, `stack`, is scrubbed again here even though the client scrubs it.
 * No user id is attached: events are counted, not tied to people.
 */

export interface TelemetryDeps {
  /** Where the structured lines go (the app logger in production). */
  logger: FastifyBaseLogger;
}

export function crashLogEntry(c: CrashReport): Record<string, unknown> {
  return reportedError({
    service: "sayvox-desktop",
    version: c.clientVersion,
    stack: scrubStack(c.stack),
    errorCode: c.errorCode,
    module: c.module ?? "other",
    extra: { os: c.os, at: c.at },
  });
}

export function eventLogEntry(e: TelemetryEvent): Record<string, unknown> {
  return {
    telemetry: "event",
    name: e.name,
    at: e.at,
    ...(e.mode ? { mode: e.mode } : {}),
    ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
    ...(e.clientVersion ? { clientVersion: e.clientVersion } : {}),
    ...(e.os ? { os: e.os } : {}),
  };
}

export function registerTelemetryRoutes(app: FastifyInstance, deps: TelemetryDeps): void {
  app.post("/v1/telemetry", { bodyLimit: 128 * 1024 }, async (req, reply) => {
    requireUser(req);
    const { items } = TelemetryBatch.parse(req.body);
    for (const item of items) {
      if (item.kind === "crash") deps.logger.error(crashLogEntry(item), "client crash");
      else deps.logger.info(eventLogEntry(item), "client event");
    }
    return reply.code(202).send();
  });
}
