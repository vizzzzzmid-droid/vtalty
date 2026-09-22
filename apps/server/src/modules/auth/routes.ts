import type { FastifyInstance, FastifyReply } from "fastify";
import {
  authResponseSchema,
  loginBodySchema,
  registerBodySchema,
  type User,
} from "@vitality/shared";
import type { AppDeps } from "../../app.js";
import { authenticate } from "../../lib/auth.js";
import { unauthorized } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { getById } from "../users/service.js";
import {
  REFRESH_COOKIE,
  login,
  logout,
  refresh,
  register,
  type AuthResult,
} from "./service.js";

function setRefreshCookie(
  reply: FastifyReply,
  env: AppDeps["env"],
  rawToken: string,
  maxAgeSeconds: number,
): void {
  reply.setCookie(REFRESH_COOKIE, rawToken, {
    path: "/api/v1/auth",
    httpOnly: true,
    sameSite: "lax",
    secure: env.COOKIE_SECURE,
    maxAge: maxAgeSeconds,
  });
}

function toResponse(result: AuthResult): { user: User; accessToken: string } {
  return authResponseSchema.parse({
    user: result.user,
    accessToken: result.tokens.accessToken,
  });
}

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, env } = deps;

  app.post(
    "/api/v1/auth/register",
    { config: { rateLimit: { max: env.RATE_LIMIT_REGISTER_MAX, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = parseBody(registerBodySchema, request.body);
      const result = await register(db, env, input);
      setRefreshCookie(
        reply,
        env,
        result.tokens.refreshToken,
        result.tokens.refreshMaxAgeSeconds,
      );
      reply.code(201);
      return toResponse(result);
    },
  );

  app.post(
    "/api/v1/auth/login",
    { config: { rateLimit: { max: env.RATE_LIMIT_LOGIN_MAX, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = parseBody(loginBodySchema, request.body);
      const result = await login(db, env, input);
      setRefreshCookie(
        reply,
        env,
        result.tokens.refreshToken,
        result.tokens.refreshMaxAgeSeconds,
      );
      return toResponse(result);
    },
  );

  app.post(
    "/api/v1/auth/refresh",
    { config: { rateLimit: { max: env.RATE_LIMIT_REFRESH_MAX, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const raw = request.cookies[REFRESH_COOKIE];
      if (typeof raw !== "string" || raw.length === 0) {
        throw unauthorized("Missing refresh token");
      }
      const result = await refresh(db, env, raw);
      setRefreshCookie(
        reply,
        env,
        result.tokens.refreshToken,
        result.tokens.refreshMaxAgeSeconds,
      );
      return toResponse(result);
    },
  );

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const raw = request.cookies[REFRESH_COOKIE];
    await logout(db, typeof raw === "string" ? raw : null);
    reply.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
    reply.code(204);
    return null;
  });

  app.get(
    "/api/v1/auth/me",
    { preHandler: [authenticate] },
    async (request) => getById(db, request.userId),
  );
}
