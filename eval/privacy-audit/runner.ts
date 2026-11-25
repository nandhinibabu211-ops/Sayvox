/**
 * Privacy audit runner (T078). See privacy-audit/README.md for the procedure.
 *
 *   pnpm --filter @sayvox/eval privacy:audit -- --project sayvox-staging \
 *     --dataset sayvox_analytics --phrase "canary 2026 11 25 saffron" [--freshness 1d]
 *
 * Needs gcloud, bq and psql on PATH, signed in with read access, and DATABASE_URL pointing
 * at the staging database (read-only user recommended). Exits 1 if any canary is found or a
 * source couldn't be checked.
 */
import { execFile } from "node:child_process";
import {
  bqArgs,
  bqSearchSql,
  bqTablesSql,
  loggingArgs,
  PG_COLUMNS_SQL,
  pgCountScript,
  type Exec,
  type Hit,
} from "./checks";

const exec: Exec = (cmd, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      // No shell: phrases and filters are passed as exact arguments.
      { maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) =>
        err ? reject(new Error(`${cmd}: ${stderr || err.message}`)) : resolve(stdout),
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
  });

export interface AuditOptions {
  project: string;
  dataset: string | undefined;
  databaseUrl: string | undefined;
  phrases: string[];
  freshness: string;
}

export async function runAudit(o: AuditOptions, run: Exec = exec) {
  const hits: Hit[] = [];
  const checked = { logging: 0, "error-reporting": 0, bigquery: 0, postgres: 0 };
  const errors: string[] = [];

  // Cloud Logging (all logs: API, client telemetry, Error Reporting's source entries).
  for (const phrase of o.phrases) {
    try {
      const entries = JSON.parse(
        (await run("gcloud", loggingArgs(o.project, phrase, o.freshness))) || "[]",
      ) as unknown[];
      checked.logging++;
      if (entries.length)
        hits.push({ source: "logging", where: "Cloud Logging", phrase, count: entries.length });
    } catch (e) {
      errors.push(`logging: ${(e as Error).message}`);
    }
  }

  // Error Reporting: group stats + events over the last day, searched as text.
  try {
    const token = (await run("gcloud", ["auth", "print-access-token"])).trim();
    const base = `https://clouderrorreporting.googleapis.com/v1beta1/projects/${o.project}`;
    const get = async (path: string) => {
      const res = await fetch(`${base}/${path}`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`error reporting HTTP ${res.status}`);
      return res.json() as Promise<Record<string, unknown>>;
    };
    const stats = await get("groupStats?timeRange.period=PERIOD_1_DAY&pageSize=100");
    const groups = (stats["errorGroupStats"] as { group: { groupId: string } }[] | undefined) ?? [];
    for (const g of groups) {
      const events = JSON.stringify(
        await get(
          `events?groupId=${encodeURIComponent(g.group.groupId)}&timeRange.period=PERIOD_1_DAY&pageSize=100`,
        ),
      ).toLowerCase();
      checked["error-reporting"]++;
      for (const phrase of o.phrases) {
        const n = events.split(phrase).length - 1;
        if (n)
          hits.push({
            source: "error-reporting",
            where: `group ${g.group.groupId}`,
            phrase,
            count: n,
          });
      }
    }
  } catch (e) {
    errors.push(`error-reporting: ${(e as Error).message}`);
  }

  // BigQuery: every table in the analytics dataset (log sink output).
  if (o.dataset) {
    try {
      const tables = (
        JSON.parse(await run("bq", bqArgs(o.project, bqTablesSql(o.project, o.dataset)))) as {
          table_name: string;
        }[]
      ).map((t) => t.table_name);
      for (const table of tables) {
        for (const phrase of o.phrases) {
          const rows = JSON.parse(
            await run("bq", bqArgs(o.project, bqSearchSql(o.project, o.dataset, table), phrase)),
          ) as { n: string }[];
          const n = Number(rows[0]?.n ?? 0);
          if (n)
            hits.push({ source: "bigquery", where: `${o.dataset}.${table}`, phrase, count: n });
        }
        checked.bigquery++;
      }
    } catch (e) {
      errors.push(`bigquery: ${(e as Error).message}`);
    }
  } else errors.push("bigquery: no --dataset given");

  // Postgres: every text-like column.
  if (o.databaseUrl) {
    try {
      const cols = (await run("psql", [o.databaseUrl, "-At", "-c", PG_COLUMNS_SQL]))
        .split(/\r?\n/)
        .filter(Boolean);
      for (const col of cols) {
        const [table, column] = col.split(".") as [string, string];
        for (const phrase of o.phrases) {
          const out = await run(
            "psql",
            [o.databaseUrl, "-At", "-v", `phrase=${phrase}`, "-f", "-"],
            pgCountScript(table, column),
          );
          const n = Number(out.trim() || 0);
          if (n) hits.push({ source: "postgres", where: col, phrase, count: n });
        }
        checked.postgres++;
      }
    } catch (e) {
      errors.push(`postgres: ${(e as Error).message}`);
    }
  } else errors.push("postgres: DATABASE_URL not set");

  return { hits, checked, errors };
}
