import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";
import { createLogger } from "../../src/lib/logger";
import { requireUser } from "../../src/modules/auth/plugin";
import type { AuthUser, ResolveUser } from "../../src/modules/auth/users";
import { createIdTokenVerifier } from "../../src/modules/auth/verifier";

const PROJECT = "sayvox-app-2026";
const ISS = `https://securetoken.google.com/${PROJECT}`;

type Key = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let privateKey: Key;
let otherKey: Key;
let jwk: JWK;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey;
  jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  otherKey = (await generateKeyPair("RS256")).privateKey;
});

async function token(
  claims: Record<string, unknown> = {},
  opts: { key?: Key; iss?: string; aud?: string; exp?: string | number } = {},
): Promise<string> {
  return new SignJWT({ email: "Nandhini@Example.com", email_verified: true, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setSubject("uid-123")
    .setIssuer(opts.iss ?? ISS)
    .setAudience(opts.aud ?? PROJECT)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h")
    .sign(opts.key ?? privateKey);
}

function makeApp(resolveUser?: ResolveUser) {
  const users = new Map<string, AuthUser>();
  const resolve: ResolveUser =
    resolveUser ??
    (async (id) => {
      const u = users.get(id.sub) ?? {
        id: `user-${id.sub}`,
        authProviderId: id.sub,
        email: id.email,
        planId: "free",
        status: "active" as const,
      };
      users.set(id.sub, u);
      return u;
    });
  const app = buildApp({
    logger: createLogger({ level: "silent" }),
    auth: {
      verify: createIdTokenVerifier({
        projectId: PROJECT,
        keys: (h, t) => createLocalJWKSet({ keys: [jwk] })(h, t),
      }),
      resolveUser: resolve,
    },
  });
  app.get("/v1/me", async (req) => requireUser(req));
  app.get("/v1/public-thing", { config: { public: true } }, async () => ({ ok: true }));
  return { app, users };
}

describe("auth plugin", () => {
  const { app, users } = makeApp();
  afterAll(async () => {
    await app.close();
  });

  it("accepts a valid Identity Platform token and lazily creates the user", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ authProviderId: "uid-123", email: "nandhini@example.com" });
    expect(users.size).toBe(1);
  });

  it("rejects a missing token", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects an expired token with a distinct message", async () => {
    const t = await token({}, { exp: Math.floor(Date.now() / 1000) - 600 });
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe("Token expired");
  });

  it.each([
    ["wrong issuer", { iss: "https://securetoken.google.com/other-project" }],
    ["wrong audience", { aud: "other-project" }],
    ["unknown signing key", {}],
  ])("rejects a token with %s", async (_label, opts) => {
    const t =
      _label === "unknown signing key" ? await token({}, { key: otherKey }) : await token({}, opts);
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects tokens without an email", async () => {
    const t = await token({ email: undefined });
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${t}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects alg=none tokens when emulator mode is off", async () => {
    const unsigned =
      Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url") +
      "." +
      Buffer.from(
        JSON.stringify({ sub: "x", email: "a@b.c", iss: ISS, aud: PROJECT, exp: 9e9, iat: 1 }),
      ).toString("base64url") +
      ".";
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${unsigned}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("lets public routes through without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/public-thing" });
    expect(res.statusCode).toBe(200);
  });

  it("requires auth on unknown /v1 paths", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/does-not-exist" });
    expect(res.statusCode).toBe(401);
  });

  it("does not require auth for /healthz", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });
});

describe("suspended users", () => {
  it("are rejected with 403", async () => {
    const { app } = makeApp(async (id) => ({
      id: "u1",
      authProviderId: id.sub,
      email: id.email,
      planId: "free",
      status: "suspended",
    }));
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
