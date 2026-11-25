/**
 * Where Sayvox's web pages live (sign-in, privacy, terms, install). Cloud Run, not Firebase
 * Hosting (owner decision 2026-11-26). Release builds set VITE_WEB_ORIGIN; dev and test
 * builds use staging. Must match SAYVOX_WEB_ORIGIN in the Rust build (sign-in callback
 * Origin check) and the opener allow-list in capabilities/default.json.
 */
export const STAGING_WEB_ORIGIN = "https://sayvox-staging-web-264655228768.us-west1.run.app";

export const WEB_ORIGIN = (
  (import.meta.env["VITE_WEB_ORIGIN"] as string | undefined) ?? STAGING_WEB_ORIGIN
).replace(/\/$/, "");
