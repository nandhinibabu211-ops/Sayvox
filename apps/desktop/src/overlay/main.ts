import { Channel, invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { SessionStartResponse, SettingsResponse } from "@sayvox/shared";
import { openMicrophoneSettings } from "../onboarding/permissions";
import { DEFAULT_PREFS } from "../services/modeResolver";
import { DictationPipeline, type DictationEvent, type InsertOutcome } from "../services/pipeline";
import { API_BASE_URL, CLIENT_VERSION, createApiClient } from "../services/runtime";
import { ScribeSession, streamRewrite, streamUrl } from "@sayvox/client";
import { credentialSessionStore } from "../services/session";
import { parseCached, SETTINGS_CACHE_KEY, SettingsStore } from "../services/settingsStore";
import { TokenCache } from "../services/tokenCache";
import { REVIEW_HINT } from "./review";
import { errorFor, type OverlayState } from "./state";
import { startTelemetry } from "../telemetry";
import { ProductAnalytics } from "../telemetry/analytics";
import { ClientConfigWatcher, trayText } from "../updates/clientConfig";
import { fetchClientConfig, startUpdates } from "../updates/runtime";
import { hotkeyLabel } from "../settings/model";

/**
 * Overlay window: runs the dictation pipeline and renders its state (T038).
 * Lives for the whole app session (pre-created hidden), so the token cache stays warm.
 */

const api = createApiClient();
const STREAM_URL = streamUrl(API_BASE_URL);
const telemetry = startTelemetry(api, "overlay");
const analytics = new ProductAnalytics((name, fields) => telemetry.event(name, fields));
const tokens = new TokenCache(() =>
  api.json<SessionStartResponse>("/v1/session/start", { method: "POST", body: "{}" }),
);

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const root = $<HTMLDivElement>("#overlay");
const label = $<HTMLSpanElement>("#label");
const text = $<HTMLParagraphElement>("#text");
const action = $<HTMLButtonElement>("#action");
const badge = $<HTMLButtonElement>("#mode");
const hint = $<HTMLSpanElement>("#hint");
const MODE_LABELS = {
  dictation: "Dictation",
  prompt: "Prompt",
  email: "Email",
  translate: "English",
} as const;
let onAction: (() => void) | undefined;
let lastText = "";

const LABELS: Record<OverlayState["kind"], string> = {
  hidden: "",
  listening: "Listening",
  transcribing: "Transcribing",
  rewriting: "Writing",
  review: "Review",
  inserting: "Inserting",
  inserted: "Inserted",
  blocked: "Can't paste here",
  error: "Error",
};

let lastHeight = 64;
/** Grow the notch for longer text (64–240 px), without jumping on every token. */
function fit(): void {
  const wanted =
    text.textContent && text.textContent.length > 60
      ? Math.min(240, 64 + Math.ceil(text.textContent.length / 55) * 18)
      : 64;
  if (Math.abs(wanted - lastHeight) >= 18 || wanted === 64) {
    if (wanted !== lastHeight) void invoke("overlay_resize", { height: wanted });
    lastHeight = wanted;
  }
  root.classList.toggle("tall", wanted > 64);
}

let lastReported = 0;
function render(s: OverlayState): void {
  // Tell the Rust watchdog this page is alive (at most every 500 ms while streaming).
  const t = Date.now();
  if (t - lastReported > 500 || s.kind !== "rewriting") {
    lastReported = t;
    void invoke("overlay_rendered").catch(() => {});
  }
  root.dataset["state"] = s.kind;
  label.textContent = LABELS[s.kind];
  action.hidden = true;
  onAction = undefined;
  hint.hidden = s.kind !== "review";
  const mode = "mode" in s ? s.mode : undefined;
  badge.hidden = !mode;
  if (mode) badge.textContent = MODE_LABELS[mode];

  switch (s.kind) {
    case "hidden":
      text.textContent = "";
      fit();
      void invoke("overlay_hide");
      return;
    case "listening":
    case "transcribing":
      // Live partials: shown, never logged or stored.
      text.textContent = s.partial;
      fit();
      return;
    case "rewriting":
      // Streamed rewrite tokens: shown, never logged or stored.
      text.textContent = s.text;
      fit();
      return;
    case "review":
      // Shown for approval, never logged or stored.
      text.textContent = s.notice ? `${s.notice} ${s.text}` : s.text;
      hint.textContent = REVIEW_HINT;
      action.textContent = "Insert";
      action.hidden = false;
      onAction = () => pipeline.decideReview("insert");
      fit();
      return;
    case "inserting":
      text.textContent = s.text;
      fit();
      return;
    case "inserted":
      text.textContent = s.notice ?? s.text;
      fit();
      return;
    case "blocked":
      lastText = s.text;
      text.textContent = s.text;
      action.textContent = "Copy";
      action.hidden = false;
      onAction = () => {
        void invoke("copy_text", { text: lastText }).finally(() => render({ kind: "hidden" }));
      };
      return;
    case "error":
      text.textContent = s.message;
      if (s.action === "openMicSettings") {
        action.textContent = s.micProblem === "no-device" ? "How to fix" : "Fix it";
        action.hidden = false;
        onAction = () => {
          // Step-by-step guide in the Sayvox window, plus the Windows page it points to.
          void showMainWindow().then(() =>
            emitTo("main", "settings://mic-help", { problem: s.micProblem ?? "windows-off" }),
          );
          if (s.micProblem !== "no-device") void openMicrophoneSettings();
          render({ kind: "hidden" });
        };
      } else if (s.action === "update") {
        action.textContent = "Update";
        action.hidden = false;
        onAction = () => void showMainWindow();
      } else if (s.action === "upgrade") {
        // T086: daily/monthly limit reached → Settings → Usage & Plan.
        action.textContent = "Upgrade";
        action.hidden = false;
        onAction = () => {
          void showMainWindow().then(() => emitTo("main", "settings://open", { page: "usage" }));
          render({ kind: "hidden" });
        };
      } else if (s.action === "signIn") {
        action.textContent = "Sign in";
        action.hidden = false;
        onAction = () => {
          void WebviewWindow.getByLabel("main").then(async (w) => {
            await w?.show();
            await w?.setFocus();
          });
        };
      }
      return;
  }
}

async function showMainWindow(): Promise<void> {
  const w = await WebviewWindow.getByLabel("main");
  await w?.show();
  await w?.setFocus();
}

action.addEventListener("click", () => onAction?.());

// Kill switch / forced update (T081) and auto-update timing (T082).
const clientConfig = new ClientConfigWatcher({ fetchConfig: fetchClientConfig });
let lastActivity = 0;
const updateTray = () =>
  void invoke("set_tray_status", {
    text: trayText(clientConfig.gate, hotkeyLabel(prefs?.hotkey ?? "Ctrl+Shift")),
  }).catch(() => {});
clientConfig.subscribe(updateTray);
// A forced update brings up the settings window with the blocking "Update required" panel.
let shownForUpdate = false;
clientConfig.subscribe(() => {
  if (clientConfig.gate.kind === "updateRequired" && !shownForUpdate) {
    shownForUpdate = true;
    void showMainWindow();
  }
});
badge.addEventListener("click", () => pipeline.cycleMode());

// Settings (Story 2.6): cached copy at once, fresh copy from the API when signed in. The
// settings window writes the cache; the `storage` event brings its changes here.
const settings = new SettingsStore({
  get: () => api.json<SettingsResponse>("/v1/settings"),
  put: (body) =>
    api.json<SettingsResponse>("/v1/settings", { method: "PUT", body: JSON.stringify(body) }),
});
let prefs: SettingsResponse | null = settings.current;
let appliedHotkey = "";
let appliedTranslate: string | null | undefined;
function applySettings(s: SettingsResponse | null): void {
  prefs = s;
  if (s && s.hotkey !== appliedHotkey) {
    appliedHotkey = s.hotkey;
    void invoke("set_hotkey", { hotkey: s.hotkey }).catch(() => {});
    updateTray();
  }
  // Second chord: hold it to dictate into English (Settings → General).
  if (s && s.translateHotkey !== appliedTranslate) {
    appliedTranslate = s.translateHotkey;
    void invoke("set_translate_hotkey", {
      hotkey: s.translateHotkey,
      dictationHotkey: s.hotkey,
    }).catch(() => {});
  }
}
applySettings(prefs);
settings.subscribe(applySettings);
window.addEventListener("storage", (e) => {
  if (e.key === SETTINGS_CACHE_KEY) {
    const next = parseCached(e.newValue);
    if (next) applySettings(next);
    // Cleared by account deletion: drop the prefetched session of the deleted user.
    else if (e.newValue === null) tokens.invalidate();
  }
});

const pipeline = new DictationPipeline({
  takeSession: () => tokens.take(),
  newScribe: (opts) => new ScribeSession({ ...opts, url: STREAM_URL }),
  insert: (t) => invoke<InsertOutcome>("insert_text", { text: t }),
  now: () => invoke<number>("dictation_now"),
  endSession: (id, body) =>
    api.json(`/v1/session/${id}/end`, { method: "POST", body: JSON.stringify(body) }),
  onState: (s) => {
    if (s.kind !== "hidden") lastActivity = Date.now();
    analytics.observe(s);
    render(s);
  },
  blocked: () => {
    const g = clientConfig.gate;
    if (g.kind === "paused") return { kind: "error", message: g.message };
    if (g.kind === "updateRequired") return errorFor("CLIENT_OUTDATED");
    return null;
  },
  clientVersion: CLIENT_VERSION,
  rewrite: (req, onToken) => streamRewrite(api, req, (_t, soFar) => onToken(soFar)),
  recordTiming: (record) => void invoke("timing_append", { record }).catch(() => {}),
  modePrefs: () =>
    prefs ? { defaultMode: prefs.defaultMode, overrides: prefs.appModeOverrides } : DEFAULT_PREFS,
  insertMode: () => prefs?.insertMode ?? "auto",
  reviewKeys: (active) => void invoke("review_keys", { active }).catch(() => {}),
});

function toArrayBuffer(m: unknown): ArrayBuffer | undefined {
  if (m instanceof ArrayBuffer) return m;
  if (ArrayBuffer.isView(m))
    return m.buffer.slice(m.byteOffset, m.byteOffset + m.byteLength) as ArrayBuffer;
  if (Array.isArray(m)) return Uint8Array.from(m as number[]).buffer;
  return undefined;
}

const channel = new Channel<unknown>();
channel.onmessage = (m) => {
  const pcm = toArrayBuffer(m);
  if (pcm) pipeline.onChunk(pcm);
  else void pipeline.onEvent(m as DictationEvent);
};
void invoke("dictation_attach", { chunks: channel });

// Opt-in reply context (off by default); toggled in the settings window.
let replyContextOn = false;
try {
  replyContextOn = localStorage.getItem("sayvox.replyContext") === "on";
} catch {
  // storage unavailable: keep it off
}
void invoke("set_reply_context", { enabled: replyContextOn });
window.addEventListener("storage", (e) => {
  if (e.key === "sayvox.replyContext") {
    void invoke("set_reply_context", { enabled: e.newValue === "on" });
  }
});

// Warm the token cache if signed in, and again when the network comes back.
async function warm(): Promise<void> {
  if (await credentialSessionStore.load().catch(() => null)) {
    tokens.prefetch();
    void settings.load().catch(() => {});
  }
}
void warm();
clientConfig.start();
startUpdates(clientConfig, () => (lastActivity ? Date.now() - lastActivity : Infinity));
window.addEventListener("online", () => void warm());
setInterval(() => void warm(), 5 * 60_000);
