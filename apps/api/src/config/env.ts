import { z } from "zod";

const csv = z
  .string()
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().min(1)).min(1));

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

/**
 * Provider keys and secrets: surrounding whitespace is dropped (a key pasted into
 * `gcloud secrets versions add --data-file=-` usually ends with a newline), and an empty
 * value counts as unset.
 */
const secret = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string())
  .optional()
  .transform((s) => (s ? s : undefined));

/**
 * Environment contract for the API. Secrets come from Secret Manager in staging/prod.
 * Provider keys are optional here so unit tests and local dev can boot without them;
 * the modules that call providers fail loudly if their key is missing.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  REGION: z.string().default("us-east4"),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  /** Extra browser origins for CORS (comma-separated), e.g. the web app origin. */
  CORS_ORIGINS: z.string().default(""),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  /** Raise for scale-to-zero databases (AlloyDB Express wakes in ~20 s). */
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),

  GCP_PROJECT_ID: z.string().min(1),
  /** Dev only: accept unsigned Firebase Auth emulator tokens (refused in staging/production). */
  FIREBASE_AUTH_EMULATOR_HOST: z.string().optional(),

  /** OTLP collector base URL (Cloud Run sidecar). Unset = telemetry not exported. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  OTEL_TRACE_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(0.1),

  // Client control (Story 2.9); Redis `cfg:client` overrides these at runtime.
  MIN_CLIENT_VERSION: z.string().default("0.1.0"),
  LATEST_CLIENT_VERSION: z.string().default("0.1.0"),
  KILL_SWITCH: bool.default(false),
  KILL_SWITCH_MESSAGE: z.string().default("Sayvox is temporarily paused."),
  ROLLOUT_PERCENT: z.coerce.number().int().min(0).max(100).default(100),

  // Model presets: ordered OpenRouter slugs, primary first (architecture §7, ADR-008).
  // Defaults are verified against OpenRouter's model list in research.md R2 (task T019).
  PRESET_FASTEST: csv.default([
    "google/gemini-3.5-flash-lite",
    "openai/gpt-6-luna",
    "anthropic/claude-haiku-5.5",
  ]),
  PRESET_BALANCED: csv.default([
    "anthropic/claude-haiku-5.5",
    "openai/gpt-6-luna",
    "google/gemini-3.5-flash-lite",
  ]),
  PRESET_CHEAPEST: csv.default(["openai/gpt-6-luna", "anthropic/claude-haiku-5.5"]),

  /**
   * Lowest reasoning effort per model (research R2): Gemini 3.5 Flash-Lite requires reasoning
   * ("minimal"); Haiku 5.5 and GPT-6 Luna allow "none". JSON object; unknown models use "none".
   */
  MODEL_REASONING_EFFORT: z
    .string()
    .default('{"google/gemini-3.5-flash-lite":"minimal"}')
    .transform((s, ctx) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "not JSON" });
        return z.NEVER;
      }
    })
    .pipe(z.record(z.string(), z.enum(["none", "minimal", "low", "medium", "high"]))),

  // Billing (ADR-003). All optional: without keys, checkout returns 503 and the app works
  // on the free plan. Test-mode keys outside production.
  RAZORPAY_KEY_ID: secret,
  RAZORPAY_KEY_SECRET: secret,
  RAZORPAY_WEBHOOK_SECRET: secret,
  /** Sayvox plan id → Razorpay plan id, e.g. {"pro":"plan_XXXX"} (created in the dashboard). */
  RAZORPAY_PLAN_IDS: z
    .string()
    .default("{}")
    .transform((s, ctx) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "not JSON" });
        return z.NEVER;
      }
    })
    .pipe(
      z.record(z.string().regex(/^[a-z0-9_-]{1,32}$/), z.string().regex(/^plan_[A-Za-z0-9]+$/)),
    ),
  /** Billing cycles per subscription (Razorpay needs a count); 120 monthly = 10 years. */
  RAZORPAY_TOTAL_COUNT: z.coerce.number().int().min(1).max(1200).default(120),

  ELEVENLABS_API_KEY: secret,
  /**
   * Speech-to-text behind /v1/stream (ADR-012): ElevenLabs Scribe realtime, or OpenRouter's
   * transcription endpoint with STT_MODELS tried in order (fastest/cheapest first).
   */
  STT_PROVIDER: z.enum(["elevenlabs", "openrouter"]).default("elevenlabs"),
  STT_MODELS: csv.default(["openai/whisper-large-v3-turbo", "elevenlabs/scribe-v2"]),
  /** OpenRouter only: re-transcribe the audio so far this often for live text (0 = off). */
  STT_PARTIAL_EVERY_MS: z.coerce.number().int().min(0).max(10_000).default(2_000),
  OPENROUTER_API_KEY: secret,
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Name the bad variables, never print their values (they may be secrets).
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
    throw new Error(`Invalid environment: ${names.join(", ")}`);
  }
  return parsed.data;
}
