// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
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

describe("Avatar image sizing", () => {
  // Regression: Root is a <span> sized with inline width/height. Without an
  // explicit block display those are ignored on an inline box, so a custom
  // avatar image rendered at its intrinsic size (256x256) instead of `size`.
  it("sizes the root as a block box so inline width/height apply", () => {
    const html = renderToStaticMarkup(
      <Avatar id={USER_A} name="Ada Lovelace" src="https://cdn.test/a.png" size={28} />,
    );
    expect(html).toMatch(/class="[^"]*\bblock\b[^"]*"/);
    // `display:block` is inlined, not left to the stylesheet, so the sizing
    // survives even if the class is overridden or CSS is not loaded yet.
    expect(html).toMatch(/style="display:block;width:28px;height:28px/);
  });

  it("renders the image block-level and object-cover", async () => {
    // Radix only mounts the <img> once it reports `load`, which never happens
    // in happy-dom, so render on the client and fire the event ourselves.
    // Radix probes the URL with its own `new window.Image()` and only swaps
    // the fallback for the <img> once that probe reports `complete` with a
    // non-zero `naturalWidth`, which never happens in happy-dom. Make the
    // probe succeed so the real <img> is mounted.
    const RealImage = globalThis.Image;
    globalThis.Image = class {
      complete = true;
      naturalWidth = 1;
      naturalHeight = 1;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      addEventListener() {}
      removeEventListener() {}
      set src(_value: string) {}
      get src(): string {
        return "";
      }
    } as unknown as typeof Image;
    try {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      act(() => {
        root.render(
          <Avatar id={USER_A} name="Ada Lovelace" src="https://cdn.test/a.png" size={24} />,
        );
      });
      await act(async () => {});
      const img = host.querySelector("img");
      expect(img).not.toBeNull();
      expect(img!.className).toMatch(/\bblock\b/);
      expect(img!.className).toMatch(/object-cover/);
      act(() => root.unmount());
      host.remove();
    } finally {
      globalThis.Image = RealImage;
    }
  });
});
