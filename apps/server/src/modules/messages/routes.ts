import type { FastifyInstance } from "fastify";
import {
  createMessageBodySchema,
  historyQuerySchema,
  markReadBodySchema,
  patchMessageBodySchema,
} from "@vitality/shared";
import type { AppDeps } from "../../app.js";
import { authenticate } from "../../lib/auth.js";
import { notFound } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import {
  deleteMessage,
  editMessage,
  getHistory,
  getUnread,
  markRead,
  sendMessage,
} from "./service.js";

function idParam(request: { params: unknown }, kind: string): string {
  const params = request.params as { id?: unknown };
  if (typeof params.id !== "string") {
    throw notFound(`${kind} not found`);
  }
  return params.id;
}

export function registerMessageRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;

  app.post(
    "/api/v1/channels/:id/messages",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const body = parseBody(createMessageBodySchema, request.body);
      const message = await sendMessage(db, request.userId, idParam(request, "Channel"), body);
      reply.code(201);
      return message;
    },
  );

  app.get(
    "/api/v1/channels/:id/messages",
    { preHandler: [authenticate] },
    async (request) => {
      const query = parseBody(historyQuerySchema, request.query);
      return getHistory(db, request.userId, idParam(request, "Channel"), query);
    },
  );

  app.patch(
    "/api/v1/messages/:id",
    { preHandler: [authenticate] },
    async (request) => {
      const body = parseBody(patchMessageBodySchema, request.body);
      return editMessage(db, request.userId, idParam(request, "Message"), body.content);
    },
  );

  app.delete(
    "/api/v1/messages/:id",
    { preHandler: [authenticate] },
    async (request, reply) => {
      await deleteMessage(db, request.userId, idParam(request, "Message"));
      reply.code(204);
      return null;
    },
  );

  app.post(
    "/api/v1/channels/:id/read",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const body = parseBody(markReadBodySchema, request.body);
      await markRead(db, request.userId, idParam(request, "Channel"), body.lastReadMessageId);
      reply.code(204);
      return null;
    },
  );

  app.get(
    "/api/v1/servers/:id/unread",
    { preHandler: [authenticate] },
    async (request) => getUnread(db, request.userId, idParam(request, "Server")),
  );
}
