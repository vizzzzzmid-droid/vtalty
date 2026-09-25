// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Avatar, GeneratedAvatar, avatarColors, hueOf } from "../src/components/Avatar.js";

const USER_A = "018f6b1e-2f3a-7c4d-8e5f-000000000001";
const USER_B = "018f6b1e-2f3a-7c4d-8e5f-000000000002";

describe("generated avatar determinism", () => {
  it("derives the same hue from the same user id every time", () => {
    expect(hueOf(USER_A)).toBe(hueOf(USER_A));
    expect(avatarColors(USER_A)).toEqual(avatarColors(USER_A));
  });

  it("gives different users different colours", () => {
    expect(hueOf(USER_A)).not.toBe(hueOf(USER_B));
  });

  it("keeps the hue inside the 0-359 range for arbitrary ids", () => {
    for (const id of ["", "a", "user-42", USER_A, "юникод-имя", "x".repeat(200)]) {
      const hue = hueOf(id);
      expect(Number.isInteger(hue)).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("renders identical markup for identical inputs", () => {
    const first = renderToStaticMarkup(<GeneratedAvatar id={USER_A} name="Ada Lovelace" />);
    const second = renderToStaticMarkup(<GeneratedAvatar id={USER_A} name="Ada Lovelace" />);
    expect(first).toBe(second);
    expect(first).toContain("AL");
    expect(first).toContain(avatarColors(USER_A).background);
  });

  it("derives the colour from the id, not the name", () => {
    const renamed = renderToStaticMarkup(<GeneratedAvatar id={USER_A} name="Grace Hopper" />);
    expect(renamed).toContain(avatarColors(USER_A).background);
  });
});

describe("Avatar fallback", () => {
  it("shows the generated avatar when there is no custom image", () => {
    const html = renderToStaticMarkup(<Avatar id={USER_A} name="Ada Lovelace" src={null} />);
    expect(html).toContain(avatarColors(USER_A).background);
  });

  it("keeps a neutral fallback when no user id is known", () => {
    const html = renderToStaticMarkup(<Avatar name="Ada Lovelace" src={null} />);
    expect(html).not.toContain("hsl(");
  });
});
