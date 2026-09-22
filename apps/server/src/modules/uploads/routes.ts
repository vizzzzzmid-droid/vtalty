import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDeps } from "../../app.js";
import { authenticate } from "../../lib/auth.js";
import { badRequest, notFound, unauthorized } from "../../lib/errors.js";
import {
  serveAttachment,
  serveSignedAttachment,
  uploadFiles,
  type UploadedFile,
} from "./service.js";
import { signAttachmentUrl, verifyAttachmentSignature } from "./signed-urls.js";
import { LocalStorage } from "./storage.js";

function idParam(request: { params: unknown }, kind: string): string {
  const params = request.params as { id?: unknown };
  if (typeof params.id !== "string") {
    throw notFound(`${kind} not found`);
  }
  return params.id;
}

/**
 * Download auth: a Bearer token (API clients) OR a valid HMAC-signed URL
 * (browser <img>/<a> loads cannot send headers — see signed-urls.ts).
 */
function makeDownloadGuard(secret: string) {
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
      verifyAttachmentSignature(secret, params.id, expires, signature)
    ) {
      return;
    }
    throw unauthorized("Missing bearer token or valid download signature");
  };
}

export function registerUploadRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, env } = deps;
  const storage = deps.storage ?? new LocalStorage(env.UPLOAD_DIR);
  const signUrl = (attachmentId: string): string =>
    signAttachmentUrl(env.JWT_ACCESS_SECRET, attachmentId, env.ATTACHMENT_URL_TTL_SECONDS);

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
        signUrl,
      );
    },
  );

  app.get(
    "/api/v1/attachments/:id",
    { preHandler: [makeDownloadGuard(env.JWT_ACCESS_SECRET)] },
    async (request, reply) => {
      const id = idParam(request, "Attachment");
      // Bearer path keeps per-user access checks; the signed path is a
      // capability URL whose minting was access-controlled (member-gated).
      const served =
        request.headers.authorization !== undefined
          ? await serveAttachment(db, storage, request.userId, id)
          : await serveSignedAttachment(db, storage, id);
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
