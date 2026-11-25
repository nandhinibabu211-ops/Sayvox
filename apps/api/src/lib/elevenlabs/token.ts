/**
 * Mint a single-use Scribe realtime token (contracts/scribe-realtime.md, research R1).
 * The API key never leaves the backend (Constitution II).
 */

export const SCRIBE_TOKEN_TTL_MS = 15 * 60 * 1000;
const ENDPOINT = "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";

export interface ScribeToken {
  token: string;
  expiresAt: Date;
}

export type MintScribeToken = (opts: { maxSessionSeconds: number }) => Promise<ScribeToken>;

export class ProviderError extends Error {
  constructor(
    readonly provider: "elevenlabs",
    readonly status: number | "timeout" | "network" | "not_configured",
  ) {
    super(`${provider} token request failed: ${status}`);
    this.name = "ProviderError";
  }
}

export function createScribeTokenMinter(opts: {
  apiKey: string | undefined;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}): MintScribeToken {
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  return async ({ maxSessionSeconds }) => {
    // No key (e.g. staging before keys are added): a clean 503, not a 500.
    if (!opts.apiKey) throw new ProviderError("elevenlabs", "not_configured");
    const url = `${ENDPOINT}?max_session_duration_seconds=${Math.max(1, Math.floor(maxSessionSeconds))}`;
    const issuedAt = now();
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { "xi-api-key": opts.apiKey },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 2_000),
      });
    } catch (err) {
      throw new ProviderError(
        "elevenlabs",
        (err as Error).name === "TimeoutError" ? "timeout" : "network",
      );
    }
    if (!res.ok) throw new ProviderError("elevenlabs", res.status);
    const body = (await res.json()) as { token?: unknown };
    if (typeof body.token !== "string" || body.token.length === 0) {
      throw new ProviderError("elevenlabs", res.status);
    }
    return { token: body.token, expiresAt: new Date(issuedAt + SCRIBE_TOKEN_TTL_MS) };
  };
}
