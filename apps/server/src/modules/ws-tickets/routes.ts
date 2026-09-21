import type { FastifyInstance } from "fastify";
import { wsTicketResponseSchema } from "@vitality/shared";
import type { AppDeps } from "../../app.js";
import { authenticate } from "../../lib/auth.js";
import { createWsTicket } from "./service.js";

export function registerWsTicketRoutes(
  app: FastifyInstance,
  deps: AppDeps,
): void {
  const { db, env } = deps;

  app.post(
    "/api/v1/ws-ticket",
    {
      preHandler: [authenticate],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request) => {
      const ticket = await createWsTicket(
        db,
        request.userId,
        request.sessionId,
        env.WS_TICKET_TTL_SECONDS,
      );
      return wsTicketResponseSchema.parse({ ticket });
    },
  );
}
