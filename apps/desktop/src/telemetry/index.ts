import type { ClientOs } from "@sayvox/shared";
import type { ApiClient } from "../services/apiClient";
import { CLIENT_VERSION } from "../services/runtime";
import { credentialSessionStore } from "../services/session";
import { detectOs, installCrashHandlers, TelemetryReporter } from "./reporter";

/** One reporter per window, reporting that window's uncaught errors. */
export function startTelemetry(api: ApiClient, module: "overlay" | "settings"): TelemetryReporter {
  let os: ClientOs = "windows10";
  void detectOs().then((v) => (os = v));
  const reporter = new TelemetryReporter({
    send: (batch) => api.json("/v1/telemetry", { method: "POST", body: JSON.stringify(batch) }),
    signedIn: async () => Boolean(await credentialSessionStore.load().catch(() => null)),
    clientVersion: CLIENT_VERSION,
    os: () => os,
  });
  installCrashHandlers(reporter, module);
  return reporter;
}
