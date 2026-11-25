/**
 * ElevenLabs Scribe v3 Live client (Story 1.6 + Story 3.7 retry), per
 * specs/001-voice-to-prompt-mvp/contracts/scribe-realtime.md.
 *
 * The socket goes to the Sayvox API's metering proxy (`/v1/stream`, audit SEC-03), never to
 * ElevenLabs directly: the API holds the Scribe token, fixes the model, audio format,
 * keyterms and language, and passes the Scribe protocol through unchanged. The client
 * authenticates with the one-time ticket from /v1/session/start, sent as a WebSocket
 * subprotocol (never in the URL).
 *
 * - Opens the socket on press; chunks queue until `session_started`, then flush in order.
 * - Every chunk carries message_type, audio_base_64, commit and sample_rate (all required).
 * - Release = `commit()`; resolves with the committed transcript.
 * - One retry on a retryable drop: new session ticket, reconnect, replay every buffered chunk.
 * Partial and final text are never logged (Constitution I).
 */

export const STREAM_PROTOCOL = "sayvox.stream.v1";
const SAMPLE_RATE = 16_000;

/** `http(s)://api` → `ws(s)://api/v1/stream`. */
export function streamUrl(apiBaseUrl: string): string {
  const u = new URL("/v1/stream", apiBaseUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

const FATAL = new Set(["auth_error", "quota_exceeded", "unaccepted_terms"]);
const RETRYABLE = new Set([
  "error",
  "rate_limited",
  "resource_exhausted",
  "queue_overflow",
  "transcriber_error",
]);

export type ScribeFailure = "fatal" | "timeout" | "connection" | "rejected";

export class ScribeError extends Error {
  constructor(
    readonly failure: ScribeFailure,
    readonly providerType?: string,
  ) {
    super(`scribe ${failure}${providerType ? ` (${providerType})` : ""}`);
    this.name = "ScribeError";
  }
}

export interface ScribeOptions {
  /** One-time stream ticket from /v1/session/start. */
  ticket: string;
  /** Fresh ticket for the one retry (a new /v1/session/start). */
  refreshTicket?: () => Promise<string>;
  onPartial?: (text: string) => void;
  /** The API's stream endpoint (`streamUrl(API_BASE_URL)`). */
  url: string;
  WebSocketImpl?: typeof WebSocket;
  commitTimeoutMs?: number;
  now?: () => number;
}

/** What the pipeline supplies; the window wiring adds the URL. */
export type ScribeStreamOptions = Omit<ScribeOptions, "url" | "WebSocketImpl">;

export interface CommitResult {
  text: string;
  /** commit sent → committed_transcript received. */
  commitMs: number;
  retried: boolean;
}

export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function chunkMessage(audioBase64: string, commit: boolean): string {
  return JSON.stringify({
    message_type: "input_audio_chunk",
    audio_base_64: audioBase64,
    commit,
    sample_rate: SAMPLE_RATE,
  });
}

export class ScribeSession {
  private ws: WebSocket | undefined;
  private ready = false;
  private readonly buffered: string[] = [];
  private sent = 0;
  private commitRequested = false;
  private commitSentAt = 0;
  private retried = false;
  private done = false;
  private pending:
    | {
        resolve: (r: CommitResult) => void;
        reject: (e: ScribeError) => void;
        timer?: ReturnType<typeof setTimeout>;
      }
    | undefined;
  private failure: ScribeError | undefined;
  private readonly WS: typeof WebSocket;
  private readonly now: () => number;

  constructor(private readonly opts: ScribeOptions) {
    this.WS = opts.WebSocketImpl ?? WebSocket;
    this.now = opts.now ?? (() => performance.now());
  }

  start(): void {
    this.connect(this.opts.ticket);
  }

  private connect(ticket: string): void {
    this.ready = false;
    this.sent = 0;
    const ws = new this.WS(this.opts.url, [STREAM_PROTOCOL, ticket]);
    this.ws = ws;
    ws.onmessage = (ev) => this.onMessage(ws, ev);
    ws.onclose = () => this.onDrop(ws);
    ws.onerror = () => this.onDrop(ws);
  }

  private onMessage(ws: WebSocket, ev: MessageEvent): void {
    if (ws !== this.ws || this.done) return;
    let m: { message_type?: string; text?: string };
    try {
      m = JSON.parse(String(ev.data)) as typeof m;
    } catch {
      return;
    }
    const type = m.message_type ?? "";
    switch (type) {
      case "session_started":
        this.ready = true;
        this.flush();
        return;
      case "partial_transcript":
        if (typeof m.text === "string") this.opts.onPartial?.(m.text);
        return;
      case "committed_transcript":
        this.finish({
          text: typeof m.text === "string" ? m.text : "",
          commitMs: Math.round(this.now() - this.commitSentAt),
          retried: this.retried,
        });
        return;
      case "insufficient_audio_activity":
        // Nothing audible was said: an empty transcript, not an error.
        if (this.commitRequested) this.finish({ text: "", commitMs: 0, retried: this.retried });
        return;
      case "session_time_limit_exceeded":
        if (!this.commitRequested) void this.commit().catch(() => {});
        return;
      default:
        if (FATAL.has(type)) this.fail(new ScribeError("fatal", type));
        else if (RETRYABLE.has(type)) this.onDrop(ws);
        else if (type && type !== "warning" && !type.startsWith("committed_transcript")) {
          this.fail(new ScribeError("rejected", type));
        }
    }
  }

  private flush(): void {
    const ws = this.ws;
    if (!ws || !this.ready || ws.readyState !== this.WS.OPEN) return;
    while (this.sent < this.buffered.length) {
      ws.send(chunkMessage(this.buffered[this.sent]!, false));
      this.sent++;
    }
    if (this.commitRequested && this.commitSentAt === 0) {
      this.commitSentAt = this.now();
      ws.send(chunkMessage("", true));
    }
  }

  /** Queue one 16 kHz PCM16 LE chunk; sent immediately once the session is ready. */
  sendChunk(pcm: ArrayBuffer): void {
    if (this.done || this.commitRequested) return;
    this.buffered.push(toBase64(pcm));
    this.flush();
  }

  /** Release: ask Scribe to finalize. */
  commit(): Promise<CommitResult> {
    if (this.failure) return Promise.reject(this.failure);
    this.commitRequested = true;
    return new Promise<CommitResult>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new ScribeError("timeout")),
        this.opts.commitTimeoutMs ?? 2_000,
      );
      this.pending = { resolve, reject, timer };
      this.flush();
    });
  }

  private onDrop(ws: WebSocket): void {
    if (ws !== this.ws || this.done) return;
    this.ws = undefined;
    if (this.retried || !this.opts.refreshTicket) {
      this.fail(new ScribeError("connection"));
      return;
    }
    this.retried = true;
    this.commitSentAt = 0;
    this.opts
      .refreshTicket()
      .then((ticket) => {
        if (!this.done) this.connect(ticket); // flush() replays every buffered chunk
      })
      .catch(() => this.fail(new ScribeError("connection")));
  }

  private finish(r: CommitResult): void {
    if (this.done) return;
    this.done = true;
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending?.resolve(r);
    this.pending = undefined;
    this.close();
  }

  private fail(e: ScribeError): void {
    if (this.done) return;
    this.done = true;
    this.failure = e;
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending?.reject(e);
    this.pending = undefined;
    this.close();
  }

  private close(): void {
    const ws = this.ws;
    this.ws = undefined;
    try {
      ws?.close();
    } catch {
      // already closed
    }
    // Drop buffered audio as soon as the utterance is over (Constitution I).
    this.buffered.length = 0;
  }

  /** Cancel (accidental tap / shortcut): close without a result. */
  abort(): void {
    this.fail(new ScribeError("rejected", "aborted"));
  }

  get bufferedChunks(): number {
    return this.buffered.length;
  }
}
