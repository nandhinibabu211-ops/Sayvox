import { WebSocketServer, type WebSocket } from "ws";

/**
 * Mock ElevenLabs Scribe realtime server (T024), following contracts/scribe-realtime.md.
 * Validates every client chunk, emits partials as audio arrives, and a committed transcript
 * on `commit: true`. Behaviours can be scripted per connection to simulate failures.
 */

export interface ReceivedChunk {
  bytes: number;
  commit: boolean;
  sampleRate: number;
}

export type Behaviour =
  | "normal"
  /** Close the socket after N audio chunks (mid-utterance drop). */
  | { dropAfterChunks: number }
  /** Send this fatal error message type after the first chunk. */
  | { fatal: "auth_error" | "quota_exceeded" | "unaccepted_terms" }
  /** Never answer the commit (commit timeout). */
  | "ignoreCommit"
  /** Send session_started late. */
  | { startDelayMs: number };

export interface Connection {
  url: URL;
  chunks: ReceivedChunk[];
  protocolErrors: string[];
}

export interface MockScribe {
  url: string;
  connections: Connection[];
  /** Behaviour for each new connection, in order (default "normal"). */
  script: Behaviour[];
  transcript: string;
  close: () => Promise<void>;
}

export async function startMockScribe(): Promise<MockScribe> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const mock: MockScribe = {
    url: `ws://127.0.0.1:${port}/v1/speech-to-text/realtime`,
    connections: [],
    script: [],
    transcript: "um so let's meet on Thursday no wait Friday",
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => r());
      }),
  };

  wss.on("connection", (ws: WebSocket, req) => {
    const conn: Connection = {
      url: new URL(req.url ?? "/", "ws://127.0.0.1"),
      chunks: [],
      protocolErrors: [],
    };
    mock.connections.push(conn);
    const behaviour = mock.script.shift() ?? "normal";
    const send = (m: object) => ws.send(JSON.stringify(m));

    const delay =
      typeof behaviour === "object" && "startDelayMs" in behaviour ? behaviour.startDelayMs : 0;
    setTimeout(
      () => send({ message_type: "session_started", session_id: "s1", config: {} }),
      delay,
    );

    ws.on("message", (raw) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        conn.protocolErrors.push("not JSON");
        return;
      }
      for (const field of ["message_type", "audio_base_64", "commit", "sample_rate"]) {
        if (!(field in m)) conn.protocolErrors.push(`missing ${field}`);
      }
      if (m["message_type"] !== "input_audio_chunk") conn.protocolErrors.push("bad message_type");
      const b64 = String(m["audio_base_64"] ?? "");
      const bytes = Buffer.from(b64, "base64").length;
      conn.chunks.push({
        bytes,
        commit: m["commit"] === true,
        sampleRate: Number(m["sample_rate"]),
      });

      const audioChunks = conn.chunks.filter((c) => c.bytes > 0).length;
      if (
        typeof behaviour === "object" &&
        "dropAfterChunks" in behaviour &&
        audioChunks >= behaviour.dropAfterChunks
      ) {
        ws.terminate();
        return;
      }
      if (typeof behaviour === "object" && "fatal" in behaviour && audioChunks === 1) {
        send({ message_type: behaviour.fatal, error: "nope" });
        ws.close();
        return;
      }
      if (bytes > 0) {
        const words = mock.transcript.split(" ");
        send({
          message_type: "partial_transcript",
          text: words.slice(0, Math.min(words.length, audioChunks)).join(" "),
        });
      }
      if (m["commit"] === true && behaviour !== "ignoreCommit") {
        send({ message_type: "committed_transcript", text: mock.transcript });
      }
    });
  });

  return mock;
}
