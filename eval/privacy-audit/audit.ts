/* eslint-disable no-console -- CLI script */
/**
 * Privacy audit (T078). Procedure: privacy-audit/README.md.
 *
 *   pnpm --filter @sayvox/eval privacy:audit -- --project sayvox-staging \
 *     --dataset sayvox_analytics [--phrase "extra phrase"] [--freshness 1d] [--print-only]
 *
 * Needs gcloud, bq and psql on PATH with read access, and DATABASE_URL for the staging
 * database (read-only user recommended). Exits 1 if any canary is found or a source
 * couldn't be checked.
 */
import { parseArgs } from "node:util";
import { canaryFor, DEFAULT_PHRASES, normalisePhrases, summarise } from "./checks";
import { runAudit } from "./runner";

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    dataset: { type: "string" },
    phrase: { type: "string", multiple: true },
    freshness: { type: "string", default: "1d" },
    "print-only": { type: "boolean", default: false },
  },
});

const phrases = normalisePhrases([
  ...DEFAULT_PHRASES,
  canaryFor(new Date()),
  ...(values.phrase ?? []),
]);

if (values["print-only"]) {
  console.log("Dictate each of these (see README):");
  for (const p of phrases) console.log(`  ${p}`);
  process.exit(0);
}
if (!values.project) {
  console.error("--project is required (e.g. --project sayvox-staging)");
  process.exit(2);
}

console.log(`Searching for ${phrases.length} canary phrase(s) in ${values.project}…`);
const r = await runAudit({
  project: values.project,
  dataset: values.dataset,
  databaseUrl: process.env["DATABASE_URL"],
  phrases,
  freshness: values.freshness ?? "1d",
});
const { ok, lines } = summarise(r.hits, r.checked);
for (const l of lines) console.log(l);
for (const e of r.errors) console.error(`NOT CHECKED ${e}`);
const pass = ok && r.errors.length === 0;
console.log(pass ? "PASS: no canary phrase found anywhere." : "FAIL");
process.exit(pass ? 0 : 1);
