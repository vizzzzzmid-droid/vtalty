import type { FastifyInstance } from "fastify";
import { patchMeBodySchema } from "@vitality/shared";
import type { AppDeps } from "../../app.js";
import { authenticate } from "../../lib/auth.js";
import { notFound } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { getById, updateMe } from "./service.js";

export function registerUserRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;

  app.patch(
    "/api/v1/users/me",
    { preHandler: [authenticate] },
    async (request) => {
      const patch = parseBody(patchMeBodySchema, request.body);
      return updateMe(db, request.userId, patch);
    },
  );

  app.get(
    "/api/v1/users/:id",
    { preHandler: [authenticate] },
    async (request) => {
      const params = request.params as { id?: unknown };
      if (typeof params.id !== "string") {
        throw notFound("User not found");
      }
      return getById(db, params.id);
    },
  );
}
