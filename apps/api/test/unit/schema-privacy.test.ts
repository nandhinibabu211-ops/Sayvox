import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { schema } from "../../src/lib/db/schema";

// Constitution I / Story 2.1 AC 2: no column may hold user speech or generated text.
const FORBIDDEN = /transcript|rewrite|partial|thread|content|body|text|message/i;

describe("schema privacy guard", () => {
  for (const table of Object.values(schema)) {
    it(`${getTableName(table)} has no text-content columns`, () => {
      const names = Object.values(getTableColumns(table)).map((c) => c.name);
      expect(names.filter((n) => FORBIDDEN.test(n))).toEqual([]);
    });
  }
});
