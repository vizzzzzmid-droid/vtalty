import jwt from "jsonwebtoken";

export function signAccessToken(
  userId: string,
  secret: string,
  expiresInSeconds: number,
): string {
  return jwt.sign({ sub: userId }, secret, { expiresIn: expiresInSeconds });
}

/** Returns the `sub` claim. Throws on bad signature, expiry, bad claims. */
export function verifyAccessToken(token: string, secret: string): string {
  const decoded = jwt.verify(token, secret);
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("access token payload must be an object");
  }
  const sub: unknown = decoded.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    throw new Error("access token has no sub claim");
  }
  return sub;
}
