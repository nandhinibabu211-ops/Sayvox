import { describe, expect, it, vi } from "vitest";
import { createTranscriber, TranscribeError, wav } from "../../src/lib/openrouter/transcribe";

const pcm = Buffer.alloc(32_000); // one second of silence
const ok = (text: string, cost = 0.00001) => Response.json({ text, usage: { cost, seconds: 1 } });
const bodyOf = (fetchFn: ReturnType<typeof vi.fn>, call = 0) =>
  JSON.parse((fetchFn.mock.calls[call]![1] as RequestInit).body as string) as Record<
    string,
    unknown
  >;

describe("wav", () => {
  it("wraps 16 kHz mono PCM16 in a valid header", () => {
    const w = wav(pcm);
    expect(w.length).toBe(44 + 32_000);
    expect(w.toString("ascii", 0, 4)).toBe("RIFF");
    expect(w.toString("ascii", 8, 12)).toBe("WAVE");
    expect(w.readUInt32LE(24)).toBe(16_000);
    expect(w.readUInt16LE(34)).toBe(16);
    expect(w.readUInt32LE(40)).toBe(32_000);
  });
});

describe("createTranscriber (OpenRouter /audio/transcriptions)", () => {
  const models = ["openai/whisper-large-v3-turbo", "elevenlabs/scribe-v2"];

  it("sends base64 WAV with privacy routing and returns text and cost", async () => {
    const fetchFn = vi.fn(async () => ok("  let's meet friday  ", 0.000004));
    const t = createTranscriber({
      apiKey: "k",
      models,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const r = await t({ pcm, language: "en", keyterms: [] });
    expect(r).toEqual({ text: "let's meet friday", model: models[0], costUsd: 0.000004 });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer k");
    const body = bodyOf(fetchFn);
    expect(body).toMatchObject({
      model: models[0],
      language: "en",
      provider: { zdr: true, data_collection: "deny", sort: "latency" },
    });
    const audio = Buffer.from((body["input_audio"] as { data: string }).data, "base64");
    expect(audio.toString("ascii", 0, 4)).toBe("RIFF");
  });

  it("gives Whisper the dictionary as a prompt and other models as keyterms", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(ok("Zoho Zia demo"));
    const t = createTranscriber({
      apiKey: "k",
      models,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const r = await t({ pcm, keyterms: ["Zoho", "Zia"] });
    expect(bodyOf(fetchFn, 0)).toMatchObject({ prompt: "Vocabulary: Zoho, Zia." });
    expect(bodyOf(fetchFn, 0)).not.toHaveProperty("keyterms");
    expect(bodyOf(fetchFn, 1)).toMatchObject({ model: models[1], keyterms: ["Zoho", "Zia"] });
    expect(bodyOf(fetchFn, 1)).not.toHaveProperty("language");
    expect(r.model).toBe(models[1]);
  });

  it("falls back on timeouts and 429, stops on a refused key", async () => {
    const timeout = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("t", "TimeoutError"))
      .mockResolvedValueOnce(ok("ok"));
    expect(
      (
        await createTranscriber({
          apiKey: "k",
          models,
          fetchFn: timeout as unknown as typeof fetch,
        })({ pcm, keyterms: [] })
      ).text,
    ).toBe("ok");

    const refused = vi.fn(async () => new Response("no", { status: 401 }));
    await expect(
      createTranscriber({ apiKey: "bad", models, fetchFn: refused as unknown as typeof fetch })({
        pcm,
        keyterms: [],
      }),
    ).rejects.toMatchObject({ kind: "auth", status: 401 });
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable when every model fails, or there is no key", async () => {
    const down = vi.fn(async () => new Response("x", { status: 502 }));
    await expect(
      createTranscriber({ apiKey: "k", models, fetchFn: down as unknown as typeof fetch })({
        pcm,
        keyterms: [],
      }),
    ).rejects.toBeInstanceOf(TranscribeError);
    expect(down).toHaveBeenCalledTimes(2);
    await expect(
      createTranscriber({ apiKey: undefined, models })({ pcm, keyterms: [] }),
    ).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});
