import { describe, expect, it } from "vitest";
import { createIdentityDeleter, IdentityDeleteError } from "../../src/modules/account/identity";

function fakeFetch(responses: Response[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return responses.shift() ?? Response.json({});
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("Identity Platform account delete (T075)", () => {
  it("uses the metadata-server token and caches it", async () => {
    const f = fakeFetch([
      Response.json({ access_token: "ya29.tok", expires_in: 3600 }),
      Response.json({}),
      Response.json({}),
    ]);
    const del = createIdentityDeleter({ projectId: "sayvox-app-2026", fetchFn: f.fn });
    await del("uid-1");
    await del("uid-2");
    expect(f.calls).toHaveLength(3);
    expect(f.calls[0]!.url).toContain("metadata.google.internal");
    expect(f.calls[1]!.url).toBe(
      "https://identitytoolkit.googleapis.com/v1/projects/sayvox-app-2026/accounts:delete",
    );
    expect(new Headers(f.calls[1]!.init?.headers).get("authorization")).toBe("Bearer ya29.tok");
    expect(JSON.parse(String(f.calls[2]!.init?.body))).toEqual({ localId: "uid-2" });
  });

  it("talks to the emulator with the owner token in dev", async () => {
    const f = fakeFetch([Response.json({})]);
    const del = createIdentityDeleter({
      projectId: "p",
      emulatorHost: "127.0.0.1:9099",
      fetchFn: f.fn,
    });
    await del("u");
    expect(f.calls[0]!.url).toBe(
      "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/p/accounts:delete",
    );
    expect(new Headers(f.calls[0]!.init?.headers).get("authorization")).toBe("Bearer owner");
  });

  it("treats an already-deleted user as done (retries are safe)", async () => {
    const f = fakeFetch([Response.json({ error: { message: "USER_NOT_FOUND" } }, { status: 400 })]);
    const del = createIdentityDeleter({ projectId: "p", emulatorHost: "h", fetchFn: f.fn });
    await expect(del("u")).resolves.toBeUndefined();
  });

  it("fails on other errors", async () => {
    const f = fakeFetch([new Response("nope", { status: 403 })]);
    const del = createIdentityDeleter({ projectId: "p", emulatorHost: "h", fetchFn: f.fn });
    await expect(del("u")).rejects.toBeInstanceOf(IdentityDeleteError);
  });
});
