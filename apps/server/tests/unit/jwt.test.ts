import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { signAccessToken, verifyAccessToken } from "../../src/lib/jwt.js";

const SECRET = "test-secret-".padEnd(32, "x");
const OTHER_SECRET = "other-secret".padEnd(32, "y");

describe("access tokens", () => {
  it("round-trips sub and sid claims", () => {
    const token = signAccessToken("user-1", SECRET, 900, "family-1");
    expect(verifyAccessToken(token, SECRET)).toEqual({
      sub: "user-1",
      sid: "family-1",
    });
  });

  it("rejects tokens signed with another secret", () => {
    const token = signAccessToken("user-1", OTHER_SECRET, 900, "family-1");
    expect(() => verifyAccessToken(token, SECRET)).toThrow();
  });

  it("rejects expired tokens", () => {
    const token = signAccessToken("user-1", SECRET, -10, "family-1");
    expect(() => verifyAccessToken(token, SECRET)).toThrow();
  });

  it("rejects tokens without a sid claim", () => {
    const token = jwt.sign({ sub: "user-1" }, SECRET, { expiresIn: 900 });
    expect(() => verifyAccessToken(token, SECRET)).toThrow();
  });
});
