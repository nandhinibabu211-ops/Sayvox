import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../../src/app";
import { createLogger } from "../../src/lib/logger";
import { TranscribeError, type Transcribe } from "../../src/lib/openrouter/transcribe";
import type { ChargeInput } from "../../src/modules/stream/charge";
import { STREAM_PROTOCOL } from "../../src/modules/stream/proxy";
import type { StreamTicketData } from "../../src/modules/stream/ticket";
import { isoLanguage, openRouterUpstream } from "../../src/modules/stream/upstream";

const TICKET = "A".repeat(43);
const chunk = (seconds: number, commit = false) =>
  JSON.stringify({
    message_type: "input_audio_chunk",
    audio_base_64: Buffer.alloc(Math.round(seconds * 32_000)).toString("base64"),
    commit,
    sample_rate: 16_000,
  });

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

async function harness(
  transcribe: Transcribe,
  partialEveryMs = 0,
  postprocess?: (text: string) => Promise<string>,
) {
  const charges: ChargeInput[] = [];
  const ticket: StreamTicketData = {
    sessionId: "3f1c2a4e-8b7d-4c1a-9e2f-1a2b3c4d5e6f",
    userId: "user-1",
    scribeToken: "none",
    keyterms: ["Zoho"],
    languageHint: "en-IN",
    keytermsUsed: true,
    maxSessionSeconds: 300,
  };
  let used = false;
  const app = buildApp({
    logger: createLogger({ level: "silent" }),
    stream: {
      takeTicket: async (t) => (t === TICKET && !used ? ((used = true), ticket) : null),
      charge: async (c) => {
        charges.push(c);
      },
      upstream: openRouterUpstream(transcribe, { partialEveryMs }),
      ...(postprocess ? { postprocess } : {}),
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  closers.push(() => app.close());
  const port = (app.server.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`, [STREAM_PROTOCOL, TICKET]);
  const got: { message_type: string; text?: string }[] = [];
  ws.on("message", (d) => got.push(JSON.parse(d.toString()) as { message_type: string }));
  const waitFor = async (type: string) => {
    for (let i = 0; i < 300 && !got.some((m) => m.message_type === type); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return got.find((m) => m.message_type === type);
  };
  return { ws, got, charges, waitFor };
}

describe("OpenRouter speech-to-text upstream (ADR-012)", () => {
  it("maps hints to ISO codes", () => {
    expect(isoLanguage("en-IN")).toBe("en");
    expect(isoLanguage("ta")).toBe("ta");
    expect(isoLanguage("auto")).toBeUndefined();
    expect(isoLanguage(null)).toBeUndefined();
  });

  it("starts at once, transcribes everything on commit, charges the provider cost", async () => {
    const transcribe = vi.fn<Transcribe>(async () => ({
      text: "let's meet Friday",
      model: "m",
      costUsd: 0.00002,
    }));
    const h = await harness(transcribe);
    await h.waitFor("session_started");
    h.ws.send(chunk(1));
    h.ws.send(chunk(0.5));
    h.ws.send(chunk(0, true));
    expect(await h.waitFor("committed_transcript")).toEqual({
      message_type: "committed_transcript",
      text: "let's meet Friday",
    });
    const req = transcribe.mock.calls[0]![0];
    expect(req.pcm.length).toBe(48_000); // 1.5 s of 16 kHz PCM16
    expect(req).toMatchObject({ language: "en", keyterms: ["Zoho"] });
    h.ws.close();
    for (let i = 0; i < 100 && h.charges.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(h.charges[0]).toMatchObject({ seconds: 1.5, costUsd: 0.00002 });
  });

  it("runs the transcript postprocess (Tanglish pass) before the client sees it", async () => {
    const transcribe = vi.fn<Transcribe>(async () => ({
      text: "நாளைக்கு meeting",
      model: "m",
      costUsd: 0,
    }));
    const h = await harness(transcribe, 0, async () => "naalaiku meeting");
    await h.waitFor("session_started");
    h.ws.send(chunk(0.5));
    h.ws.send(chunk(0, true));
    expect((await h.waitFor("committed_transcript"))?.text).toBe("naalaiku meeting");
    h.ws.close();
  });

  it("sends live text while the user speaks", async () => {
    let n = 0;
    const transcribe = vi.fn<Transcribe>(async () => ({
      text: `partial ${++n}`,
      model: "m",
      costUsd: 0,
    }));
    const h = await harness(transcribe, 30);
    await h.waitFor("session_started");
    h.ws.send(chunk(1.2));
    expect((await h.waitFor("partial_transcript"))?.text).toMatch(/^partial/);
    h.ws.close();
  });

  it("answers silence and failures with the errors the client understands", async () => {
    const empty = await harness(vi.fn<Transcribe>());
    await empty.waitFor("session_started");
    empty.ws.send(chunk(0, true));
    expect(await empty.waitFor("insufficient_audio_activity")).toBeTruthy();
    empty.ws.close();

    const down = await harness(
      vi.fn<Transcribe>(async () => Promise.reject(new TranscribeError("unavailable"))),
    );
    await down.waitFor("session_started");
    down.ws.send(chunk(0.5));
    down.ws.send(chunk(0, true));
    expect(await down.waitFor("transcriber_error")).toBeTruthy(); // the client retries once
    down.ws.close();

    const badKey = await harness(
      vi.fn<Transcribe>(async () => Promise.reject(new TranscribeError("auth", 401))),
    );
    await badKey.waitFor("session_started");
    badKey.ws.send(chunk(0.5));
    badKey.ws.send(chunk(0, true));
    expect(await badKey.waitFor("auth_error")).toBeTruthy(); // fatal, no retry
    badKey.ws.close();
  });
});
