import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";
import { createLogger } from "../../src/lib/logger";

const app = buildApp({ logger: createLogger({ level: "silent" }) });

afterAll(async () => {
  await app.close();
});

describe("GET /healthz", () => {
  it('returns 200 {"status":"ok"}', async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("is also served at /health (Cloud Run's frontend reserves /healthz)", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("sets an x-request-id header", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("echoes a safe incoming x-request-id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { "x-request-id": "abc-123" },
    });
    expect(res.headers["x-request-id"]).toBe("abc-123");
  });

  it("returns the error envelope for unknown routes", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});
