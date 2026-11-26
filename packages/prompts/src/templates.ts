import { readFileSync } from "node:fs";

/**
 * System prompts (Story 3.1, T046/T047). The text lives in `templates/*.md` so prompt
 * changes are reviewed as prose and gated by the eval set (Constitution V).
 * Each template is the mode text followed by the shared rules: a fixed string with no
 * interpolation, sent first in every request so providers can cache it.
 *
 * Server-side only (reads files with node:fs); the desktop app never imports this.
 */

export type TemplateId = "dictation" | "prompt" | "email" | "chat" | "translate" | "tanglish";

function load(name: string): string {
  return readFileSync(new URL(`./templates/${name}.md`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .trim();
}

const SHARED_RULES = load("shared-rules");
/** Every mode except translate (whose job is changing the language) and the Tanglish pass. */
const KEEP_LANGUAGE = load("keep-language");
const keep = (name: string) => `${load(name)}\n\n${SHARED_RULES}\n${KEEP_LANGUAGE}`;

export const templates: Readonly<Record<TemplateId, string>> = Object.freeze({
  dictation: keep("dictation"),
  prompt: keep("prompt"),
  email: keep("email"),
  chat: keep("chat"),
  translate: `${load("translate")}\n\n${SHARED_RULES}`,
  /** Not a mode: the Tanglish script pass on speech-to-text output (languageHint tanglish). */
  tanglish: `${load("tanglish")}\n\n${SHARED_RULES}`,
});
