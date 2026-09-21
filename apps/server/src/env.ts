import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  WS_TICKET_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  COOKIE_SECURE: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  REGISTRATION_MODE: z.enum(["invite-only", "open"]).default("invite-only"),
  LIVEKIT_URL: z.string().default("http://livekit:7880"),
  LIVEKIT_API_KEY: z.string().default("devkey"),
  LIVEKIT_API_SECRET: z.string().default("devsecret"),
  LIVEKIT_PUBLIC_URL: z.string().default("wss://localhost/livekit"),
  VOICE_MAX_PARTICIPANTS: z.coerce.number().int().positive().default(15),
  VOICE_RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  VOICE_MAX_SHARERS: z.coerce.number().int().positive().default(3),
  UPLOAD_CLEANUP_MAX_AGE_HOURS: z.coerce.number().int().positive().default(24),
  UPLOAD_CLEANUP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(3600),
  UPLOAD_DIR: z.string().default("/data/uploads"),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
});

export type Env = z.infer<typeof envSchema>;

/** Parse and validate process env. Throws a ZodError on invalid config. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}
