import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Windows microphone access (T039, ADR-010). Windows has no per-app prompt for desktop
 * apps; access is controlled by Settings → Privacy & security → Microphone →
 * "Let desktop apps access your microphone". If it's off, capture fails with
 * `permissionDenied` and we send the user straight to that page.
 * (No Accessibility permission exists on Windows; that was a macOS-only step.)
 */
export const MIC_SETTINGS_URL = "ms-settings:privacy-microphone";

export function openMicrophoneSettings(): Promise<void> {
  return openUrl(MIC_SETTINGS_URL);
}
