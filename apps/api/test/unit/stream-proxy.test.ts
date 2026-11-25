import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { buildApp } from "../../src/app";
import { scribeUpstreamUrl } from "../../src/lib/elevenlabs/realtime";
import { createLogger } from "../../src/lib/logger";
import type { ChargeInput } from "../../src/modules/stream/charge";
import { base64Bytes, parseAudioChunk } from "../../src/modules/stream/meter";
import { STREAM_PROTOCOL } from "../../src/modules/stream/proxy";
import type { StreamTicketData } from "../../src/modules/stream/ticket";

const TICKET = "A".repeat(43);
const SESSION = "3f1c2a4e-8b7d-4c1a-9e2f-1a2b3c4d5e6f";

/** n seconds of 16 kHz PCM16 silence as one Scribe chunk. */
const chunk = (seconds: number, commit = false) =>
  JSON.stringify({
    message_type: "input_audio_chunk",
    audio_base_64: Buffer.alloc(Math.round(seconds * 32_000)).toString("base64"),
    commit,
    sample_rate: 16_000,
  });

describe("metering", () => {
  it("measures PCM16 duration from base64 without decoding", () => {
    expect(base64Bytes(Buffer.alloc(32_000).toString("base64"))).toBe(32_000);
    expect(base64Bytes(Buffer.alloc(1).toString("base64"))).toBe(1);
    expect(base64Bytes("")).toBe(0);
    expect(parseAudioChunk(chunk(0.5))).toEqual({ seconds: 0.5, commit: false });
  });

  it("rejects anything that isn't a 16 kHz audio chunk", () => {
    expect(parseAudioChunk("not json")).toBeNull();
    expect(parseAudioChunk(JSON.stringify({ message_type: "config" }))).toBeNull();
    expect(
      parseAudioChunk(chunk(0.1).replace('"sample_rate":16000', '"sample_rate":8000')),
    ).toBeNull();
    expect(
      parseAudioChunk(
        JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: "%%%=",
          commit: false,
          sample_rate: 16_000,
        }),
      ),
    ).toBeNull();
  });

  it("fixes the audio format in the upstream URL; the client can't change it", () => {
    const u = new URL(scribeUpstreamUrl({ token: "t", keyterms: ["Zoho"], languageHint: "en-IN" }));
    expect(u.searchParams.get("audio_format")).toBe("pcm_16000");
    expect(u.searchParams.get("model_id")).toBe("scribe_v3_live");
    expect(u.searchParams.get("language_code")).toBe("en");
    expect(u.searchParams.getAll("keyterms")).toEqual(["Zoho"]);
  });
});

interface Harness {
  url: string;
  upstreamGot: string[];
  upstreamUrl: string[];
  charges: ChargeInput[];
  close: () => Promise<void>;
}

const open: Harness[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()));
});

