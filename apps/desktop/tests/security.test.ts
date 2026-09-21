import { describe, expect, it } from "vitest";
import {
  isConnectSender,
  isTrustedSender,
  navigationDecision,
  normalizeServerUrl,
  serverUrlSchema,
} from "../src/shared.js";
import { decideNavigation, decidePermission } from "../src/security.js";

describe("serverUrlSchema", () => {
  it("accepts https URLs", () => {
    expect(serverUrlSchema.safeParse("https://voice.example.com").success).toBe(true);
  });

  it("accepts http on loopback", () => {
    expect(serverUrlSchema.safeParse("http://localhost:3000").success).toBe(true);
    expect(serverUrlSchema.safeParse("http://127.0.0.1:3000").success).toBe(true);
  });

  it("rejects http on non-loopback", () => {
    expect(serverUrlSchema.safeParse("http://voice.example.com").success).toBe(false);
  });

  it("rejects non-http schemes", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ftp://x.example"]) {
      expect(serverUrlSchema.safeParse(url).success).toBe(false);
    }
  });

  it("rejects credentials in the URL", () => {
    expect(serverUrlSchema.safeParse("https://user:pass@voice.example.com").success).toBe(false);
    expect(serverUrlSchema.safeParse("https://user@voice.example.com").success).toBe(false);
  });

  it("rejects overlong input", () => {
    expect(serverUrlSchema.safeParse(`https://x.example/${"a".repeat(2100)}`).success).toBe(false);
  });
});

describe("normalizeServerUrl", () => {
  it("drops fragments", () => {
    expect(normalizeServerUrl("https://voice.example.com/app#token")).toBe(
      "https://voice.example.com/app",
    );
  });

  it("returns null for invalid URLs", () => {
    expect(normalizeServerUrl("http://voice.example.com")).toBeNull();
  });
});

describe("navigationDecision", () => {
  const origin = "https://voice.example.com";

  it("allows same-origin navigation", () => {
    expect(navigationDecision(`${origin}/channels/1`, origin)).toBe("allow");
  });

  it("routes cross-origin https to external", () => {
    expect(navigationDecision("https://evil.example/app", origin)).toBe("external");
  });

  it("denies non-http schemes", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "vitality://x"]) {
      expect(navigationDecision(url, origin)).toBe("deny");
    }
  });

  it("denies garbage URLs and empty origins", () => {
    expect(navigationDecision("::not a url::", origin)).toBe("deny");
    expect(navigationDecision(`${origin}/x`, "")).toBe("deny");
  });

  it("connect screen is always allowed", () => {
    expect(decideNavigation("file:///app/dist/renderer/connect.html", "")).toBe("allow");
  });
});

describe("isTrustedSender", () => {
  const origin = "https://voice.example.com";

  it("trusts the instance origin", () => {
    expect(isTrustedSender(`${origin}/app`, origin)).toBe(true);
  });

  it("rejects other origins", () => {
    expect(isTrustedSender("https://evil.example/app", origin)).toBe(false);
  });

  it("trusts the connect screen only before connecting", () => {
    const connect = "file:///app/dist/renderer/connect.html";
    expect(isConnectSender(connect)).toBe(true);
    expect(isTrustedSender(connect, "")).toBe(true);
    expect(isTrustedSender(connect, origin)).toBe(false);
  });

  it("rejects empty and garbage senders", () => {
    expect(isTrustedSender(undefined, origin)).toBe(false);
    expect(isTrustedSender("", origin)).toBe(false);
    expect(isTrustedSender("::bad::", origin)).toBe(false);
  });
});

describe("decidePermission", () => {
  const origin = "https://voice.example.com";

  it("grants media/display-capture/notifications for the instance origin", () => {
    for (const permission of ["media", "display-capture", "notifications"]) {
      expect(decidePermission(permission, `${origin}/app`, origin)).toBe(permission);
    }
  });

  it("denies everything else", () => {
    expect(decidePermission("geolocation", `${origin}/app`, origin)).toBe("other");
    expect(decidePermission("media", "https://evil.example/app", origin)).toBe("other");
    expect(decidePermission("media", `${origin}/app`, "")).toBe("other");
  });
});
