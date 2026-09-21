import { Headphones, Mic, MicOff, PhoneOff, Settings } from "lucide-react";
import type { User } from "@vitality/shared";
import { displayNameOf } from "../lib/format.js";
import { useUiStore } from "../store/ui.js";
import {
  joinVoiceChannel,
  leaveVoiceChannel,
  setSelfDeafened,
  setSelfMuted,
} from "../voice/room.js";
import { qualityDots, useVoiceConnection } from "../voice/store.js";
import { Avatar } from "./Avatar.js";
import { Tip } from "./ui.js";

function ConnectionBox({
  channelId,
  channelName,
}: {
  channelId: string;
  channelName: string;
}): React.JSX.Element {
  const status = useVoiceConnection((state) => state.status);
  const error = useVoiceConnection((state) => state.error);
  const quality = useVoiceConnection((state) => state.connectionQuality);
  const dots = qualityDots(quality);

  return (
    <div className="border-t border-black/20 px-2 py-2 [background-color:var(--surface-1)]">
      {status === "reconnecting" ? (
        <p role="status" className="px-1 pb-1 text-xs text-amber-400">
          Reconnecting to voice…
        </p>
      ) : null}
      {status === "failed" ? (
        <div className="px-1 pb-1">
          <p role="alert" className="text-xs text-red-400">
            {error ?? "Voice connection failed."}
          </p>
          <button
            type="button"
            onClick={() => void joinVoiceChannel(channelId)}
            className="mt-1 rounded px-2 py-0.5 text-xs [background-color:var(--surface-3)] hover:brightness-110"
          >
            Retry join
          </button>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <span
          role="img"
          aria-label={`Connection quality: ${quality}`}
          className="flex items-end gap-0.5"
        >
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              aria-hidden="true"
              className="w-1 rounded-sm"
              style={{
                height: 4 + index * 3,
                backgroundColor:
                  index < dots ? "var(--status-ok)" : "var(--surface-3)",
              }}
            />
          ))}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {channelName}
        </span>
        <Tip label="Disconnect from voice" side="top">
          <button
            type="button"
            aria-label="Disconnect from voice"
            onClick={() => void leaveVoiceChannel()}
            className="rounded p-1.5 text-red-400 hover:[background-color:var(--surface-3)]"
          >
            <PhoneOff size={16} aria-hidden="true" />
          </button>
        </Tip>
      </div>
    </div>
  );
}

export function UserPanel({
  user,
  channelId,
  channelName,
}: {
  user: User;
  channelId: string | null;
  channelName: string | null;
}): React.JSX.Element {
  const setSettings = useUiStore((state) => state.setSettings);
  const selfMuted = useVoiceConnection((state) => state.selfMuted);
  const selfDeafened = useVoiceConnection((state) => state.selfDeafened);
  const status = useVoiceConnection((state) => state.status);
  const name = displayNameOf(user.displayName, user.username);
  const connected = status === "connected" || status === "reconnecting";

  return (
    <div className="shrink-0 [background-color:var(--surface-1)]">
      {connected && channelId !== null && channelName !== null ? (
        <ConnectionBox channelId={channelId} channelName={channelName} />
      ) : null}
      <div className="flex h-[52px] items-center gap-1 px-2">
        <Avatar name={name} src={user.avatarUrl} size={32} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{name}</div>
          <div className="truncate text-xs [color:var(--text-muted)]">
            @{user.username}
          </div>
        </div>
        <Tip label={selfMuted ? "Unmute microphone" : "Mute microphone"} side="top">
          <button
            type="button"
            aria-label={selfMuted ? "Unmute microphone" : "Mute microphone"}
            aria-pressed={selfMuted}
            onClick={() => void setSelfMuted(!selfMuted)}
            className={`rounded p-1.5 hover:[background-color:var(--surface-3)] ${
              selfMuted ? "text-red-400" : "[color:var(--text-muted)]"
            }`}
          >
            {selfMuted ? (
              <MicOff size={18} aria-hidden="true" />
            ) : (
              <Mic size={18} aria-hidden="true" />
            )}
          </button>
        </Tip>
        <Tip label={selfDeafened ? "Undeafen audio" : "Deafen audio"} side="top">
          <button
            type="button"
            aria-label={selfDeafened ? "Undeafen audio" : "Deafen audio"}
            aria-pressed={selfDeafened}
            onClick={() => void setSelfDeafened(!selfDeafened)}
            className={`rounded p-1.5 hover:[background-color:var(--surface-3)] ${
              selfDeafened ? "text-red-400" : "[color:var(--text-muted)]"
            }`}
          >
            <Headphones size={18} aria-hidden="true" />
          </button>
        </Tip>
        <Tip label="User settings" side="top">
          <button
            type="button"
            aria-label="Open user settings"
            onClick={() => setSettings(true, "account")}
            className="rounded p-1.5 [color:var(--text-muted)] hover:[background-color:var(--surface-3)] hover:[color:var(--text-primary)]"
          >
            <Settings size={18} aria-hidden="true" />
          </button>
        </Tip>
      </div>
    </div>
  );
}
