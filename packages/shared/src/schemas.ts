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

/**
 * Hold-to-talk chords the user can pick (Story 2.6 / T072). Modifier-only, two keys.
 * Ctrl+Shift is also Windows' keyboard-layout switch for people with several input
 * languages; Ctrl+Alt is AltGr on some layouts (₹, €). Hence the choice.
 */
export const HOTKEY_OPTIONS = [
  "Ctrl+Shift",
  "Ctrl+Alt",
  "Alt+Shift",
  "Ctrl+Win",
  "Shift+Win",
] as const;
export const Hotkey = z.enum(HOTKEY_OPTIONS);
export type Hotkey = z.infer<typeof Hotkey>;

/** Speech language hint (Settings → General). Mapped to Scribe params by the client. */
export const LANGUAGE_HINTS = ["auto", "en", "en-IN", "hinglish"] as const;
export const LanguageHint = z.enum(LANGUAGE_HINTS);
export type LanguageHint = z.infer<typeof LanguageHint>;

export const Settings = z.object({
  preset: Preset,
  defaultMode: Mode,
  appModeOverrides: z
    .record(TargetApp, Mode)
    .refine((o) => Object.keys(o).length <= 100, "At most 100 app overrides"),
  insertMode: InsertMode,
  /** null = auto-detect. */
  languageHint: LanguageHint.nullable(),
  hotkey: Hotkey,
});
export type Settings = z.infer<typeof Settings>;

/** GET/PUT /v1/settings response: the settings plus what the user's plan allows. */
export const SettingsResponse = Settings.extend({
  plan: z.object({
    id: z.string(),
    allowedPresets: z.array(Preset),
    dictionaryLimit: z.int(),
  }),
});
export type SettingsResponse = z.infer<typeof SettingsResponse>;

export const DictionaryTerm = z.object({
  id: z.uuid(),
  term: z.string(),
  createdAt: z.iso.datetime(),
});
export type DictionaryTerm = z.infer<typeof DictionaryTerm>;

/** Collapse inner whitespace; reject control characters (they'd break keyterm URLs). */
export const DictionaryTermText = z
  .string()
  .transform((s) => s.trim().replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(1, "Term is empty")
      .max(64, "Terms can be at most 64 characters")
      // eslint-disable-next-line no-control-regex -- rejecting control characters on purpose
      .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "Term has invalid characters"),
  );

export const AddDictionaryTermRequest = z.object({
  term: DictionaryTermText,
});

export const DictionaryList = z.object({
  terms: z.array(DictionaryTerm),
  limit: z.int(),
});
export type DictionaryList = z.infer<typeof DictionaryList>;
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

/** Version strings only ("0.1.0", "0.2.0-beta.1"): no room for free text. */
const ClientVersion = z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/);

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
  clientVersion: ClientVersion.optional(),
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
  clientVersion: ClientVersion,
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
