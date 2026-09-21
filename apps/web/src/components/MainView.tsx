import { useState } from "react";
import { Volume2 } from "lucide-react";
import type { Channel, ServerState } from "@vitality/shared";
import { displayNameOf } from "../lib/format.js";
import { StreamTile } from "./StreamTile.js";

// Voice channel view: active stream tiles (opt-in watching) or an
// explanatory empty state. Text channels render ChatView (see App shell).
export function MainView({
  channel,
  state,
}: {
  channel: Channel | null;
  state: ServerState | null;
}): React.JSX.Element {
  const [theater, setTheater] = useState<string | null>(null);

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
  const theaterSharer = sharers.find((entry) => entry.userId === theater) ?? null;

  return (
    <div className="flex min-w-0 flex-1 flex-col [background-color:var(--surface-3)]">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-black/20 px-4">
        <Volume2 size={18} aria-hidden="true" className="[color:var(--text-muted)]" />
        <h2 className="truncate text-sm font-semibold">{channel.name}</h2>
        {sharers.length > 0 ? (
          <span
            aria-label={`${sharers.length} live streams`}
            className="rounded px-1.5 py-0.5 text-[10px] font-bold text-white"
            style={{ backgroundColor: "#ed4245" }}
          >
            {sharers.length} LIVE
          </span>
        ) : null}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {theaterSharer !== null ? (
          <StreamTile
            sharerId={theaterSharer.userId}
            sharerName={sharerDisplayName(byId, theaterSharer.userId)}
            theater
            onTheater={setTheater}
          />
        ) : null}
        {sharers.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-6">
            <p className="max-w-md text-center text-sm [color:var(--text-muted)]">
              No one is sharing right now. Click a voice channel to join it,
              then use the screen button in the bottom-left panel.
            </p>
          </div>
        ) : (
          sharers
            .filter((entry) => entry.userId !== theater)
            .map((entry) => (
              <StreamTile
                key={entry.userId}
                sharerId={entry.userId}
                sharerName={sharerDisplayName(byId, entry.userId)}
                theater={false}
                onTheater={setTheater}
              />
            ))
        )}
      </div>
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
