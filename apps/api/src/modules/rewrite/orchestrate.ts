import type { ChatMessage } from "@sayvox/prompts";
import type { ReasoningEffort, StreamCompletion, StreamItem } from "../../lib/openrouter/stream";

/**
 * Walk the preset's models one attempt at a time (research R3):
 * - each attempt must produce its first token within `ttftMs` (1.5 s) or it is aborted and
 *   the next model is tried (`fallback`, reason "timeout");
 * - an HTTP error, an in-stream error or an empty answer before any token was relayed also
 *   falls back (reason "error");
 * - once tokens have reached the client we never switch models mid-answer: a later failure
 *   ends with `error`, and the client pastes the raw transcript instead (Constitution IV);
 * - the whole rewrite is bounded by `totalMs` (8 s).
 */

export interface OrchestrateInput {
  models: string[];
  messages: ChatMessage[];
  effortFor: (slug: string) => ReasoningEffort;
  complete: StreamCompletion;
  /** Client went away: abort the upstream request. */
  signal?: AbortSignal;
  ttftMs?: number;
  totalMs?: number;
  now?: () => number;
}

export type OrchestratedEvent =
  | { event: "token"; data: { text: string } }
  | { event: "fallback"; data: { from: string; to: string; reason: "timeout" | "error" } }
  | {
      event: "done";
      data: {
        model: string;
        inputTokens: number;
        outputTokens: number;
        ttftMs: number;
        totalMs: number;
      };
    }
  | { event: "error"; data: { code: "PROVIDER_UNAVAILABLE"; message: string } };

const TIMEOUT = Symbol("timeout");

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<typeof TIMEOUT>((r) => {
    timer = setTimeout(() => r(TIMEOUT), Math.max(0, ms));
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export async function* orchestrate(input: OrchestrateInput): AsyncGenerator<OrchestratedEvent> {
  const now = input.now ?? (() => performance.now());
  const ttftMs = input.ttftMs ?? 1_500;
  const totalMs = input.totalMs ?? 8_000;
  const started = now();
  const fail = (message: string): OrchestratedEvent => ({
    event: "error",
    data: { code: "PROVIDER_UNAVAILABLE", message },
  });

  for (let i = 0; i < input.models.length; i++) {
    const model = input.models[i]!;
    const next = input.models[i + 1];
    if (input.signal?.aborted) return;
    const remaining = totalMs - (now() - started);
    if (remaining <= 0) {
      yield fail("Rewrite took too long");
      return;
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    let relayed = false;
    let firstTokenAt = 0;
    let usage = { inputTokens: 0, outputTokens: 0 };
    let reason: "timeout" | "error" | undefined;

    try {
      const iterator = input
        .complete(
          { model, messages: input.messages, reasoningEffort: input.effortFor(model) },
          controller.signal,
        )
        [Symbol.asyncIterator]();
      for (;;) {
        const budget = relayed
          ? totalMs - (now() - started)
          : Math.min(ttftMs, totalMs - (now() - started));
        const step = await raceTimeout(iterator.next(), budget);
        if (step === TIMEOUT) {
          controller.abort();
          if (relayed) {
            yield fail("Rewrite took too long");
            return;
          }
          reason = "timeout";
          break;
        }
        if (step.done) break;
        const item: StreamItem = step.value;
        if (item.type === "token") {
          if (!relayed) firstTokenAt = now();
          relayed = true;
          yield { event: "token", data: { text: item.text } };
        } else if (item.type === "usage") {
          usage = { inputTokens: item.inputTokens, outputTokens: item.outputTokens };
        } else {
          reason = "error";
          break;
        }
      }
    } catch {
      if (input.signal?.aborted) return;
      reason = "error";
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
    }

    if (!reason && !relayed) reason = "error"; // empty answer
    if (!reason) {
      yield {
        event: "done",
        data: {
          model,
          ...usage,
          ttftMs: Math.round(firstTokenAt - started),
          totalMs: Math.round(now() - started),
        },
      };
      return;
    }
    if (relayed) {
      // Partial answer already shown; don't splice a second model's answer onto it.
      yield fail("Rewrite was interrupted");
      return;
    }
    if (next) yield { event: "fallback", data: { from: model, to: next, reason } };
  }
  yield fail("All models failed");
}
