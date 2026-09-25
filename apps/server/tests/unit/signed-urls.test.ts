import { describe, expect, it } from "vitest";
import {
  signAttachmentUrl,
  verifyAttachmentSignature,
  signAvatarUrl,
  verifyAvatarSignature,
} from "../../src/modules/uploads/signed-urls.js";

const SECRET = "unit-test-secret-32-chars-minimum-ok";
const OTHER_SECRET = "other-secret-32-chars-minimum-0000";
const ATTACHMENT_ID = "018f6b1e-2f3a-7c4d-8e5f-000000000001";
const OTHER_ID = "018f6b1e-2f3a-7c4d-8e5f-000000000002";
const NOW = new Date("2026-09-22T12:00:00Z");

function parse(url: string): { e: number; s: string } {
  const parsed = new URL(url, "http://localhost");
  return {
    e: Number(parsed.searchParams.get("e")),
    s: parsed.searchParams.get("s") ?? "",
  };
}

describe("attachment signed URLs", () => {
  it("roundtrips: a freshly signed URL verifies", () => {
    const url = signAttachmentUrl(SECRET, ATTACHMENT_ID, 3600, NOW);
    expect(url.startsWith(`/api/v1/attachments/${ATTACHMENT_ID}?e=`)).toBe(true);
    expect(url).toContain("&s=");
    const { e, s } = parse(url);
    expect(verifyAttachmentSignature(SECRET, ATTACHMENT_ID, e, s, NOW)).toBe(true);
  });

  it("rejects a tampered signature", () => {
    const { e } = parse(signAttachmentUrl(SECRET, ATTACHMENT_ID, 3600, NOW));
    expect(verifyAttachmentSignature(SECRET, ATTACHMENT_ID, e, "AAAA", NOW)).toBe(false);
  });

  it("rejects a signature minted for another attachment id", () => {
    const { e, s } = parse(signAttachmentUrl(SECRET, ATTACHMENT_ID, 3600, NOW));
    expect(verifyAttachmentSignature(SECRET, OTHER_ID, e, s, NOW)).toBe(false);
  });

  it("rejects a tampered expiry (signature binds e)", () => {
    const { e, s } = parse(signAttachmentUrl(SECRET, ATTACHMENT_ID, 3600, NOW));
    expect(verifyAttachmentSignature(SECRET, ATTACHMENT_ID, e + 3600, s, NOW)).toBe(false);
  });

  it("rejects expired URLs even when the signature is valid", () => {
    const signedAt = new Date(NOW.getTime() - 2 * 3600 * 1000);
    const { e, s } = parse(signAttachmentUrl(SECRET, ATTACHMENT_ID, 3600, signedAt));
    expect(verifyAttachmentSignature(SECRET, ATTACHMENT_ID, e, s, NOW)).toBe(false);
  });

  it("rejects URLs under a different secret", () => {
    const { e, s } = parse(signAttachmentUrl(SECRET, ATTACHMENT_ID, 3600, NOW));
    expect(verifyAttachmentSignature(OTHER_SECRET, ATTACHMENT_ID, e, s, NOW)).toBe(false);
  });

  it("rejects non-integer and non-finite expiry values", () => {
    const { s } = parse(signAttachmentUrl(SECRET, ATTACHMENT_ID, 3600, NOW));
    expect(verifyAttachmentSignature(SECRET, ATTACHMENT_ID, Number.NaN, s, NOW)).toBe(false);
    expect(verifyAttachmentSignature(SECRET, ATTACHMENT_ID, 1.5, s, NOW)).toBe(false);
  });
});

describe("avatar signed URLs", () => {
  it("roundtrips: a freshly signed URL verifies", () => {
    const url = signAvatarUrl(SECRET, ATTACHMENT_ID, 3600, NOW);
    expect(url.startsWith(`/api/v1/users/${ATTACHMENT_ID}/avatar?e=`)).toBe(true);
    const { e, s } = parse(url);
    expect(verifyAvatarSignature(SECRET, ATTACHMENT_ID, e, s, NOW)).toBe(true);
  });

  it("rejects a tampered signature and a foreign user id", () => {
    const { e, s } = parse(signAvatarUrl(SECRET, ATTACHMENT_ID, 3600, NOW));
    expect(verifyAvatarSignature(SECRET, ATTACHMENT_ID, e, "AAAA", NOW)).toBe(false);
    expect(verifyAvatarSignature(SECRET, OTHER_ID, e, s, NOW)).toBe(false);
  });

  it("rejects expired URLs and foreign secrets", () => {
    const signedAt = new Date(NOW.getTime() - 2 * 3600 * 1000);
    const { e, s } = parse(signAvatarUrl(SECRET, ATTACHMENT_ID, 3600, signedAt));
    expect(verifyAvatarSignature(SECRET, ATTACHMENT_ID, e, s, NOW)).toBe(false);
    const fresh = parse(signAvatarUrl(SECRET, ATTACHMENT_ID, 3600, NOW));
    expect(verifyAvatarSignature(OTHER_SECRET, ATTACHMENT_ID, fresh.e, fresh.s, NOW)).toBe(
      false,
    );
  });

  it("rejects non-integer expiry values", () => {
    const { s } = parse(signAvatarUrl(SECRET, ATTACHMENT_ID, 3600, NOW));
    expect(verifyAvatarSignature(SECRET, ATTACHMENT_ID, Number.NaN, s, NOW)).toBe(false);
  });

  it("does not accept an attachment signature as an avatar signature", () => {
    // Domain separation: replaying a capability URL across the two endpoints
    // must fail even for the same id/expiry.
    const { e, s } = parse(signAttachmentUrl(SECRET, ATTACHMENT_ID, 3600, NOW));
    expect(verifyAvatarSignature(SECRET, ATTACHMENT_ID, e, s, NOW)).toBe(false);
    const avatar = parse(signAvatarUrl(SECRET, ATTACHMENT_ID, 3600, NOW));
    expect(
      verifyAttachmentSignature(SECRET, ATTACHMENT_ID, avatar.e, avatar.s, NOW),
    ).toBe(false);
  });
});

