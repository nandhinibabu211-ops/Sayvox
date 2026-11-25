/**
 * ElevenLabs Scribe v3 Live realtime WebSocket (research R1, contracts/scribe-realtime.md).
 * Only the API connects here: the desktop app streams to the API's /v1/stream proxy, which
 * meters the audio (audit SEC-03) and forwards it with a single-use token.
 */
export const SCRIBE_REALTIME_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
export const SCRIBE_MODEL = "scribe_v3_live";
export const SCRIBE_SAMPLE_RATE = 16_000;

export function scribeUpstreamUrl(opts: {
  token: string;
  keyterms: readonly string[];
  languageHint?: string | null;
  base?: string;
}): string {
  const u = new URL(opts.base ?? SCRIBE_REALTIME_URL);
  u.searchParams.set("model_id", SCRIBE_MODEL);
  u.searchParams.set("token", opts.token);
  // Fixed here, not by the client, so the metering below (16 kHz PCM16) is always right.
  u.searchParams.set("audio_format", "pcm_16000");
  u.searchParams.set("commit_strategy", "manual");
  const lang = opts.languageHint;
  const iso = lang && lang !== "auto" ? lang.split("-")[0]!.toLowerCase() : "";
  if (/^[a-z]{2,3}$/.test(iso)) u.searchParams.set("language_code", iso);
  for (const k of opts.keyterms) u.searchParams.append("keyterms", k);
  return u.toString();
}
