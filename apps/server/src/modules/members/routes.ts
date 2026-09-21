import type { FastifyInstance } from "fastify";
import { patchMemberBodySchema } from "@vitality/shared";
import type { AppDeps } from "../../app.js";
import { authenticate } from "../../lib/auth.js";
import { notFound } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { kickMember, leaveServer, updateRole } from "./service.js";

function memberIdParam(request: { params: unknown }): string {
  const params = request.params as { id?: unknown };
  if (typeof params.id !== "string") {
    throw notFound("Member not found");
  }
  return params.id;
}

function serverIdParam(request: { params: unknown }): string {
  const params = request.params as { id?: unknown };
  if (typeof params.id !== "string") {
    throw notFound("Server not found");
  }
  return params.id;
}

export function registerMemberRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;
  const livekit = app.livekit;

  app.patch(
    "/api/v1/members/:id",
    { preHandler: [authenticate] },
    async (request) => {
      const body = parseBody(patchMemberBodySchema, request.body);
      return updateRole(db, livekit, request.userId, memberIdParam(request), body.roleId);
    },
  );

  app.delete(
    "/api/v1/members/:id",
    { preHandler: [authenticate] },
    async (request, reply) => {
      await kickMember(db, livekit, request.userId, memberIdParam(request));
      reply.code(204);
      return null;
    },
  );

  app.delete(
    "/api/v1/servers/:id/leave",
    { preHandler: [authenticate] },
    async (request, reply) => {
      await leaveServer(db, livekit, request.userId, serverIdParam(request));
      reply.code(204);
      return null;
    },
  );
}
