import { ApiClient } from "./apiClient";
import { credentialSessionStore, identityPlatformRefresher } from "./session";

/** App-wide wiring shared by the overlay and settings windows. */

export const API_BASE_URL =
  (import.meta.env["VITE_API_BASE_URL"] as string | undefined) ?? "http://localhost:8787";
const FIREBASE_API_KEY = (import.meta.env["VITE_FIREBASE_API_KEY"] as string | undefined) ?? "";
export const CLIENT_VERSION =
  (import.meta.env["VITE_APP_VERSION"] as string | undefined) ?? "0.1.0";

/** Random per-install id for staged rollouts; not linked to the user's identity. */
export function installId(): string {
  const key = "sayvox.installId";
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return "unknown";
  }
}

export function createApiClient(): ApiClient {
  return new ApiClient({
    baseUrl: API_BASE_URL,
    store: credentialSessionStore,
    makeRefresher: (email) => identityPlatformRefresher(FIREBASE_API_KEY, email),
    clientVersion: CLIENT_VERSION,
    installId: installId(),
  });
}
