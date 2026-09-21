import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useMutation } from "@tanstack/react-query";
import type { MemberWithUser, ServerState } from "@vitality/shared";
import { queryClient } from "../api/queryClient.js";
import { kickMember, patchMember } from "../api/resources.js";
import { displayNameOf } from "../lib/format.js";
import { myAccess } from "../lib/membership.js";
import { usePresenceStore } from "../store/presence.js";
import { Avatar } from "./Avatar.js";

function statusColor(status: string): string {
  if (status === "online") {
    return "var(--status-ok)";
  }
  if (status === "idle") {
    return "#faa81a";
  }
  return "var(--text-muted)";
}

function MemberRow({
  member,
  canManage,
  adminRoleId,
  memberRoleId,
  isSelf,
  isOwnerRow,
}: {
  member: MemberWithUser;
  canManage: boolean;
  adminRoleId: string | null;
  memberRoleId: string | null;
  isSelf: boolean;
  isOwnerRow: boolean;
}): React.JSX.Element {
  const status = usePresenceStore(
    (state) => state.statuses[member.userId] ?? "offline",
  );
  const serverId = member.serverId;
  const promote = useMutation({
    mutationFn: (roleId: string) => patchMember(member.id, roleId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["state", serverId] });
    },
  });
  const kick = useMutation({
    mutationFn: () => kickMember(member.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["state", serverId] });
    },
  });

  const actionable = canManage && !isSelf && !isOwnerRow;
  const name = displayNameOf(member.user.displayName, member.user.username);

  const row = (
    <div className="flex items-center gap-2 rounded px-2 py-1 hover:[background-color:var(--surface-3)]">
      <div className="relative">
        <Avatar name={name} src={member.user.avatarUrl} size={28} />
        <span
          aria-hidden="true"
          className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2"
          style={{ backgroundColor: statusColor(status), borderColor: "var(--surface-2)" }}
        />
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{name}</div>
        <div className="truncate text-xs [color:var(--text-muted)]">
          @{member.user.username} · {status}
        </div>
      </div>
    </div>
  );

  if (!actionable) {
    return row;
  }
  const isAdmin = member.roleId === adminRoleId;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label={`Manage ${name}`} className="w-full text-left">
          {row}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="left"
          align="start"
          className="z-50 min-w-40 rounded p-1 text-sm [background-color:var(--surface-1)]"
        >
          {isAdmin ? (
            <DropdownMenu.Item
              onSelect={() => {
                if (memberRoleId !== null) {
                  promote.mutate(memberRoleId);
                }
              }}
              className="cursor-pointer rounded px-2 py-1.5 outline-none hover:[background-color:var(--surface-3)]"
            >
              Make member
            </DropdownMenu.Item>
          ) : (
            <DropdownMenu.Item
              onSelect={() => {
                if (adminRoleId !== null) {
                  promote.mutate(adminRoleId);
                }
              }}
              className="cursor-pointer rounded px-2 py-1.5 outline-none hover:[background-color:var(--surface-3)]"
            >
              Make admin
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item
            onSelect={() => kick.mutate()}
            className="cursor-pointer rounded px-2 py-1.5 text-red-400 outline-none hover:[background-color:var(--surface-3)]"
          >
            Kick from server
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MemberList({
  state,
  myUserId,
}: {
  state: ServerState;
  myUserId: string;
}): React.JSX.Element {
  const access = myAccess(state, myUserId);
  const adminRoleId =
    state.roles.find((role) => role.name === "admin")?.id ?? null;
  const memberRoleId =
    state.roles.find((role) => role.name === "member")?.id ?? null;
  const statuses = usePresenceStore((store) => store.statuses);

  const online = (member: MemberWithUser): boolean => {
    const status = statuses[member.userId] ?? "offline";
    return status === "online" || status === "idle";
  };

  return (
    <aside
      aria-label="Members"
      className="flex h-full w-60 shrink-0 flex-col overflow-y-auto [background-color:var(--surface-2)]"
    >
      <div className="flex flex-col gap-4 px-2 py-3">
        {state.roles.map((role) => {
          const roleMembers = state.members.filter(
            (member) => member.roleId === role.id,
          );
          if (roleMembers.length === 0) {
            return null;
          }
          const onlineMembers = roleMembers.filter(online);
          const offlineMembers = roleMembers.filter((member) => !online(member));
          return (
            <section key={role.id} aria-label={`${role.name} members`}>
              <h3 className="px-2 text-xs font-semibold uppercase tracking-wide [color:var(--text-muted)]">
                {role.name} — {onlineMembers.length}
              </h3>
              <div className="mt-1 flex flex-col gap-0.5">
                {[...onlineMembers, ...offlineMembers].map((member) => (
                  <MemberRow
                    key={member.id}
                    member={member}
                    canManage={access?.canManageMembers === true}
                    adminRoleId={adminRoleId}
                    memberRoleId={memberRoleId}
                    isSelf={member.userId === myUserId}
                    isOwnerRow={member.roleId === state.roles.find((r) => r.name === "owner")?.id}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </aside>
  );
}
