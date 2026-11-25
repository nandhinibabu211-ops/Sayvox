import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../../plugins/errors";
import type { AuthUser, ResolveUser } from "./users";
import { InvalidTokenError, type IdTokenVerifier, type VerifiedIdentity } from "./verifier";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the auth hook on every non-public /v1 route. */
    user: AuthUser | undefined;
  }
  interface FastifyContextConfig {
    /** Opt a route out of authentication (healthz, client-config, billing webhook). */
    public?: boolean;
    /** Reachable by a tombstoned account, so a failed deletion can be retried. */
    allowDeleted?: boolean;
  }
}

export interface AuthOptions {
  verify: IdTokenVerifier;
  resolveUser: ResolveUser;
  /**
   * True if this identity's account was deleted (Story 5.7): its ID tokens stay valid for up
   * to an hour, and resolving would recreate the user. Errors fail open (logged).
   */
  isDeleted?: (authProviderId: string) => Promise<boolean>;
}

function bearerToken(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (typeof h !== "string") return undefined;
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(h.trim());
  return m?.[1];
}

/**
 * Authenticate every /v1 route unless it sets `config: { public: true }` (Story 2.2 AC 3).
 * Unknown /v1 paths also require auth, so unauthenticated probing can't map the API.
 */
export function registerAuth(app: FastifyInstance, opts: AuthOptions): void {
  app.decorateRequest("user", undefined);

  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/v1/")) return;
    if (req.routeOptions.config?.public) return;

    const token = bearerToken(req);
    if (!token) throw new ApiError("UNAUTHENTICATED", "Missing bearer token");

    let identity: VerifiedIdentity;
    try {
      identity = await opts.verify(token);
    } catch (err) {
      const reason = err instanceof InvalidTokenError ? err.reason : "invalid";
      req.log.info({ authFailure: reason }, "auth rejected");
      throw new ApiError(
        "UNAUTHENTICATED",
        reason === "expired" ? "Token expired" : "Invalid token",
      );
    }

    if (opts.isDeleted && !req.routeOptions.config?.allowDeleted) {
      const deleted = await opts.isDeleted(identity.sub).catch((err: unknown) => {
        req.log.warn({ errName: (err as Error).name }, "deleted-account check failed");
        return false;
      });
      if (deleted) throw new ApiError("UNAUTHENTICATED", "This account was deleted");
    }

    const user = await opts.resolveUser(identity);
    if (user.status !== "active") throw new ApiError("FORBIDDEN", "Account is not active");
    req.user = user;
  });
}

/** For route handlers: the authenticated user (throws if a route forgot to require auth). */
export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw new ApiError("UNAUTHENTICATED", "Not signed in");
  return req.user;
}
