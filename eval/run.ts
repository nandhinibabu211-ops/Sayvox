/* eslint-disable no-console -- CLI script */
/**
 * Quality + timing eval (Story 4.2 / 4.3 / 4.4, T057/T058).
 *
 *   OPENROUTER_API_KEY=… pnpm --filter @sayvox/eval quality [--models a,b] [--judge] [--cases id1,id2]
 *
 * For each model: run every case through the production prompt (buildMessages) and request
 * shape, score with the rule checks, optionally the LLM judge (absolute, and pairwise when a
 * Lemon baseline exists in eval/baselines/lemon/<id>.txt), and report TTFT/total latency.
 * Writes eval/results/quality-<date>.json. Exit 0 = gate passed for every model.
 * Uses provider routing that neither trains on nor retains prompts.
 */
import { buildMessages } from "@sayvox/prompts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "./dataset/cases";
import { judgeAbsolute, judgePairwise, type AbsoluteScore, type Pairwise } from "./scorer/judge";
import { complete } from "./scorer/openrouter";
import { ruleGate, scoreCase, type CaseScore } from "./scorer/rules";
import { percentile } from "./timing/stats";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const apiKey = process.env["OPENROUTER_API_KEY"];
if (!apiKey) {
  console.error("Set OPENROUTER_API_KEY (use a low-limit eval key).");
  process.exit(1);
}
const models = (arg("models") ?? "anthropic/claude-haiku-5.5,openai/gpt-6-luna").split(",");
const useJudge = process.argv.includes("--judge");
const only = arg("cases")?.split(",");
const cases = only ? CASES.filter((c) => only.includes(c.id)) : CASES;
const here = fileURLToPath(new URL(".", import.meta.url));
const baseline = (id: string) => {
  const f = join(here, "baselines", "lemon", `${id}.txt`);
  return existsSync(f) ? readFileSync(f, "utf8").trim() : undefined;
};

interface ModelReport {
  model: string;
  gate: ReturnType<typeof ruleGate>;
  judge?: { faithfulness: number; format: number; tone: number };
  vsLemon?: { wins: number; ties: number; losses: number; compared: number };
  latency: { ttftP50: number; ttftP95: number; totalP50: number; totalP95: number };
  errors: string[];
  cases: (CaseScore & { output: string; absolute?: AbsoluteScore; pairwise?: Pairwise })[];
}

const reports: ModelReport[] = [];
for (const model of models) {
  const rows: ModelReport["cases"] = [];
  const ttft: number[] = [];
  const total: number[] = [];
  const errors: string[] = [];
  for (const c of cases) {
    const { messages } = buildMessages({
      mode: c.mode,
      targetApp: c.targetApp,
      transcript: c.transcript,
    });
    try {
      const r = await complete(model, messages, { apiKey });
      ttft.push(r.ttftMs);
      total.push(r.totalMs);
      const row: ModelReport["cases"][number] = { ...scoreCase(c, r.text), output: r.text };
      if (useJudge) {
        row.absolute = await judgeAbsolute(c, r.text, apiKey);
        const base = baseline(c.id);
        if (base) row.pairwise = await judgePairwise(c, r.text, base, apiKey);
      }
      rows.push(row);
      process.stdout.write(row.failures.length ? "x" : ".");
    } catch (err) {
      errors.push(`${c.id}: ${(err as Error).message}`);
      process.stdout.write("E");
    }
  }
  console.log(` ${model}`);
  const avg = (k: keyof AbsoluteScore) => {
    const v = rows.flatMap((r) => (r.absolute ? [r.absolute[k]] : []));
    return v.length
      ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100
      : Number.NaN;
  };
  const pw = rows.flatMap((r) => (r.pairwise ? [r.pairwise] : []));
  reports.push({
    model,
    gate: ruleGate(rows),
    ...(useJudge
      ? { judge: { faithfulness: avg("faithfulness"), format: avg("format"), tone: avg("tone") } }
      : {}),
    ...(pw.length
      ? {
          vsLemon: {
            wins: pw.filter((p) => p === "candidate").length,
            ties: pw.filter((p) => p === "tie").length,
            losses: pw.filter((p) => p === "baseline").length,
            compared: pw.length,
          },
        }
      : {}),
    latency: {
      ttftP50: percentile(ttft, 50),
      ttftP95: percentile(ttft, 95),
      totalP50: percentile(total, 50),
      totalP95: percentile(total, 95),
    },
    errors,
    cases: rows,
  });
}

const resultsDir = join(here, "results");
mkdirSync(resultsDir, { recursive: true });
const date = new Date().toISOString();
const file = join(resultsDir, `quality-${date.slice(0, 10)}.json`);
// Results hold model outputs for SYNTHETIC cases only; never run this on real user text.
writeFileSync(file, `${JSON.stringify({ date, cases: cases.length, reports }, null, 2)}\n`);

let ok = true;
for (const r of reports) {
  const lemonOk = !r.vsLemon || r.vsLemon.wins + r.vsLemon.ties >= r.vsLemon.losses;
  const judgeOk = !r.judge || r.judge.faithfulness >= 4;
  const pass = r.gate.pass && lemonOk && judgeOk && r.errors.length === 0;
  ok &&= pass;
  console.log(
    `${pass ? "PASS" : "FAIL"} ${r.model}: rules ${(r.gate.rulePassRate * 100).toFixed(1)}%, injection failures ${r.gate.injectionFailures.length}` +
      (r.judge ? `, judge F/Fmt/T ${r.judge.faithfulness}/${r.judge.format}/${r.judge.tone}` : "") +
      (r.vsLemon ? `, vs Lemon ${r.vsLemon.wins}W/${r.vsLemon.ties}T/${r.vsLemon.losses}L` : "") +
      `, TTFT p50/p95 ${r.latency.ttftP50}/${r.latency.ttftP95} ms, total p95 ${r.latency.totalP95} ms` +
      (r.errors.length ? `, ${r.errors.length} errors` : ""),
  );
}
console.log(`Saved ${file}`);
process.exit(ok ? 0 : 2);
