import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";
import { createLogger } from "../../src/lib/logger";

const WEB = "https://sayvox-staging-web-264655228768.us-west1.run.app";
const app = buildApp({
  logger: createLogger({ level: "silent" }),
  corsOrigins: ["http://tauri.localhost", WEB],
  auth: {
    verify: async () => {
      throw new Error("no tokens in this test");
    },
    resolveUser: async () => {
      throw new Error("unused");
    },
  },
});
afterAll(() => app.close());

describe("CORS (desktop webview + web app)", () => {
  it("answers a preflight from an allowed origin before auth", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/v1/usage",
      headers: {
        origin: WEB,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(WEB);
    expect(String(res.headers["access-control-allow-headers"])).toContain("authorization");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("adds the origin header to real responses, including errors", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/usage",
      headers: { origin: "http://tauri.localhost" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["access-control-allow-origin"]).toBe("http://tauri.localhost");
    expect(String(res.headers["access-control-expose-headers"])).toContain("x-request-id");
  });

  it("gives other origins nothing", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/v1/usage",
      headers: { origin: "https://evil.example" },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.statusCode).not.toBe(204);
  });
});
