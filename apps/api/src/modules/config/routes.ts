import type { ClientConfig } from "@sayvox/shared";
import type { FastifyInstance } from "fastify";
import { compareVersions } from "./semver";
import type { ConfigService } from "./service";

export interface ClientConfigDeps {
  config: Pick<ConfigService, "clientConfig">;
}

/** Install ids are random UUIDs; anything else is ignored rather than bucketed. */
const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const header = (v: string | string[] | undefined) => (typeof v === "string" ? v.trim() : "");

/**
 * `GET /v1/client-config` (Story 2.9 / T081): public, so a signed-out or outdated client
 * still learns it must update or that the service is paused. Polled on start, every 30 min
 * and on wake. `updateRequired` is computed when the client sends `x-client-version`.
 */
export function registerClientConfigRoutes(app: FastifyInstance, deps: ClientConfigDeps): void {
  app.get("/v1/client-config", { config: { public: true } }, async (req, reply) => {
    const installId = header(req.headers["x-install-id"]);
    const version = header(req.headers["x-client-version"]);
    const cfg = await deps.config.clientConfig(INSTALL_ID.test(installId) ? installId : undefined);
    const body: ClientConfig = VERSION.test(version)
      ? { ...cfg, updateRequired: compareVersions(version, cfg.minClientVersion) < 0 }
      : cfg;
    // Per-install answer (inRollout); short private cache so a kill switch lands quickly.
    reply.header("cache-control", "private, max-age=60");
    return body;
  });
}
