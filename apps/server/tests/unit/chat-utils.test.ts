import { afterEach, describe, expect, it, vi } from "vitest";
import { checkUserRateLimit, resetRateLimits } from "../../src/lib/rate-limit.js";
import { extractMentionUsernames } from "../../src/modules/messages/service.js";

afterEach(() => {
  resetRateLimits();
  vi.useRealTimers();
});

describe("checkUserRateLimit", () => {
  it("allows up to max actions per window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    for (let i = 0; i < 3; i += 1) {
      expect(() => checkUserRateLimit("u1", 3, 60_000)).not.toThrow();
    }
    expect(() => checkUserRateLimit("u1", 3, 60_000)).toThrowError(/slow down/i);
  });

  it("resets after the window and isolates keys", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    checkUserRateLimit("u2", 1, 60_000);
    expect(() => checkUserRateLimit("u2", 1, 60_000)).toThrow();
    checkUserRateLimit("other", 1, 60_000);
    vi.setSystemTime(1_000_000 + 60_001);
    expect(() => checkUserRateLimit("u2", 1, 60_000)).not.toThrow();
  });
});

describe("extractMentionUsernames", () => {
  it("finds unique @usernames and skips loners", () => {
    expect(extractMentionUsernames("hi @anna and @bob, ping @anna!")).toEqual([
      "anna",
      "bob",
    ]);
    expect(extractMentionUsernames("@a @ @ab @abc")).toEqual(["ab", "abc"]);
    expect(extractMentionUsernames("no mentions here")).toEqual([]);
  });
});
