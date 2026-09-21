import { Hash, Volume2 } from "lucide-react";
import type { Channel } from "@vitality/shared";

export function MainView({ channel }: { channel: Channel | null }): React.JSX.Element {
  if (channel === null) {
    return (
      <div className="flex flex-1 items-center justify-center [background-color:var(--surface-3)]">
        <p className="text-sm [color:var(--text-muted)]">
          Select a channel to get started.
        </p>
      </div>
    );
  }

  const Icon = channel.type === "voice" ? Volume2 : Hash;
  const note =
    channel.type === "voice"
      ? "Voice channels arrive in Phase 4 (LiveKit): sidebar participants, mute/deafen, push-to-talk."
      : "Text chat arrives in Phase 3: history, markdown, uploads, typing, unread badges.";

  return (
    <div className="flex min-w-0 flex-1 flex-col [background-color:var(--surface-3)]">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-black/20 px-4">
        <Icon size={18} aria-hidden="true" className="[color:var(--text-muted)]" />
        <h2 className="truncate text-sm font-semibold">{channel.name}</h2>
      </header>
      <div className="flex flex-1 items-center justify-center px-6">
        <p className="max-w-md text-center text-sm [color:var(--text-muted)]">
          {note}
        </p>
      </div>
    </div>
  );
}
