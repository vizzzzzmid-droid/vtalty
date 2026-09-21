import type { FastifyInstance } from "fastify";
import { patchRoleBodySchema } from "@vitality/shared";
import type { AppDeps } from "../../app.js";
import { authenticate } from "../../lib/auth.js";
import { notFound } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { updateRoleFlags } from "./service.js";

export function registerRoleRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;

  app.patch(
    "/api/v1/servers/:serverId/roles/:roleId",
    { preHandler: [authenticate] },
    async (request) => {
      const params = request.params as { serverId?: unknown; roleId?: unknown };
      if (typeof params.serverId !== "string" || typeof params.roleId !== "string") {
        throw notFound("Role not found");
      }
      const body = parseBody(patchRoleBodySchema, request.body);
      return updateRoleFlags(db, app.livekit, request.userId, params.serverId, params.roleId, body.flags);
    },
  );
}