async function harness(ticket: Partial<StreamTicketData> = {}): Promise<Harness> {
  const upstreamGot: string[] = [];
  const upstreamUrl: string[] = [];
  // Mock Scribe: session_started on connect, a committed transcript on commit.
  const mock = new WebSocketServer({ port: 0 });
  mock.on("connection", (ws, req) => {
    upstreamUrl.push(req.url ?? "");
    ws.send(JSON.stringify({ message_type: "session_started" }));
    ws.on("message", (d) => {
      const m = d.toString();
      upstreamGot.push(m);
      if ((JSON.parse(m) as { commit: boolean }).commit) {
        ws.send(JSON.stringify({ message_type: "committed_transcript", text: "hello" }));
      }
    });
  });
  await new Promise((r) => mock.once("listening", r));
  const mockPort = (mock.address() as AddressInfo).port;

  const charges: ChargeInput[] = [];
  const data: StreamTicketData = {
    sessionId: SESSION,
    userId: "user-1",
    scribeToken: "scribe-secret",
    keyterms: [],
    languageHint: null,
    keytermsUsed: false,
    maxSessionSeconds: 300,
    ...ticket,
  };
  let used = false;
  const app = buildApp({
    logger: createLogger({ level: "silent" }),
    stream: {
      takeTicket: async (t) => {
        if (t !== TICKET || used) return null;
        used = true;
        return data;
      },
      charge: async (c) => {
        charges.push(c);
      },
      upstreamUrl: (t) => `ws://127.0.0.1:${mockPort}/realtime?token=${t.scribeToken}`,
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  const h: Harness = {
    url: `ws://127.0.0.1:${port}/v1/stream`,
    upstreamGot,
    upstreamUrl,
    charges,
    close: async () => {
      await app.close();
      await new Promise((r) => mock.close(r));
    },
  };
  open.push(h);
  return h;
}

function connect(h: Harness, protocols: string[] = [STREAM_PROTOCOL, TICKET]) {
  return new WebSocket(h.url, protocols);
}

const until = async (cond: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("/v1/stream proxy (audit SEC-03)", () => {
  it("passes the Scribe protocol through and charges the audio it metered", async () => {
    const h = await harness();
    const ws = connect(h);
    const got: string[] = [];
    ws.on("message", (d) => got.push(d.toString()));
    await new Promise((r) => ws.once("open", r));
    expect(ws.protocol).toBe(STREAM_PROTOCOL);
    await until(() => got.some((m) => m.includes("session_started")));
    ws.send(chunk(0.5));
    ws.send(chunk(0.5));
    ws.send(chunk(0.25));
    ws.send(chunk(0, true));
    await until(() => got.some((m) => m.includes("committed_transcript")));
    ws.close();
    await until(() => h.charges.length === 1);
    expect(h.charges[0]).toMatchObject({ sessionId: SESSION, userId: "user-1", seconds: 1.25 });
    expect(h.upstreamGot).toHaveLength(4);
    // The Scribe token is used upstream only.
    expect(h.upstreamUrl[0]).toContain("token=scribe-secret");
  });

  it("refuses a missing, wrong or reused ticket with 401, before any upgrade", async () => {
    const h = await harness();
    const status = (protocols: string[]) =>
      new Promise<number>((resolve) => {
        const ws = connect(h, protocols);
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.on("open", () => resolve(101));
      });
    expect(await status([STREAM_PROTOCOL])).toBe(401);
    expect(await status([STREAM_PROTOCOL, "B".repeat(43)])).toBe(401);
    expect(await status([STREAM_PROTOCOL, TICKET])).toBe(101);
    expect(await status([STREAM_PROTOCOL, TICKET])).toBe(401);
  });

  it("stops forwarding at the session cap and asks Scribe to commit", async () => {
    const h = await harness({ maxSessionSeconds: 1 });
    const ws = connect(h);
    const got: string[] = [];
    ws.on("message", (d) => got.push(d.toString()));
    await until(() => got.some((m) => m.includes("session_started")));
    ws.send(chunk(0.5));
    ws.send(chunk(0.5));
    ws.send(chunk(0.5)); // over the cap: not forwarded
    await until(() => got.some((m) => m.includes("committed_transcript")));
    ws.close();
    await until(() => h.charges.length === 1);
    expect(h.charges[0]!.seconds).toBe(1);
    const forwardedAudio = h.upstreamGot.filter(
      (m) => !(JSON.parse(m) as { commit: boolean }).commit,
    );
    expect(forwardedAudio).toHaveLength(2);
  });

  it("closes on anything but an audio chunk (1008) and still charges what was sent", async () => {
    const h = await harness();
    const ws = connect(h);
    await new Promise((r) => ws.once("open", r));
    ws.send(chunk(0.5));
    ws.send(JSON.stringify({ message_type: "something_else" }));
    const code = await new Promise<number>((r) => ws.once("close", (c) => r(c)));
    expect(code).toBe(1008);
    await until(() => h.charges.length === 1);
    expect(h.charges[0]!.seconds).toBe(0.5);
  });

  it("charges open streams when the server shuts down", async () => {
    const h = await harness();
    const ws = connect(h);
    const got: string[] = [];
    ws.on("message", (d) => got.push(d.toString()));
    await until(() => got.some((m) => m.includes("session_started")));
    ws.send(chunk(0.75));
    await until(() => h.upstreamGot.length === 1);
    open.splice(open.indexOf(h), 1);
    await h.close();
    expect(h.charges).toHaveLength(1);
    expect(h.charges[0]!.seconds).toBe(0.75);
  });
});
