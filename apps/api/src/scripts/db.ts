/* eslint-disable no-console -- CLI script */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { createDb } from "../lib/db/client";
import { seedPlans } from "../lib/db/seed";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

const command = process.argv[2];
const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const { db, close } = createDb(url, 1);
try {
  if (command === "migrate" || command === "setup") {
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    console.log("migrations applied");
  }
  if (command === "seed" || command === "setup") {
    await seedPlans(db);
    console.log("plans seeded");
  }
  if (!["migrate", "seed", "setup"].includes(command ?? "")) {
    console.error("usage: db.ts <migrate|seed|setup>");
    process.exitCode = 1;
  }
} finally {
  await close();
}
