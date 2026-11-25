import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { shellStatus } from "./appInfo";
import { openMicrophoneSettings } from "./onboarding/permissions";
import { signIn } from "./onboarding/signin";
import { credentialSessionStore } from "./services/session";

/** Settings / onboarding window (front-end spec §3.1). */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $<HTMLParagraphElement>("status");

async function refresh(): Promise<void> {
  const session = await credentialSessionStore.load().catch(() => null);
  $("signed-out").hidden = Boolean(session);
  $("signed-in").hidden = !session;
  if (session) $("email").textContent = session.email;
}

$<HTMLButtonElement>("sign-in").addEventListener("click", async (e) => {
  const button = e.currentTarget as HTMLButtonElement;
  button.disabled = true;
  status.textContent = "Waiting for sign-in in your browser…";
  try {
    const r = await signIn();
    status.textContent =
      r.status === "signed-in"
        ? "Signed in. Hold Ctrl+Shift anywhere to dictate."
        : "Sign-in timed out. Try again.";
  } catch {
    status.textContent = "Couldn't start sign-in. Try again.";
  } finally {
    button.disabled = false;
    await refresh();
  }
});

$<HTMLButtonElement>("sign-out").addEventListener("click", async () => {
  await credentialSessionStore.clear();
  status.textContent = "Signed out.";
  await refresh();
});

const replyContext = $<HTMLInputElement>("reply-context");
try {
  replyContext.checked = localStorage.getItem("sayvox.replyContext") === "on";
} catch {
  replyContext.disabled = true;
}
replyContext.addEventListener("change", () => {
  try {
    localStorage.setItem("sayvox.replyContext", replyContext.checked ? "on" : "off");
  } catch {
    // ignore
  }
  void invoke("set_reply_context", { enabled: replyContext.checked });
});

$<HTMLButtonElement>("mic-settings").addEventListener("click", () => {
  void openMicrophoneSettings();
});

void (async () => {
  let version = "dev";
  try {
    version = await getVersion();
  } catch {
    // Plain browser (vite dev without Tauri).
  }
  document.title = `Sayvox ${version}`;
  status.textContent = shellStatus(version);
  await refresh();
})();
