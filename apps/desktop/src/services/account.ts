import type { ApiClient } from "./apiClient";
import type { SessionStore } from "./session";

/**
 * Account deletion on this PC (Story 5.7 AC 2, T074/T075): ask the server to delete
 * everything, then forget the user locally (Credential Manager, cached settings and other
 * `sayvox.*` preferences). Local data is cleared only after the server confirms, so a
 * failed request leaves the user signed in and able to retry.
 */

export const DELETE_CONFIRMATION = "DELETE";

export interface LocalPrefs {
  keys(): string[];
  remove(key: string): void;
}

export const browserPrefs: LocalPrefs = {
  keys() {
    try {
      return Object.keys(localStorage);
    } catch {
      return [];
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
};

export function canConfirmDeletion(typed: string): boolean {
  return typed.trim() === DELETE_CONFIRMATION;
}

export async function deleteAccount(
  api: Pick<ApiClient, "json">,
  session: SessionStore,
  prefs: LocalPrefs = browserPrefs,
): Promise<void> {
  await api.json("/v1/account", { method: "DELETE" });
  await session.clear().catch(() => {});
  for (const k of prefs.keys()) if (k.startsWith("sayvox.")) prefs.remove(k);
}
