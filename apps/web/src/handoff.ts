/**
 * Hand the signed-in session to the desktop app's one-shot loopback listener
 * (apps/desktop/src-tauri/src/auth_callback.rs). Pure helpers, unit-tested.
 */

export interface HandoffParams {
  port: number;
  state: string;
}

/** Only accept what the desktop app generates: an ephemeral port and a 32-hex state. */
export function parseHandoff(search: string): HandoffParams | null {
  const q = new URLSearchParams(search);
  const port = Number(q.get("port"));
  const state = q.get("state") ?? "";
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) return null;
  if (!/^[0-9a-f]{32}$/.test(state)) return null;
  return { port, state };
}

export interface SessionTokens {
  idToken: string;
  refreshToken: string;
  expiresIn: number;
  email: string;
}

/** POST the tokens to 127.0.0.1 (never in a URL). Returns true when the app accepted them. */
export async function sendToDesktop(
  params: HandoffParams,
  tokens: SessionTokens,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchFn(`http://127.0.0.1:${params.port}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: params.state, ...tokens }),
      // Chrome Private Network Access: a public page reaching loopback.
      targetAddressSpace: "loopback",
    } as RequestInit);
    return res.status === 204;
  } catch {
    return false;
  }
}

/** Brings the desktop app to the front; carries only the state, never tokens. */
export function deepLink(state: string): string {
  return `sayvox://auth?state=${encodeURIComponent(state)}`;
}
