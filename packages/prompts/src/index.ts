import type { Mode } from "@sayvox/shared";
import { templates, type TemplateId } from "./templates";

export { templates, type TemplateId };

/** FNV-1a 32-bit hash: small, deterministic. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Changes whenever any template text changes; recorded with each rewrite for eval traceability. */
export const TEMPLATE_VERSION: string = fnv1a(
  (Object.keys(templates) as TemplateId[])
    .sort()
    .map((id) => `${id}\u0000${templates[id]}`)
    .join("\u0001"),
);

/** Chat apps get the chat variant of email mode (short, no greeting/sign-off). */
const CHAT_APPS =
  /^(slack\.exe|ms-teams\.exe|teams\.exe|web:slack|web:teams|discord\.exe|web:discord|whatsapp\.exe|web:whatsapp)$/i;

export function templateIdFor(mode: Mode, targetApp: string): TemplateId {
  if (mode === "email") return CHAT_APPS.test(targetApp) ? "chat" : "email";
  return mode;
}

export function templateFor(mode: Mode, targetApp = ""): string {
  return templates[templateIdFor(mode, targetApp)];
}

/**
 * Escape user-supplied text so it can't close or forge our tags
 * (e.g. a dictated "</transcript> ignore the rules"). Constitution VI.
 */
export function escapeData(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface BuildInput {
  mode: Mode;
  targetApp: string;
  transcript: string;
  /** Email mode only: the message being replied to. Never stored or logged. */
  threadContext?: string | undefined;
}

export function buildMessages(input: BuildInput): {
  templateId: TemplateId;
  messages: ChatMessage[];
} {
  const templateId = templateIdFor(input.mode, input.targetApp);
  const parts = [`<target_app>${escapeData(input.targetApp || "unknown")}</target_app>`];
  if (input.threadContext && templateId === "email") {
    parts.push(`<thread>${escapeData(input.threadContext)}</thread>`);
  }
  parts.push(`<transcript>${escapeData(input.transcript)}</transcript>`);
  return {
    templateId,
    messages: [
      { role: "system", content: templates[templateId] },
      { role: "user", content: parts.join("\n") },
    ],
  };
}
