import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/env.js";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://vitality:pw@127.0.0.1:5432/vitality",
    JWT_ACCESS_SECRET: "x".repeat(32),
  };
}

describe("loadEnv", () => {
  it("applies defaults", () => {
    const env = loadEnv(baseEnv());
    expect(env.NODE_ENV).toBe("development");
    expect(env.HOST).toBe("0.0.0.0");
    expect(env.PORT).toBe(3000);
    expect(env.REGISTRATION_MODE).toBe("invite-only");
    expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(env.REFRESH_TOKEN_TTL_DAYS).toBe(30);
    expect(env.COOKIE_SECURE).toBe(false);
  });

  it("parses COOKIE_SECURE truthfully", () => {
    expect(loadEnv({ ...baseEnv(), COOKIE_SECURE: "true" }).COOKIE_SECURE).toBe(true);
    expect(loadEnv({ ...baseEnv(), COOKIE_SECURE: "false" }).COOKIE_SECURE).toBe(false);
  });

  it("throws when DATABASE_URL is missing", () => {
    const source = baseEnv();
    delete source["DATABASE_URL"];
    expect(() => loadEnv(source)).toThrow();
  });

  it("throws when JWT_ACCESS_SECRET is too short", () => {
    expect(() => loadEnv({ ...baseEnv(), JWT_ACCESS_SECRET: "short" })).toThrow();
  });

  it("accepts open registration mode and a custom port", () => {
    const env = loadEnv({ ...baseEnv(), REGISTRATION_MODE: "open", PORT: "4000" });
    expect(env.REGISTRATION_MODE).toBe("open");
    expect(env.PORT).toBe(4000);
  });

  it("defaults auth rate limits and accepts overrides", () => {
    const defaults = loadEnv(baseEnv());
    expect(defaults.RATE_LIMIT_REGISTER_MAX).toBe(10);
    expect(defaults.RATE_LIMIT_LOGIN_MAX).toBe(10);
    expect(defaults.RATE_LIMIT_REFRESH_MAX).toBe(30);
    const raised = loadEnv({
      ...baseEnv(),
      RATE_LIMIT_REGISTER_MAX: "1000",
      RATE_LIMIT_LOGIN_MAX: "500",
      RATE_LIMIT_REFRESH_MAX: "600",
    });
    expect(raised.RATE_LIMIT_REGISTER_MAX).toBe(1000);
    expect(raised.RATE_LIMIT_LOGIN_MAX).toBe(500);
    expect(raised.RATE_LIMIT_REFRESH_MAX).toBe(600);
  });

  it("rejects non-positive rate limits", () => {
    expect(() => loadEnv({ ...baseEnv(), RATE_LIMIT_REGISTER_MAX: "0" })).toThrow();
    expect(() => loadEnv({ ...baseEnv(), RATE_LIMIT_LOGIN_MAX: "-5" })).toThrow();
  });
});
