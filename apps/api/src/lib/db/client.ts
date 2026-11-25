import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { schema } from "./schema";

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close: () => Promise<void>;
}

/** One pool per instance; size kept small so all Cloud Run instances fit under the Cloud SQL limit. */
export function createDb(connectionString: string, maxConnections = 5): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    max: maxConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
