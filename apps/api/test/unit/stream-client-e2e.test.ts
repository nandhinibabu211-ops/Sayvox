import { ScribeSession } from "@sayvox/client";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../../src/app";
import { createLogger } from "../../src/lib/logger";
import type { Transcribe } from "../../src/lib/openrouter/transcribe";
import type { StreamTicketData } from "../../src/modules/stream/ticket";
import { openRouterUpstream } from "../../src/modules/stream/upstream";

// The real client (packages/client ScribeSession, used by the desktop app and /app) against
// the real /v1/stream proxy with the OpenRouter upstream, the way the apps use it.
const TICKET = "A".repeat(43);
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

async function server(transcribe: Transcribe) {
  const ticket: StreamTicketData = {
    sessionId: "3f1c2a4e-8b7d-4c1a-9e2f-1a2b3c4d5e6f",
    userId: "u",
    scribeToken: "none",
    keyterms: [],
    languageHint: null,
    keytermsUsed: false,
    maxSessionSeconds: 300,
  };
  const app = buildApp({
    logger: createLogger({ level: "silent" }),
    stream: {
      takeTicket: async (t) => (t === TICKET ? ticket : null),
      charge: async () => {},
      upstream: openRouterUpstream(transcribe, { partialEveryMs: 0 }),
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  closers.push(() => app.close());
  return `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/v1/stream`;
}

const pcm = (ms: number) => new Int16Array((16_000 * ms) / 1000).fill(200).buffer;

describe("desktop/web client ↔ proxy (OpenRouter)", () => {
  it("audio sent before the server is ready still gets transcribed", async () => {
    const transcribe = vi.fn<Transcribe>(async () => ({
      text: "hello there",
      model: "m",
      costUsd: 0,
    }));
    const url = await server(transcribe);
    const s = new ScribeSession({
      ticket: TICKET,
      url,
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    });
    s.start();
    // The apps send 100–250 ms chunks from the moment the key is pressed.
    for (let i = 0; i < 8; i++) s.sendChunk(pcm(160));
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 4; i++) s.sendChunk(pcm(160));
    const r = await s.commit();
    expect(r.text).toBe("hello there");
    expect(transcribe.mock.calls[0]![0].pcm.length).toBe(12 * 160 * 32);
  });
});
