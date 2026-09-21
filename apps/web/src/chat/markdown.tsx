import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Children, isValidElement, type ReactNode } from "react";
import { MENTION_PATTERN_SOURCE } from "@vitality/shared";

const MENTION_RE = new RegExp(MENTION_PATTERN_SOURCE, "g");

/** Link targets considered safe. Everything else renders without href. */
export function safeUrl(href: string): string | null {
  const trimmed = href.trim();
  if (
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("#")
  ) {
    return trimmed;
  }
  return null;
}

function splitMentions(text: string, usernames: Set<string>): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(MENTION_RE)) {
    const name = match[1];
    const index = match.index ?? 0;
    if (name === undefined || !usernames.has(name)) {
      continue;
    }
    if (index > last) {
      out.push(text.slice(last, index));
    }
    out.push(
      <span
        key={`m-${key++}`}
        className="rounded px-0.5 font-medium"
        style={{ backgroundColor: "var(--accent)", color: "#fff" }}
      >
        @{name}
      </span>,
    );
    last = index + match[0].length;
  }
  if (last < text.length) {
    out.push(text.slice(last));
  }
  return out;
}

function highlightChild(child: ReactNode, usernames: Set<string>, key: number): ReactNode {
  if (typeof child !== "string") {
    return child;
  }
  const parts = splitMentions(child, usernames);
  if (parts.length === 1 && parts[0] === child) {
    return child;
  }
  return <span key={`t-${key}`}>{parts}</span>;
}

/**
 * Sanitizing markdown pipeline:
 * - no raw-HTML plugin, so `<tags>` render as inert text, never elements;
 * - links allowlisted by safeUrl + rel/target hardening;
 * - @mentions of known members highlighted (top-level text only; mentions
 *   inside code/bold are left alone — "basic" per spec).
 */
export function MessageBody({
  content,
  usernames,
}: {
  content: string;
  usernames: string[];
}): React.JSX.Element {
  const known = new Set(usernames);
  const components: Components = {
    a: ({ href, children }) => {
      const safe = typeof href === "string" ? safeUrl(href) : null;
      if (safe === null) {
        return <span>{children}</span>;
      }
      const external = safe.startsWith("http://") || safe.startsWith("https://");
      return (
        <a
          href={safe}
          {...(external
            ? { target: "_blank", rel: "noopener noreferrer nofollow" }
            : {})}
          className="underline"
          style={{ color: "var(--accent)" }}
        >
          {children}
        </a>
      );
    },
    p: ({ children }) => (
      <p className="my-1 first:mt-0 last:mb-0">
        {Children.map(children, (child, index) =>
          isValidElement(child)
            ? child
            : highlightChild(child, known, index),
        )}
      </p>
    ),
    code: ({ children }) => (
      <code className="rounded px-1 py-0.5 font-mono text-[0.85em] [background-color:var(--surface-1)]">
        {children}
      </code>
    ),
    pre: ({ children }) => (
      <pre className="my-2 overflow-x-auto rounded p-2 font-mono text-[0.85em] [background-color:var(--surface-1)]">
        {children}
      </pre>
    ),
    blockquote: ({ children }) => (
      <blockquote className="my-1 border-l-2 pl-2 [border-color:var(--text-muted)]">
        {children}
      </blockquote>
    ),
    ul: ({ children }) => <ul className="my-1 list-disc pl-5">{children}</ul>,
    ol: ({ children }) => <ol className="my-1 list-decimal pl-5">{children}</ol>,
    table: ({ children }) => (
      <table className="my-2 border-collapse text-sm">{children}</table>
    ),
    th: ({ children }) => (
      <th className="border px-2 py-1 text-left [border-color:var(--surface-1)]">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="border px-2 py-1 [border-color:var(--surface-1)]">{children}</td>
    ),
  };
  return (
    <div className="break-words text-sm leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={safeUrl}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default MessageBody;
