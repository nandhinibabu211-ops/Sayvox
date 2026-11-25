import type { Mode, TelemetryEvent } from "@sayvox/shared";
import type { OverlayState } from "../overlay/state";

/**
 * Text-free product events (T093) derived from overlay state changes, so the pipeline
 * doesn't need to know about analytics. Only the event name, mode and a duration ever
 * leave this class: the `partial` / `text` fields of a state are never read (Constitution I).
 * Events go through the telemetry reporter to /v1/telemetry, then a log sink to BigQuery.
 */
export type Emit = (
  name: TelemetryEvent["name"],
  fields?: Pick<TelemetryEvent, "mode" | "durationMs">,
) => void;

export class ProductAnalytics {
  private pressStartedAt: number | undefined;
  private mode: Mode | undefined;

  constructor(
    private readonly emit: Emit,
    private readonly now: () => number = Date.now,
  ) {}

  observe(s: OverlayState): void {
    switch (s.kind) {
      case "listening": {
        if (this.pressStartedAt === undefined) {
          this.pressStartedAt = this.now();
          this.mode = s.mode;
          this.emit("dictation_started", s.mode ? { mode: s.mode } : {});
        } else if (s.mode && this.mode && s.mode !== this.mode) {
          this.mode = s.mode;
          this.emit("mode_changed", { mode: s.mode });
        }
        return;
      }
      case "rewriting":
      case "review":
        this.mode = s.mode;
        return;
      case "inserted": {
        const fields = {
          ...(this.mode ? { mode: this.mode } : {}),
          ...(this.pressStartedAt !== undefined
            ? { durationMs: Math.max(0, Math.round(this.now() - this.pressStartedAt)) }
            : {}),
        };
        this.emit("dictation_inserted", fields);
        if (s.notice) this.emit("fallback_used", this.mode ? { mode: this.mode } : {});
        this.reset();
        return;
      }
      case "error":
        if (s.action === "upgrade") this.emit("quota_hit", this.mode ? { mode: this.mode } : {});
        this.reset();
        return;
      case "hidden":
      case "blocked":
        this.reset();
        return;
      case "transcribing":
      case "inserting":
        return;
    }
  }

  private reset(): void {
    this.pressStartedAt = undefined;
    this.mode = undefined;
  }
}
