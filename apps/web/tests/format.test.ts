import { describe, expect, it } from "vitest";
import { displayNameOf, initialsOf } from "../src/lib/format.js";

describe("initialsOf", () => {
  it("uses first letters of the first two words", () => {
    expect(initialsOf("John Doe")).toBe("JD");
    expect(initialsOf("alice")).toBe("A");
    expect(initialsOf("  mary   jane  ")).toBe("MJ");
  });

  it("falls back to a placeholder", () => {
    expect(initialsOf("")).toBe("?");
    expect(initialsOf("   ")).toBe("?");
  });
});

describe("displayNameOf", () => {
  it("prefers the display name and falls back to username", () => {
    expect(displayNameOf("John", "john")).toBe("John");
    expect(displayNameOf("   ", "john")).toBe("john");
  });
});
