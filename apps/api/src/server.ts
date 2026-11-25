import { buildApp } from "./app";
import { loadEnv } from "./config/env";
import { createDb } from "./lib/db/client";
import { createLogger } from "./lib/logger";
import { startTelemetry } from "./lib/otel";
import { createRedis } from "./lib/redis/client";
import { ConfigService } from "./modules/config/service";
import { createUserResolver } from "./modules/auth/users";
import { createIdTokenVerifier } from "./modules/auth/verifier";
import { createScribeTokenMinter } from "./lib/elevenlabs/token";
import { startSweeper } from "./modules/session/sweeper";

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

const database = createDb(env.DATABASE_URL, env.DB_POOL_MAX);
const redis = createRedis(env.REDIS_URL);
await redis.connect();

const config = new ConfigService(env, redis);

const app = buildApp({
  logger,
  auth: {
    verify: createIdTokenVerifier({
      projectId: env.GCP_PROJECT_ID,
      acceptEmulatorTokens: !isDeployed && Boolean(env.FIREBASE_AUTH_EMULATOR_HOST),
    }),
    resolveUser: createUserResolver(database.db),
  },
  session: {
    db: database.db,
    redis,
    config,
    region: env.REGION,
    mintToken: createScribeTokenMinter({ apiKey: env.ELEVENLABS_API_KEY }),
  },
});

const stopSweeper = startSweeper(database.db, (err) =>
  app.log.warn({ errName: (err as Error).name }, "session sweep failed"),
);

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "shutting down");
  stopSweeper();
  await app.close();
  await Promise.allSettled([database.close(), redis.quit(), telemetry.shutdown()]);
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
