import jwt from "jsonwebtoken";

export interface AccessClaims {
  sub: string;
  /** Refresh-token family id: binds the access token to a live session. */
  sid: string;
}

export function signAccessToken(
  userId: string,
  secret: string,
  expiresInSeconds: number,
  sessionId: string,
): string {
  return jwt.sign({ sub: userId, sid: sessionId }, secret, {
    expiresIn: expiresInSeconds,
  });
}

/** Returns `{ sub, sid }`. Throws on bad signature, expiry, bad claims. */
export function verifyAccessToken(token: string, secret: string): AccessClaims {
  const decoded = jwt.verify(token, secret);
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("access token payload must be an object");
  }
  const claims = decoded as { sub?: unknown; sid?: unknown };
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    throw new Error("access token has no sub claim");
  }
  if (typeof claims.sid !== "string" || claims.sid.length === 0) {
    throw new Error("access token has no sid claim");
  }
  return { sub: claims.sub, sid: claims.sid };
}
