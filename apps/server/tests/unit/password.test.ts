import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../src/lib/password.js";

describe("password hashing", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("correct-horse-123");
    await expect(verifyPassword(hash, "correct-horse-123")).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct-horse-123");
    await expect(verifyPassword(hash, "wrong-password")).resolves.toBe(false);
  });

  it("returns false for a malformed hash", async () => {
    await expect(verifyPassword("not-a-hash", "whatever")).resolves.toBe(false);
  });
});
