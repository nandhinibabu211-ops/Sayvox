/**
 * Overlay states (front-end spec §3.2, T038). Pure data; the view renders whatever state
 * the pipeline reports.
 */
import type { Mode } from "@sayvox/shared";

export type OverlayState =
  | { kind: "hidden" }
  | { kind: "listening"; partial: string; mode?: Mode }
  | { kind: "transcribing"; partial: string; mode?: Mode }
  /** Streaming an AI rewrite (prompt / email mode, T054). */
  | { kind: "rewriting"; text: string; mode: Mode }
  | { kind: "inserting"; text: string }
  /** `notice` set when the raw transcript was pasted because the rewrite failed (T055). */
  | { kind: "inserted"; text: string; notice?: string }
  /** Paste impossible (elevated target): keep the text so the user can copy it. */
  | { kind: "blocked"; text: string }
  | { kind: "error"; message: string; action?: "openMicSettings" | "signIn" | "upgrade" };

export const INSERTED_HIDE_MS = 800;
export const ERROR_HIDE_MS = 3_000;

export function errorFor(code: string): Extract<OverlayState, { kind: "error" }> {
  switch (code) {
    case "permissionDenied":
      return {
        kind: "error",
        message: "Microphone access is off for apps in Windows settings.",
        action: "openMicSettings",
      };
    case "noDevice":
      return { kind: "error", message: "No microphone found." };
    case "deviceLost":
      return { kind: "error", message: "Microphone disconnected." };
    case "QUOTA_EXCEEDED":
      return { kind: "error", message: "Daily limit reached.", action: "upgrade" };
    case "SESSION_EXPIRED":
    case "UNAUTHENTICATED":
      return { kind: "error", message: "Sign in to Sayvox to dictate.", action: "signIn" };
    case "CLIENT_OUTDATED":
      return { kind: "error", message: "Update Sayvox to keep dictating." };
    case "KILL_SWITCH":
      return { kind: "error", message: "Sayvox is temporarily paused." };
    case "offline":
      return { kind: "error", message: "No internet connection." };
    default:
      return { kind: "error", message: "Couldn't transcribe. Try again." };
  }
}
