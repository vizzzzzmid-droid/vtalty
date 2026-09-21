import { buildApp } from "./app.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { loadEnv } from "./env.js";
import { logger } from "./lib/logger.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, close } = createDb(env.DATABASE_URL);

  // Migrations run on every start (fail fast on DB errors).
  await runMigrations(db);

  const app = await buildApp({ env, db });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    await app.close();
    await close();
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: env.HOST, port: env.PORT });
}

try {
  await main();
} catch (err) {
  logger.fatal({ err }, "server failed to start");
  process.exit(1);
}
