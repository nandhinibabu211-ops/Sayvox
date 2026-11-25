import { describe, expect, it, vi } from "vitest";
import { deepLink, parseHandoff, sendToDesktop } from "./handoff";

const STATE = "0123456789abcdef0123456789abcdef";

describe("parseHandoff", () => {
  it("accepts an ephemeral port and a 32-hex state", () => {
    expect(parseHandoff(`?port=51234&state=${STATE}`)).toEqual({ port: 51234, state: STATE });
  });

  it.each([
    ["missing port", `?state=${STATE}`],
    ["privileged port", `?port=80&state=${STATE}`],
    ["non-numeric port", `?port=abc&state=${STATE}`],
    ["short state", "?port=51234&state=abc"],
    ["state with other chars", `?port=51234&state=${STATE.slice(0, 31)}Z`],
  ])("rejects %s", (_l, search) => {
    expect(parseHandoff(search)).toBeNull();
  });
});

describe("sendToDesktop", () => {
  const tokens = { idToken: "i", refreshToken: "r", expiresIn: 3600, email: "a@b.c" };

  it("POSTs the tokens with the state to loopback", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    const ok = await sendToDesktop(
      { port: 51234, state: STATE },
      tokens,
      fetchFn as unknown as typeof fetch,
    );
    expect(ok).toBe(true);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:51234/callback");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ state: STATE, ...tokens });
  });

  it("returns false when the app rejects or is unreachable", async () => {
    const rejected = vi.fn(async () => new Response(null, { status: 403 }));
    expect(
      await sendToDesktop(
        { port: 51234, state: STATE },
        tokens,
        rejected as unknown as typeof fetch,
      ),
    ).toBe(false);
    const down = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(
      await sendToDesktop({ port: 51234, state: STATE }, tokens, down as unknown as typeof fetch),
    ).toBe(false);
  });
});

describe("deepLink", () => {
  it("carries only the state", () => {
    expect(deepLink(STATE)).toBe(`sayvox://auth?state=${STATE}`);
  });
});
