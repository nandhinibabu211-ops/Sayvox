import { ErrorEnvelope } from "@sayvox/shared";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiError, registerErrorHandling } from "../../src/plugins/errors";

const app = Fastify({ logger: false });
registerErrorHandling(app);
app.get("/quota", async () => {
  throw new ApiError("QUOTA_EXCEEDED", "Daily limit reached", {
    resetAt: new Date("2026-11-26T00:00:00Z"),
  });
});
app.post("/zod", async (req) => {
  z.object({ transcript: z.string().max(3) }).parse(req.body);
  return { ok: true };
});
app.get("/boom", async () => {
  throw new Error("upstream said: secret payload");
});

afterAll(async () => {
  await app.close();
});

describe("error envelope", () => {
  it("maps ApiError to its status and code with resetAt", async () => {
    const res = await app.inject({ method: "GET", url: "/quota" });
    expect(res.statusCode).toBe(402);
    const body = ErrorEnvelope.parse(res.json());
    expect(body.error).toMatchObject({
      code: "QUOTA_EXCEEDED",
      resetAt: "2026-11-26T00:00:00.000Z",
    });
  });

  it("reports zod failures by field name only, never the value", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/zod",
      payload: { transcript: "meet priya friday" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
    expect(res.body).toContain("transcript");
    expect(res.body).not.toContain("priya");
  });

  it("hides 5xx messages", async () => {
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatchObject({ code: "INTERNAL", message: "Internal error" });
    expect(res.body).not.toContain("secret payload");
  });

  it("does not echo malformed JSON bodies", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/zod",
      headers: { "content-type": "application/json" },
      payload: '{"transcript": "meet priya',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("priya");
  });
});
