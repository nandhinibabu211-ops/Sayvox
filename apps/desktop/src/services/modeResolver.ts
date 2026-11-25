import type { Mode } from "@sayvox/shared";

/**
 * Pick the rewrite mode for the app being dictated into (Story 3.4, T052):
 * the user's per-app override → the built-in map → the user's default mode.
 * App ids come from Rust: lower-case exe names or `web:*` ids for browser apps.
 */
export const BUILT_IN_MODES: Readonly<Record<string, Mode>> = Object.freeze({
  // AI coding and chat tools → structured prompt
  "cursor.exe": "prompt",
  "code.exe": "prompt",
  "code - insiders.exe": "prompt",
  "windsurf.exe": "prompt",
  "zed.exe": "prompt",
  "chatgpt.exe": "prompt",
  "claude.exe": "prompt",
  "web:chatgpt": "prompt",
  "web:claude": "prompt",
  "web:gemini": "prompt",
  // Email
  "outlook.exe": "email",
  "olk.exe": "email", // new Outlook for Windows
  "thunderbird.exe": "email",
  "web:gmail": "email",
  "web:outlook": "email",
  // Chat (email mode uses the chat template for these on the server)
  "slack.exe": "email",
  "ms-teams.exe": "email",
  "teams.exe": "email",
  "discord.exe": "email",
  "whatsapp.exe": "email",
  "web:slack": "email",
  "web:teams": "email",
  "web:discord": "email",
  "web:whatsapp": "email",
});

export interface ModePrefs {
  defaultMode: Mode;
  /** Settings → Modes (Story 2.6). */
  overrides: Readonly<Record<string, Mode>>;
}

export const DEFAULT_PREFS: ModePrefs = { defaultMode: "dictation", overrides: {} };

export function resolveMode(appId: string, prefs: ModePrefs = DEFAULT_PREFS): Mode {
  const id = appId.toLowerCase();
  return prefs.overrides[id] ?? BUILT_IN_MODES[id] ?? prefs.defaultMode;
}

const CYCLE: readonly Mode[] = ["dictation", "prompt", "email"];

/** Overlay badge click: next mode, for this press only. */
export function nextMode(m: Mode): Mode {
  return CYCLE[(CYCLE.indexOf(m) + 1) % CYCLE.length]!;
}
