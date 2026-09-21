import type { FastifyInstance } from "fastify";
import { createInviteBodySchema } from "@vitality/shared";
import type { AppDeps } from "../../app.js";
import { authenticate } from "../../lib/auth.js";
import { notFound } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { createInvite, deleteInvite, listInvites } from "./service.js";

function param(request: { params: unknown }, key: string, kind: string): string {
  const params = request.params as Record<string, unknown>;
  const value = params[key];
  if (typeof value !== "string") {
    throw notFound(`${kind} not found`);
  }
  return value;
}

export function registerInviteRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;

  app.post(
    "/api/v1/servers/:id/invites",
    { preHandler: [authenticate] },
    async (request) => {
      const body = parseBody(createInviteBodySchema, request.body);
      return createInvite(db, request.userId, param(request, "id", "Server"), body);
    },
  );

  app.get(
    "/api/v1/servers/:id/invites",
    { preHandler: [authenticate] },
    async (request) =>
      listInvites(db, request.userId, param(request, "id", "Server")),
  );

  app.delete(
    "/api/v1/invites/:id",
    { preHandler: [authenticate] },
    async (request, reply) => {
      await deleteInvite(db, request.userId, param(request, "id", "Invite"));
      reply.code(204);
      return null;
    },
  );
}
