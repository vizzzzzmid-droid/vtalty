import pino, { type LoggerOptions } from "pino";

/**
 * Paths redacted from every log line. Secrets must never reach logs:
 * - Authorization header (access JWT) and WS tickets in the query string;
 * - passwords and invite codes in request bodies;
 * - Set-Cookie headers (refresh cookie).
 */
export const REDACTED_PATHS = [
  "req.headers.authorization",
  "req.query.ticket",
  "req.query.token",
  "req.body.password",
  "req.body.inviteCode",
  "res.headers.set-cookie",
  "res.headers.Set-Cookie",
] as const;

export function loggerOptions(): LoggerOptions {
  return {
    level: process.env["LOG_LEVEL"] ?? "info",
    redact: {
      paths: [...REDACTED_PATHS],
      censor: "[Redacted]",
    },
  };
}

export const logger = pino(loggerOptions());
