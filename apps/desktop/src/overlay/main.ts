import { Channel, invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { SessionStartResponse } from "@sayvox/shared";
import { openMicrophoneSettings } from "../onboarding/permissions";
import { DictationPipeline, type DictationEvent, type InsertOutcome } from "../services/pipeline";
import { CLIENT_VERSION, createApiClient } from "../services/runtime";
import { streamRewrite } from "../services/rewriteClient";
import { ScribeSession } from "../services/scribeClient";
import { credentialSessionStore } from "../services/session";
import { TokenCache } from "../services/tokenCache";
import type { OverlayState } from "./state";

/**
 * Overlay window: runs the dictation pipeline and renders its state (T038).
 * Lives for the whole app session (pre-created hidden), so the token cache stays warm.
 */

const api = createApiClient();
const tokens = new TokenCache(() =>
  api.json<SessionStartResponse>("/v1/session/start", { method: "POST", body: "{}" }),
);

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const root = $<HTMLDivElement>("#overlay");
const label = $<HTMLSpanElement>("#label");
const text = $<HTMLParagraphElement>("#text");
const action = $<HTMLButtonElement>("#action");
const badge = $<HTMLButtonElement>("#mode");
const MODE_LABELS = { dictation: "Dictation", prompt: "Prompt", email: "Email" } as const;
let onAction: (() => void) | undefined;
let lastText = "";

const LABELS: Record<OverlayState["kind"], string> = {
  hidden: "",
  listening: "Listening",
  transcribing: "Transcribing",
  rewriting: "Writing",
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

function render(s: OverlayState): void {
  root.dataset["state"] = s.kind;
  label.textContent = LABELS[s.kind];
  action.hidden = true;
  onAction = undefined;
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
        action.textContent = "Open settings";
        action.hidden = false;
        onAction = () => void openMicrophoneSettings();
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

action.addEventListener("click", () => onAction?.());
badge.addEventListener("click", () => pipeline.cycleMode());

const pipeline = new DictationPipeline({
  takeSession: () => tokens.take(),
  newScribe: (opts) => new ScribeSession(opts),
  insert: (t) => invoke<InsertOutcome>("insert_text", { text: t }),
  now: () => invoke<number>("dictation_now"),
  endSession: (id, body) =>
    api.json(`/v1/session/${id}/end`, { method: "POST", body: JSON.stringify(body) }),
  onState: render,
  clientVersion: CLIENT_VERSION,
  rewrite: (req, onToken) => streamRewrite(api, req, (_t, soFar) => onToken(soFar)),
  recordTiming: (record) => void invoke("timing_append", { record }).catch(() => {}),
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

// Warm the token cache if signed in, and again when the network comes back.
async function warm(): Promise<void> {
  if (await credentialSessionStore.load().catch(() => null)) tokens.prefetch();
}
void warm();
window.addEventListener("online", () => void warm());
setInterval(() => void warm(), 5 * 60_000);
