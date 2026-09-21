import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../../app.js";
import { authenticate } from "../../lib/auth.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { serveAttachment, uploadFiles, type UploadedFile } from "./service.js";
import { LocalStorage } from "./storage.js";

function idParam(request: { params: unknown }, kind: string): string {
  const params = request.params as { id?: unknown };
  if (typeof params.id !== "string") {
    throw notFound(`${kind} not found`);
  }
  return params.id;
}

export function registerUploadRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, env } = deps;
  const storage = deps.storage ?? new LocalStorage(env.UPLOAD_DIR);

  app.post(
    "/api/v1/channels/:id/attachments",
    { preHandler: [authenticate] },
    async (request) => {
      const files: UploadedFile[] = [];
      for await (const part of request.parts()) {
        if (part.type !== "file") {
          continue;
        }
        if (files.length >= 10) {
          throw badRequest("TOO_MANY_FILES", "At most 10 files per request");
        }
        files.push({ buffer: await part.toBuffer(), filename: part.filename });
      }
      return uploadFiles(
        db,
        storage,
        env.UPLOAD_MAX_BYTES,
        request.userId,
        idParam(request, "Channel"),
        files,
      );
    },
  );

  app.get(
    "/api/v1/attachments/:id",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const served = await serveAttachment(
        db,
        storage,
        request.userId,
        idParam(request, "Attachment"),
      );
      reply.header("content-type", served.mime);
      reply.header("x-content-type-options", "nosniff");
      reply.header("cache-control", "private, max-age=31536000, immutable");
      if (served.inline) {
        reply.header("content-disposition", "inline");
      } else {
        reply.header(
          "content-disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(served.filename)}`,
        );
      }
      return reply.send(served.data);
    },
  );
}
