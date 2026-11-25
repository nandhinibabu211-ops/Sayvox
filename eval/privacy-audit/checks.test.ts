import { describe, expect, it } from "vitest";
import { runAudit } from "./runner";
import {
  bqSearchSql,
  canaryFor,
  loggingFilter,
  normalisePhrases,
  pgCountScript,
  summarise,
  type Exec,
} from "./checks";

describe("privacy audit queries (T078)", () => {
  it("normalises phrases and makes a dated canary", () => {
    expect(
      normalisePhrases(["  Purple  Walrus Invoice ", "purple walrus invoice", "short"]),
    ).toEqual(["purple walrus invoice"]);
    expect(canaryFor(new Date("2026-11-25T12:00:00Z"))).toBe("canary 2026 11 25 saffron");
  });

  it("escapes quotes in the logging filter", () => {
    expect(loggingFilter('say "hi"')).toBe('SEARCH("say \\"hi\\"")');
  });

  it("refuses identifiers that could inject SQL", () => {
    expect(bqSearchSql("p", "d", "events")).toContain("`p.d.events`");
    expect(() => bqSearchSql("p", "d", "x` OR 1=1 --")).toThrow();
    expect(() => pgCountScript('users"; drop table users; --', "email")).toThrow();
    expect(pgCountScript("users", "email")).toContain(":'phrase'");
  });

  it("summarises hits and clean sources", () => {
    const r = summarise(
      [
        {
          source: "postgres",
          where: "sessions.target_app",
          phrase: "purple walrus invoice",
          count: 1,
        },
      ],
      { logging: 3, "error-reporting": 0, bigquery: 2, postgres: 9 },
    );
    expect(r.ok).toBe(false);
    expect(r.lines.find((l) => l.startsWith("FAIL"))).toContain("sessions.target_app");
    expect(r.lines.filter((l) => l.startsWith("ok"))).toHaveLength(3);
  });
});

describe("runAudit with fake tools", () => {
  it("finds a canary in Postgres and reports unchecked sources", async () => {
    const run: Exec = async (cmd, args, stdin) => {
      if (cmd === "gcloud" && args[0] === "logging") return "[]";
      if (cmd === "gcloud") throw new Error("not signed in");
      if (cmd === "psql" && args.includes("-c")) return "dictionary_terms.term\nusers.email\n";
      if (cmd === "psql") return stdin?.includes('"term"') ? "1\n" : "0\n";
      throw new Error(`unexpected ${cmd}`);
    };
    const r = await runAudit(
      {
        project: "sayvox-staging",
        dataset: undefined,
        databaseUrl: "postgres://ro@localhost/sayvox",
        phrases: ["purple walrus invoice"],
        freshness: "1d",
      },
      run,
    );
    expect(r.hits).toEqual([
      {
        source: "postgres",
        where: "dictionary_terms.term",
        phrase: "purple walrus invoice",
        count: 1,
      },
    ]);
    expect(r.checked).toMatchObject({ logging: 1, postgres: 2 });
    expect(r.errors.map((e) => e.split(":")[0])).toEqual(["error-reporting", "bigquery"]);
  });
});
