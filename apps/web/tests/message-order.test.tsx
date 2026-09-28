// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@vitality/shared";
import type { HistoryPage } from "../src/api/resources.js";

/**
 * The page the REST history endpoint returns is ASCENDING (oldest -> newest)
 * and page 1 is always the NEWEST page; every older page loaded afterwards is
 * fetched with `before:` and lands BEHIND it in time. React Query appends
 * fetched pages to the END of `pages`, so the flat list must be built with the
 * pages reversed or the list renders newest-first with the oldest messages
 * below them.
 */
const store = vi.hoisted(() => ({
  pages: [] as HistoryPage[],
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useInfiniteQuery: () => ({
      data: { pages: store.pages, pageParams: store.pages.map(() => undefined) },
      hasNextPage: false,
      isFetchingNextPage: false,
      isPending: store.pages.length === 0,
      isError: false,
      refetch: () => Promise.resolve(),
      fetchNextPage: () => Promise.resolve(),
    }),
  };
});

vi.mock("../src/chat/markdown.js", () => ({
  default: ({ content }: { content: string }): React.JSX.Element => <p>{content}</p>,
}));

import { MessageList } from "../src/chat/MessageList.js";

let container: HTMLDivElement | null = null;
let unmountTree: (() => Promise<void>) | null = null;

/** Ascending page of fake messages (m1 older than m2 ...). */
function page(ids: string[]): HistoryPage {
  return {
    messages: ids.map((id) => message(id)),
    hasMoreBefore: false,
    hasMoreAfter: false,
  };
}

function message(id: string): ChatMessage {
  return {
    id,
    channelId: "11111111-1111-1111-8111-111111111111",
    authorId: "22222222-2222-2222-8222-222222222222",
    content: `body-${id}`,
    createdAt: new Date(0).toISOString(),
    editedAt: null,
    deletedAt: null,
    attachments: [],
    mentions: [],
  };
}

class FakeIntersectionObserver {
  observe(): void {
    // No paging driven here; the pages are installed directly.
  }
  disconnect(): void {
    // Nothing observing.
  }
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  store.pages = [];
});

afterEach(async () => {
  if (unmountTree !== null) {
    const unmount = unmountTree;
    unmountTree = null;
    await unmount();
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
  vi.unstubAllGlobals();
});

async function renderList(): Promise<void> {
  if (unmountTree !== null) {
    const unmount = unmountTree;
    unmountTree = null;
    await unmount();
  }
  if (container === null) {
    container = document.createElement("div");
    document.body.appendChild(container);
  }
  const root = createRoot(container);
  unmountTree = async () => {
    await act(async () => {
      root.unmount();
    });
  };
  const client = new QueryClient();
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MessageList
          channelId="11111111-1111-1111-8111-111111111111"
          members={[]}
          myUserId="me"
          canModerate={false}
          lastReadId={null}
          onConsumeRead={() => undefined}
        />
      </QueryClientProvider>,
    );
  });
}

async function renderedBodies(): Promise<string[]> {
  // The mocked message body is the only <p> per row.
  return [...container!.querySelectorAll("p")]
    .map((element) => element.textContent ?? "")
    .filter((text) => text.startsWith("body-"));
}

describe("message list page merge", () => {
  it("renders a single page oldest-first", async () => {
    store.pages = [page(["m1", "m2", "m3"])];
    await renderList();
    expect(await renderedBodies()).toEqual(["body-m1", "body-m2", "body-m3"]);
  });

  it("keeps chronological order after an older page is loaded", async () => {
    // Page 1 = newest 3; page 2 (fetched with `before:`) = older 3. Pages are
    // appended in fetch order, so a naive flatMap renders m4..m6 followed by
    // m1..m3 and a message that arrives live lands at the very bottom.
    store.pages = [page(["m4", "m5", "m6"]), page(["m1", "m2", "m3"])];
    await renderList();
    expect(await renderedBodies()).toEqual([
      "body-m1",
      "body-m2",
      "body-m3",
      "body-m4",
      "body-m5",
      "body-m6",
    ]);
  });

  it("appends a live message to the newest page (bottom of the list)", async () => {
    // The socket handler appends an incoming message to the LAST page it
    // holds, which is the newest page once the pages are merged oldest-first.
    store.pages = [
      page(["m4", "m5", "m6", "m7"]),
      page(["m1", "m2", "m3"]),
    ];
    await renderList();
    const bodies = await renderedBodies();
    expect(bodies).toEqual([
      "body-m1",
      "body-m2",
      "body-m3",
      "body-m4",
      "body-m5",
      "body-m6",
      "body-m7",
    ]);
  });
});
