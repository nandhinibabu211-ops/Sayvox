import {
  cleanup,
  micProblemFromError,
  RewriteFailed,
  ScribeError,
  ScribeSession,
  streamRewrite,
  streamUrl,
} from "@sayvox/client";
import type { Mode, SessionStartResponse, SettingsResponse, UsageResponse } from "@sayvox/shared";
import { initializeApp } from "firebase/app";
import {
  initializeAuth,
  inMemoryPersistence,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth";
import { CAPTURE_WORKLET, Resampler, toPcm16 } from "./audio";
import { authErrorMessage } from "./authMessages";
import { webConfig } from "./config";
import { apiErrorMessage, ApiFailure } from "./appMessages";
import { isEmbedded, micPermission, showMicDialog } from "./micDialog";

/**
 * Sayvox in the browser (app.html): sign in, hold to talk, get dictation / a structured
 * prompt / an email, copy it. Uses the same API as the desktop app: audio goes through the
 * metered /v1/stream proxy, quotas and rewrites are server-side. Nothing is stored in the
 * browser: auth is in memory (reload = sign in again) and audio is never kept.
 */
const config = webConfig();
const firebase = initializeApp({
  apiKey: config.apiKey,
  authDomain: config.authDomain,
  projectId: "sayvox-app-2026",
});
const auth = initializeAuth(firebase, { persistence: inMemoryPersistence });
const TARGET_APP = "web:sayvox";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $<HTMLParagraphElement>("status");
const live = $<HTMLParagraphElement>("live");
const out = $<HTMLTextAreaElement>("out");
const meta = $<HTMLSpanElement>("meta");
const talk = $<HTMLButtonElement>("talk");

function show(text: string, isError = false): void {
  status.textContent = text;
  status.classList.toggle("error", isError);
}

let user: User | null = null;

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  if (!user) throw new ApiFailure(401, "UNAUTHENTICATED");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${await user.getIdToken()}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${config.apiBaseUrl}${path}`, { ...init, headers });
}

async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await api(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiFailure(res.status, body?.error?.code, body?.error?.message);
  }
  return (await res.json()) as T;
}

// ── Sign-in ─────────────────────────────────────────────────────────────

function showApp(signedIn: boolean): void {
  $<HTMLElement>("signin-view").hidden = signedIn;
  $<HTMLElement>("app-view").hidden = !signedIn;
  $<HTMLButtonElement>("signout").hidden = !signedIn;
  $<HTMLSpanElement>("who").textContent = signedIn ? (user?.email ?? "") : "";
}

if (!config.apiBaseUrl) show("This page isn't connected to a Sayvox server yet.", true);

$<HTMLFormElement>("signin-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const email = $<HTMLInputElement>("email").value.trim();
  const password = $<HTMLInputElement>("password").value;
  show("Signing in…");
  signInWithEmailAndPassword(auth, email, password)
    .then((cred) => {
      user = cred.user;
      showApp(true);
      show("");
      void refreshUsage();
      void loadSettings();
      void checkMicUpFront();
    })
    .catch((err: unknown) => show(authErrorMessage((err as { code?: string }).code), true));
});

$<HTMLButtonElement>("signout").addEventListener("click", () => {
  void signOut(auth).finally(() => {
    user = null;
    out.value = "";
    showApp(false);
    show("Signed out.");
  });
});

// ── Language (saved on the account, shared with the desktop app) ───────────

const languageSelect = $<HTMLSelectElement>("language");
let settings: SettingsResponse | null = null;

async function loadSettings(): Promise<void> {
  try {
    settings = await apiJson<SettingsResponse>("/v1/settings");
    languageSelect.value = settings.languageHint ?? "auto";
  } catch (err) {
    show(apiErrorMessage(err), true);
  }
}

languageSelect.addEventListener("change", () => {
  if (!settings) return;
  const languageHint = languageSelect.value === "auto" ? null : languageSelect.value;
  // PUT takes the settings fields only (no plan).
  const body = {
    preset: settings.preset,
    defaultMode: settings.defaultMode,
    appModeOverrides: settings.appModeOverrides,
    insertMode: settings.insertMode,
    languageHint,
    hotkey: settings.hotkey,
    translateHotkey: settings.translateHotkey,
  };
  apiJson<SettingsResponse>("/v1/settings", { method: "PUT", body: JSON.stringify(body) })
    .then((s) => {
      settings = s;
      show("Language saved. It applies to your next dictation, here and in the desktop app.");
    })
    .catch((err: unknown) => {
      languageSelect.value = settings?.languageHint ?? "auto";
      show(apiErrorMessage(err), true);
    });
});

// ── Microphone ──────────────────────────────────────────────────────────

/** Before the first press: explain a blocked mic now, rather than on the first try. */
async function checkMicUpFront(): Promise<void> {
  if (isEmbedded()) {
    void showMicDialog("embedded");
    return;
  }
  if ((await micPermission()) === "denied") void showMicDialog("browser-denied");
}

// ── Usage ───────────────────────────────────────────────────────────────

async function refreshUsage(): Promise<void> {
  try {
    const u = await apiJson<UsageResponse>("/v1/usage");
    $<HTMLParagraphElement>("usage").textContent =
      `${u.planName} plan · today ${u.todayMinutes} of ${u.dailyCapMinutes} min · ` +
      `this month ${u.periodMinutes} of ${u.monthlyMinutes} min`;
  } catch (err) {
    $<HTMLParagraphElement>("usage").textContent = apiErrorMessage(err);
  }
}

// ── Hold to talk ────────────────────────────────────────────────────────

interface Recording {
  session: Promise<SessionStartResponse>;
  scribe?: ScribeSession;
  media?: MediaStream;
  ctx?: AudioContext;
  startedAt: number;
  released: boolean;
  ready: Promise<void>;
}

let rec: Recording | null = null;
let busy = false;

const mode = (): Mode =>
  (document.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value ??
    "dictation") as Mode;

function setRecording(on: boolean): void {
  talk.classList.toggle("recording", on);
  talk.textContent = on ? "Listening… let go when done" : "Hold to talk";
}

function start(): void {
  if (rec || busy || !user) return;
  setRecording(true);
  live.textContent = "";
  show("");
  const r: Recording = {
    session: apiJson<SessionStartResponse>("/v1/session/start", { method: "POST", body: "{}" }),
    startedAt: performance.now(),
    released: false,
    ready: Promise.resolve(),
  };
  r.ready = (async () => {
    const s = await r.session;
    r.scribe = new ScribeSession({
      ticket: s.streamTicket,
      url: streamUrl(config.apiBaseUrl),
      onPartial: (text) => {
        live.textContent = text;
      },
    });
    r.scribe.start();
    r.media = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const ctx = new AudioContext();
    r.ctx = ctx;
    const url = URL.createObjectURL(
      new Blob([CAPTURE_WORKLET], { type: "application/javascript" }),
    );
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(ctx, "sayvox-capture");
    const resampler = new Resampler(ctx.sampleRate);
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (!r.released) r.scribe?.sendChunk(toPcm16(resampler.push(e.data)));
    };
    // A silent output keeps the worklet running in every browser.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    ctx.createMediaStreamSource(r.media).connect(node).connect(mute).connect(ctx.destination);
  })();
  rec = r;
}

function stopAudio(r: Recording): void {
  r.media?.getTracks().forEach((t) => t.stop());
  void r.ctx?.close().catch(() => {});
}

async function stop(): Promise<void> {
  const r = rec;
  if (!r || r.released) return;
  r.released = true;
  rec = null;
  busy = true;
  setRecording(false);
  const releasedAt = performance.now();
  const m = mode();
  let sessionId: string | undefined;
  let insertResult: "inserted" | "raw_fallback" | "discarded" | "failed" = "failed";
  let sttCommitMs = 0;
  try {
    await r.ready;
    stopAudio(r);
    sessionId = (await r.session).sessionId;
    if (!r.scribe) throw new Error("no stream");
    live.textContent = "Transcribing…";
    const committed = await r.scribe.commit();
    sttCommitMs = committed.commitMs;
    let text = cleanup(committed.text);
    if (!text.trim()) {
      insertResult = "discarded";
      live.textContent = "";
      show("Didn't catch anything. Hold the button while you speak, then let go.");
      return;
    }
    meta.textContent = "";
    if (m !== "dictation") {
      live.textContent = "Writing…";
      out.value = "";
      try {
        const done = await streamRewrite(
          { fetch: (path, init) => api(path, init) },
          { sessionId, transcript: text, mode: m, targetApp: TARGET_APP },
          (_token, soFar) => {
            out.value = soFar;
          },
        );
        text = done.text;
        meta.textContent = done.fallbackUsed ? `${done.model} (fallback)` : done.model;
        insertResult = "inserted";
      } catch (err) {
        if (!(err instanceof RewriteFailed)) throw err;
        insertResult = "raw_fallback";
        show("The AI rewrite failed, so this is your text as spoken.", true);
      }
    } else {
      insertResult = "inserted";
    }
    out.value = text;
    live.textContent = "";
  } catch (err) {
    stopAudio(r);
    live.textContent = "";
    if (
      err instanceof DOMException &&
      /NotAllowed|NotFound|Overconstrained|Security/.test(err.name)
    ) {
      show("");
      void showMicDialog(micProblemFromError(err, isEmbedded())).then((ok) => {
        if (ok) show("Microphone allowed. Hold the button or Space bar and speak.");
      });
    } else {
      show(
        err instanceof ScribeError ? "Speech recognition failed. Try again." : apiErrorMessage(err),
        true,
      );
    }
  } finally {
    busy = false;
    if (sessionId) {
      void api(`/v1/session/${sessionId}/end`, {
        method: "POST",
        body: JSON.stringify({
          audioSeconds: Math.round(((releasedAt - r.startedAt) / 1000) * 100) / 100,
          mode: m,
          targetApp: TARGET_APP,
          insertResult,
          timings: { sttCommitMs, releaseToInsertMs: Math.round(performance.now() - releasedAt) },
        }),
      })
        .catch(() => {})
        .finally(() => void refreshUsage());
    }
  }
}

talk.addEventListener("pointerdown", (e) => {
  talk.setPointerCapture(e.pointerId);
  start();
});
talk.addEventListener("pointerup", () => void stop());
talk.addEventListener("pointercancel", () => void stop());

const typing = () => {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
};
window.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat || typing() || $<HTMLElement>("app-view").hidden) return;
  e.preventDefault();
  start();
});
window.addEventListener("keyup", (e) => {
  if (e.code !== "Space" || typing()) return;
  e.preventDefault();
  void stop();
});

$<HTMLButtonElement>("copy").addEventListener("click", () => {
  if (!out.value) return;
  navigator.clipboard
    .writeText(out.value)
    .then(() => show("Copied."))
    .catch(() => {
      out.select();
      show("Press Ctrl+C to copy.");
    });
});
