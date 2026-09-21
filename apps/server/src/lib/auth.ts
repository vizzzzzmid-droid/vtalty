import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Env } from "../env.js";
import { unauthorized } from "./errors.js";
import { verifyAccessToken } from "./jwt.js";

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
  }
  interface FastifyInstance {
    config: Env;
  }
}

/** Pre-handler: requires `Authorization: Bearer <access JWT>`. */
export async function authenticate(request: FastifyRequest): Promise<void> {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) {
    throw unauthorized("Missing bearer token");
  }
  const token = header.slice("Bearer ".length);
  try {
    request.userId = verifyAccessToken(
      token,
      (request.server as FastifyInstance).config.JWT_ACCESS_SECRET,
    );
  } catch {
    throw unauthorized("Invalid or expired token");
  }
}
