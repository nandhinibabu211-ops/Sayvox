import { SCRIBE_SAMPLE_RATE } from "../../lib/elevenlabs/realtime";

/**
 * Audio metering for the /v1/stream proxy (audit SEC-03). Every client message must be a
 * Scribe `input_audio_chunk` of 16 kHz mono PCM16 (the upstream URL fixes the format), so
 * its duration is exact: bytes / (16 000 samples/s * 2 bytes).
 */
export const BYTES_PER_SECOND = SCRIBE_SAMPLE_RATE * 2;

/** Decoded byte length of a base64 string without decoding it. */
export function base64Bytes(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - pad;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export interface AudioChunk {
  seconds: number;
  commit: boolean;
}

/** Parse one client message; null if it isn't a well-formed 16 kHz audio chunk. */
export function parseAudioChunk(raw: string): AudioChunk | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null) return null;
  const o = m as Record<string, unknown>;
  if (o["message_type"] !== "input_audio_chunk") return null;
  if (o["sample_rate"] !== SCRIBE_SAMPLE_RATE) return null;
  if (typeof o["commit"] !== "boolean") return null;
  const audio = o["audio_base_64"];
  if (typeof audio !== "string" || audio.length % 4 !== 0 || !BASE64.test(audio)) return null;
  return { seconds: base64Bytes(audio) / BYTES_PER_SECOND, commit: o["commit"] };
}

/** The message that asks Scribe to finalize what it has (sent when the cap is reached). */
export const COMMIT_MESSAGE = JSON.stringify({
  message_type: "input_audio_chunk",
  audio_base_64: "",
  commit: true,
  sample_rate: SCRIBE_SAMPLE_RATE,
});
