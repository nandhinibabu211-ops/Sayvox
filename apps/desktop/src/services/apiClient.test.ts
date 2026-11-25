import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./apiClient";
import { SessionExpiredError, type SessionStore, type StoredSession } from "./session";

const NOW = 1_800_000_000_000;

function memoryStore(
  initial: StoredSession | null,
): SessionStore & { value: StoredSession | null } {
  const s = {
    value: initial,
    load: async () => s.value,
    save: async (v: StoredSession) => {
      s.value = v;
    },
    clear: async () => {
      s.value = null;
    },
  };
  return s;
}

const fresh = (id = "tok-1", expiresIn = 3_600_000): StoredSession => ({
  idToken: id,
  refreshToken: `ref-${id}`,
  expiresAt: NOW + expiresIn,
  email: "a@example.com",
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(
  store: SessionStore,
  fetchFn: typeof fetch,
  refresh = vi.fn(async () => fresh("tok-2")),
) {
  return {
    refresh,
    api: new ApiClient({
      baseUrl: "http://api.test",
      store,
      makeRefresher: () => refresh,
      clientVersion: "0.1.0",
      installId: "install-1",
      fetchFn,
      now: () => NOW,
    }),
  };
}

describe("ApiClient", () => {
  it("sends the ID token, client version and install id", async () => {
    const fetchFn = vi.fn(async () => json(200, { ok: true }));
    const { api } = client(memoryStore(fresh()), fetchFn as unknown as typeof fetch);
    await api.json("/v1/usage");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const h = new Headers(init.headers);
    expect(url).toBe("http://api.test/v1/usage");
    expect(h.get("authorization")).toBe("Bearer tok-1");
    expect(h.get("x-client-version")).toBe("0.1.0");
    expect(h.get("x-install-id")).toBe("install-1");
  });

  it("refreshes ahead of expiry", async () => {
    const store = memoryStore(fresh("tok-1", 30_000));
    const fetchFn = vi.fn(async () => json(200, {}));
    const { api, refresh } = client(store, fetchFn as unknown as typeof fetch);
    await api.json("/v1/usage");
    expect(refresh).toHaveBeenCalledOnce();
    expect(store.value?.idToken).toBe("tok-2");
  });

  it("refreshes once on 401 and retries once", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        json(401, { error: { code: "UNAUTHENTICATED", message: "x", requestId: "r" } }),
      )
      .mockResolvedValueOnce(json(200, { ok: true }));
    const { api, refresh } = client(memoryStore(fresh()), fetchFn);
    await expect(api.json("/v1/usage")).resolves.toEqual({ ok: true });
    expect(refresh).toHaveBeenCalledOnce();
    expect(
      new Headers((fetchFn.mock.calls[1]![1] as RequestInit).headers).get("authorization"),
    ).toBe("Bearer tok-2");
  });

  it("shares one refresh between concurrent requests", async () => {
    const store = memoryStore(fresh("tok-1", 1_000));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const refresh = vi.fn(async () => {
      await gate;
      return fresh("tok-2");
    });
    const fetchFn = vi.fn(async () => json(200, {}));
    const { api } = client(store, fetchFn as unknown as typeof fetch, refresh);
    const calls = [api.json("/a"), api.json("/b"), api.json("/c")];
    release();
    await Promise.all(calls);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("clears the session and asks for sign-in when the refresh token is dead", async () => {
    const store = memoryStore(fresh("tok-1", 1_000));
    const refresh = vi.fn(async () => {
      throw new SessionExpiredError();
    });
    const { api } = client(store, vi.fn() as unknown as typeof fetch, refresh);
    await expect(api.json("/v1/usage")).rejects.toBeInstanceOf(SessionExpiredError);
    expect(store.value).toBeNull();
  });

  it("throws SessionExpiredError when never signed in", async () => {
    const { api } = client(memoryStore(null), vi.fn() as unknown as typeof fetch);
    await expect(api.json("/v1/usage")).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("surfaces the error envelope as ApiError", async () => {
    const fetchFn = vi.fn(async () =>
      json(402, {
        error: { code: "QUOTA_EXCEEDED", message: "Daily limit reached", requestId: "req-9" },
      }),
    );
    const { api } = client(memoryStore(fresh()), fetchFn as unknown as typeof fetch);
    const err = (await api
      .json("/v1/session/start", { method: "POST" })
      .catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 402, code: "QUOTA_EXCEEDED", requestId: "req-9" });
  });
});
