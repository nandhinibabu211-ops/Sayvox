import { createRemoteJWKSet, errors, jwtVerify, UnsecuredJWT, type JWTVerifyGetKey } from "jose";

/** Google's public keys for Firebase / Identity Platform ID tokens. */
export const IDENTITY_PLATFORM_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

export interface VerifiedIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
}

export class InvalidTokenError extends Error {
  constructor(readonly reason: "expired" | "invalid" | "no_email") {
    super(`invalid token: ${reason}`);
    this.name = "InvalidTokenError";
  }
}

export type IdTokenVerifier = (token: string) => Promise<VerifiedIdentity>;

export interface VerifierOptions {
  projectId: string;
  /** Injected in tests; defaults to Google's cached remote JWKS. */
  keys?: JWTVerifyGetKey;
  /**
   * Accept unsigned Firebase Auth emulator tokens. Only allowed outside staging/production;
   * see createVerifierFromEnv.
   */
  acceptEmulatorTokens?: boolean;
  clockToleranceSeconds?: number;
}

function toIdentity(payload: Record<string, unknown>): VerifiedIdentity {
  const sub = payload["sub"];
  const email = payload["email"];
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 128) {
    throw new InvalidTokenError("invalid");
  }
  if (typeof email !== "string" || email.length === 0) throw new InvalidTokenError("no_email");
  return { sub, email: email.toLowerCase(), emailVerified: payload["email_verified"] === true };
}

export function createIdTokenVerifier(opts: VerifierOptions): IdTokenVerifier {
  // createRemoteJWKSet caches keys in memory and refetches on unknown `kid`, so the hot path
  // (/v1/session/start, < 150 ms) normally does no network call for auth.
  const keys =
    opts.keys ??
    createRemoteJWKSet(new URL(IDENTITY_PLATFORM_JWKS_URL), { cooldownDuration: 30_000 });
  const issuer = `https://securetoken.google.com/${opts.projectId}`;

  return async (token) => {
    if (opts.acceptEmulatorTokens) {
      try {
        const { payload } = UnsecuredJWT.decode(token, { issuer, audience: opts.projectId });
        return toIdentity(payload);
      } catch {
        // Not an emulator token: fall through to normal verification.
      }
    }
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer,
        audience: opts.projectId,
        algorithms: ["RS256"],
        clockTolerance: opts.clockToleranceSeconds ?? 5,
        requiredClaims: ["sub", "iat", "exp"],
      });
      return toIdentity(payload);
    } catch (err) {
      if (err instanceof InvalidTokenError) throw err;
      if (err instanceof errors.JWTExpired) throw new InvalidTokenError("expired");
      throw new InvalidTokenError("invalid");
    }
  };
}
