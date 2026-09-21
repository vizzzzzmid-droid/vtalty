import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../../app.js";
import { authenticate } from "../../lib/auth.js";
import { getVoiceSettings, putVoiceSettings } from "./service.js";

export function registerSettingsRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;

  app.get(
    "/api/v1/users/me/voice-settings",
    { preHandler: [authenticate] },
    async (request) => getVoiceSettings(db, request.userId),
  );

  app.put(
    "/api/v1/users/me/voice-settings",
    { preHandler: [authenticate] },
    async (request) => putVoiceSettings(db, request.userId, request.body),
  );
}
