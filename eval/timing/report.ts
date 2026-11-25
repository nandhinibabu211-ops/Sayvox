/* eslint-disable no-console -- CLI script */
/**
 * Phase 1 gate report (T040).
 *   pnpm --filter @sayvox/eval timing:report [path/to/timings.jsonl]
 * Default input: %APPDATA%\app.sayvox.desktop\timings.jsonl (written by debug builds).
 * Writes eval/results/phase1-<date>.json and prints pass/fail. Contains numbers only.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, release } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gate, parseJsonl } from "./stats";

const input =
  process.argv[2] ?? join(process.env["APPDATA"] ?? ".", "app.sayvox.desktop", "timings.jsonl");

let text: string;
try {
  text = readFileSync(input, "utf8");
} catch {
  console.error(`No timing log at ${input}. Run a debug build and dictate the 20 phrases first.`);
  process.exit(1);
}

const report = gate(parseJsonl(text));
const out = {
  date: new Date().toISOString(),
  gate: "Phase 1: plain dictation release → inserted < 1 s on 20 phrases",
  environment: { os: `Windows ${release()}`, cpu: cpus()[0]?.model ?? "unknown" },
  ...report,
};

const resultsDir = fileURLToPath(new URL("../results", import.meta.url));
mkdirSync(resultsDir, { recursive: true });
const file = join(resultsDir, `phase1-${out.date.slice(0, 10)}.json`);
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);

console.log(
  `${report.pass ? "PASS" : "FAIL"}  ${report.phrases}/${report.required} phrases · ` +
    `release→insert p50 ${report.releaseToInsert.p50} ms, p95 ${report.releaseToInsert.p95} ms, ` +
    `max ${report.releaseToInsert.max} ms · over budget ${report.overBudget} · failures ${report.failures}`,
);
console.log(`Saved ${file}`);
process.exit(report.pass ? 0 : 2);
