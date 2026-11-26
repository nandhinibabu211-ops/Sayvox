import WebSocket, { type RawData } from "ws";
import { TranscribeError, type Transcribe } from "../../lib/openrouter/transcribe";
import type { StreamTicketData } from "./ticket";

/**
 * Where the /v1/stream proxy sends a session's audio. Clients always speak the Scribe
 * realtime protocol (contracts/scribe-realtime.md); an upstream answers in it too:
 * `session_started`, `partial_transcript`, `committed_transcript`, and error types the
 * client already handles (`auth_error` fatal, `transcriber_error` retried once).
 *
 * - elevenLabsUpstream: ElevenLabs Scribe realtime over WebSocket (ADR-011).
 * - openRouterUpstream: OpenRouter's transcription endpoint (ADR-012). Buffers the audio,
 *   transcribes on commit, and re-transcribes the audio so far every few seconds for the
 *   live text while the user speaks.
 */
export interface UpstreamEvents {
  message: (text: string) => void;
  /** The upstream ended on its own (close code for the client). */
  close: (code: number) => void;
}

export interface SttUpstream {
  /** A validated client message: an audio chunk or the commit. */
  send: (msg: string) => void;
  close: () => void;
  /** What the provider reported this session cost, when it reports it. */
  costUsd?: () => number;
}

export type UpstreamFactory = (t: StreamTicketData, events: UpstreamEvents) => SttUpstream;

/** Close codes a server may send on to the client (1006 etc. are reserved). */
const passCode = (code: number) => (code === 1000 || (code >= 3000 && code <= 4999) ? code : 1011);

export function elevenLabsUpstream(url: (t: StreamTicketData) => string): UpstreamFactory {
  return (t, events) => {
    const queue: string[] = [];
    const ws = new WebSocket(url(t), { handshakeTimeout: 5_000 });
    ws.on("open", () => {
      for (const m of queue) ws.send(m);
      queue.length = 0;
    });
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (!isBinary) events.message(data.toString());
    });
    ws.on("close", (code: number) => events.close(passCode(code)));
    ws.on("error", () => events.close(1011));
    ws.on("unexpected-response", () => events.close(1011));
    return {
      send: (msg) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
        else if (ws.readyState === WebSocket.CONNECTING) queue.push(msg);
      },
      close: () => {
        queue.length = 0;
        if (ws.readyState === WebSocket.OPEN) ws.close(1000);
        else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      },
    };
  };
}

/** "en-IN" -> "en"; "auto"/null -> undefined (auto-detect). */
export function isoLanguage(hint: string | null | undefined): string | undefined {
  const iso = hint && hint !== "auto" ? (hint.split("-")[0] ?? "").toLowerCase() : "";
  return /^[a-z]{2,3}$/.test(iso) ? iso : undefined;
}

const BYTES_PER_SECOND = 32_000;
const msg = (o: object) => JSON.stringify(o);

export function openRouterUpstream(
  transcribe: Transcribe,
  opts: {
    /** Live text cadence (0 = off). */
    partialEveryMs?: number;
    /** Models for live text; the first (fastest) of the main list by default. */
    partialModels?: readonly string[];
  } = {},
): UpstreamFactory {
  return (t, events) => {
    const parts: Buffer[] = [];
    let bytes = 0;
    let closed = false;
    let committed = false;
    let cost = 0;
    const language = isoLanguage(t.languageHint);
    const base = { language, keyterms: t.keyterms };

    // Nothing to connect to: ready at once.
    queueMicrotask(() => {
      if (!closed) events.message(msg({ message_type: "session_started" }));
    });

    const pcm = () => Buffer.concat(parts, bytes);

    let partialBytes = 0;
    let partialInFlight = false;
    const every = opts.partialEveryMs ?? 2_000;
    const timer =
      every > 0
        ? setInterval(() => {
            // Only when there is at least a second of new audio and no request running.
            if (committed || closed || partialInFlight || bytes - partialBytes < BYTES_PER_SECOND)
              return;
            partialInFlight = true;
            partialBytes = bytes;
            transcribe({
              ...base,
              pcm: pcm(),
              ...(opts.partialModels ? { models: opts.partialModels } : {}),
            })
              .then((r) => {
                cost += r.costUsd;
                if (!committed && !closed && r.text) {
                  events.message(msg({ message_type: "partial_transcript", text: r.text }));
                }
              })
              .catch(() => {}) // live text is best effort
              .finally(() => {
                partialInFlight = false;
              });
          }, every)
        : undefined;

    function commit(): void {
      if (committed) return;
      committed = true;
      if (timer) clearInterval(timer);
      if (bytes === 0) {
        events.message(msg({ message_type: "insufficient_audio_activity" }));
        return;
      }
      transcribe({ ...base, pcm: pcm() })
        .then((r) => {
          cost += r.costUsd;
          if (closed) return;
          events.message(
            r.text
              ? msg({ message_type: "committed_transcript", text: r.text })
              : msg({ message_type: "insufficient_audio_activity" }),
          );
        })
        .catch((err: unknown) => {
          if (closed) return;
          const fatal = err instanceof TranscribeError && err.kind === "auth";
          events.message(msg({ message_type: fatal ? "auth_error" : "transcriber_error" }));
        });
    }

    return {
      send: (raw) => {
        if (closed || committed) return;
        const m = JSON.parse(raw) as { audio_base_64: string; commit: boolean };
        if (m.audio_base_64) {
          const b = Buffer.from(m.audio_base_64, "base64");
          parts.push(b);
          bytes += b.length;
        }
        if (m.commit) commit();
      },
      close: () => {
        closed = true;
        if (timer) clearInterval(timer);
        parts.length = 0; // drop audio as soon as the session is over (Constitution I)
      },
      costUsd: () => cost,
    };
  };
}
