import { describe, expect, it } from "vitest";
import { ApiError } from "./apiClient";
import { canConfirmDeletion, deleteAccount, type LocalPrefs } from "./account";
import type { SessionStore } from "./session";

function fakes(fail = false) {
  const calls: string[] = [];
  const data = new Map([
    ["sayvox.settings", "{}"],
    ["sayvox.replyContext", "on"],
    ["sayvox.installId", "x"],
    ["other.app", "keep"],
  ]);
  const prefs: LocalPrefs = { keys: () => [...data.keys()], remove: (k) => void data.delete(k) };
  const session: SessionStore = {
    load: async () => null,
    save: async () => {},
    clear: async () => void calls.push("clear"),
  };
  const api = {
    json: async <T>(path: string, init?: RequestInit): Promise<T> => {
      calls.push(`${init?.method} ${path}`);
      if (fail) throw new ApiError(500, "INTERNAL", "Couldn't finish deleting your account.");
      return undefined as T;
    },
  };
  return { calls, data, prefs, session, api };
}

describe("account deletion on the client (T074)", () => {
  it("needs DELETE typed exactly", () => {
    expect(canConfirmDeletion("DELETE")).toBe(true);
    expect(canConfirmDeletion(" DELETE ")).toBe(true);
    expect(canConfirmDeletion("delete")).toBe(false);
    expect(canConfirmDeletion("")).toBe(false);
  });

  it("deletes on the server, then signs out and clears Sayvox's local data", async () => {
    const f = fakes();
    await deleteAccount(f.api, f.session, f.prefs);
    expect(f.calls).toEqual(["DELETE /v1/account", "clear"]);
    expect([...f.data.keys()]).toEqual(["other.app"]);
  });

  it("keeps the user signed in if the server fails, so they can retry", async () => {
    const f = fakes(true);
    await expect(deleteAccount(f.api, f.session, f.prefs)).rejects.toThrow("Couldn't finish");
    expect(f.calls).toEqual(["DELETE /v1/account"]);
    expect(f.data.size).toBe(4);
  });
});
