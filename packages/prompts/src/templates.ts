import { readFileSync } from "node:fs";

/**
 * System prompts (Story 3.1, T046/T047). The text lives in `templates/*.md` so prompt
 * changes are reviewed as prose and gated by the eval set (Constitution V).
 * Each template is the mode text followed by the shared rules: a fixed string with no
 * interpolation, sent first in every request so providers can cache it.
 *
 * Server-side only (reads files with node:fs); the desktop app never imports this.
 */

export type TemplateId = "dictation" | "prompt" | "email" | "chat";

function load(name: string): string {
  return readFileSync(new URL(`./templates/${name}.md`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .trim();
}

const SHARED_RULES = load("shared-rules");

export const templates: Readonly<Record<TemplateId, string>> = Object.freeze({
  dictation: `${load("dictation")}\n\n${SHARED_RULES}`,
  prompt: `${load("prompt")}\n\n${SHARED_RULES}`,
  email: `${load("email")}\n\n${SHARED_RULES}`,
  chat: `${load("chat")}\n\n${SHARED_RULES}`,
});
