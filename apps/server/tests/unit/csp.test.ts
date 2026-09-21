import { describe, expect, it } from "vitest";
import { contentSecurityPolicyDirectives } from "../../src/lib/csp.js";

describe("content security policy", () => {
  it("allows self scripts plus WASM compilation", () => {
    const scriptSrc = contentSecurityPolicyDirectives()["script-src"] ?? [];
    expect(scriptSrc).toContain("'self'");
    // Without this, WebAssembly.compile (RNNoise) dies in production
    // while still working under `vite dev` (no CSP there).
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
  });

  it("does not allow inline scripts or remote code", () => {
    const scriptSrc = contentSecurityPolicyDirectives()["script-src"] ?? [];
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc.every((entry) => !entry.startsWith("http"))).toBe(true);
  });
});
