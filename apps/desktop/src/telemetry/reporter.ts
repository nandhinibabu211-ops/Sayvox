import {
  scrubStack,
  type ClientOs,
  type CrashReport,
  type TelemetryBatch,
  type TelemetryEvent,
} from "@sayvox/shared";

/**
 * Crash reports and text-free product events → `POST /v1/telemetry` (T076).
 *
 * Nothing here can carry user text: crash reports send the error *type* as a code and a
 * scrubbed stack (frames only, no message); events are enums and numbers. Delivery is
 * best-effort: batched, capped, dropped on failure (no retry storms), and skipped when
 * signed out.
 */

type CrashModule = NonNullable<CrashReport["module"]>;

export interface ReporterDeps {
  send: (batch: TelemetryBatch) => Promise<void>;
  signedIn: () => Promise<boolean>;
  clientVersion: string;
  os: () => ClientOs;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  flushMs?: number;
}

export const MAX_QUEUE = 50;
const FLUSH_AT = 20;

/** "TypeError" → "TYPE_ERROR"; anything odd → "UNKNOWN". */
export function errorCodeOf(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const code = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()
    .slice(0, 64);
  return code || "UNKNOWN";
}

export class TelemetryReporter {
  private queue: TelemetryBatch["items"] = [];
  private timer: unknown;
  private readonly now: () => Date;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly seen = new Set<string>();

  constructor(private readonly deps: ReporterDeps) {
    this.now = deps.now ?? (() => new Date());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  }

  crash(err: unknown, module: CrashModule = "other"): void {
    const stack = scrubStack(err instanceof Error ? err.stack : undefined);
    const errorCode = errorCodeOf(err);
    // The same crash in a render loop shouldn't flood the queue.
    const key = `${errorCode}|${module}|${stack.split("\n")[1] ?? ""}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.push({
      kind: "crash",
      at: this.now().toISOString(),
      clientVersion: this.deps.clientVersion,
      os: this.deps.os(),
      errorCode,
      module,
      ...(stack ? { stack } : {}),
    });
  }

  event(
    name: TelemetryEvent["name"],
    fields: Pick<TelemetryEvent, "mode" | "durationMs"> = {},
  ): void {
    this.push({
      kind: "event",
      name,
      at: this.now().toISOString(),
      clientVersion: this.deps.clientVersion,
      os: this.deps.os(),
      ...fields,
    });
  }

  private push(item: TelemetryBatch["items"][number]): void {
    if (this.queue.length >= MAX_QUEUE) return; // drop newest beyond the cap
    this.queue.push(item);
    if (this.queue.length >= FLUSH_AT) void this.flush();
    else if (!this.timer) {
      this.timer = this.setTimer(() => {
        this.timer = undefined;
        void this.flush();
      }, this.deps.flushMs ?? 30_000);
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const items = this.queue.splice(0, MAX_QUEUE);
    try {
      if (!(await this.deps.signedIn())) return;
      await this.deps.send({ items });
    } catch {
      // Best effort: telemetry must never affect dictation.
    }
  }
}

/** Windows 11 reports platformVersion ≥ 13 through UA client hints; default to Windows 10. */
export async function detectOs(): Promise<ClientOs> {
  try {
    const uad = (
      navigator as Navigator & {
        userAgentData?: {
          getHighEntropyValues(h: string[]): Promise<{ platformVersion?: string }>;
        };
      }
    ).userAgentData;
    const v = (await uad?.getHighEntropyValues(["platformVersion"]))?.platformVersion;
    if (v && Number(v.split(".")[0]) >= 13) return "windows11";
  } catch {
    // fall through
  }
  return "windows10";
}

/** Report uncaught errors and rejections from this window. */
export function installCrashHandlers(r: TelemetryReporter, module: CrashModule): void {
  window.addEventListener("error", (e) => r.crash(e.error ?? new Error("ScriptError"), module));
  window.addEventListener("unhandledrejection", (e) => r.crash(e.reason, module));
  window.addEventListener("pagehide", () => void r.flush());
}
