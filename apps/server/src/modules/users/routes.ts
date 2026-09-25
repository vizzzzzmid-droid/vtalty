import type { FastifyInstance, FastifyRequest } from "fastify";
import { patchMeBodySchema } from "@vitality/shared";
import type { AppDeps } from "../../app.js";
import { authenticate } from "../../lib/auth.js";
import { badRequest, notFound, unauthorized } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { verifyAvatarSignature } from "../uploads/signed-urls.js";
import { LocalStorage } from "../uploads/storage.js";
import { getById, removeMyAvatar, serveAvatar, setMyAvatar, updateMe } from "./service.js";

/**
 * Avatar downloads: a Bearer token (API clients) OR a valid signed URL —
 * browser <img> loads cannot send headers (same pattern as attachments).
 */
function makeAvatarGuard(deps: AppDeps) {
  return async (request: FastifyRequest): Promise<void> => {
    if (request.headers.authorization !== undefined) {
      await authenticate(request);
      return;
    }
    const query = request.query as { e?: unknown; s?: unknown };
    const expires = typeof query.e === "string" ? Number(query.e) : NaN;
    const signature = typeof query.s === "string" ? query.s : "";
    const params = request.params as { id?: unknown };
    if (
      typeof params.id === "string" &&
      verifyAvatarSignature(deps.env.JWT_ACCESS_SECRET, params.id, expires, signature)
    ) {
      return;
    }
    throw unauthorized("Missing bearer token or valid avatar signature");
  };
}

export function registerUserRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, env } = deps;
  const storage = deps.storage ?? new LocalStorage(env.UPLOAD_DIR);

  app.patch(
    "/api/v1/users/me",
    { preHandler: [authenticate] },
    async (request) => {
      const patch = parseBody(patchMeBodySchema, request.body);
      return updateMe(db, request.userId, patch);
    },
  );

  // Upload/replace the caller's own avatar. Only self is addressable: the
  // path carries no user id, so there is no cross-user escalation surface.
  app.put(
    "/api/v1/users/me/avatar",
    { preHandler: [authenticate] },
    async (request) => {
      let buffer: Buffer | null = null;
      for await (const part of request.parts()) {
        if (part.type !== "file") {
          continue;
        }
        if (buffer !== null) {
          throw badRequest("TOO_MANY_FILES", "Send a single avatar file");
        }
        buffer = await part.toBuffer();
      }
      if (buffer === null) {
        throw badRequest("NO_FILE", "Missing avatar file");
      }
      return setMyAvatar(db, storage, request.userId, buffer);
    },
  );

  app.delete(
    "/api/v1/users/me/avatar",
    { preHandler: [authenticate] },
    async (request) => removeMyAvatar(db, storage, request.userId),
  );

  app.get(
    "/api/v1/users/:id/avatar",
    { preHandler: [makeAvatarGuard(deps)] },
    async (request, reply) => {
      const params = request.params as { id?: unknown };
      if (typeof params.id !== "string") {
        throw notFound("Avatar not found");
      }
      const served = await serveAvatar(db, storage, params.id);
      reply.header("content-type", served.mime);
      reply.header("x-content-type-options", "nosniff");
      // Avatars are mutable, so no immutable caching; the signed URL's
      // expiry bounds staleness on the client side.
      reply.header("cache-control", "private, max-age=300");
      return reply.send(served.data);
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
