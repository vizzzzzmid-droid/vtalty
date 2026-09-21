import { describe, expect, it } from "vitest";
import { generateInviteCode } from "../../src/modules/invites/service.js";

describe("generateInviteCode", () => {
  it("produces 12-char base64url codes", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const code = generateInviteCode();
      expect(code).toMatch(/^[A-Za-z0-9_-]{12}$/);
      seen.add(code);
    }
    expect(seen.size).toBe(50);
  });
});
