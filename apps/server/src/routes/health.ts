import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { APP_NAME, APP_VERSION } from "@vitality/shared";
import type { Db } from "../db/client.js";

export interface HealthDeps {
  db: Db;
}

function livenessBody() {
  return { status: "ok", service: `${APP_NAME}-server`, version: APP_VERSION };
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get("/healthz", async () => livenessBody());
  app.get("/api/v1/health", async () => livenessBody());

  const readiness = async () => {
    await deps.db.execute(sql`SELECT 1`);
    return { status: "ready", service: `${APP_NAME}-server`, version: APP_VERSION };
  };

  app.get("/readyz", async (request, reply) => {
    try {
      return await readiness();
    } catch (err) {
      request.log.error({ err }, "readiness check failed");
      reply.code(503);
      return { status: "not-ready", service: `${APP_NAME}-server` };
    }
  });

  app.get("/api/v1/ready", async (request, reply) => {
    try {
      return await readiness();
    } catch (err) {
      request.log.error({ err }, "readiness check failed");
      reply.code(503);
      return { status: "not-ready", service: `${APP_NAME}-server` };
    }
  });
}
