import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageBody, safeUrl } from "../src/chat/markdown.js";

function html(content: string, usernames: string[] = []): string {
  return renderToStaticMarkup(
    <MessageBody content={content} usernames={usernames} />,
  );
}

describe("safeUrl", () => {
  it("allows http(s), mailto and relative links", () => {
    expect(safeUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(safeUrl("http://example.com")).toBe("http://example.com");
    expect(safeUrl("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(safeUrl("/channels/1")).toBe("/channels/1");
    expect(safeUrl("#frag")).toBe("#frag");
  });

  it("blocks dangerous schemes", () => {
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeUrl("vbscript:msgbox(1)")).toBeNull();
  });
});

describe("MessageBody sanitization", () => {
  it("renders basic markdown", () => {
    const out = html("**bold** *italic* ~~strike~~ `code`");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
    expect(out).toContain("<del>strike</del>");
    expect(out).toContain("<code");
  });

  it("neutralizes raw HTML tags", () => {
    const out = html("<img src=x onerror=alert(1)> and <svg onload=alert(1)>");
    // Rendered as inert escaped text, never as elements: no real tags or
    // attributes exist (the words only survive inside escaped text).
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<svg");
    expect(out).toContain("&lt;img");
    expect(out).toContain("&gt;");
  });

  it("strips javascript: link targets", () => {
    const out = html("[click](javascript:alert(1))");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("click");
  });

  it("strips data: link targets and script payloads", () => {
    const out = html("[x](data:text/html,<script>alert(1)</script>)");
    expect(out).not.toContain("data:");
    expect(out).not.toContain("<script");
  });

  it("escapes scripts inside code blocks", () => {
    const out = html("```js\n<script>alert(1)</script>\n```");
    expect(out).not.toContain("<script>alert");
    expect(out).toContain("&lt;script&gt;");
  });

  it("hardens external links", () => {
    const out = html("[site](https://example.com) and https://example.com/auto");
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  it("highlights known @mentions only", () => {
    const out = html("hi @anna and @stranger!", ["anna"]);
    expect(out).toContain("@anna");
    expect(out).toContain("@stranger");
    // Exactly one highlighted mention span.
    expect(out.match(/<span class="rounded/g)?.length ?? 0).toBe(1);
  });

  it("renders quotes and lists", () => {
    const out = html("> quoted\n\n- one\n- two");
    expect(out).toContain("<blockquote");
    expect(out).toContain("<ul");
  });
});
