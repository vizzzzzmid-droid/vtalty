import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import type { Db } from "./db/client.js";
import type { Env } from "./env.js";
import { HttpError } from "./lib/errors.js";
import { contentSecurityPolicyDirectives } from "./lib/csp.js";
import { createLiveKit, type LiveKitAdmin } from "./lib/livekit.js";
import { loggerOptions } from "./lib/logger.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import { registerChannelRoutes } from "./modules/channels/routes.js";
import { registerInviteRoutes } from "./modules/invites/routes.js";
import { registerMemberRoutes } from "./modules/members/routes.js";
import { registerMessageRoutes } from "./modules/messages/routes.js";
import { registerRoleRoutes } from "./modules/roles/routes.js";
import { registerServerRoutes } from "./modules/servers/routes.js";
import { registerSettingsRoutes } from "./modules/settings/routes.js";
import { registerUserRoutes } from "./modules/users/routes.js";
import { registerVoiceRoutes } from "./modules/voice/routes.js";
import { LocalStorage, type UploadStorage } from "./modules/uploads/storage.js";
import { registerUploadRoutes } from "./modules/uploads/routes.js";
import { registerWsTicketRoutes } from "./modules/ws-tickets/routes.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerGateway } from "./ws/gateway.js";

export interface AppDeps {
  env: Env;
  db: Db;
  /** Overridden in tests; defaults to local disk under UPLOAD_DIR. */
  storage?: UploadStorage;
  /** Overridden in tests with a fake; defaults to a real LiveKit client. */
  livekit?: LiveKitAdmin;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.env.NODE_ENV === "test" ? false : loggerOptions(),
  });
  app.decorate("config", deps.env);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof ZodError) {
      // Server-side contract violation (bug), never client input.
      request.log.error({ err: error }, "internal validation failed");
      reply
        .code(500)
        .send({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
      return;
    }
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (
      typeof statusCode === "number" &&
      statusCode >= 400 &&
      statusCode < 500
    ) {
      // Client errors from plugins (e.g. 429 rate limit): safe to echo.
      const message =
        error instanceof Error ? error.message : "Request failed";
      reply
        .code(statusCode)
        .send({ error: { code: "REQUEST_FAILED", message } });
      return;
    }
    request.log.error({ err: error }, "unhandled error");
    reply
      .code(500)
      .send({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: contentSecurityPolicyDirectives() },
  });
  // Same-origin in production (Caddy). Reflect origin for host-run dev
  // (Vite :5173 -> server :3000); an explicit allowlist is a later hardening.
  await app.register(cors, { origin: true });
  // Coarse global cap; auth routes add stricter per-route limits.
  // Custom key: the plugin's default generator crashes on requests without
  // a socket IP (WS upgrades via inject in tests) — fall back instead.
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.ip ?? "unknown",
  });
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: deps.env.UPLOAD_MAX_BYTES, files: 10 },
    throwFileSizeLimit: true,
  });
  // LiveKit posts application/webhook+json; signature verification needs
  // the exact raw bytes, so keep the body as a string (never parsed JSON).
  app.addContentTypeParser(
    "application/webhook+json",
    { parseAs: "string" },
    (request, body, done) => {
      done(null, body);
    },
  );
  const storage = deps.storage ?? new LocalStorage(deps.env.UPLOAD_DIR);
  const livekit = deps.livekit ?? createLiveKit(deps.env);
  app.decorate("livekit", livekit);

  registerHealthRoutes(app, deps);
  registerAuthRoutes(app, deps);
  registerUserRoutes(app, deps);
  registerServerRoutes(app, deps);
  registerChannelRoutes(app, deps);
  registerInviteRoutes(app, deps);
  registerMemberRoutes(app, deps);
  registerMessageRoutes(app, deps);
  registerUploadRoutes(app, { ...deps, storage });
  registerRoleRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerVoiceRoutes(app, deps);
  registerWsTicketRoutes(app, deps);
  await registerGateway(app, deps);

  return app;
}
