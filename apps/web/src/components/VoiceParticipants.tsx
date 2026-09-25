import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Headphones, MicOff, MonitorUp } from "lucide-react";
import type { MemberWithUser, VoiceParticipant } from "@vitality/shared";
import { queryClient } from "../api/queryClient.js";
import { moderateVoiceDisconnect, moderateVoiceMute } from "../api/resources.js";
import { ApiError } from "../api/http.js";
import { displayNameOf } from "../lib/format.js";
import { useVoiceSettings } from "../voice/settings.js";
import { applyUserVolume } from "../voice/room.js";
import { useVoiceConnection } from "../voice/store.js";
import { Avatar } from "./Avatar.js";

function ParticipantMenu({
  channelId,
  participant,
  member,
  isSelf,
  canModerate,
  serverId,
}: {
  channelId: string;
  participant: VoiceParticipant;
  member?: MemberWithUser;
  isSelf: boolean;
  canModerate: boolean;
  serverId: string;
}): React.JSX.Element | null {
  const volumes = useVoiceSettings((state) => state.userVolumes);
  const setUserVolume = useVoiceSettings((state) => state.setUserVolume);
  const [error, setError] = useState<string | null>(null);
  const volume = volumes[participant.userId] ?? 1;

  const muteMutation = useMutation({
    mutationFn: (muted: boolean) =>
      moderateVoiceMute(channelId, participant.userId, muted),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["state", serverId] });
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Moderation failed");
    },
  });
  const kickMutation = useMutation({
    mutationFn: () => moderateVoiceDisconnect(channelId, participant.userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["state", serverId] });
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Disconnect failed");
    },
  });

  const name = member
    ? displayNameOf(member.user.displayName, member.user.username)
    : "Unknown user";

  return (
    <DropdownMenu.Root onOpenChange={() => setError(null)}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`Voice options for ${name}`}
          className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:[background-color:var(--surface-3)]"
        >
          <ParticipantRow
            participant={participant}
            member={member}
          />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="right"
          align="start"
          className="z-50 w-56 rounded p-2 text-sm [background-color:var(--surface-1)]"
        >
          <div className="px-2 py-1.5">
            <label htmlFor={`vol-${participant.userId}`} className="text-xs [color:var(--text-muted)]">
              Volume — {name} · {Math.round(volume * 100)}%
            </label>
            <input
              id={`vol-${participant.userId}`}
              type="range"
              min={0}
              max={400}
              value={Math.round(volume * 100)}
              onChange={(event) => {
                const next = Number(event.target.value) / 100;
                setUserVolume(participant.userId, next);
                applyUserVolume(participant.userId, next);
              }}
              className="w-full"
            />
          </div>
          {canModerate && !isSelf ? (
            <>
              <DropdownMenu.Separator className="my-1 h-px [background-color:var(--surface-3)]" />
              <DropdownMenu.Item
                onSelect={() => muteMutation.mutate(!participant.serverMuted)}
                className="cursor-pointer rounded px-2 py-1.5 outline-none hover:[background-color:var(--surface-3)]"
              >
                {participant.serverMuted ? "Lift server mute" : "Server mute"}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() => kickMutation.mutate()}
                className="cursor-pointer rounded px-2 py-1.5 text-red-400 outline-none hover:[background-color:var(--surface-3)]"
              >
                Disconnect from voice
              </DropdownMenu.Item>
            </>
          ) : null}
          {error === null ? null : (
            <p role="alert" className="px-2 py-1 text-xs text-red-400">
              {error}
            </p>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ParticipantRow({
  participant,
  member,
}: {
  participant: VoiceParticipant;
  member?: MemberWithUser;
}): React.JSX.Element {
  const speakingIds = useVoiceConnection((state) => state.speakingIds);
  const speaking = speakingIds.includes(participant.userId);
  const name = member
    ? displayNameOf(member.user.displayName, member.user.username)
    : "Unknown user";

  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span
        className="rounded-full p-0.5"
        style={speaking ? { boxShadow: "0 0 0 2px var(--accent)" } : undefined}
      >
        <Avatar
          name={name}
          id={member?.user.id}
          src={member?.user.avatarUrl ?? null}
          size={24}
        />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
      {participant.sharingScreen ? (
        <span
          aria-label={`${name} is sharing live`}
          className="shrink-0 rounded px-1 py-px text-[10px] font-bold text-white"
          style={{ backgroundColor: "var(--live)" }}
        >
          LIVE
        </span>
      ) : null}
      {participant.sharingScreen ? (
        <span aria-label={`${name} is sharing their screen`} role="img">
          <MonitorUp size={14} aria-hidden="true" className="[color:var(--text-muted)]" />
        </span>
      ) : null}
      {participant.deafened ? (
        <span role="img" aria-label={`${name} is deafened`} className="shrink-0 text-red-400">
          <Headphones size={14} aria-hidden="true" />
        </span>
      ) : participant.muted || participant.serverMuted ? (
        <span role="img" aria-label={`${name} is muted`} className="shrink-0 text-red-400">
          <MicOff size={14} aria-hidden="true" />
        </span>
      ) : null}
    </span>
  );
}

export function VoiceParticipants({
  channelId,
  serverId,
  participants,
  members,
  myUserId,
  canModerate,
}: {
  channelId: string;
  serverId: string;
  participants: VoiceParticipant[];
  members: MemberWithUser[];
  myUserId: string;
  canModerate: boolean;
}): React.JSX.Element | null {
  if (participants.length === 0) {
    return null;
  }
  const byId = new Map(members.map((member) => [member.userId, member]));
  return (
    <ul aria-label="Voice participants" className="ml-6 flex flex-col gap-0.5 pb-1">
      {participants.map((participant) => (
        <li key={participant.userId}>
          <ParticipantMenu
            channelId={channelId}
            serverId={serverId}
            participant={participant}
            member={byId.get(participant.userId)}
            isSelf={participant.userId === myUserId}
            canModerate={canModerate}
          />
        </li>
      ))}
    </ul>
  );
}
