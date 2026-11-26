import type { FastifyInstance } from "fastify";

/**
 * CORS for the two browser clients: the desktop app's webview (Tauri serves it from
 * http://tauri.localhost on Windows) and the web app on the web pages' origin. Only listed
 * origins get CORS headers; others get none, so their browsers block the response.
 * Requests carry a bearer token, never cookies, so credentials are not allowed.
 *
 * Runs before authentication so preflights (which carry no token) are answered. Headers are
 * set on the raw response so routes that write it themselves (the rewrite SSE stream) get
 * them too.
 */
export const DEFAULT_CORS_ORIGINS = [
  "http://tauri.localhost",
  "https://tauri.localhost",
  "tauri://localhost",
  "http://localhost:1420", // desktop vite dev
  "http://localhost:5173", // web vite dev
];

const ALLOW_HEADERS =
  "authorization, content-type, accept, x-client-version, x-install-id, x-request-id";
const ALLOW_METHODS = "GET, POST, PUT, DELETE, OPTIONS";

export function registerCors(app: FastifyInstance, origins: readonly string[]): void {
  const allowed = new Set(origins.map((o) => o.replace(/\/$/, "")));
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (typeof origin !== "string" || !allowed.has(origin)) return;
    const res = reply.raw;
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
    res.setHeader("access-control-expose-headers", "x-request-id, retry-after");
    if (req.method === "OPTIONS") {
      res.setHeader("access-control-allow-methods", ALLOW_METHODS);
      res.setHeader("access-control-allow-headers", ALLOW_HEADERS);
      res.setHeader("access-control-max-age", "600");
      return reply.code(204).send();
    }
  });
}
