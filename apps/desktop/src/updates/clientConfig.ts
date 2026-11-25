import { ClientConfig } from "@sayvox/shared";
import { browserStorage, type KeyValue } from "../services/settingsStore";

/**
 * Client side of `GET /v1/client-config` (Story 2.9 AC 2, T081): polled at start, every
 * 30 min and on wake from sleep. The last answer is cached so a restart while offline
 * still honours a kill switch or forced update.
 */

export const CLIENT_CONFIG_CACHE_KEY = "sayvox.clientConfig";
export const POLL_MS = 30 * 60_000;
const WAKE_CHECK_MS = 60_000;

export type ServiceGate =
  | { kind: "ok" }
  | { kind: "paused"; message: string }
  | { kind: "updateRequired"; minVersion: string };

/** Kill switch wins: an update wouldn't help while the service is paused. */
export function gateOf(cfg: ClientConfig | null): ServiceGate {
  if (!cfg) return { kind: "ok" };
  if (cfg.killSwitch)
    return { kind: "paused", message: cfg.killSwitchMessage || "Sayvox is temporarily paused." };
  if (cfg.updateRequired) return { kind: "updateRequired", minVersion: cfg.minClientVersion };
  return { kind: "ok" };
}

export function trayText(g: ServiceGate, hotkey: string): string {
  switch (g.kind) {
    case "paused":
      return `Sayvox is paused: ${g.message}`;
    case "updateRequired":
      return "Sayvox: update required";
    default:
      return `Sayvox: hold ${hotkey} to dictate`;
  }
}

export interface WatcherDeps {
  fetchConfig: () => Promise<ClientConfig>;
  storage?: KeyValue;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
}

type Listener = (cfg: ClientConfig) => void;

export class ClientConfigWatcher {
  private cfg: ClientConfig | null;
  private lastPoll = 0;
  private lastTick: number;
  private readonly listeners = new Set<Listener>();
  private readonly storage: KeyValue;
  private readonly now: () => number;

  constructor(private readonly deps: WatcherDeps) {
    this.storage = deps.storage ?? browserStorage;
    this.now = deps.now ?? Date.now;
    this.lastTick = this.now();
    let cached: ClientConfig | null = null;
    try {
      const raw = this.storage.get(CLIENT_CONFIG_CACHE_KEY);
      const parsed = raw ? ClientConfig.safeParse(JSON.parse(raw)) : undefined;
      if (parsed?.success) cached = parsed.data;
    } catch {
      // corrupt cache: start fresh
    }
    this.cfg = cached;
  }

  get current(): ClientConfig | null {
    return this.cfg;
  }

  get gate(): ServiceGate {
    return gateOf(this.cfg);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Fetch now. Network errors keep the last known config. */
  async poll(): Promise<ClientConfig | null> {
    this.lastPoll = this.now();
    try {
      const cfg = await this.deps.fetchConfig();
      this.cfg = cfg;
      this.storage.set(CLIENT_CONFIG_CACHE_KEY, JSON.stringify(cfg));
      for (const fn of this.listeners) fn(cfg);
    } catch {
      // offline or API down: keep what we had
    }
    return this.cfg;
  }

  /**
   * Poll now, then every 30 min. A once-a-minute tick notices a wake from sleep (the clock
   * jumped well past the tick interval) and polls immediately.
   */
  start(): void {
    void this.poll();
    const every = this.deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    every(() => this.tick(), WAKE_CHECK_MS);
  }

  /** Exposed for tests. */
  tick(): void {
    const t = this.now();
    const woke = t - this.lastTick > WAKE_CHECK_MS * 3;
    this.lastTick = t;
    if (woke || t - this.lastPoll >= POLL_MS) void this.poll();
  }
}
