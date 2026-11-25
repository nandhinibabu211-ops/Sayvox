import type { Mode } from "@sayvox/shared";
import { templates } from "./templates";

export { templates };

/** FNV-1a 32-bit hash: small, deterministic, no Node-only APIs. */
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
  (Object.keys(templates) as Mode[])
    .sort()
    .map((m) => `${m}\u0000${templates[m]}`)
    .join("\u0001"),
);

export function templateFor(mode: Mode): string {
  return templates[mode];
}
