import { randomUUID } from "node:crypto";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { registerHttpMetrics } from "./lib/otel/metrics";
import { registerAuth, type AuthOptions } from "./modules/auth/plugin";
import { registerRewriteRoutes, type RewriteDeps } from "./modules/rewrite/routes";
import { registerSessionRoutes, type SessionDeps } from "./modules/session/routes";
import { registerSettingsRoutes, type SettingsDeps } from "./modules/settings/routes";
import { registerErrorHandling } from "./plugins/errors";

export interface BuildAppOptions {
  logger: FastifyBaseLogger;
  /** Omit only in tests that exercise unauthenticated routes. */
  auth?: AuthOptions;
  /** Session routes (/v1/session/*); require `auth`. */
  session?: SessionDeps;
  /** POST /v1/rewrite; requires `auth`. */
  rewrite?: RewriteDeps;
  /** /v1/settings and /v1/dictionary; require `auth`. */
  settings?: SettingsDeps;
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function buildApp({
  logger,
  auth,
  session,
  rewrite,
  settings,
}: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && SAFE_REQUEST_ID.test(incoming)
        ? incoming
        : randomUUID();
    },
    bodyLimit: 64 * 1024,
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  registerErrorHandling(app);
  registerHttpMetrics(app);
  if (auth) registerAuth(app, auth);

  app.get("/healthz", { config: { public: true } }, async () => ({ status: "ok" }));
  if (session) {
    if (!auth) throw new Error("session routes require auth");
    registerSessionRoutes(app, session);
  }
  if (rewrite) {
    if (!auth) throw new Error("rewrite routes require auth");
    registerRewriteRoutes(app, rewrite);
  }
  if (settings) {
    if (!auth) throw new Error("settings routes require auth");
    registerSettingsRoutes(app, settings);
  }

  return app;
}
