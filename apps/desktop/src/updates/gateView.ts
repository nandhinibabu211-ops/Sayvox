import { openUrl } from "@tauri-apps/plugin-opener";
import type { ClientConfigWatcher, ServiceGate } from "./clientConfig";
import { rustUpdater } from "./runtime";

export const INSTALL_URL = "https://sayvox-app-2026.web.app/install";

/**
 * Settings window side of the forced-update and kill-switch states (front-end spec §3.5):
 * a blocking "Update required" panel, and a "paused" banner.
 */
export function mountGate(watcher: ClientConfigWatcher): void {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const gate = $<HTMLDivElement>("gate");
  const title = $<HTMLHeadingElement>("gate-title");
  const text = $<HTMLParagraphElement>("gate-text");
  const update = $<HTMLButtonElement>("gate-update");
  const download = $<HTMLButtonElement>("gate-download");
  const status = $<HTMLParagraphElement>("gate-status");
  const banner = $<HTMLParagraphElement>("paused-banner");

  const render = (g: ServiceGate) => {
    banner.hidden = g.kind !== "paused";
    if (g.kind === "paused") banner.textContent = `Sayvox is paused. ${g.message}`;
    const wasHidden = gate.hidden;
    gate.hidden = g.kind !== "updateRequired";
    document.body.classList.toggle("gated", !gate.hidden);
    // Keyboard and screen readers can't reach the screens behind the panel either.
    for (const el of document.querySelectorAll<HTMLElement>(".shell, .onboarding")) {
      el.inert = !gate.hidden;
    }
    if (g.kind === "updateRequired") {
      title.textContent = "Update required";
      text.textContent = `This version of Sayvox no longer works with the service. Update to ${g.minVersion} or later to keep dictating. Your settings are kept.`;
      if (wasHidden) update.focus();
    }
  };

  update.addEventListener("click", async () => {
    update.disabled = true;
    status.textContent = "Checking for the update…";
    try {
      const r = await rustUpdater.check();
      if (r.status === "available") {
        status.textContent = `Installing ${r.version}. Sayvox will restart.`;
        await rustUpdater.install(); // quits the app on success
      } else if (r.status === "notConfigured") {
        status.textContent = "This build can't update itself. Download the latest version.";
        download.hidden = false;
      } else {
        status.textContent = "The update isn't published yet. Try again in a few minutes.";
      }
    } catch {
      status.textContent = "Couldn't download the update. Check your connection and try again.";
      download.hidden = false;
    } finally {
      update.disabled = false;
    }
  });
  download.addEventListener("click", () => void openUrl(INSTALL_URL).catch(() => {}));

  render(watcher.gate);
  watcher.subscribe(() => render(watcher.gate));
}
