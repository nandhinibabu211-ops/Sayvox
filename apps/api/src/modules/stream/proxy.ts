import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { scribeUpstreamUrl } from "../../lib/elevenlabs/realtime";
import type { ChargeAudio } from "./charge";
import { COMMIT_MESSAGE, parseAudioChunk } from "./meter";
import type { StreamTicketData } from "./ticket";
import type { TranscriptPostprocess } from "./tanglish";
import { elevenLabsUpstream, type SttUpstream, type UpstreamFactory } from "./upstream";

/**
 * `GET /v1/stream` (WebSocket): the clients' speech-to-text stream, proxied to the
 * configured speech-to-text upstream (ElevenLabs Scribe or OpenRouter, upstream.ts) so the
 * API meters every second of audio itself (audit SEC-03).
 *
 * - Auth: subprotocols `["sayvox.stream.v1", <ticket>]` from /v1/session/start. The ticket
 *   is in a header, never the URL (which Cloud Run logs), and works exactly once.
 * - Messages pass through unchanged in both directions (contracts/scribe-realtime.md), so
 *   the client speaks the Scribe protocol. Only `input_audio_chunk` is accepted upstream.
 * - Metering: 16 kHz PCM16 bytes / 32 000 = seconds. Audio beyond the session's
 *   `maxSessionSeconds` is not forwarded; Scribe is asked to commit instead.
 * - Charging: once, when either side closes, with the metered seconds.
 * Audio and transcripts are never logged or stored (Constitution I).
 */
export const STREAM_PATH = "/v1/stream";
export const STREAM_PROTOCOL = "sayvox.stream.v1";

export interface StreamDeps {
  takeTicket: (ticket: string) => Promise<StreamTicketData | null>;
  charge: ChargeAudio;
  /** Applied to each committed transcript before the client sees it (the Tanglish pass). */
  postprocess?: TranscriptPostprocess;
  /** Speech-to-text upstream; default ElevenLabs Scribe realtime at `upstreamUrl`. */
  upstream?: UpstreamFactory;
  /** Upstream Scribe URL for a ticket (tests point it at a mock server). */
  upstreamUrl?: (t: StreamTicketData) => string;
  /** Close a stream that sends nothing for this long (default 30 s). */
  idleMs?: number;
  now?: () => Date;
}

