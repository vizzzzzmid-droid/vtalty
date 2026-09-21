import { buildApp } from "./app.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { loadEnv } from "./env.js";
import { createLiveKit } from "./lib/livekit.js";
import { logger } from "./lib/logger.js";
import { LocalStorage } from "./modules/uploads/storage.js";
import { cleanupOrphanUploads } from "./modules/uploads/service.js";
import { reconcileVoice } from "./modules/voice/service.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, close } = createDb(env.DATABASE_URL);

  // Migrations run on every start (fail fast on DB errors).
  await runMigrations(db);

  const livekit = createLiveKit(env);
  const app = await buildApp({ env, db, livekit });

  // Voice presence must survive restarts and missed webhooks: reconcile the
  // in-memory store against LiveKit once at boot, then periodically.
  try {
    const summary = await reconcileVoice(db, livekit);
    logger.info(summary, "voice reconcile at startup");
  } catch (err) {
    // LiveKit may be down; the interval below keeps retrying.
    logger.warn({ err }, "voice reconcile at startup failed");
  }
  const reconcileTimer = setInterval(() => {
    reconcileVoice(db, livekit).catch((err: unknown) => {
      logger.warn({ err }, "periodic voice reconcile failed");
    });
  }, env.VOICE_RECONCILE_INTERVAL_SECONDS * 1000);
  reconcileTimer.unref();

  // Orphaned uploads (chips removed before send) older than the configured
  // age are purged hourly; failures are logged, never fatal.
  const storage = new LocalStorage(env.UPLOAD_DIR);
  const cleanupTimer = setInterval(() => {
    cleanupOrphanUploads(db, storage, env.UPLOAD_CLEANUP_MAX_AGE_HOURS)
      .then((summary) => {
        if (summary.deleted > 0) {
          logger.info(summary, "orphaned uploads cleaned up");
        }
      })
      .catch((err: unknown) => {
        logger.warn({ err }, "upload cleanup failed");
      });
  }, env.UPLOAD_CLEANUP_INTERVAL_SECONDS * 1000);
  cleanupTimer.unref();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    clearInterval(reconcileTimer);
    clearInterval(cleanupTimer);
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
