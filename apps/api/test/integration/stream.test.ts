import { SessionStartResponse } from "@sayvox/shared";
import type { StartedRedisContainer } from "@testcontainers/redis";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { buildApp } from "../../src/app";
import { loadEnv } from "../../src/config/env";
import { sessions, usageDaily, users } from "../../src/lib/db/schema";
import { createLogger } from "../../src/lib/logger";
import { createUserResolver } from "../../src/modules/auth/users";
import { ConfigService } from "../../src/modules/config/service";
import { STREAM_PROTOCOL } from "../../src/modules/stream/proxy";
import { createAudioCharger } from "../../src/modules/stream/charge";
import { takeTicket } from "../../src/modules/stream/ticket";
import { startPostgres, startRedis, type PgFixture } from "./helpers";

// Whole server path for the metering proxy (audit SEC-03): session start -> ticket ->
// /v1/stream -> mock Scribe -> close -> usage charged from metered audio, not the client.

let pg: PgFixture;
let redisC: StartedRedisContainer;
let redis: Redis;
let mock: WebSocketServer;
let mockPort = 0;
const upstreamTokens: string[] = [];

beforeAll(async () => {
  [pg, redisC] = await Promise.all([startPostgres(), startRedis()]);
  redis = new Redis(redisC.getConnectionUrl());
  mock = new WebSocketServer({ port: 0 });
  mock.on("connection", (ws, req) => {
    upstreamTokens.push(new URL(req.url ?? "/", "ws://x").searchParams.get("token") ?? "");
    ws.send(JSON.stringify({ message_type: "session_started" }));
    ws.on("message", (d) => {
      if ((JSON.parse(d.toString()) as { commit: boolean }).commit) {
        ws.send(JSON.stringify({ message_type: "committed_transcript", text: "ok" }));
      }
    });
  });
  await new Promise((r) => mock.once("listening", r));
  mockPort = (mock.address() as AddressInfo).port;
}, 120_000);

afterAll(async () => {
  await new Promise((r) => mock.close(r));
  await redis.quit();
  await Promise.all([pg.stop(), redisC.stop()]);
});

const chunk = (seconds: number, commit = false) =>
  JSON.stringify({
    message_type: "input_audio_chunk",
    audio_base_64: Buffer.alloc(Math.round(seconds * 32_000)).toString("base64"),
    commit,
    sample_rate: 16_000,
  });

describe("metered stream, end to end", () => {
  it("charges what was streamed even when the client reports 0", async () => {
    const env = loadEnv({ DATABASE_URL: "x", REDIS_URL: "x", GCP_PROJECT_ID: "p" });
    const app = buildApp({
      logger: createLogger({ level: "silent" }),
      auth: {
        verify: async (t) => ({ sub: t, email: `${t}@example.com`, emailVerified: true }),
        resolveUser: createUserResolver(pg.handle.db, { cacheMs: 0 }),
      },
      session: {
        db: pg.handle.db,
        redis,
        config: new ConfigService(env, redis, 0),
        mintToken: async () => ({ token: "sutkn_live", expiresAt: new Date(Date.now() + 900_000) }),
        region: "us-east4",
      },
      stream: {
        takeTicket: (t) => takeTicket(redis, t),
        charge: createAudioCharger(pg.handle.db, redis),
        upstreamUrl: (t) => `ws://127.0.0.1:${mockPort}/realtime?token=${t.scribeToken}`,
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const auth = { authorization: "Bearer u-stream" };

    const started = await app.inject({
      method: "POST",
      url: "/v1/session/start",
      headers: auth,
      payload: {},
    });
    const body = SessionStartResponse.parse(started.json());

    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`, [
      STREAM_PROTOCOL,
      body.streamTicket,
    ]);
    const got: string[] = [];
    ws.on("message", (d) => got.push(d.toString()));
    await new Promise((r) => ws.once("open", r));
    const waitFor = async (s: string) => {
      for (let i = 0; i < 200 && !got.some((m) => m.includes(s)); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    await waitFor("session_started");
    ws.send(chunk(1));
    ws.send(chunk(1.5));
    ws.send(chunk(0, true));
    await waitFor("committed_transcript");
    ws.close();

    const ended = await app.inject({
      method: "POST",
      url: `/v1/session/${body.sessionId}/end`,
      headers: auth,
      payload: {
        audioSeconds: 0,
        insertResult: "inserted",
        timings: { sttCommitMs: 200, releaseToInsertMs: 600 },
      },
    });
    expect(ended.statusCode).toBe(204);
    await app.close(); // waits for the charge

    expect(upstreamTokens).toContain("sutkn_live");
    const [u] = await pg.handle.db.select().from(users).where(eq(users.authProviderId, "u-stream"));
    const [row] = await pg.handle.db.select().from(sessions).where(eq(sessions.id, body.sessionId));
    expect(row).toMatchObject({ status: "completed", audioSeconds: "2.50" });
    expect(row!.meteredAt).not.toBeNull();
    const [usage] = await pg.handle.db
      .select()
      .from(usageDaily)
      .where(eq(usageDaily.userId, u!.id));
    expect(usage).toMatchObject({ audioSeconds: "2.50", requests: 1 });
  });
});
