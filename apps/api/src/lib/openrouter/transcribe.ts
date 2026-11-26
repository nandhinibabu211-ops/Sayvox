import { OPENROUTER_BASE } from "./stream";

/**
 * Speech-to-text through OpenRouter's transcription endpoint (owner decision 2026-11-26:
 * OpenRouter instead of ElevenLabs; ADR-012). `POST /api/v1/audio/transcriptions` with the
 * audio as base64 WAV. Models are tried in order: the next one on a timeout, 429 or 5xx;
 * a 401/403 stops (the key is wrong, another model won't help).
 *
 * Privacy: every request asks for zero-data-retention providers that don't collect data,
 * like the rewrite calls (research R2). Audio and text are never logged.
 */
export const SAMPLE_RATE = 16_000;

/** 16 kHz mono PCM16 little-endian -> a WAV file. */
export function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export class TranscribeError extends Error {
  constructor(
    /** auth: the key is refused. unavailable: every model failed or timed out. */
    readonly kind: "auth" | "unavailable",
    readonly status?: number,
  ) {
    super(`transcription failed: ${kind}${status ? ` (${status})` : ""}`);
    this.name = "TranscribeError";
  }
}

export interface TranscribeRequest {
  pcm: Buffer;
  /** ISO 639-1, e.g. "en"; omitted = auto-detect. */
  language?: string | undefined;
  /** Dictionary terms (names, jargon). */
  keyterms: readonly string[];
  /** Override the model order (live partials use only the first, fastest model). */
  models?: readonly string[];
}

export interface Transcript {
  text: string;
  model: string;
  costUsd: number;
}

export type Transcribe = (req: TranscribeRequest) => Promise<Transcript>;

/** Whisper-style models take vocabulary as a prompt; the others take `keyterms`. */
const promptStyle = (model: string) => /whisper|gpt-4o.*transcribe/.test(model);

export function createTranscriber(opts: {
  apiKey: string | undefined;
  models: readonly string[];
  fetchFn?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}): Transcribe {
  const fetchFn = opts.fetchFn ?? fetch;
  return async (req) => {
    if (!opts.apiKey) throw new TranscribeError("unavailable");
    const models = req.models ?? opts.models;
    const audio = wav(req.pcm).toString("base64");
    let lastStatus: number | undefined;
    for (const model of models) {
      const terms = req.keyterms.slice(0, 100);
      const body = {
        model,
        input_audio: { data: audio, format: "wav" },
        ...(req.language ? { language: req.language } : {}),
        ...(terms.length
          ? promptStyle(model)
            ? { prompt: `Vocabulary: ${terms.join(", ")}.` }
            : { keyterms: terms }
          : {}),
        temperature: 0,
        provider: { zdr: true, data_collection: "deny", sort: "latency" },
      };
      let res: Response;
      try {
        res = await fetchFn(`${opts.baseUrl ?? OPENROUTER_BASE}/audio/transcriptions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        });
      } catch {
        continue; // timeout or network: try the next model
      }
      if (res.status === 401 || res.status === 403) throw new TranscribeError("auth", res.status);
      if (!res.ok) {
        lastStatus = res.status;
        continue;
      }
      const out = (await res.json().catch(() => ({}))) as {
        text?: unknown;
        usage?: { cost?: unknown };
      };
      if (typeof out.text !== "string") {
        lastStatus = res.status;
        continue;
      }
      return {
        text: out.text.trim(),
        model,
        costUsd: typeof out.usage?.cost === "number" ? out.usage.cost : 0,
      };
    }
    throw new TranscribeError("unavailable", lastStatus);
  };
}
