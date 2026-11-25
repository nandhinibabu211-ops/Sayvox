import { invoke } from "@tauri-apps/api/core";

/** Mirrors `StoredSession` in src-tauri/src/auth_callback.rs. */
export interface StoredSession {
  idToken: string;
  refreshToken: string;
  /** Unix epoch ms. */
  expiresAt: number;
  email: string;
}

export interface SessionStore {
  load(): Promise<StoredSession | null>;
  save(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
}

function isSession(v: unknown): v is StoredSession {
  const s = v as Partial<StoredSession> | null;
  return (
    !!s &&
    typeof s.idToken === "string" &&
    typeof s.refreshToken === "string" &&
    typeof s.expiresAt === "number" &&
    typeof s.email === "string"
  );
}

/** Tokens live in Windows Credential Manager via Rust commands, never in localStorage. */
export const credentialSessionStore: SessionStore = {
  async load() {
    const raw = await invoke<string | null>("credentials_get", { slot: "authSession" });
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isSession(parsed) ? parsed : null;
    } catch {
      return null;
    }
  },
  async save(session) {
    await invoke("credentials_set", { slot: "authSession", value: JSON.stringify(session) });
  },
  async clear() {
    await invoke("credentials_delete", { slot: "authSession" });
  },
};

export type RefreshFn = (refreshToken: string) => Promise<StoredSession>;

/**
 * Exchange a refresh token at Identity Platform's secure-token endpoint.
 * `apiKey` is the public Firebase web API key (not a secret).
 */
export function identityPlatformRefresher(
  apiKey: string,
  email: string,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): RefreshFn {
  return async (refreshToken) => {
    const res = await fetchFn(
      `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
      },
    );
    if (!res.ok) throw new SessionExpiredError();
    const body = (await res.json()) as {
      id_token?: string;
      refresh_token?: string;
      expires_in?: string;
    };
    if (!body.id_token || !body.refresh_token) throw new SessionExpiredError();
    return {
      idToken: body.id_token,
      refreshToken: body.refresh_token,
      expiresAt: now() + Number(body.expires_in ?? "3600") * 1000,
      email,
    };
  };
}

/** The refresh token was revoked or expired: the user must sign in again. */
export class SessionExpiredError extends Error {
  constructor() {
    super("Session expired; sign in again");
    this.name = "SessionExpiredError";
  }
}
