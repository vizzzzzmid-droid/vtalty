import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb, type Db } from "./client.js";
import { loadEnv } from "../env.js";
import { logger } from "../lib/logger.js";

// Resolves to apps/server/migrations both when running from src (tsx) and
// from dist (node), because tsc preserves the src/db -> dist/db layout.
export function migrationsFolder(): string {
  return fileURLToPath(new URL("../../migrations", import.meta.url));
}

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsFolder() });
}

// Standalone runner: `pnpm migrate` and `make migrate`.
const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const env = loadEnv();
  const { db, close } = createDb(env.DATABASE_URL);
  try {
    await runMigrations(db);
    logger.info("migrations applied");
  } finally {
    await close();
  }
}
