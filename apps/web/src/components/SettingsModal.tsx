import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { useMutation } from "@tanstack/react-query";
import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { LogOut, Trash2, Upload, X } from "lucide-react";
import type { ServerState, User } from "@vitality/shared";
import { queryClient } from "../api/queryClient.js";
import {
  patchMe,
  removeAvatar,
  uploadAvatar,
  validateAvatarFile,
} from "../api/resources.js";
import { ApiError } from "../api/http.js";
import { myAccess } from "../lib/membership.js";
import { useSessionStore } from "../store/session.js";
import { useUiStore } from "../store/ui.js";
import { Avatar } from "./Avatar.js";
import { ChannelsTab, InvitesTab, MembersTab } from "./AdminTabs.js";
import { Field, inputClass } from "./ui.js";
import { VoiceAudioTab } from "./VoiceAudioTab.js";

function AvatarPicker({ user }: { user: User }): React.JSX.Element {
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Object URL for the pre-upload preview; revoked on replace/unmount.
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const applyUser = (updated: User): void => {
    useSessionStore.setState({ user: updated });
    void queryClient.invalidateQueries({ queryKey: ["state"] });
  };

  const upload = useMutation({
    mutationFn: uploadAvatar,
    onMutate: () => {
      setError(null);
      setStatus("Uploading…");
    },
    onSuccess: (updated) => {
      applyUser(updated);
      setStatus(null);
    },
    onError: (err) => {
      setStatus(null);
      setError(err instanceof ApiError ? err.message : "Upload failed");
    },
  });

  const remove = useMutation({
    mutationFn: removeAvatar,
    onMutate: () => {
      setError(null);
      setStatus("Removing…");
    },
    onSuccess: (updated) => {
      applyUser(updated);
      setStatus(null);
    },
    onError: (err) => {
      setStatus(null);
      setError(err instanceof ApiError ? err.message : "Failed to remove avatar");
    },
  });

  const pick = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Reset immediately so re-picking the same file fires change again.
    event.target.value = "";
    if (file === undefined) {
      return;
    }
    const invalid = validateAvatarFile(file);
    if (invalid !== null) {
      setError(invalid);
      return;
    }
    setError(null);
    if (preview !== null) {
      URL.revokeObjectURL(preview);
    }
    setPreview(URL.createObjectURL(file));
    upload.mutate(file);
  };

  const busy = upload.isPending || remove.isPending;
  const hasCustom = (preview ?? user.avatarUrl ?? null) !== null;

  return (
    <div className="flex items-center gap-4">
      <div className="relative">
        {preview === null ? (
          <Avatar name={user.displayName || user.username} id={user.id} src={user.avatarUrl} size={64} />
        ) : (
          // Plain object-URL preview: not a Next Image, by design.
          <img
            src={preview}
            alt="New avatar preview"
            className="h-16 w-16 rounded-full object-cover"
          />
        )}
        {busy ? (
          <span
            aria-label="Avatar upload in progress"
            className="absolute inset-0 animate-pulse rounded-full ring-2 [background-color:var(--surface-3)]"
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label="Avatar file"
            className="hidden"
            onChange={pick}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1.5 rounded px-3 py-1.5 text-sm text-white disabled:opacity-60"
            style={{ backgroundColor: "var(--accent-strong)" }}
          >
            <Upload size={14} aria-hidden="true" />
            {hasCustom ? "Replace avatar" : "Upload avatar"}
          </button>
          {hasCustom ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (preview !== null) {
                  URL.revokeObjectURL(preview);
                  setPreview(null);
                }
                remove.mutate();
              }}
              className="flex items-center gap-1.5 rounded px-3 py-1.5 text-sm text-red-400 disabled:opacity-60 hover:[background-color:var(--surface-3)]"
            >
              <Trash2 size={14} aria-hidden="true" />
              Remove avatar
            </button>
          ) : null}
        </div>
        <p className="text-xs [color:var(--text-muted)]">
          PNG, JPEG or WebP, up to 2 MB. Resized to 256×256.
        </p>
        {status === null ? null : (
          <p className="text-xs [color:var(--text-muted)]" role="status">
            {status}
          </p>
        )}
        {error === null ? null : (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function AccountTab({ user }: { user: User }): React.JSX.Element {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [error, setError] = useState<string | null>(null);
  const logout = useSessionStore((state) => state.logout);

  const save = useMutation({
    mutationFn: () => patchMe({ displayName: displayName.trim() }),
    onSuccess: (updated) => {
      useSessionStore.setState({ user: updated });
      void queryClient.invalidateQueries({ queryKey: ["state"] });
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Failed to save");
    },
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (displayName.trim().length > 0) {
      save.mutate();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Username (cannot be changed)">
          <input aria-label="Username" className={inputClass} value={user.username} disabled />
        </Field>
        <Field label="Display name">
          <input
            aria-label="Display name"
            className={inputClass}
            value={displayName}
            maxLength={64}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </Field>
        <Field label="Avatar">
          <AvatarPicker user={user} />
        </Field>
        {error === null ? null : (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={save.isPending}
          className="self-start rounded px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          style={{ backgroundColor: "var(--accent-strong)" }}
        >
          {save.isPending ? "Saving…" : "Save changes"}
        </button>
      </form>
      <button
        type="button"
        onClick={() => void logout()}
        className="flex items-center gap-2 self-start rounded px-3 py-1.5 text-sm text-red-400 hover:[background-color:var(--surface-3)]"
      >
        <LogOut size={14} aria-hidden="true" />
        Log out
      </button>
    </div>
  );
}

export function SettingsModal({
  state,
  myUserId,
}: {
  state: ServerState | null;
  myUserId: string;
}): React.JSX.Element {
  const open = useUiStore((state) => state.settingsOpen);
  const tab = useUiStore((state) => state.settingsTab);
  const setSettings = useUiStore((state) => state.setSettings);
  const user = useSessionStore((state) => state.user);

  const access = state === null ? null : myAccess(state, myUserId);
  const showChannels = access?.canManageChannels === true;
  const showTeam = access?.canManageMembers === true;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) {
          setSettings(false);
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 flex h-[min(80vh,40rem)] w-[min(94vw,52rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg p-0 [background-color:var(--surface-2)] md:flex-row"
        >
          <Dialog.Title className="sr-only">Settings</Dialog.Title>
          <Tabs.Root
            value={tab}
            onValueChange={(value) => setSettings(true, value)}
            orientation="vertical"
            className="flex min-h-0 flex-1 flex-col md:flex-row"
          >
            <Tabs.List
              aria-label="Settings sections"
              className="flex shrink-0 gap-1 overflow-x-auto p-4 [background-color:var(--surface-1)] md:w-48 md:flex-col"
            >
              <Tabs.Trigger
                value="account"
                className="rounded px-3 py-1.5 text-left text-sm data-[state=active]:[background-color:var(--surface-3)]"
              >
                Account
              </Tabs.Trigger>
              <Tabs.Trigger
                value="voice"
                className="rounded px-3 py-1.5 text-left text-sm data-[state=active]:[background-color:var(--surface-3)]"
              >
                Voice &amp; Audio
              </Tabs.Trigger>
              {showChannels ? (
                <Tabs.Trigger
                  value="channels"
                  className="rounded px-3 py-1.5 text-left text-sm data-[state=active]:[background-color:var(--surface-3)]"
                >
                  Channels
                </Tabs.Trigger>
              ) : null}
              {showTeam ? (
                <>
                  <Tabs.Trigger
                    value="invites"
                    className="rounded px-3 py-1.5 text-left text-sm data-[state=active]:[background-color:var(--surface-3)]"
                  >
                    Invites
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="members"
                    className="rounded px-3 py-1.5 text-left text-sm data-[state=active]:[background-color:var(--surface-3)]"
                  >
                    Members
                  </Tabs.Trigger>
                </>
              ) : null}
            </Tabs.List>
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <Tabs.Content value="account">
                {user === null ? null : <AccountTab user={user} />}
              </Tabs.Content>
              <Tabs.Content value="voice">
                <VoiceAudioTab />
              </Tabs.Content>
              {showChannels && state !== null ? (
                <Tabs.Content value="channels">
                  <ChannelsTab state={state} />
                </Tabs.Content>
              ) : null}
              {showTeam && state !== null ? (
                <Tabs.Content value="invites">
                  <InvitesTab state={state} />
                </Tabs.Content>
              ) : null}
              {showTeam && state !== null ? (
                <Tabs.Content value="members">
                  <MembersTab state={state} myUserId={myUserId} />
                </Tabs.Content>
              ) : null}
            </div>
          </Tabs.Root>
          <Dialog.Close asChild>
            <button
              type="button"
              aria-label="Close settings"
              className="absolute right-3 top-3 rounded p-1 [color:var(--text-muted)] hover:[background-color:var(--surface-3)]"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
