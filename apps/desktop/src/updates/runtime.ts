import { ClientConfig } from "@sayvox/shared";
import { invoke } from "@tauri-apps/api/core";
import { API_BASE_URL, CLIENT_VERSION, installId } from "../services/runtime";
import type { ClientConfigWatcher } from "./clientConfig";
import { UpdateController, type CheckResult } from "./updater";

/** Public endpoint: no sign-in needed, so signed-out and outdated clients still learn. */
export async function fetchClientConfig(): Promise<ClientConfig> {
  const res = await fetch(`${API_BASE_URL}/v1/client-config`, {
    headers: { "x-client-version": CLIENT_VERSION, "x-install-id": installId() },
  });
  if (!res.ok) throw new Error(`client-config HTTP ${res.status}`);
  return ClientConfig.parse(await res.json());
}

export const rustUpdater = {
  check: () => invoke<CheckResult>("update_check"),
  download: () => invoke<void>("update_download"),
  install: () => invoke<void>("update_install"),
};

/**
 * Overlay window only (it lives for the whole session): check/download on each config,
 * try an idle install every minute.
 */
export function startUpdates(watcher: ClientConfigWatcher, idleMs: () => number): UpdateController {
  const c = new UpdateController({ ...rustUpdater, idleMs });
  watcher.subscribe((cfg) => void c.onConfig(cfg));
  if (watcher.current) void c.onConfig(watcher.current);
  setInterval(() => void c.maybeInstall(), 60_000);
  return c;
}
