import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { schema } from "./schema";

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close: () => Promise<void>;
}

/**
 * One pool per instance; size kept small so all Cloud Run instances fit under the database
 * connection limit. `connectTimeoutMs` defaults to 5 s; scale-to-zero databases (AlloyDB
 * Express in staging takes ~20 s to wake) need it raised via DB_CONNECT_TIMEOUT_MS.
 */
export function createDb(
  connectionString: string,
  maxConnections = 5,
  connectTimeoutMs = Number(process.env["DB_CONNECT_TIMEOUT_MS"] ?? 5_000),
): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    max: maxConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: connectTimeoutMs,
  });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
