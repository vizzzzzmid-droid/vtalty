import type { Channel, ServerState } from "@vitality/shared";
import { Volume2 } from "lucide-react";
import { displayNameOf } from "../lib/format.js";
import { StreamTile } from "./StreamTile.js";

// Voice channel view: screen-share cards in a responsive grid (opt-in
// watching) or an explanatory empty state. Text channels render ChatView
// (see App shell).
export function MainView({
  channel,
  state,
  myUserId,
}: {
  channel: Channel | null;
  state: ServerState | null;
  /** Local user id, so the sharer's own tile is marked (no self-watch). */
  myUserId: string;
}): React.JSX.Element {
  if (channel === null) {
    return (
      <div className="flex flex-1 items-center justify-center [background-color:var(--surface-3)]">
        <p className="text-sm [color:var(--text-muted)]">
          Select a channel to get started.
        </p>
      </div>
    );
  }

  const voice =
    state?.voice.find((entry) => entry.channelId === channel.id) ?? null;
  const sharers = (voice?.participants ?? []).filter(
    (participant) => participant.sharingScreen,
  );
  const byId = new Map((state?.members ?? []).map((member) => [member.userId, member]));

  return (
    <div className="flex min-w-0 flex-1 flex-col [background-color:var(--surface-3)]">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-black/20 px-4">
        <Volume2 size={18} aria-hidden="true" className="[color:var(--text-muted)]" />
        <h2 className="truncate text-sm font-semibold">{channel.name}</h2>
        {sharers.length > 0 ? (
          <span
            aria-label={`${sharers.length} live streams`}
            className="rounded px-1.5 py-0.5 text-[10px] font-bold text-white"
            style={{ backgroundColor: "var(--live)" }}
          >
            {sharers.length} LIVE
          </span>
        ) : null}
      </header>
      {sharers.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <p className="max-w-md text-center text-sm [color:var(--text-muted)]">
            No one is sharing right now. Click a voice channel to join it,
            then use the screen button in the bottom-left panel.
          </p>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]">
          {sharers.map((entry) => (
            <StreamTile
              key={entry.userId}
              sharerId={entry.userId}
              sharerName={sharerDisplayName(byId, entry.userId)}
              sharerAvatarUrl={byId.get(entry.userId)?.user.avatarUrl ?? null}
              isSelf={entry.userId === myUserId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function sharerDisplayName(
  byId: Map<string, { user: { displayName: string; username: string } }>,
  userId: string,
): string {
  const member = byId.get(userId);
  return member ? displayNameOf(member.user.displayName, member.user.username) : "Unknown user";
}