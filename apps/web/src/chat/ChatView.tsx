import { useState } from "react";
import { Hash } from "lucide-react";
import type { Channel, ServerState } from "@vitality/shared";
import { queryClient } from "../api/queryClient.js";
import { markChannelRead } from "../api/resources.js";
import { displayNameOf } from "../lib/format.js";
import { myAccess } from "../lib/membership.js";
import { usePresenceStore } from "../store/presence.js";
import { MessageList } from "./MessageList.js";
import { Composer } from "./Composer.js";

function TypingBar({
  channelId,
  state,
}: {
  channelId: string;
  state: ServerState;
}): React.JSX.Element | null {
  const typing = usePresenceStore((store) => store.typing[channelId]);
  const names = Object.entries(typing ?? {})
    .filter(([, until]) => until > Date.now())
    .map(([userId]) => state.members.find((entry) => entry.userId === userId))
    .filter((member) => member !== undefined)
    .map((member) => displayNameOf(member.user.displayName, member.user.username));
  if (names.length === 0) {
    return <div aria-hidden="true" className="h-5 shrink-0" />;
  }
  const text =
    names.length === 1
      ? `${names[0]} is typing…`
      : names.length === 2
        ? `${names[0]} and ${names[1]} are typing…`
        : "Several people are typing…";
  return (
    <p role="status" className="h-5 shrink-0 px-4 text-xs [color:var(--text-muted)]">
      {text}
    </p>
  );
}

export function ChatView({
  channel,
  state,
  myUserId,
}: {
  channel: Channel;
  state: ServerState;
  myUserId: string;
}): React.JSX.Element {
  const initial = state.readStates.find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { channelId?: unknown }).channelId === channel.id,
  ) as { lastReadMessageId?: unknown } | undefined;
  const initialLastRead =
    typeof initial?.lastReadMessageId === "string" ? initial.lastReadMessageId : null;
  const [lastReadId, setLastReadId] = useState<string | null>(initialLastRead);

  const access = myAccess(state, myUserId);
  const roleName = state.roles.find((role) => role.id === access?.roleId)?.name;
  const canModerate = access?.isOwner === true || roleName === "admin";

  const consumeRead = (id: string): void => {
    setLastReadId(id);
    markChannelRead(channel.id, id)
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: ["unread", state.server.id] });
      })
      .catch(() => {
        // Next mount or message retries; read state is best-effort here.
      });
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col [background-color:var(--surface-3)]">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-black/20 px-4">
        <Hash size={18} aria-hidden="true" className="[color:var(--text-muted)]" />
        <h2 className="truncate text-sm font-semibold">{channel.name}</h2>
      </header>
      <MessageList
        channelId={channel.id}
        members={state.members}
        myUserId={myUserId}
        canModerate={canModerate}
        lastReadId={lastReadId}
        onConsumeRead={consumeRead}
      />
      <TypingBar channelId={channel.id} state={state} />
      <Composer channelId={channel.id} members={state.members} myUserId={myUserId} />
    </div>
  );
}
