import { useInfiniteQuery } from "@tanstack/react-query";
import {
  useLayoutEffect,
  useRef,
  type UIEvent,
} from "react";
import type { MemberWithUser } from "@vitality/shared";
import { fetchHistory } from "../api/resources.js";
import { displayNameOf } from "../lib/format.js";
import { MessageItem } from "./MessageItem.js";

const PAGE_LIMIT = 30;
const BOTTOM_THRESHOLD_PX = 80;

export function MessageList({
  channelId,
  members,
  myUserId,
  canModerate,
  lastReadId,
  onConsumeRead,
}: {
  channelId: string;
  members: MemberWithUser[];
  myUserId: string;
  canModerate: boolean;
  lastReadId: string | null;
  onConsumeRead: (id: string) => void;
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const anchorHeightRef = useRef(0);
  const anchorArmedRef = useRef(false);
  const mountedRef = useRef(false);

  const history = useInfiniteQuery({
    queryKey: ["messages", channelId],
    queryFn: ({ pageParam }: { pageParam?: { before?: string } }) =>
      fetchHistory(channelId, { limit: PAGE_LIMIT, ...pageParam }),
    initialPageParam: undefined as { before?: string } | undefined,
    getNextPageParam: (lastPage) => {
      const oldest = lastPage.messages[0];
      return lastPage.hasMoreBefore && oldest !== undefined
        ? { before: oldest.id }
        : undefined;
    },
  });

  const flat = (history.data?.pages ?? []).flatMap((page) => page.messages);
  const usernames = members.map((member) => member.user.username);
  const byId = new Map(members.map((member) => [member.userId, member]));

  // Upward infinite scroll: arm scroll anchoring before fetching older pages.
  useLayoutEffect(() => {
    const sentinel = sentinelRef.current;
    const container = containerRef.current;
    if (sentinel === null || container === null) {
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries[0]?.isIntersecting === true;
        if (
          visible &&
          history.hasNextPage &&
          !history.isFetchingNextPage
        ) {
          anchorHeightRef.current = container.scrollHeight;
          anchorArmedRef.current = true;
          void history.fetchNextPage();
        }
      },
      { root: container, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [history.hasNextPage, history.isFetchingNextPage, history.fetchNextPage]);

  // Initial scroll to bottom.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!mountedRef.current && container !== null && flat.length > 0) {
      mountedRef.current = true;
      container.scrollTop = container.scrollHeight;
    }
  }, [history.data]);

  // Scroll anchoring after older pages arrive; auto-scroll on new messages
  // only when already at the bottom.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    if (anchorArmedRef.current) {
      anchorArmedRef.current = false;
      container.scrollTop += container.scrollHeight - anchorHeightRef.current;
      return;
    }
    if (atBottomRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [history.data]);

  const handleScroll = (event: UIEvent<HTMLDivElement>): void => {
    const target = event.currentTarget;
    atBottomRef.current =
      target.scrollHeight - target.scrollTop - target.clientHeight <
      BOTTOM_THRESHOLD_PX;
  };

  // Mark read when the newest message is visible at the bottom.
  const latestId = flat.length > 0 ? flat[flat.length - 1]?.id : undefined;
  useLayoutEffect(() => {
    if (
      latestId !== undefined &&
      atBottomRef.current &&
      latestId !== lastReadId
    ) {
      onConsumeRead(latestId);
    }
  }, [latestId]);

  const dividerIndex =
    lastReadId === null ? -1 : flat.findIndex((entry) => entry.id > lastReadId);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      aria-label="Message history"
      className="flex-1 overflow-y-auto py-2"
    >
      <div ref={sentinelRef} aria-hidden="true" className="h-px" />
      {history.isFetchingNextPage ? (
        <p role="status" className="py-2 text-center text-xs [color:var(--text-muted)]">
          Loading older messages…
        </p>
      ) : null}
      {flat.length === 0 && !history.isPending ? (
        <p className="px-4 py-6 text-center text-sm [color:var(--text-muted)]">
          No messages yet. Say hello!
        </p>
      ) : null}
      {flat.map((message, index) => {
        const member = byId.get(message.authorId);
        const name = member
          ? displayNameOf(member.user.displayName, member.user.username)
          : "Unknown user";
        return (
          <div key={message.id}>
            {index === dividerIndex ? (
              <div
                role="separator"
                aria-label="New messages"
                className="mx-4 my-2 flex items-center gap-2 text-xs font-medium"
                style={{ color: "var(--accent)" }}
              >
                <span aria-hidden="true" className="h-px flex-1" style={{ backgroundColor: "var(--accent)" }} />
                New messages
                <span aria-hidden="true" className="h-px flex-1" style={{ backgroundColor: "var(--accent)" }} />
              </div>
            ) : null}
            <MessageItem
              message={message}
              authorName={name}
              authorUsername={member?.user.username ?? "unknown"}
              authorAvatar={member?.user.avatarUrl ?? null}
              isOwn={message.authorId === myUserId}
              canModerate={canModerate}
              usernames={usernames}
              mentioned={message.mentions.includes(myUserId)}
            />
          </div>
        );
      })}
    </div>
  );
}
