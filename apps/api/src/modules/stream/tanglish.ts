import { buildTanglish, hasTamilScript } from "@sayvox/prompts";
import type { ReasoningEffort, StreamCompletion } from "../../lib/openrouter/stream";
import { orchestrate } from "../rewrite/orchestrate";
import type { StreamTicketData } from "./ticket";

/**
 * Language: Tanglish. Speech-to-text writes Tamil words in Tamil script; Tanglish users type
 * Tamil in Latin letters ("naalaiku meeting irukku"). When the language is Tanglish and the
 * final transcript has Tamil script, one fast LLM pass converts it (templates/tanglish.md):
 * Tamil -> Latin letters, English stays, nothing translated. Live partials are left as is.
 * Any failure keeps the original text, so a dictation is never lost to this step.
 */
export type TranscriptPostprocess = (text: string, t: StreamTicketData) => Promise<string>;

export function createTanglishPass(opts: {
  /** Model order: the "fastest" preset (config). */
  models: () => Promise<string[]>;
  effortFor: (slug: string) => ReasoningEffort;
  complete: StreamCompletion;
  ttftMs?: number;
  totalMs?: number;
}): TranscriptPostprocess {
  return async (text, t) => {
    if (t.languageHint !== "tanglish" || !hasTamilScript(text)) return text;
    let out = "";
    try {
      for await (const ev of orchestrate({
        models: await opts.models(),
        messages: buildTanglish(text),
        effortFor: opts.effortFor,
        complete: opts.complete,
        ttftMs: opts.ttftMs ?? 1_500,
        totalMs: opts.totalMs ?? 3_000,
      })) {
        if (ev.event === "token") out += ev.data.text;
        if (ev.event === "error") return text;
      }
    } catch {
      return text;
    }
    return out.trim() || text;
  };
}
