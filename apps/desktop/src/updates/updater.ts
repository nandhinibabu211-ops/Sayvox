import type { ClientConfig } from "@sayvox/shared";

/**
 * When to check, download and install updates (Story 5.3, T082). The signed download and
 * install happen in Rust (`src-tauri/src/updater.rs`); this decides timing:
 *
 * - Check only if this install is in the staged rollout (`inRollout`), or the version is
 *   below the minimum (`updateRequired`, everyone must update).
 * - Download in the background as soon as an update is found.
 * - Install by itself only when Sayvox has been idle for a while: installing quits the
 *   app, and that must never cut off a dictation. A forced update waits for the user's
 *   click in the "Update required" window instead.
 */

export type CheckResult =
  { status: "notConfigured" } | { status: "upToDate" } | { status: "available"; version: string };

export type UpdateState =
  | { kind: "idle" }
  | { kind: "notConfigured" }
  | { kind: "downloading"; version: string }
  | { kind: "ready"; version: string }
  | { kind: "failed" };

export interface UpdaterDeps {
  check: () => Promise<CheckResult>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  /** Ms since the last dictation activity; Infinity if none yet. */
  idleMs: () => number;
  onState?: (s: UpdateState) => void;
}

export const AUTO_INSTALL_IDLE_MS = 10 * 60_000;

export class UpdateController {
  private state: UpdateState = { kind: "idle" };
  private running = false;
  private forced = false;

  constructor(private readonly deps: UpdaterDeps) {}

  get current(): UpdateState {
    return this.state;
  }

  private set(s: UpdateState): void {
    this.state = s;
    this.deps.onState?.(s);
  }

  /** Call with each fresh client config. */
  async onConfig(cfg: ClientConfig): Promise<void> {
    this.forced = cfg.updateRequired === true;
    if (!cfg.inRollout && !this.forced) return;
    if (this.running || this.state.kind === "notConfigured") return;
    this.running = true;
    try {
      const r = await this.deps.check();
      if (r.status === "notConfigured") return this.set({ kind: "notConfigured" });
      if (r.status === "upToDate") return this.set({ kind: "idle" });
      if (this.state.kind === "ready" && this.state.version === r.version) return;
      this.set({ kind: "downloading", version: r.version });
      await this.deps.download();
      this.set({ kind: "ready", version: r.version });
    } catch {
      this.set({ kind: "failed" });
    } finally {
      this.running = false;
    }
  }

  /** Call periodically (every minute): installs a ready, non-forced update when idle. */
  async maybeInstall(): Promise<boolean> {
    if (this.state.kind !== "ready" || this.forced) return false;
    if (this.deps.idleMs() < AUTO_INSTALL_IDLE_MS) return false;
    await this.deps.install().catch(() => this.set({ kind: "failed" }));
    return true;
  }
}
