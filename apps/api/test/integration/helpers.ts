import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { createDb, type DbHandle } from "../../src/lib/db/client";
import { seedPlans } from "../../src/lib/db/seed";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

export interface PgFixture {
  container: StartedPostgreSqlContainer;
  handle: DbHandle;
  stop: () => Promise<void>;
}

export async function startPostgres(): Promise<PgFixture> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const handle = createDb(container.getConnectionUri(), 3);
  await migrate(handle.db, { migrationsFolder: MIGRATIONS });
  await seedPlans(handle.db);
  return {
    container,
    handle,
    stop: async () => {
      await handle.close();
      await container.stop();
    },
  };
}

export async function startRedis(): Promise<StartedRedisContainer> {
  return new RedisContainer("redis:7-alpine").start();
}
