import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";
import { createLogger } from "../../src/lib/logger";
import type { AuthOptions } from "../../src/modules/auth/plugin";

export function capture() {
  const lines: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      for (const l of String(chunk).split("\n").filter(Boolean)) lines.push(JSON.parse(l));
      cb();
    },
  });
  return { lines, sink };
}

const USER_ID = "6f1c2a4e-8b7d-4c1a-9e2f-1a2b3c4d5e6f";
const fakeAuth: AuthOptions = {
  verify: async (t) => ({ sub: t, email: `${t}@example.com`, emailVerified: true }),
  resolveUser: async (id) => ({
    id: USER_ID,
    authProviderId: id.sub,
    email: id.email,
    planId: "free",
    status: "active",
  }),
};

function harness() {
  const { lines, sink } = capture();
  const app = buildApp({
    logger: createLogger({ level: "silent" }),
    auth: fakeAuth,
    telemetry: { logger: createLogger({ level: "info" }, sink) },
  });
  const post = (payload: unknown, auth = true) =>
    app.inject({
      method: "POST",
      url: "/v1/telemetry",
      headers: auth ? { authorization: "Bearer u1" } : {},
      payload: payload as Record<string, unknown>,
    });
  return { app, lines, post };
}

const AT = "2026-11-25T10:00:00Z";

describe("POST /v1/telemetry (T076)", () => {
  it("logs events without a user id, and crashes in Error Reporting format", async () => {
    const { app, lines, post } = harness();
    const res = await post({
      items: [
        {
          kind: "event",
          name: "dictation_inserted",
          at: AT,
          mode: "prompt",
          durationMs: 640,
          os: "windows11",
        },
        {
          kind: "crash",
          at: AT,
          clientVersion: "0.1.0",
          os: "windows11",
          errorCode: "OVERLAY_RENDER",
          module: "overlay",
          stack: "TypeError: cannot show 'meet priya friday'\n    at render (main.ts:4:2)",
        },
      ],
    });
    expect(res.statusCode).toBe(202);
    expect(lines.find((l) => l["telemetry"] === "event")).toMatchObject({
      name: "dictation_inserted",
      mode: "prompt",
      durationMs: 640,
    });
    expect(lines.find((l) => l["@type"])).toMatchObject({
      severity: "ERROR",
      serviceContext: { service: "sayvox-desktop", version: "0.1.0" },
      stack_trace: "TypeError\nat render (main.ts:4:2)",
    });
    const all = JSON.stringify(lines);
    expect(all).not.toContain(USER_ID);
    expect(all).not.toContain("priya");
    await app.close();
  });

  it("rejects unknown fields, free-text versions and oversized batches", async () => {
    const { app, lines, post } = harness();
    const bad = [
      { items: [{ kind: "event", name: "dictation_inserted", at: AT, transcript: "hi" }] },
      {
        items: [
          { kind: "event", name: "dictation_inserted", at: AT, clientVersion: "call me maybe" },
        ],
      },
      { items: Array.from({ length: 51 }, () => ({ kind: "event", name: "quota_hit", at: AT })) },
    ];
    for (const payload of bad) expect((await post(payload)).statusCode).toBe(400);
    expect(lines).toHaveLength(0);
    await app.close();
  });

  it("requires sign-in", async () => {
    const { app, post } = harness();
    expect((await post({ items: [] }, false)).statusCode).toBe(401);
    await app.close();
  });
});

describe("deleted accounts (T075)", () => {
  it("refuses a tombstoned identity before resolving it, so the user isn't recreated", async () => {
    let resolved = 0;
    const app = buildApp({
      logger: createLogger({ level: "silent" }),
      auth: {
        ...fakeAuth,
        resolveUser: async (id) => {
          resolved++;
          return fakeAuth.resolveUser(id);
        },
        isDeleted: async (sub) => sub === "gone",
      },
      telemetry: { logger: createLogger({ level: "silent" }) },
    });
    const send = (who: string) =>
      app.inject({
        method: "POST",
        url: "/v1/telemetry",
        headers: { authorization: `Bearer ${who}` },
        payload: { items: [] },
      });
    const res = await send("gone");
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe("This account was deleted");
    expect(resolved).toBe(0);
    expect((await send("alive")).statusCode).toBe(202);
    await app.close();
  });

  it("fails open if the check itself errors", async () => {
    const app = buildApp({
      logger: createLogger({ level: "silent" }),
      auth: {
        ...fakeAuth,
        isDeleted: async () => {
          throw new Error("redis down");
        },
      },
      telemetry: { logger: createLogger({ level: "silent" }) },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/telemetry",
      headers: { authorization: "Bearer x" },
      payload: { items: [] },
    });
    expect(res.statusCode).toBe(202);
    await app.close();
  });
});

describe("backend Error Reporting (T076)", () => {
  it("reports an unexpected 5xx with a scrubbed stack and no message or body", async () => {
    const { lines, sink } = capture();
    const app = buildApp({ logger: createLogger({ level: "error" }, sink) });
    app.post("/boom", async () => {
      throw new Error("failed on transcript 'tell priya the invoice is late'");
    });
    const res = await app.inject({
      method: "POST",
      url: "/boom",
      payload: { text: "secret words" },
    });
    expect(res.statusCode).toBe(500);
    const entry = lines.find((l) => l["@type"])!;
    expect(entry).toMatchObject({ severity: "ERROR", serviceContext: { service: "sayvox-api" } });
    expect(String(entry["stack_trace"])).toMatch(/^Error\nat /);
    const all = JSON.stringify(lines);
    expect(all).not.toContain("priya");
    expect(all).not.toContain("secret words");
    await app.close();
  });
});
