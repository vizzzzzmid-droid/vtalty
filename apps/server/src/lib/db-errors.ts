/** postgres-js surfaces server errors with a `code` property (e.g. 23505). */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  return (err as { code?: unknown }).code === "23505";
}
