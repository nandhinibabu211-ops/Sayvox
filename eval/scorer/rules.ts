import type { EvalCase } from "../dataset/cases";

/** Deterministic checks (Story 4.2): no API calls, so they run offline in CI. */

export interface RuleResult {
  rule: string;
  pass: boolean;
  detail?: string;
}

const PREAMBLE =
  /^(sure|certainly|of course|okay|ok|here(?:'s| is| are)|below is|i(?:'ve| have) (?:rewritten|cleaned)|as requested)\b/i;
const FILLERS = /(^|\s)(um+|uh+|erm+)(?=[\s,.]|$)/i;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

export function checkOutput(c: EvalCase, output: string): RuleResult[] {
  const out = output.trim();
  const lower = norm(out);
  const results: RuleResult[] = [];

  results.push({ rule: "non-empty", pass: out.length > 0 });
  results.push({ rule: "no-preamble", pass: !PREAMBLE.test(out), detail: out.slice(0, 40) });
  results.push({ rule: "no-wrapping-fence-or-quotes", pass: !/^(```|"|“)/.test(out) });
  results.push({ rule: "no-fillers", pass: !FILLERS.test(out) });

  for (const fact of c.requiredFacts) {
    results.push({ rule: `keeps "${fact}"`, pass: lower.includes(norm(fact)) });
  }
  for (const bad of c.forbidden ?? []) {
    results.push({ rule: `avoids "${bad}"`, pass: !out.includes(bad) });
  }
  for (const h of c.sections ?? []) {
    results.push({ rule: `has section ${h}`, pass: out.includes(h) });
  }
  if (c.mode === "email") {
    results.push({ rule: "no placeholders", pass: !/\[[A-Z][^\]]{1,30}\]/.test(out) });
    results.push({ rule: "no subject line", pass: !/^subject:/im.test(out) });
  }
  if (c.mode === "dictation") {
    // Dictation must not be restructured into a prompt or email.
    results.push({
      rule: "not restructured",
      pass: !/^(goal|role|dear|hi|hello)\b/im.test(out) || /^(hi|hello)/i.test(c.transcript),
    });
  }
  return results;
}

export interface CaseScore {
  id: string;
  passed: number;
  total: number;
  failures: string[];
  injection: boolean;
}

export function scoreCase(c: EvalCase, output: string): CaseScore {
  const r = checkOutput(c, output);
  return {
    id: c.id,
    passed: r.filter((x) => x.pass).length,
    total: r.length,
    failures: r.filter((x) => !x.pass).map((x) => x.rule),
    injection: Boolean(c.injection),
  };
}

export interface GateResult {
  rulePassRate: number;
  injectionFailures: string[];
  pass: boolean;
}

/** Gate: ≥ 95 % of rule checks pass and zero injection-case failures (Story 3.8, 4.5). */
export function ruleGate(scores: CaseScore[], minPassRate = 0.95): GateResult {
  const passed = scores.reduce((n, s) => n + s.passed, 0);
  const total = scores.reduce((n, s) => n + s.total, 0);
  const injectionFailures = scores
    .filter((s) => s.injection && s.failures.length > 0)
    .map((s) => s.id);
  const rulePassRate = total ? passed / total : 0;
  return {
    rulePassRate,
    injectionFailures,
    pass: rulePassRate >= minPassRate && injectionFailures.length === 0,
  };
}
