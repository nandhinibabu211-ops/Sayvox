/**
 * Local dictation cleanup (Story 3.5 / T036): the fast path that needs no LLM.
 * Scribe already punctuates, so these rules are deliberately conservative: they remove
 * hesitation fillers, apply explicit self-corrections, fix casing and end punctuation, and
 * restore custom-dictionary casing. They never reword.
 */

const FILLER_WORD = "(?:u+m+|u+h+|e+r+m+|u+h+m+|h+m+|m+h+m+)";
/** Pure hesitation sounds: always removable. */
const HESITATION = new RegExp(String.raw`(^|[\s,.;!?])${FILLER_WORD}(?=$|[\s,.;!?])[,.]?`, "gi");
/** "word, um, next": drop the filler and its comma pair... */
const COMMA_PAIR_FILLER = new RegExp(String.raw`(\S+),\s*${FILLER_WORD}\s*,`, "gi");
/** ...but keep the comma after an opening word ("So, uh, the build" -> "So, the build"). */
const INTRO_WORDS = new Set(["so", "well", "okay", "ok", "yes", "no", "and", "but", "now"]);

/** "you know" / "like" only when set off by commas, or "you know," leading a sentence. */
const COMMA_FILLERS = [
  /,\s*(?:you know|like)\s*,/gi, // "is, you know, slow" -> "is slow" (comma pair removed)
  /(^\s*|[.!?]\s+)you know,\s*/gi, // "You know, the API" -> "The API"
];

/** Correction markers: "X <marker> Y" means "replace X with Y". */
const MARKERS = [
  /,?\s*\bno,?\s+wait\b,?\s*/i,
  /,?\s*\bsorry,?\s+i\s+mean\b,?\s*/i,
  /,?\s*\bactually,?\s+no\b,?\s*/i,
];
/** Longer replacements are ambiguous (where does X start?), so leave the text unchanged. */
const MAX_REPLACEMENT_WORDS = 4;

function removeFillers(text: string): string {
  let t = text.replace(COMMA_PAIR_FILLER, (_m, word: string, offset: number, all: string) => {
    const before = all.slice(0, offset).trimEnd();
    const sentenceStart = before === "" || /[.!?]$/.test(before);
    const intro = sentenceStart && INTRO_WORDS.has(word.toLowerCase().replace(/[^a-z]/g, ""));
    return intro ? `${word},` : word;
  });
  t = t.replace(HESITATION, (_m, lead: string) => lead);
  t = t.replace(COMMA_FILLERS[0]!, " ");
  t = t.replace(COMMA_FILLERS[1]!, (_m, lead: string) => lead);
  return t;
}

function applyCorrections(text: string): string {
  // Work clause by clause so a correction never reaches across a sentence.
  return text.replace(/[^.!?]+[.!?]*/g, (clause) => {
    for (let guard = 0; guard < 3; guard++) {
      const hit = MARKERS.map((re) => re.exec(clause)).find((m) => m !== null);
      if (!hit) break;
      const before = clause.slice(0, hit.index);
      const afterFull = clause.slice(hit.index + hit[0].length);
      const tailPunct = /[.!?]+\s*$/.exec(afterFull)?.[0] ?? "";
      const after = afterFull.slice(0, afterFull.length - tailPunct.length);
      const repl = after.trim().split(/\s+/).filter(Boolean);
      if (repl.length === 0 || repl.length > MAX_REPLACEMENT_WORDS) break;

      // Replacement may restate a leading preposition ("to Priya, no wait, to Arun").
      const beforeWords = before.trim().split(/\s+/).filter(Boolean);
      // Count only the words the replacement is swapping; trailing words after the corrected
      // phrase ("Tuesday please") are kept: assume the first replacement word maps onto the
      // last `k` words before the marker, where k = number of replacement words that look
      // like the corrected item (numbers/units/names), capped at the replacement length.
      const n = swapLength(repl, beforeWords);
      const k = Math.min(n, beforeWords.length);
      if (k === 0) break;
      const kept = beforeWords.slice(0, beforeWords.length - k);
      clause = [...kept, ...repl].join(" ") + tailPunct;
    }
    return clause;
  });
}

/**
 * How many replacement words replace the same number of words before the marker.
 * A trailing politeness/filler word ("please", "thanks") stays as a continuation.
 */
function swapLength(repl: string[], before: string[]): number {
  const trailing = new Set(["please", "thanks", "okay", "ok", "then"]);
  let n = repl.length;
  while (n > 1 && trailing.has(repl[n - 1]!.toLowerCase().replace(/[^a-z]/g, ""))) n--;
  // "40 actually no 45 rupees": the unit wasn't said before the marker, so only the number
  // is swapped. "3 pm sorry I mean 4 pm": the unit was said, so both words are swapped.
  if (n === 2 && /^\d/.test(repl[0]!) && !/^\d/.test(repl[1]!)) {
    const lastBefore = (before[before.length - 1] ?? "").toLowerCase();
    return lastBefore === repl[1]!.toLowerCase() ? 2 : 1;
  }
  return n;
}

function tidy(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:])(?=\S)/g, "$1 ")
    .replace(/([,;:])\s*([.!?])/g, "$2")
    .replace(/,\s*,+/g, ",")
    .replace(/^[\s,.;:]+/, "")
    .trim();
}

function caseAndPunctuate(text: string): string {
  if (!text) return "";
  let t = text.replace(/\bi\b/g, "I");
  t = t.replace(/(^|[.!?]\s+)([a-z])/g, (_m, lead: string, c: string) => lead + c.toUpperCase());
  if (!/[.!?…"')\]]$/.test(t)) t += ".";
  return t;
}

function applyDictionary(text: string, terms: readonly string[]): string {
  let t = text;
  for (const term of terms) {
    if (!term.trim()) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`(?<![\\w])${escaped}(?![\\w])`, "gi"), term);
  }
  return t;
}

export function cleanup(raw: string, dictionary: readonly string[] = []): string {
  let t = tidy(removeFillers(` ${raw} `));
  if (!/[a-z0-9]/i.test(t)) return "";
  t = tidy(applyCorrections(t));
  t = caseAndPunctuate(t);
  // Dictionary last so its casing wins over sentence-casing, except at a sentence start.
  t = applyDictionary(t, dictionary);
  return t.replace(/(^|[.!?]\s+)([a-z])/g, (_m, lead: string, c: string) => lead + c.toUpperCase());
}