function reject(socket: Duplex, status: 400 | 401 | 503): void {
  const text = { 400: "Bad Request", 401: "Unauthorized", 503: "Service Unavailable" }[status];
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function registerStreamProxy(app: FastifyInstance, deps: StreamDeps): void {
  const now = deps.now ?? (() => new Date());
  const makeUpstream =
    deps.upstream ??
    elevenLabsUpstream(
      deps.upstreamUrl ??
        ((t: StreamTicketData) =>
          scribeUpstreamUrl({
            token: t.scribeToken,
            keyterms: t.keyterms,
            languageHint: t.languageHint,
          })),
    );
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 512 * 1024,
    handleProtocols: (offered) => (offered.has(STREAM_PROTOCOL) ? STREAM_PROTOCOL : false),
  });

  // Open streams and in-flight charges, so shutdown can charge every stream before the
  // database closes (a deploy must not lose usage).
  const active = new Set<() => void>();
  const pending = new Set<Promise<unknown>>();

  function bridge(client: WebSocket, t: StreamTicketData): void {
    let seconds = 0;
    let capped = false;
    let finished = false;
    let chunks = 0;
    let committed = false;
    let closedBy = "server";
    let upstreamEvent = "";
    // `upstream` is created below; these only run later (on messages, timers, close).
    const sendUp = (msg: string) => upstream.send(msg);

    let idle: NodeJS.Timeout | undefined;
    const touch = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => finish(1000), deps.idleMs ?? 30_000);
    };
    // Hard stop: the cap plus slack for the commit round trip.
    const hard = setTimeout(() => finish(1000), t.maxSessionSeconds * 1000 + 60_000);
    touch();
    const stop = () => finish(1001);
    active.add(stop);

    function finish(clientCode: number, by?: string): void {
      if (finished) return;
      if (by) closedBy = by;
      finished = true;
      active.delete(stop);
      if (idle) clearTimeout(idle);
      clearTimeout(hard);
      upstream.close();
      if (client.readyState === WebSocket.OPEN) client.close(clientCode);
      else if (client.readyState === WebSocket.CONNECTING) client.terminate();
      app.log.info(
        {
          sessionId: t.sessionId,
          audioSeconds: Math.round(seconds * 100) / 100,
          capped,
          chunks,
          committed,
          closedBy,
          closeCode: clientCode,
          lastUpstream: upstreamEvent,
        },
        "stream ended",
      );
      const charging = deps
        .charge({
          userId: t.userId,
          sessionId: t.sessionId,
          seconds,
          keytermsUsed: t.keytermsUsed,
          at: now(),
          ...(upstream.costUsd ? { costUsd: upstream.costUsd() } : {}),
        })
        .catch((err: unknown) =>
          app.log.error(
            { errName: (err as Error).name, sessionId: t.sessionId },
            "stream charge failed",
          ),
        )
        .finally(() => pending.delete(charging));
      pending.add(charging);
    }

    const toClient = (text: string) => {
      if (client.readyState === WebSocket.OPEN) client.send(text);
    };
    const upstream: SttUpstream = makeUpstream(t, {
      message: (text) => {
        // Message type only (never the transcript) for the "stream ended" line.
        upstreamEvent = /"message_type":"([a-z_]+)"/.exec(text)?.[1] ?? upstreamEvent;
        if (!deps.postprocess || !text.includes('"committed_transcript"')) return toClient(text);
        let m: { message_type?: string; text?: unknown };
        try {
          m = JSON.parse(text) as typeof m;
        } catch {
          return toClient(text);
        }
        if (m.message_type !== "committed_transcript" || typeof m.text !== "string") {
          return toClient(text);
        }
        void deps
          .postprocess(m.text, t)
          .catch(() => m.text as string)
          .then((out) => toClient(JSON.stringify({ ...m, text: out })));
      },
      close: (code) => finish(code),
    });

    client.on("message", (data: RawData, isBinary: boolean) => {
      if (finished) return;
      const raw = isBinary ? null : data.toString();
      const chunk = raw === null ? null : parseAudioChunk(raw);
      if (!chunk || raw === null) {
        finish(1008, "server:bad_message");
        return;
      }
      touch();
      chunks++;
      if (chunk.commit) committed = true;
      if (capped) return;
      if (seconds + chunk.seconds > t.maxSessionSeconds + 1e-6) {
        // Over the cap: forward nothing more, finalize what Scribe already has.
        capped = true;
        sendUp(COMMIT_MESSAGE);
        return;
      }
      seconds += chunk.seconds;
      sendUp(raw);
    });
    client.on("close", (code: number) => finish(1000, `client:${code}`));
    client.on("error", () => finish(1011));
  }

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    if ((req.url ?? "").split("?")[0] !== STREAM_PATH) {
      reject(socket, 400);
      return;
    }
    const offered = String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const ticket = offered.find((p) => p !== STREAM_PROTOCOL);
    if (!offered.includes(STREAM_PROTOCOL) || !ticket) {
      reject(socket, 401);
      return;
    }
    deps.takeTicket(ticket).then(
      (t) => {
        if (!t) return reject(socket, 401);
        wss.handleUpgrade(req, socket, head, (client) => bridge(client, t));
      },
      () => reject(socket, 503),
    );
  };

  app.server.on("upgrade", onUpgrade);
  // preClose, not onClose: the HTTP server only finishes closing once these sockets are
  // gone, and onClose hooks run after that.
  app.addHook("preClose", async () => {
    app.server.off("upgrade", onUpgrade);
    for (const stop of [...active]) stop();
    await Promise.allSettled([...pending]);
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
  });
}
