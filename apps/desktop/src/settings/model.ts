import {
  HOTKEY_OPTIONS,
  type Hotkey,
  type LanguageHint,
  type Mode,
  type Preset,
  type SettingsResponse,
  TargetApp,
} from "@sayvox/shared";

/** Pure view-model helpers for the settings screens (Story 2.6/2.7), unit-tested. */

// ── General: hotkey recorder (T067/T072) ────────────────────────────────

type Mod = "Ctrl" | "Shift" | "Alt" | "Win";
const ORDER: readonly Mod[] = ["Ctrl", "Alt", "Shift", "Win"];

/** `KeyboardEvent.key` → modifier. AltGr reports as "AltGraph" (it's Ctrl+Alt underneath). */
function modOf(key: string): Mod | "AltGr" | undefined {
  switch (key) {
    case "Control":
      return "Ctrl";
    case "Shift":
      return "Shift";
    case "Alt":
      return "Alt";
    case "Meta":
    case "OS":
      return "Win";
    case "AltGraph":
      return "AltGr";
    default:
      return undefined;
  }
}

/** The supported chord for these modifiers, in the canonical spelling, or null. */
export function chordFor(mods: ReadonlySet<Mod>): Hotkey | null {
  if (mods.size !== 2) return null;
  return (
    HOTKEY_OPTIONS.find((opt) => {
      const parts = opt.split("+");
      return parts.every((p) => mods.has(p as Mod));
    }) ?? null
  );
}

export function hotkeyLabel(h: string): string {
  return h.replace("+", " + ");
}

export type RecorderResult = { hotkey: Hotkey } | { error: string } | null;

/**
 * Hold two modifiers, release: that's the new chord. Any other key, AltGr, or an
 * unsupported pair is refused with a message.
 */
export class HotkeyRecorder {
  private down = new Set<Mod>();
  private peak = new Set<Mod>();
  private bad: string | undefined;

  keyDown(key: string): RecorderResult {
    const m = modOf(key);
    if (m === "AltGr") this.bad = "AltGr types characters (₹, €) on many layouts; pick another.";
    else if (!m) this.bad = "Use modifier keys only (Ctrl, Shift, Alt, Win).";
    else {
      this.down.add(m);
      if (this.down.size > this.peak.size) this.peak = new Set(this.down);
    }
    return null;
  }

  keyUp(key: string): RecorderResult {
    const m = modOf(key);
    if (m && m !== "AltGr") this.down.delete(m);
    if (this.down.size > 0) return null;
    const peak = this.peak;
    const bad = this.bad;
    this.peak = new Set();
    this.bad = undefined;
    if (bad) return { error: bad };
    if (peak.size === 0) return null;
    const chord = chordFor(peak);
    if (chord) return { hotkey: chord };
    const pressed = ORDER.filter((k) => peak.has(k)).join("+");
    return {
      error:
        peak.size !== 2
          ? `Hold exactly two keys (you pressed ${pressed}).`
          : `${pressed} isn't supported; try ${HOTKEY_OPTIONS.slice(0, 3).join(", ")}.`,
    };
  }
}

// ── General: language ───────────────────────────────────────────────────

export const LANGUAGE_CHOICES: readonly { value: LanguageHint; label: string }[] = [
  { value: "auto", label: "Auto-detect" },
  { value: "en", label: "English" },
  { value: "en-IN", label: "English (India)" },
  { value: "hinglish", label: "Hinglish (Hindi + English)" },
];

/** `null` in settings means auto-detect; the select shows it as "auto". */
export const languageValue = (s: Pick<SettingsResponse, "languageHint">): LanguageHint =>
  s.languageHint ?? "auto";
export const languageSetting = (v: LanguageHint): LanguageHint | null => (v === "auto" ? null : v);

// ── Modes (T068) ────────────────────────────────────────────────────────

export const MODE_CHOICES: readonly { value: Mode; label: string }[] = [
  { value: "dictation", label: "Dictation (clean text)" },
  { value: "prompt", label: "Prompt (structured for AI tools)" },
  { value: "email", label: "Email / chat message" },
];

/** Friendly names for the ids the built-in map and running-app picker produce. */
export function appLabel(id: string): string {
  const web = /^web:(.+)$/.exec(id);
  if (web) return `${web[1]![0]!.toUpperCase()}${web[1]!.slice(1)} (web)`;
  return id;
}

/** Normalise what the user typed or picked into an app id, or explain why it can't be. */
export function parseAppId(input: string): { id: string } | { error: string } {
  const id = input.trim().toLowerCase();
  if (!id) return { error: "Pick or type an app." };
  if (!TargetApp.safeParse(id).success) return { error: "Use the app's exe name, like slack.exe." };
  return { id };
}

export const MAX_OVERRIDES = 100;

export function addOverride(
  overrides: Readonly<Record<string, Mode>>,
  id: string,
  mode: Mode,
): Record<string, Mode> | { error: string } {
  if (!(id in overrides) && Object.keys(overrides).length >= MAX_OVERRIDES)
    return { error: `At most ${MAX_OVERRIDES} app overrides.` };
  return { ...overrides, [id]: mode };
}

export function removeOverride(
  overrides: Readonly<Record<string, Mode>>,
  id: string,
): Record<string, Mode> {
  const next = { ...overrides };
  delete next[id];
  return next;
}

// ── Preset (T069) ───────────────────────────────────────────────────────

export interface PresetCard {
  id: Preset;
  name: string;
  hint: string;
  recommended: boolean;
  selected: boolean;
  locked: boolean;
}

const PRESET_INFO: readonly Omit<PresetCard, "selected" | "locked">[] = [
  { id: "fastest", name: "Fastest", hint: "Quickest rewrites, highest cost.", recommended: false },
  { id: "balanced", name: "Balanced", hint: "Good speed at a fair cost.", recommended: true },
  { id: "cheapest", name: "Cheapest", hint: "Lowest cost; a little slower.", recommended: false },
];

export function presetCards(s: Pick<SettingsResponse, "preset" | "plan">): PresetCard[] {
  return PRESET_INFO.map((p) => ({
    ...p,
    selected: s.preset === p.id,
    locked: !s.plan.allowedPresets.includes(p.id),
  }));
}

// ── Dictionary (T070) ───────────────────────────────────────────────────

export function dictionaryCounter(n: number, limit: number): { text: string; full: boolean } {
  return { text: `${n} / ${limit}`, full: n >= limit };
}
