import type { FastifyInstance } from "fastify";
import { voiceModerateBodySchema } from "@vitality/shared";
import type { AppDeps } from "../../app.js";
import { authenticate } from "../../lib/auth.js";
import { notFound } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import {
  mintVoiceToken,
  moderateDisconnect,
  moderateMute,
  receiveWebhook,
} from "./service.js";

function idParam(request: { params: unknown }, kind: string): string {
  const params = request.params as { id?: unknown };
  if (typeof params.id !== "string") {
    throw notFound(`${kind} not found`);
  }
  return params.id;
}

export function registerVoiceRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, env } = deps;
  const livekit = app.livekit;

  app.post(
    "/api/v1/channels/:id/voice-token",
    { preHandler: [authenticate] },
    async (request) =>
      mintVoiceToken(db, livekit, env, request.userId, idParam(request, "Channel")),
  );

  // LiveKit posts application/webhook+json; the raw string body is required
  // for signature verification (see the content-type parser in app.ts).
  app.post("/webhooks/livekit", async (request, reply) => {
    if (typeof request.body !== "string") {
      reply.code(400);
      return { error: { code: "BAD_WEBHOOK_BODY", message: "Expected raw body" } };
    }
    const summary = await receiveWebhook(db, livekit, env, request.body, request.headers.authorization);
    return { received: true, ...summary };
  });

  app.post(
    "/api/v1/channels/:id/voice/mute",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const body = parseBody(voiceModerateBodySchema, request.body);
      await moderateMute(
        db,
        livekit,
        request.userId,
        idParam(request, "Channel"),
        body.userId,
        body.muted,
      );
      reply.code(204);
      return null;
    },
  );

  app.delete(
    "/api/v1/channels/:id/voice/participants/:userId",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const params = request.params as { userId?: unknown };
      if (typeof params.userId !== "string") {
        throw notFound("Participant not found");
      }
      await moderateDisconnect(
        db,
        livekit,
        request.userId,
        idParam(request, "Channel"),
        params.userId,
      );
      reply.code(204);
      return null;
    },
  );
}
