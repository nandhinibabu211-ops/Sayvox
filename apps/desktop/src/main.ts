import type { SettingsResponse } from "@sayvox/shared";
import { getVersion } from "@tauri-apps/api/app";
import { shellStatus } from "./appInfo";
import { signIn } from "./onboarding/signin";
import { createApiClient } from "./services/runtime";
import { credentialSessionStore } from "./services/session";
import { SettingsStore } from "./services/settingsStore";
import { errorMessage, type SettingsContext } from "./settings/dom";
import { mountDictionary } from "./settings/Dictionary";
import { mountGeneral } from "./settings/General";
import { hotkeyLabel } from "./settings/model";
import { mountModes } from "./settings/Modes";
import { mountPreset } from "./settings/Preset";
import { mountPrivacy } from "./settings/Privacy";
import { startTelemetry } from "./telemetry";

/** Settings / onboarding window (front-end spec §2–4). */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $<HTMLParagraphElement>("status");
const say = (m: string) => (status.textContent = m);

const api = createApiClient();
const store = new SettingsStore({
  get: () => api.json<SettingsResponse>("/v1/settings"),
  put: (body) =>
    api.json<SettingsResponse>("/v1/settings", { method: "PUT", body: JSON.stringify(body) }),
});
const ctx: SettingsContext = { store, api, status: say };
startTelemetry(api, "settings");

// ── Navigation ──
type Page = "home" | "general" | "modes" | "preset" | "dictionary" | "privacy";
const mounts: Record<Exclude<Page, "home">, (root: HTMLElement, c: SettingsContext) => void> = {
  general: mountGeneral,
  modes: mountModes,
  preset: mountPreset,
  dictionary: mountDictionary,
  privacy: (root, c) =>
    mountPrivacy(root, {
      ...c,
      email: () => $("email").textContent ?? "",
      onDeleted: () => void onAccountDeleted(),
    }),
};
const mounted = new Set<Page>(["home"]);
const navButtons = [...document.querySelectorAll<HTMLButtonElement>("nav [data-page]")];

function show(page: Page): void {
  if (page !== "home" && !store.current) {
    say("Loading your settings…");
    return;
  }
  for (const b of navButtons) {
    if (b.dataset["page"] === page) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  for (const p of document.querySelectorAll<HTMLElement>(".page")) {
    p.hidden = p.id !== `page-${page}`;
  }
  if (!mounted.has(page)) {
    mounted.add(page);
    mounts[page as Exclude<Page, "home">]($(`page-${page}`), ctx);
  }
  say("");
}
for (const b of navButtons) b.addEventListener("click", () => show(b.dataset["page"] as Page));

store.subscribe((s) => {
  for (const el of document.querySelectorAll(".hotkey-label"))
    el.textContent = hotkeyLabel(s.hotkey);
});

/** After deletion: back to onboarding with a fresh window state. */
async function onAccountDeleted(): Promise<void> {
  // Screens hold the deleted user's data; rebuild them on the next sign-in.
  for (const p of [...mounted]) if (p !== "home") $(`page-${p}`).replaceChildren();
  mounted.clear();
  mounted.add("home");
  show("home");
  await refresh();
  say("Your account was deleted. Thanks for trying Sayvox.");
}

// ── Session ──
async function refresh(): Promise<void> {
  const session = await credentialSessionStore.load().catch(() => null);
  $("signed-out").hidden = Boolean(session);
  $("signed-in").hidden = !session;
  if (!session) return;
  $("email").textContent = session.email;
  try {
    await store.load();
  } catch (err) {
    // Cached settings (if any) keep the screens usable; saving needs the network.
    if (!store.current) say(`Couldn't load your settings. ${errorMessage(err)}`);
  }
}

$<HTMLButtonElement>("sign-in").addEventListener("click", async (e) => {
  const button = e.currentTarget as HTMLButtonElement;
  button.disabled = true;
  say("Waiting for sign-in in your browser…");
  try {
    const r = await signIn();
    say(
      r.status === "signed-in"
        ? `Signed in. Hold ${hotkeyLabel(store.current?.hotkey ?? "Ctrl+Shift")} anywhere to dictate.`
        : "Sign-in timed out. Try again.",
    );
  } catch {
    say("Couldn't start sign-in. Try again.");
  } finally {
    button.disabled = false;
    await refresh();
  }
});

$<HTMLButtonElement>("sign-out").addEventListener("click", async () => {
  await credentialSessionStore.clear();
  show("home");
  say("Signed out.");
  await refresh();
});

// Re-check settings when the window comes back (the tray reopens a hidden window).
window.addEventListener("focus", () => {
  if (!$("signed-in").hidden) void store.load().catch(() => {});
});

void (async () => {
  let version = "dev";
  try {
    version = await getVersion();
  } catch {
    // Plain browser (vite dev without Tauri).
  }
  document.title = `Sayvox ${version}`;
  say(shellStatus(version));
  await refresh();
})();
