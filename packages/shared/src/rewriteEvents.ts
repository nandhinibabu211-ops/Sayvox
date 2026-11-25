import { z } from "zod";
import { Mode, Preset } from "./schemas";

/** Server-Sent Event payloads for POST /v1/rewrite (contracts/rewrite-sse.md). */

export const RewriteMetaEvent = z.object({
  sessionId: z.uuid(),
  mode: Mode,
  preset: Preset,
  model: z.string(),
  templateVersion: z.string(),
});

export const RewriteTokenEvent = z.object({
  text: z.string(),
});

export const RewriteFallbackEvent = z.object({
  from: z.string(),
  to: z.string(),
  reason: z.enum(["timeout", "error"]),
});

export const RewriteDoneEvent = z.object({
  model: z.string(),
  inputTokens: z.int().min(0),
  outputTokens: z.int().min(0),
  ttftMs: z.int().min(0),
  totalMs: z.int().min(0),
});

export const RewriteErrorEvent = z.object({
  code: z.literal("PROVIDER_UNAVAILABLE"),
  message: z.string(),
});

export const REWRITE_EVENT_SCHEMAS = {
  meta: RewriteMetaEvent,
  token: RewriteTokenEvent,
  fallback: RewriteFallbackEvent,
  done: RewriteDoneEvent,
  error: RewriteErrorEvent,
} as const;

export type RewriteEventName = keyof typeof REWRITE_EVENT_SCHEMAS;
export type RewriteEvent = {
  [K in RewriteEventName]: { event: K; data: z.infer<(typeof REWRITE_EVENT_SCHEMAS)[K]> };
}[RewriteEventName];

/** Exactly one of these ends a rewrite stream. */
export const TERMINAL_REWRITE_EVENTS: readonly RewriteEventName[] = ["done", "error"];
