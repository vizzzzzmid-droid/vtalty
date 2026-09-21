import type { FastifyInstance } from "fastify";
import {
  createCategoryBodySchema,
  createChannelBodySchema,
  patchCategoryBodySchema,
  patchChannelBodySchema,
} from "@vitality/shared";
import type { AppDeps } from "../../app.js";
import { authenticate } from "../../lib/auth.js";
import { notFound } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import {
  createCategory,
  createChannel,
  deleteCategory,
  deleteChannel,
  patchCategory,
  patchChannel,
} from "./service.js";

function idParam(request: { params: unknown }, kind: string): string {
  const params = request.params as { id?: unknown };
  if (typeof params.id !== "string") {
    throw notFound(`${kind} not found`);
  }
  return params.id;
}

export function registerChannelRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;

  app.post(
    "/api/v1/servers/:id/categories",
    { preHandler: [authenticate] },
    async (request) => {
      const body = parseBody(createCategoryBodySchema, request.body);
      return createCategory(db, request.userId, idParam(request, "Server"), body.name);
    },
  );

  app.patch(
    "/api/v1/categories/:id",
    { preHandler: [authenticate] },
    async (request) => {
      const body = parseBody(patchCategoryBodySchema, request.body);
      return patchCategory(db, request.userId, idParam(request, "Category"), body);
    },
  );

  app.delete(
    "/api/v1/categories/:id",
    { preHandler: [authenticate] },
    async (request, reply) => {
      await deleteCategory(db, request.userId, idParam(request, "Category"));
      reply.code(204);
      return null;
    },
  );

  app.post(
    "/api/v1/servers/:id/channels",
    { preHandler: [authenticate] },
    async (request) => {
      const body = parseBody(createChannelBodySchema, request.body);
      return createChannel(db, request.userId, idParam(request, "Server"), body);
    },
  );

  app.patch(
    "/api/v1/channels/:id",
    { preHandler: [authenticate] },
    async (request) => {
      const body = parseBody(patchChannelBodySchema, request.body);
      return patchChannel(db, request.userId, idParam(request, "Channel"), body);
    },
  );

  app.delete(
    "/api/v1/channels/:id",
    { preHandler: [authenticate] },
    async (request, reply) => {
      await deleteChannel(db, app.livekit, request.userId, idParam(request, "Channel"));
      reply.code(204);
      return null;
    },
  );
}
