import { buildApp } from "./app";
import { loadEnv } from "./config/env";
import { createDb } from "./lib/db/client";
import { createLogger } from "./lib/logger";
import { startTelemetry } from "./lib/otel";
import { createRedis } from "./lib/redis/client";
import { ConfigService } from "./modules/config/service";
import { createUserResolver } from "./modules/auth/users";
import { createIdentityDeleter } from "./modules/account/identity";
import { keys } from "./lib/redis/keys";
import { createIdTokenVerifier } from "./modules/auth/verifier";
import { createScribeTokenMinter, SCRIBE_TOKEN_TTL_MS } from "./lib/elevenlabs/token";
import { createTranscriber } from "./lib/openrouter/transcribe";
import { createTanglishPass } from "./modules/stream/tanglish";
import { openRouterUpstream } from "./modules/stream/upstream";
import { startSweeper } from "./modules/session/sweeper";
import { claimRewrite } from "./modules/limits/store";
import { createAudioCharger } from "./modules/stream/charge";
import { DEFAULT_CORS_ORIGINS } from "./plugins/cors";
import { takeTicket } from "./modules/stream/ticket";
import { closePool, pooledFetch } from "./lib/openrouter/pool";
import { createOpenRouterClient } from "./lib/openrouter/stream";
import { createDbRewriteStore } from "./modules/rewrite/store";
import { validateSlugs, type ModelPrice } from "./modules/config/validateSlugs";
import { createRazorpayClient } from "./lib/razorpay/client";
import { PlanMap } from "./modules/billing/plans";
import { createSubscriptionCanceller } from "./modules/billing/routes";

const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL });

const isDeployed = env.NODE_ENV === "staging" || env.NODE_ENV === "production";
if (isDeployed && env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error("FIREBASE_AUTH_EMULATOR_HOST must not be set in staging/production");
}

const telemetry = startTelemetry({
  serviceVersion: process.env["npm_package_version"] ?? "0.0.0",
  region: env.REGION,
  otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  traceSampleRatio: env.OTEL_TRACE_SAMPLE_RATIO,
});

const database = createDb(env.DATABASE_URL, env.DB_POOL_MAX, env.DB_CONNECT_TIMEOUT_MS);
const redis = createRedis(env.REDIS_URL);
await redis.connect();

const config = new ConfigService(env, redis);

// T049: check preset slugs against OpenRouter, load prices, warm the keep-alive pool.
let prices = new Map<string, ModelPrice>();
const presetSlugs = Object.values(await config.presets()).flat();
await validateSlugs(presetSlugs, pooledFetch)
  .then((check) => {
    prices = check.prices;
    if (check.missing.length)
      logger.warn({ missing: check.missing }, "preset models not on OpenRouter");
  })
  .catch((err: unknown) =>
    logger.warn({ errName: (err as Error).name }, "model list check failed"),
  );

// Billing (ADR-003): optional until Razorpay is set up; the app then runs on free plans only.
const razorpay =
  env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET
    ? createRazorpayClient({ keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET })
    : undefined;
if (env.NODE_ENV === "production" && env.RAZORPAY_KEY_ID?.startsWith("rzp_test_")) {
  throw new Error("Razorpay test keys must not be used in production");
}
if (razorpay && !env.RAZORPAY_WEBHOOK_SECRET) {
  logger.warn("RAZORPAY_WEBHOOK_SECRET not set: subscriptions will never activate");
}
const planMap = new PlanMap(env.RAZORPAY_PLAN_IDS);
const billingAvailable = Boolean(
  razorpay && env.RAZORPAY_WEBHOOK_SECRET && planMap.purchasable().length,
);

const transcriber = createTranscriber({
  apiKey: env.OPENROUTER_API_KEY,
  models: env.STT_MODELS,
  fetchFn: pooledFetch,
  onAttempt: (a) => logger.info(a, "stt attempt"),
});
if (env.STT_PROVIDER === "openrouter") {
  // Self-test: one second of a 440 Hz tone through the real path; logs outcome only.
  const tone = Buffer.alloc(32_000);
  for (let i = 0; i < 16_000; i++)
    tone.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 440) / 16_000) * 8_000), i * 2);
  void transcriber({ pcm: tone, keyterms: [] }).then(
    (r) => logger.info({ model: r.model, textLength: r.text.length }, "stt self-test ok"),
    (err: unknown) =>
      logger.warn(
        {
          errName: (err as Error).name,
          kind: (err as { kind?: string }).kind,
          status: (err as { status?: number }).status,
        },
        "stt self-test failed",
      ),
  );
}

const openRouter = createOpenRouterClient({ apiKey: env.OPENROUTER_API_KEY, fetchFn: pooledFetch });

const app = buildApp({
  logger,
  auth: {
    verify: createIdTokenVerifier({
      projectId: env.GCP_PROJECT_ID,
      acceptEmulatorTokens: !isDeployed && Boolean(env.FIREBASE_AUTH_EMULATOR_HOST),
    }),
    resolveUser: createUserResolver(database.db),
    isDeleted: async (uid) => (await redis.exists(keys.accountDeleted(uid))) === 1,
  },
  session: {
    db: database.db,
    redis,
    config,
    region: env.REGION,
    // OpenRouter speech-to-text needs no per-session provider token; the ticket still
    // carries the session (stream/ticket.ts).
    mintToken:
      env.STT_PROVIDER === "openrouter"
        ? async () => ({ token: "none", expiresAt: new Date(Date.now() + SCRIBE_TOKEN_TTL_MS) })
        : createScribeTokenMinter({ apiKey: env.ELEVENLABS_API_KEY }),
  },
  rewrite: {
    store: createDbRewriteStore(database.db),
    config,
    complete: openRouter,
    prices: () => prices,
    claim: (sessionId) => claimRewrite(redis, sessionId),
  },
  settings: { db: database.db, redis },
  account: {
    db: database.db,
    redis,
    deleteIdentity: createIdentityDeleter({
      projectId: env.GCP_PROJECT_ID,
      emulatorHost: isDeployed ? undefined : env.FIREBASE_AUTH_EMULATOR_HOST,
    }),
    ...(razorpay ? { cancelSubscriptions: createSubscriptionCanceller(razorpay) } : {}),
  },
  usage: { db: database.db, redis, planMap, billingAvailable },
  stream: {
    takeTicket: (ticket) => takeTicket(redis, ticket),
    charge: createAudioCharger(database.db, redis),
    postprocess: createTanglishPass({
      models: async () => (await config.presets()).fastest,
      effortFor: (slug) => config.reasoningEffort(slug),
      complete: openRouter,
    }),
    ...(env.STT_PROVIDER === "openrouter"
      ? {
          upstream: openRouterUpstream(transcriber, {
            partialEveryMs: env.STT_PARTIAL_EVERY_MS,
            partialModels: env.STT_MODELS.slice(0, 1),
          }),
        }
      : {}),
  },
  billing: {
    db: database.db,
    redis,
    razorpay,
    planMap,
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
    totalCount: env.RAZORPAY_TOTAL_COUNT,
  },
  corsOrigins: [
    ...DEFAULT_CORS_ORIGINS,
    ...env.CORS_ORIGINS.split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  ],
  telemetry: { logger },
  clientConfig: { config },
});

const stopSweeper = startSweeper(database.db, (err) =>
  app.log.warn({ errName: (err as Error).name }, "session sweep failed"),
);

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "shutting down");
  stopSweeper();
  await app.close();
  await Promise.allSettled([database.close(), redis.quit(), telemetry.shutdown(), closePool()]);
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error({ errName: (err as Error).name }, "failed to start");
  process.exit(1);
}
