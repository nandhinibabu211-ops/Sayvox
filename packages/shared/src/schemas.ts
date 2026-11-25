import { z } from "zod";

/**
 * Request/response schemas mirroring specs/001-voice-to-prompt-mvp/contracts/openapi.yaml.
 * Keep the two in sync: the OpenAPI file is the contract, these are its runtime form.
 */

export const Mode = z.enum(["dictation", "prompt", "email"]);
export type Mode = z.infer<typeof Mode>;

export const Preset = z.enum(["fastest", "balanced", "cheapest"]);
export type Preset = z.infer<typeof Preset>;

export const InsertMode = z.enum(["auto", "review"]);
export type InsertMode = z.infer<typeof InsertMode>;

/** Windows only (ADR-010). */
export const ClientOs = z.enum(["windows10", "windows11"]);
export type ClientOs = z.infer<typeof ClientOs>;

/** App ids only (exe name or virtual `web:*` id); window titles never leave the device. */
export const TargetApp = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9._:\- ]+$/);

export const ClientConfig = z.object({
  minClientVersion: z.string(),
  latestClientVersion: z.string(),
  killSwitch: z.boolean(),
  killSwitchMessage: z.string().optional(),
  rolloutPercent: z.int().min(0).max(100),
  inRollout: z.boolean(),
});
export type ClientConfig = z.infer<typeof ClientConfig>;

export const SessionStartRequest = z.object({
  prefetch: z.boolean().default(false),
});
export type SessionStartRequest = z.infer<typeof SessionStartRequest>;

export const SessionStartResponse = z.object({
  sessionId: z.uuid(),
  scribeToken: z.string().min(1),
  expiresAt: z.iso.datetime(),
  keyterms: z.array(z.string()),
  languageHint: z.string().nullable().optional(),
  maxSessionSeconds: z.int().positive(),
});
export type SessionStartResponse = z.infer<typeof SessionStartResponse>;

export const RewriteRequest = z.object({
  sessionId: z.uuid(),
  transcript: z.string().max(20_000),
  mode: Mode,
  targetApp: TargetApp,
  /** Email mode only; never stored or logged. */
  threadContext: z.string().max(8_000).optional(),
});
export type RewriteRequest = z.infer<typeof RewriteRequest>;

export const InsertResult = z.enum(["inserted", "raw_fallback", "discarded", "failed"]);
export type InsertResult = z.infer<typeof InsertResult>;

export const SessionEndRequest = z.object({
  audioSeconds: z.number().min(0),
  mode: Mode.optional(),
  targetApp: TargetApp.optional(),
  insertResult: InsertResult,
  timings: z.object({
    sttCommitMs: z.int().min(0),
    ttftMs: z.int().min(0).optional(),
    releaseToInsertMs: z.int().min(0),
  }),
  scribeRetried: z.boolean().optional(),
  clientVersion: z.string().max(32).optional(),
});
export type SessionEndRequest = z.infer<typeof SessionEndRequest>;

export const Settings = z.object({
  preset: Preset,
  defaultMode: Mode,
  appModeOverrides: z
    .record(TargetApp, Mode)
    .refine((o) => Object.keys(o).length <= 100, "At most 100 app overrides"),
  insertMode: InsertMode,
  languageHint: z.string().nullable(),
  hotkey: z.string(),
});
export type Settings = z.infer<typeof Settings>;

export const DictionaryTerm = z.object({
  id: z.uuid(),
  term: z.string(),
  createdAt: z.iso.datetime(),
});
export type DictionaryTerm = z.infer<typeof DictionaryTerm>;

export const AddDictionaryTermRequest = z.object({
  term: z.string().trim().min(1).max(64),
});
export type AddDictionaryTermRequest = z.infer<typeof AddDictionaryTermRequest>;

export const Usage = z.object({
  planId: z.string(),
  todayMinutes: z.number(),
  dailyCapMinutes: z.int(),
  periodMinutes: z.number(),
  monthlyMinutes: z.int(),
  dailyResetAt: z.iso.datetime(),
  periodResetAt: z.iso.datetime(),
});
export type Usage = z.infer<typeof Usage>;

export const CheckoutRequest = z.object({
  planId: z.string(),
});
export type CheckoutRequest = z.infer<typeof CheckoutRequest>;

/** Text-free product event (strict: unknown fields are rejected). */
export const TelemetryEvent = z.strictObject({
  kind: z.literal("event"),
  name: z.enum([
    "dictation_started",
    "dictation_inserted",
    "mode_changed",
    "fallback_used",
    "quota_hit",
  ]),
  at: z.iso.datetime(),
  mode: Mode.optional(),
  durationMs: z.int().min(0).optional(),
  clientVersion: z.string().max(32).optional(),
  os: ClientOs.optional(),
});
export type TelemetryEvent = z.infer<typeof TelemetryEvent>;

export const CrashModule = z.enum([
  "hotkey",
  "audio",
  "scribe",
  "rewrite",
  "insert",
  "overlay",
  "settings",
  "updater",
  "other",
]);

export const CrashReport = z.strictObject({
  kind: z.literal("crash"),
  at: z.iso.datetime(),
  clientVersion: z.string().max(32),
  os: ClientOs,
  errorCode: z
    .string()
    .max(64)
    .regex(/^[A-Z0-9_]+$/),
  module: CrashModule.optional(),
  /** Symbolicated frames only; string literals scrubbed. */
  stack: z.string().max(8_000).optional(),
});
export type CrashReport = z.infer<typeof CrashReport>;

export const TelemetryBatch = z.object({
  items: z.array(z.discriminatedUnion("kind", [TelemetryEvent, CrashReport])).max(50),
});
export type TelemetryBatch = z.infer<typeof TelemetryBatch>;
