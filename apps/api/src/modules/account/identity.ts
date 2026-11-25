/**
 * Delete a user's Identity Platform account (Story 5.7 AC 1) through the Identity Toolkit
 * REST API, so the API needs no Firebase Admin SDK. On Cloud Run the access token comes from
 * the metadata server (the service account needs `roles/identityplatform.admin` or
 * `firebaseauth.users.delete`); locally the Firebase Auth emulator accepts `Bearer owner`.
 */

export type DeleteIdentity = (authProviderId: string) => Promise<void>;

export interface IdentityDeleterOptions {
  projectId: string;
  /** host:port of the Firebase Auth emulator (dev only). */
  emulatorHost?: string | undefined;
  fetchFn?: typeof fetch;
}

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

export class IdentityDeleteError extends Error {
  constructor(readonly status: number) {
    super(`identity delete failed: HTTP ${status}`);
    this.name = "IdentityDeleteError";
  }
}

export function createIdentityDeleter(opts: IdentityDeleterOptions): DeleteIdentity {
  const fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
  const base = opts.emulatorHost
    ? `http://${opts.emulatorHost}/identitytoolkit.googleapis.com`
    : "https://identitytoolkit.googleapis.com";

  let cached: { token: string; until: number } | undefined;
  async function accessToken(): Promise<string> {
    if (opts.emulatorHost) return "owner";
    if (cached && cached.until > Date.now()) return cached.token;
    const res = await fetchFn(METADATA_TOKEN_URL, { headers: { "Metadata-Flavor": "Google" } });
    if (!res.ok) throw new IdentityDeleteError(res.status);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: body.access_token, until: Date.now() + (body.expires_in - 60) * 1000 };
    return body.access_token;
  }

  return async (authProviderId) => {
    const res = await fetchFn(
      `${base}/v1/projects/${encodeURIComponent(opts.projectId)}/accounts:delete`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await accessToken()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ localId: authProviderId }),
      },
    );
    if (res.ok) return;
    // Already gone (a retried deletion): that's the outcome we want.
    if (res.status === 400) {
      const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (err?.error?.message?.startsWith("USER_NOT_FOUND")) return;
    } else {
      await res.body?.cancel().catch(() => {});
    }
    throw new IdentityDeleteError(res.status);
  };
}
