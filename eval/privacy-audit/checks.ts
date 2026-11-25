/**
 * Privacy audit (T078, Constitution I): after dictating canary phrases on staging, search
 * every place Sayvox writes data for any trace of them. Expected result: zero hits.
 *
 * Sources: Cloud Logging (which also feeds Error Reporting and the BigQuery sink), Error
 * Reporting events, every BigQuery table in the analytics dataset, and every text-like
 * column in Postgres. Pure query builders live here; `audit.ts` runs them.
 */

export interface Hit {
  source: "logging" | "error-reporting" | "bigquery" | "postgres";
  where: string;
  phrase: string;
  count: number;
}

/** Commands run via the user's gcloud / bq / psql (no credentials handled here). */
export type Exec = (cmd: string, args: string[], stdin?: string) => Promise<string>;

/**
 * Canary words: unusual enough to never appear by chance, easy to say. Each run also
 * dictates `canaryFor(date)` so old runs can't produce false passes.
 */
export const DEFAULT_PHRASES = [
  "purple walrus invoice",
  "tangerine lighthouse budget",
  "seventeen marmalade tickets",
];

export function canaryFor(date: Date): string {
  const d = date.toISOString().slice(0, 10).replaceAll("-", " ");
  return `canary ${d} saffron`;
}

/** Normalised search terms: the words of each phrase, lower case, single spaces. */
export function normalisePhrases(phrases: readonly string[]): string[] {
  return [...new Set(phrases.map((p) => p.trim().toLowerCase().replace(/\s+/g, " ")))].filter(
    (p) => p.length >= 8,
  );
}

// ── Cloud Logging ────────────────────────────────────────────────────────

/** Logging query language: SEARCH() matches the phrase anywhere in the entry. */
export function loggingFilter(phrase: string): string {
  return `SEARCH("${phrase.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}")`;
}

export function loggingArgs(project: string, phrase: string, freshness: string): string[] {
  return [
    "logging",
    "read",
    loggingFilter(phrase),
    `--project=${project}`,
    `--freshness=${freshness}`,
    "--format=json",
    "--limit=20",
  ];
}

// ── BigQuery ─────────────────────────────────────────────────────────────

const IDENT = /^[A-Za-z0-9_-]+$/;

export function assertIdent(kind: string, v: string): string {
  if (!IDENT.test(v)) throw new Error(`invalid ${kind}: ${v}`);
  return v;
}

export function bqTablesSql(project: string, dataset: string): string {
  return `SELECT table_name FROM \`${assertIdent("project", project)}.${assertIdent("dataset", dataset)}.INFORMATION_SCHEMA.TABLES\``;
}

/** SEARCH over the whole row (all columns, nested JSON included). Phrase is a parameter. */
export function bqSearchSql(project: string, dataset: string, table: string): string {
  return `SELECT COUNT(*) AS n FROM \`${assertIdent("project", project)}.${assertIdent("dataset", dataset)}.${assertIdent("table", table)}\` AS t WHERE SEARCH(t, @phrase)`;
}

export function bqArgs(project: string, sql: string, phrase?: string): string[] {
  return [
    "query",
    `--project_id=${project}`,
    "--nouse_legacy_sql",
    "--format=json",
    ...(phrase === undefined ? [] : [`--parameter=phrase:STRING:${phrase}`]),
    sql,
  ];
}

// ── Postgres ─────────────────────────────────────────────────────────────

/** Every text-like column in the app schema. */
export const PG_COLUMNS_SQL = `SELECT table_name || '.' || column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND data_type IN ('text', 'character varying', 'character', 'json', 'jsonb', 'ARRAY', 'USER-DEFINED')
ORDER BY 1;`;

/**
 * psql script counting rows whose column contains the phrase. The phrase is passed with
 * `-v phrase=…` and quoted by psql (`:'phrase'`), so it can't inject SQL.
 */
export function pgCountScript(table: string, column: string): string {
  const t = assertIdent("table", table);
  const c = assertIdent("column", column);
  return `SELECT count(*) FROM "${t}" WHERE lower("${c}"::text) LIKE '%' || lower(:'phrase') || '%';\n`;
}

// ── Result ───────────────────────────────────────────────────────────────

export function summarise(
  hits: Hit[],
  checked: Record<Hit["source"], number>,
): {
  ok: boolean;
  lines: string[];
} {
  const lines = (Object.keys(checked) as Hit["source"][]).map((s) => {
    const found = hits.filter((h) => h.source === s);
    return found.length
      ? `FAIL ${s}: ${found.map((h) => `${h.where} (${h.count}× "${h.phrase}")`).join(", ")}`
      : `ok   ${s}: ${checked[s]} location(s) checked, no canary found`;
  });
  return { ok: hits.length === 0, lines };
}
