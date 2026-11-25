/**
 * Runtime config for the web pages. In Cloud Run, /config.js (written by nginx from the
 * service's environment, apps/web/nginx.conf.template) sets window.SAYVOX_CONFIG, so one
 * image serves staging and prod. Local `vite dev` falls back to apps/web/.env.
 * Everything here is public (the API key is restricted to Identity Platform).
 */
export interface WebConfig {
  apiKey: string;
  authDomain: string;
  googleSignIn: boolean;
}

interface RawConfig {
  apiKey?: string;
  authDomain?: string;
  googleSignIn?: string;
}

export function webConfig(
  raw: RawConfig | undefined = (globalThis as { SAYVOX_CONFIG?: RawConfig }).SAYVOX_CONFIG,
  env: Record<string, string | undefined> = import.meta.env as Record<string, string | undefined>,
): WebConfig {
  const pick = (v: string | undefined, fallback: string | undefined) => (v ? v : (fallback ?? ""));
  return {
    apiKey: pick(raw?.apiKey, env["VITE_FIREBASE_API_KEY"]),
    authDomain:
      pick(raw?.authDomain, env["VITE_FIREBASE_AUTH_DOMAIN"]) || "sayvox-app-2026.firebaseapp.com",
    googleSignIn: pick(raw?.googleSignIn, env["VITE_GOOGLE_SIGNIN"]) === "true",
  };
}
