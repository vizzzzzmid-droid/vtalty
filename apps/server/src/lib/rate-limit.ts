import { HttpError } from "./errors.js";

interface Bucket {
  hits: number[];
}

// Single-process sliding-window limiter (the whole app runs on one VPS).
// Entries are pruned on every check, so memory stays proportional to
// recent activity.
const buckets = new Map<string, Bucket>();

/**
 * Allow `max` actions per `windowMs` for `key`. Throws 429 RATE_LIMITED.
 * Prefer this over the global IP limiter when the caller is authenticated:
 * Fastify rate-limit hooks run before auth pre-handlers, so per-user keys
 * are not available there.
 */
export function checkUserRateLimit(
  key: string,
  max: number,
  windowMs: number,
  now: number = Date.now(),
): void {
  let bucket = buckets.get(key);
  if (bucket === undefined) {
    bucket = { hits: [] };
    buckets.set(key, bucket);
  }
  const cutoff = now - windowMs;
  bucket.hits = bucket.hits.filter((hit) => hit > cutoff);
  if (bucket.hits.length >= max) {
    throw new HttpError(429, "RATE_LIMITED", "Slow down and try again");
  }
  bucket.hits.push(now);
}

/** Test hook: drop all limiter state. */
export function resetRateLimits(): void {
  buckets.clear();
}
