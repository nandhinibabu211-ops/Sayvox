import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { startMockScribe, type MockScribe } from "../../test/mocks/scribeServer";
import { ScribeError, ScribeSession, scribeUrl, toBase64 } from "./scribeClient";

let mock: MockScribe;
const WS = NodeWebSocket as unknown as typeof WebSocket;
const pcm = (ms = 160) => new Int16Array((16_000 * ms) / 1000).fill(100).buffer;

function session(extra: Partial<ConstructorParameters<typeof ScribeSession>[0]> = {}) {
  return new ScribeSession({ token: "sutkn_1", url: mock.url, WebSocketImpl: WS, ...extra });
}

beforeEach(async () => {
  mock = await startMockScribe();
});
afterEach(async () => {
  await mock.close();
});

describe("scribeUrl", () => {
  it("uses the verified query parameters", () => {
    const u = new URL(
      scribeUrl(
        "wss://api.elevenlabs.io/v1/speech-to-text/realtime",
        "t1",
        ["Zoho", "Zia"],
        "en-IN",
      ),
    );
    expect(u.searchParams.get("model_id")).toBe("scribe_v3_live");
    expect(u.searchParams.get("audio_format")).toBe("pcm_16000");
    expect(u.searchParams.get("commit_strategy")).toBe("manual");
    expect(u.searchParams.get("language_code")).toBe("en");
    expect(u.searchParams.getAll("keyterms")).toEqual(["Zoho", "Zia"]);
  });

  it("omits language_code for auto", () => {
    expect(new URL(scribeUrl("wss://x/y", "t", [], "auto")).searchParams.has("language_code")).toBe(
      false,
    );
  });
});

describe("toBase64", () => {
  it("encodes bytes", () => {
    expect(toBase64(new Uint8Array([1, 2, 3, 255]).buffer)).toBe("AQID/w==");
  });
});

describe("ScribeSession against the mock server (T024/T035)", () => {
  it("streams chunks, shows partials and returns the committed transcript", async () => {
    const partials: string[] = [];
    const s = session({ onPartial: (t) => partials.push(t) });
    s.start();
    s.sendChunk(pcm());
    s.sendChunk(pcm());
    s.sendChunk(pcm());
    const r = await s.commit();
    expect(r.text).toBe(mock.transcript);
    expect(r.retried).toBe(false);
    expect(partials.length).toBeGreaterThan(0);

    const c = mock.connections[0]!;
    expect(c.protocolErrors).toEqual([]);
    expect(c.chunks.map((x) => x.commit)).toEqual([false, false, false, true]);
    expect(c.chunks.every((x) => x.sampleRate === 16_000)).toBe(true);
    expect(c.chunks[0]!.bytes).toBe(5_120);
    expect(c.url.searchParams.get("token")).toBe("sutkn_1");
  });

  it("queues chunks until session_started, keeping order", async () => {
    mock.script.push({ startDelayMs: 150 });
    const s = session();
    s.start();
    for (let i = 0; i < 5; i++) s.sendChunk(pcm());
    await expect(s.commit()).resolves.toMatchObject({ text: mock.transcript });
    expect(mock.connections[0]!.chunks).toHaveLength(6);
  });

  it("retries once on a mid-utterance drop and replays all buffered audio", async () => {
    mock.script.push({ dropAfterChunks: 2 });
    const refreshToken = vi.fn(async () => "sutkn_2");
    const s = session({ refreshToken });
    s.start();
    s.sendChunk(pcm());
    s.sendChunk(pcm());
    await vi.waitFor(() => expect(refreshToken).toHaveBeenCalled());
    s.sendChunk(pcm());
    const r = await s.commit();
    expect(r).toMatchObject({ text: mock.transcript, retried: true });
    const second = mock.connections[1]!;
    expect(second.url.searchParams.get("token")).toBe("sutkn_2");
    expect(second.chunks.filter((c) => c.bytes > 0)).toHaveLength(3);
  });

  it("fails after a second drop", async () => {
    mock.script.push({ dropAfterChunks: 1 }, { dropAfterChunks: 1 });
    const s = session({ refreshToken: async () => "sutkn_2" });
    s.start();
    s.sendChunk(pcm());
    const commit = s.commit();
    await expect(commit).rejects.toMatchObject({ failure: "connection" });
  });

  it("does not retry fatal provider errors", async () => {
    mock.script.push({ fatal: "quota_exceeded" });
    const refreshToken = vi.fn(async () => "x");
    const s = session({ refreshToken });
    s.start();
    s.sendChunk(pcm());
    await expect(s.commit()).rejects.toMatchObject({
      failure: "fatal",
      providerType: "quota_exceeded",
    });
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("times out when the commit is never answered", async () => {
    mock.script.push("ignoreCommit");
    const s = session({ commitTimeoutMs: 200 });
    s.start();
    s.sendChunk(pcm());
    await expect(s.commit()).rejects.toBeInstanceOf(ScribeError);
  });

  it("abort closes without a result and drops buffered audio", async () => {
    const s = session();
    s.start();
    s.sendChunk(pcm());
    s.abort();
    expect(s.bufferedChunks).toBe(0);
    await expect(s.commit()).rejects.toMatchObject({ failure: "rejected" });
  });
});
