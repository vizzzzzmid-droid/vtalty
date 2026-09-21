import * as Collapsible from "@radix-ui/react-collapsible";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import {
  ChevronDown,
  Hash,
  MoreHorizontal,
  Plus,
  UserPlus,
  Volume2,
} from "lucide-react";
import type { Category, Channel, ServerState } from "@vitality/shared";
import { queryClient } from "../api/queryClient.js";
import { deleteCategory, deleteChannel } from "../api/resources.js";
import type { MyAccess } from "../lib/membership.js";
import { useUiStore } from "../store/ui.js";
import { CategoryDialog, ChannelDialog } from "./dialogs.js";
import { ConfirmDialog, Tip } from "./ui.js";

type DialogState =
  | { kind: "channel-create"; categoryId: string | null }
  | { kind: "channel-edit"; channel: Channel }
  | { kind: "category-create" }
  | { kind: "category-edit"; category: Category }
  | { kind: "delete-channel"; channel: Channel }
  | { kind: "delete-category"; category: Category }
  | null;

function ChannelRow({
  channel,
  selected,
  canManage,
  badge,
  onEdit,
  onDelete,
}: {
  channel: Channel;
  selected: boolean;
  canManage: boolean;
  badge?: { unreadCount: number; mentionCount: number };
  onEdit: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const selectChannel = useUiStore((state) => state.selectChannel);
  const Icon = channel.type === "voice" ? Volume2 : Hash;
  const unread = badge?.unreadCount ?? 0;
  const mentions = badge?.mentionCount ?? 0;
  return (
    <div
      className={`group flex items-center gap-1 rounded px-2 py-1 ${
        selected ? "[background-color:var(--surface-3)]" : "hover:[background-color:var(--surface-3)]"
      }`}
    >
      <button
        type="button"
        onClick={() => selectChannel(channel.id)}
        aria-current={selected ? "true" : undefined}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <Icon
          size={16}
          aria-hidden="true"
          className="shrink-0 [color:var(--text-muted)]"
        />
        <span className="truncate text-sm">{channel.name}</span>
      </button>
      {mentions > 0 ? (
        <span
          aria-label={`${mentions} mentions in ${channel.name}`}
          className="shrink-0 rounded-full px-1.5 text-[11px] font-semibold text-white"
          style={{ backgroundColor: "var(--accent)" }}
        >
          @{mentions}
        </span>
      ) : unread > 0 ? (
        <span
          aria-label={`${unread} unread messages in ${channel.name}`}
          className="shrink-0 rounded-full px-1.5 text-[11px] font-semibold [background-color:var(--surface-1)]"
        >
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
      {canManage ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label={`Channel actions for ${channel.name}`}
              className="rounded p-0.5 opacity-0 [color:var(--text-muted)] hover:[background-color:var(--surface-1)] focus:opacity-100 group-hover:opacity-100"
            >
              <MoreHorizontal size={14} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="right"
              align="start"
              className="z-50 min-w-36 rounded p-1 text-sm [background-color:var(--surface-1)]"
            >
              <DropdownMenu.Item
                onSelect={onEdit}
                className="cursor-pointer rounded px-2 py-1.5 outline-none hover:[background-color:var(--surface-3)]"
              >
                Rename channel
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={onDelete}
                className="cursor-pointer rounded px-2 py-1.5 text-red-400 outline-none hover:[background-color:var(--surface-3)]"
              >
                Delete channel
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : null}
    </div>
  );
}

export function ChannelSidebar({
  state,
  access,
  unread,
}: {
  state: ServerState;
  access: MyAccess | null;
  unread: Record<string, { unreadCount: number; mentionCount: number }>;
}): React.JSX.Element {
  const selectedChannelId = useUiStore((state) => state.selectedChannelId);
  const collapsedCategories = useUiStore((state) => state.collapsedCategories);
  const toggleCategory = useUiStore((state) => state.toggleCategory);
  const setSettings = useUiStore((state) => state.setSettings);
  const [dialog, setDialog] = useState<DialogState>(null);

  const serverId = state.server.id;
  const canManage = access?.canManageChannels === true;
  const canInvite = access?.canManageMembers === true;

  const deleteChannelMutation = useMutation({
    mutationFn: (id: string) => deleteChannel(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["state", serverId] });
      setDialog(null);
    },
  });
  const deleteCategoryMutation = useMutation({
    mutationFn: (id: string) => deleteCategory(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["state", serverId] });
      setDialog(null);
    },
  });

  const sortedChannels = [...state.channels].sort((a, b) => a.position - b.position);
  const uncategorized = sortedChannels.filter((channel) => channel.categoryId === null);
  const sortedCategories = [...state.categories].sort((a, b) => a.position - b.position);

  const renderChannel = (channel: Channel) => (
    <ChannelRow
      key={channel.id}
      channel={channel}
      selected={channel.id === selectedChannelId}
      canManage={canManage}
      badge={unread[channel.id]}
      onEdit={() => setDialog({ kind: "channel-edit", channel })}
      onDelete={() => setDialog({ kind: "delete-channel", channel })}
    />
  );

  return (
    <div className="flex h-full w-60 shrink-0 flex-col [background-color:var(--surface-2)]">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-black/20 px-4">
        <span className="truncate text-sm font-semibold">{state.server.name}</span>
        {canInvite ? (
          <Tip label="Create invite" side="bottom">
            <button
              type="button"
              aria-label="Create invite"
              onClick={() => setSettings(true, "invites")}
              className="rounded p-1 [color:var(--text-muted)] hover:[background-color:var(--surface-3)]"
            >
              <UserPlus size={16} aria-hidden="true" />
            </button>
          </Tip>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {uncategorized.map(renderChannel)}
        {sortedCategories.map((category) => {
          const collapsed = collapsedCategories[category.id] === true;
          const channels = sortedChannels.filter(
            (channel) => channel.categoryId === category.id,
          );
          return (
            <Collapsible.Root
              key={category.id}
              open={!collapsed}
              onOpenChange={() => toggleCategory(category.id)}
              className="mt-3 first:mt-0"
            >
              <div className="group flex items-center gap-1 px-1">
                <Collapsible.Trigger asChild>
                  <button
                    type="button"
                    aria-label={`${collapsed ? "Expand" : "Collapse"} category ${category.name}`}
                    className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs font-semibold uppercase tracking-wide [color:var(--text-muted)] hover:[color:var(--text-primary)]"
                  >
                    <ChevronDown
                      size={14}
                      aria-hidden="true"
                      className={`shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`}
                    />
                    <span className="truncate">{category.name}</span>
                  </button>
                </Collapsible.Trigger>
                {canManage ? (
                  <>
                    <Tip label={`Create channel in ${category.name}`} side="top">
                      <button
                        type="button"
                        aria-label={`Create channel in ${category.name}`}
                        onClick={() =>
                          setDialog({ kind: "channel-create", categoryId: category.id })
                        }
                        className="rounded p-0.5 opacity-0 [color:var(--text-muted)] hover:[background-color:var(--surface-3)] focus:opacity-100 group-hover:opacity-100"
                      >
                        <Plus size={14} aria-hidden="true" />
                      </button>
                    </Tip>
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <button
                          type="button"
                          aria-label={`Category actions for ${category.name}`}
                          className="rounded p-0.5 opacity-0 [color:var(--text-muted)] hover:[background-color:var(--surface-3)] focus:opacity-100 group-hover:opacity-100"
                        >
                          <MoreHorizontal size={14} aria-hidden="true" />
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          side="right"
                          align="start"
                          className="z-50 min-w-36 rounded p-1 text-sm [background-color:var(--surface-1)]"
                        >
                          <DropdownMenu.Item
                            onSelect={() => setDialog({ kind: "category-edit", category })}
                            className="cursor-pointer rounded px-2 py-1.5 outline-none hover:[background-color:var(--surface-3)]"
                          >
                            Rename category
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            onSelect={() => setDialog({ kind: "delete-category", category })}
                            className="cursor-pointer rounded px-2 py-1.5 text-red-400 outline-none hover:[background-color:var(--surface-3)]"
                          >
                            Delete category
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </>
                ) : null}
              </div>
              <Collapsible.Content className="mt-1 flex flex-col gap-0.5">
                {channels.map(renderChannel)}
              </Collapsible.Content>
            </Collapsible.Root>
          );
        })}
        {canManage ? (
          <button
            type="button"
            onClick={() => setDialog({ kind: "category-create" })}
            className="mt-3 flex items-center gap-1 px-2 text-xs font-semibold uppercase tracking-wide [color:var(--text-muted)] hover:[color:var(--text-primary)]"
          >
            <Plus size={14} aria-hidden="true" />
            Add category
          </button>
        ) : null}
      </div>

      {dialog?.kind === "channel-create" ? (
        <ChannelDialog
          open
          serverId={serverId}
          categoryId={dialog.categoryId}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "channel-edit" ? (
        <ChannelDialog
          open
          serverId={serverId}
          initial={{ id: dialog.channel.id, name: dialog.channel.name }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "category-create" ? (
        <CategoryDialog open serverId={serverId} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "category-edit" ? (
        <CategoryDialog
          open
          serverId={serverId}
          initial={{ id: dialog.category.id, name: dialog.category.name }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      <ConfirmDialog
        open={dialog?.kind === "delete-channel"}
        title={`Delete #${dialog?.kind === "delete-channel" ? dialog.channel.name : ""}?`}
        description="This cannot be undone. Message history arrives in Phase 3; channel settings are final."
        confirmLabel="Delete channel"
        onConfirm={() => {
          if (dialog?.kind === "delete-channel") {
            deleteChannelMutation.mutate(dialog.channel.id);
          }
        }}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === "delete-category"}
        title={`Delete ${dialog?.kind === "delete-category" ? dialog.category.name : ""}?`}
        description="Only empty categories can be deleted. Move or delete its channels first."
        confirmLabel="Delete category"
        onConfirm={() => {
          if (dialog?.kind === "delete-category") {
            deleteCategoryMutation.mutate(dialog.category.id);
          }
        }}
        onClose={() => setDialog(null)}
      />
    </div>
  );
}
