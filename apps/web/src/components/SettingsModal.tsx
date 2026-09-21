import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { LogOut, X } from "lucide-react";
import type { ServerState, User } from "@vitality/shared";
import { queryClient } from "../api/queryClient.js";
import { patchMe } from "../api/resources.js";
import { ApiError } from "../api/http.js";
import { myAccess } from "../lib/membership.js";
import { useSessionStore } from "../store/session.js";
import { useUiStore } from "../store/ui.js";
import { ChannelsTab, InvitesTab, MembersTab } from "./AdminTabs.js";
import { Field, inputClass } from "./ui.js";

function AccountTab({ user }: { user: User }): React.JSX.Element {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const logout = useSessionStore((state) => state.logout);

  const save = useMutation({
    mutationFn: () =>
      patchMe({
        displayName: displayName.trim(),
        avatarUrl: avatarUrl.trim().length > 0 ? avatarUrl.trim() : null,
      }),
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
        <Field label="Avatar URL (blank = initials)">
          <input
            aria-label="Avatar URL"
            className={inputClass}
            value={avatarUrl}
            maxLength={2048}
            onChange={(event) => setAvatarUrl(event.target.value)}
            placeholder="https://…"
          />
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
          style={{ backgroundColor: "var(--accent)" }}
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
