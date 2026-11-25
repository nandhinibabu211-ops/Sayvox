import { Channel, invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { SessionStartResponse } from "@sayvox/shared";
import { openMicrophoneSettings } from "../onboarding/permissions";
import { DictationPipeline, type DictationEvent, type InsertOutcome } from "../services/pipeline";
import { CLIENT_VERSION, createApiClient } from "../services/runtime";
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
let onAction: (() => void) | undefined;
let lastText = "";

const LABELS: Record<OverlayState["kind"], string> = {
  hidden: "",
  listening: "Listening",
  transcribing: "Transcribing",
  inserting: "Inserting",
  inserted: "Inserted",
  blocked: "Can't paste here",
  error: "Error",
};

function render(s: OverlayState): void {
  root.dataset["state"] = s.kind;
  label.textContent = LABELS[s.kind];
  action.hidden = true;
  onAction = undefined;

  switch (s.kind) {
    case "hidden":
      void invoke("overlay_hide");
      return;
    case "listening":
    case "transcribing":
      // Live partials: shown, never logged or stored.
      text.textContent = s.partial;
      return;
    case "inserting":
    case "inserted":
      text.textContent = s.text;
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

const pipeline = new DictationPipeline({
  takeSession: () => tokens.take(),
  newScribe: (opts) => new ScribeSession(opts),
  insert: (t) => invoke<InsertOutcome>("insert_text", { text: t }),
  now: () => invoke<number>("dictation_now"),
  endSession: (id, body) =>
    api.json(`/v1/session/${id}/end`, { method: "POST", body: JSON.stringify(body) }),
  onState: render,
  clientVersion: CLIENT_VERSION,
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
