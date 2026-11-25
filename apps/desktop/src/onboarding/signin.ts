import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

export interface SignInDeps {
  begin: () => Promise<{ signinUrl: string; state: string }>;
  open: (url: string) => Promise<void>;
  on: <T>(event: string, cb: (payload: T) => void) => Promise<UnlistenFn>;
}

export const tauriSignInDeps: SignInDeps = {
  begin: () => invoke("auth_begin"),
  open: (url) => openUrl(url),
  on: (event, cb) => listen(event, (e) => cb(e.payload as never)),
};

export type SignInResult = { status: "signed-in"; email: string } | { status: "timed-out" };

/**
 * Story 2.2 sign-in: Rust opens a one-shot loopback listener and returns the hosted sign-in
 * URL; the browser page POSTs tokens to it; Rust stores them in Credential Manager and emits
 * `auth://signed-in`. Tokens never pass through a URL or this web view.
 */
export async function signIn(deps: SignInDeps = tauriSignInDeps): Promise<SignInResult> {
  const unlisten: UnlistenFn[] = [];
  try {
    const result = new Promise<SignInResult>((resolve) => {
      void deps
        .on<{ email: string }>("auth://signed-in", (p) =>
          resolve({ status: "signed-in", email: p.email }),
        )
        .then((u) => unlisten.push(u));
      void deps
        .on<null>("auth://timed-out", () => resolve({ status: "timed-out" }))
        .then((u) => unlisten.push(u));
    });
    const { signinUrl } = await deps.begin();
    await deps.open(signinUrl);
    return await result;
  } finally {
    for (const u of unlisten) u();
  }
}
