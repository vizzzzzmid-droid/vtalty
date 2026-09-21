import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Copy, LogOut, Trash2 } from "lucide-react";
import type { Invite, ServerState } from "@vitality/shared";
import { queryClient } from "../api/queryClient.js";
import {
  createInvite,
  deleteInvite,
  kickMember,
  listInvites,
  patchMember,
} from "../api/resources.js";
import { ApiError } from "../api/http.js";
import { displayNameOf } from "../lib/format.js";
import { CategoryDialog, ChannelDialog } from "./dialogs.js";
import { ConfirmDialog, Field, inputClass } from "./ui.js";

export function ChannelsTab({ state }: { state: ServerState }): React.JSX.Element {
  const serverId = state.server.id;
  const [dialog, setDialog] = useState<
    | { kind: "category-create" }
    | { kind: "category-edit"; id: string; name: string }
    | { kind: "channel-create"; categoryId: string | null }
    | null
  >(null);

  return (
    <div className="flex flex-col gap-5">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Categories</h3>
          <button
            type="button"
            onClick={() => setDialog({ kind: "category-create" })}
            className="rounded px-2 py-1 text-xs [background-color:var(--surface-3)] hover:brightness-110"
          >
            New category
          </button>
        </div>
        <ul className="flex flex-col gap-1">
          {state.categories.map((category) => (
            <li
              key={category.id}
              className="flex items-center justify-between rounded px-2 py-1.5 text-sm [background-color:var(--surface-3)]"
            >
              <span>{category.name}</span>
              <button
                type="button"
                onClick={() => setDialog({ kind: "category-edit", id: category.id, name: category.name })}
                className="rounded px-2 py-0.5 text-xs [color:var(--text-muted)] hover:[color:var(--text-primary)]"
              >
                Rename
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Channels</h3>
          <button
            type="button"
            onClick={() => setDialog({ kind: "channel-create", categoryId: null })}
            className="rounded px-2 py-1 text-xs [background-color:var(--surface-3)] hover:brightness-110"
          >
            New channel
          </button>
        </div>
        <ul className="flex flex-col gap-1">
          {state.channels.map((channel) => (
            <li
              key={channel.id}
              className="flex items-center justify-between rounded px-2 py-1.5 text-sm [background-color:var(--surface-3)]"
            >
              <span>
                {channel.type === "voice" ? "♪ " : "#"}
                {channel.name}
              </span>
              <span className="text-xs [color:var(--text-muted)]">{channel.type}</span>
            </li>
          ))}
        </ul>
      </section>
      {dialog?.kind === "category-create" ? (
        <CategoryDialog open serverId={serverId} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "category-edit" ? (
        <CategoryDialog
          open
          serverId={serverId}
          initial={{ id: dialog.id, name: dialog.name }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "channel-create" ? (
        <ChannelDialog
          open
          serverId={serverId}
          categoryId={dialog.categoryId}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

export function InvitesTab({ state }: { state: ServerState }): React.JSX.Element {
  const serverId = state.server.id;
  const [maxUses, setMaxUses] = useState("");
  const [expiresInHours, setExpiresInHours] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invitesQuery = useQuery({
    queryKey: ["invites", serverId],
    queryFn: () => listInvites(serverId),
  });
  const create = useMutation({
    mutationFn: () =>
      createInvite(serverId, {
        maxUses: maxUses.trim().length > 0 ? Number(maxUses) : null,
        expiresInHours: expiresInHours.trim().length > 0 ? Number(expiresInHours) : null,
      }),
    onSuccess: () => {
      void invitesQuery.refetch();
      setMaxUses("");
      setExpiresInHours("");
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Failed to create invite");
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => deleteInvite(id),
    onSuccess: () => {
      void invitesQuery.refetch();
    },
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    create.mutate();
  };

  const copy = async (invite: Invite): Promise<void> => {
    try {
      await navigator.clipboard.writeText(invite.code);
      setCopied(invite.id);
      setTimeout(() => {
        setCopied((current) => (current === invite.id ? null : current));
      }, 1500);
    } catch {
      setError("Copy failed: select the code manually");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Max uses (blank = unlimited)">
            <input
              aria-label="Max uses"
              inputMode="numeric"
              className={inputClass}
              value={maxUses}
              onChange={(event) => setMaxUses(event.target.value)}
              placeholder="unlimited"
            />
          </Field>
          <Field label="Expires in hours (blank = never)">
            <input
              aria-label="Expires in hours"
              inputMode="numeric"
              className={inputClass}
              value={expiresInHours}
              onChange={(event) => setExpiresInHours(event.target.value)}
              placeholder="never"
            />
          </Field>
        </div>
        {error === null ? null : (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={create.isPending}
          className="self-start rounded px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          style={{ backgroundColor: "var(--accent-strong)" }}
        >
          {create.isPending ? "Creating…" : "Create invite"}
        </button>
      </form>
      <ul className="flex flex-col gap-1">
        {(invitesQuery.data ?? []).map((invite) => (
          <li
            key={invite.id}
            className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-sm [background-color:var(--surface-3)]"
          >
            <code className="truncate">{invite.code}</code>
            <span className="shrink-0 text-xs [color:var(--text-muted)]">
              {invite.uses}
              {invite.maxUses === null ? "" : `/${invite.maxUses}`} uses
            </span>
            <span className="flex shrink-0 gap-1">
              <button
                type="button"
                aria-label={`Copy invite ${invite.code}`}
                onClick={() => void copy(invite)}
                className="rounded p-1 [color:var(--text-muted)] hover:[color:var(--text-primary)]"
              >
                <Copy size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={`Revoke invite ${invite.code}`}
                onClick={() => revoke.mutate(invite.id)}
                className="rounded p-1 [color:var(--text-muted)] hover:text-red-400"
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </span>
          </li>
        ))}
      </ul>
      {copied === null ? null : (
        <p role="status" className="text-xs [color:var(--text-muted)]">
          Invite code copied.
        </p>
      )}
    </div>
  );
}

export function MembersTab({
  state,
  myUserId,
}: {
  state: ServerState;
  myUserId: string;
}): React.JSX.Element {
  const serverId = state.server.id;
  const [confirmKick, setConfirmKick] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const roleOf = (member: { roleId: string }) =>
    state.roles.find((role) => role.id === member.roleId);

  const changeRole = useMutation({
    mutationFn: ({ memberId, roleId }: { memberId: string; roleId: string }) =>
      patchMember(memberId, roleId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["state", serverId] });
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Failed to change role");
    },
  });
  const kick = useMutation({
    mutationFn: (memberId: string) => kickMember(memberId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["state", serverId] });
      setConfirmKick(null);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Failed to kick");
      setConfirmKick(null);
    },
  });

  return (
    <div className="flex flex-col gap-2">
      {error === null ? null : (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {state.members.map((member) => {
          const name = displayNameOf(member.user.displayName, member.user.username);
          const ownerRow = roleOf(member)?.name === "owner";
          return (
            <li
              key={member.id}
              className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-sm [background-color:var(--surface-3)]"
            >
              <span className="min-w-0 truncate">
                {name} <span className="[color:var(--text-muted)]">@{member.user.username}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <label className="sr-only" htmlFor={`role-${member.id}`}>
                  Role for {name}
                </label>
                <select
                  id={`role-${member.id}`}
                  value={member.roleId}
                  disabled={ownerRow || member.userId === myUserId}
                  onChange={(event) =>
                    changeRole.mutate({ memberId: member.id, roleId: event.target.value })
                  }
                  className="rounded px-1 py-0.5 text-xs [background-color:var(--surface-1)]"
                >
                  {state.roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
                {ownerRow || member.userId === myUserId ? null : (
                  <button
                    type="button"
                    aria-label={`Kick ${name}`}
                    onClick={() => setConfirmKick({ id: member.id, name })}
                    className="rounded p-1 [color:var(--text-muted)] hover:text-red-400"
                  >
                    <LogOut size={14} aria-hidden="true" />
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={confirmKick !== null}
        title={`Kick ${confirmKick?.name ?? ""}?`}
        description="They will lose access immediately. You can invite them back with a new code."
        confirmLabel="Kick"
        onConfirm={() => {
          if (confirmKick !== null) {
            kick.mutate(confirmKick.id);
          }
        }}
        onClose={() => setConfirmKick(null)}
      />
    </div>
  );
}
