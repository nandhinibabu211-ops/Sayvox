import { buildApp } from "./app";
import { createLogger } from "./lib/logger";

const port = Number(process.env["PORT"] ?? 8787);
const host = process.env["HOST"] ?? "0.0.0.0";

const app = buildApp({ logger: createLogger() });

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error({ errName: (err as Error).name }, "failed to start");
  process.exit(1);
}
