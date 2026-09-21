import type { FastifyInstance } from "fastify";
import { createServerBodySchema, patchServerBodySchema } from "@vitality/shared";
import type { AppDeps } from "../../app.js";
import { authenticate } from "../../lib/auth.js";
import { notFound } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import {
  createServer,
  deleteServer,
  getServerState,
  listServers,
  patchServer,
} from "./service.js";

function serverIdParam(request: { params: unknown }): string {
  const params = request.params as { id?: unknown };
  if (typeof params.id !== "string") {
    throw notFound("Server not found");
  }
  return params.id;
}

export function registerServerRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;

  app.get("/api/v1/servers", { preHandler: [authenticate] }, async (request) =>
    listServers(db, request.userId),
  );

  app.post("/api/v1/servers", { preHandler: [authenticate] }, async (request) => {
    const body = parseBody(createServerBodySchema, request.body);
    return createServer(db, request.userId, body.name);
  });

  app.get(
    "/api/v1/servers/:id/state",
    { preHandler: [authenticate] },
    async (request) => getServerState(db, request.userId, serverIdParam(request)),
  );

  app.patch(
    "/api/v1/servers/:id",
    { preHandler: [authenticate] },
    async (request) => {
      const body = parseBody(patchServerBodySchema, request.body);
      return patchServer(db, request.userId, serverIdParam(request), body);
    },
  );

  app.delete(
    "/api/v1/servers/:id",
    { preHandler: [authenticate] },
    async (request, reply) => {
      await deleteServer(db, app.livekit, request.userId, serverIdParam(request));
      reply.code(204);
      return null;
    },
  );
}
