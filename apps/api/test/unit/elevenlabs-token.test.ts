import { describe, expect, it, vi } from "vitest";
import { createScribeTokenMinter, ProviderError } from "../../src/lib/elevenlabs/token";

describe("ElevenLabs single-use token", () => {
  it("POSTs with the API key header and caps the session server-side", async () => {
    const fetchFn = vi.fn(async () => Response.json({ token: "sutkn_abc" }));
    const mint = createScribeTokenMinter({
      apiKey: "xi-secret",
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    const t = await mint({ maxSessionSeconds: 42.9 });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe?max_session_duration_seconds=42",
    );
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("xi-api-key")).toBe("xi-secret");
    expect(t).toEqual({ token: "sutkn_abc", expiresAt: new Date(1_000_000 + 15 * 60_000) });
  });

  it("maps HTTP failures to ProviderError without leaking the body", async () => {
    const fetchFn = vi.fn(async () => new Response("quota details", { status: 429 }));
    const mint = createScribeTokenMinter({
      apiKey: "k",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const err = await mint({ maxSessionSeconds: 300 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(429);
    expect((err as Error).message).not.toContain("quota details");
  });

  it("reports timeouts", async () => {
    const fetchFn = vi.fn(async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    const mint = createScribeTokenMinter({
      apiKey: "k",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(mint({ maxSessionSeconds: 300 })).rejects.toMatchObject({ status: "timeout" });
  });

  it("refuses to run without a key", async () => {
    const mint = createScribeTokenMinter({ apiKey: undefined });
    await expect(mint({ maxSessionSeconds: 300 })).rejects.toThrow(/ELEVENLABS_API_KEY/);
  });
});
