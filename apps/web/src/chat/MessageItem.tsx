import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useMutation } from "@tanstack/react-query";
import { Suspense, lazy, useState, type FormEvent } from "react";
import { FileText, MoreHorizontal } from "lucide-react";
import type { ChatMessage } from "@vitality/shared";
import { deleteMessage, editMessage } from "../api/resources.js";
import { ApiError } from "../api/http.js";
import { formatMessageTime } from "../lib/format.js";
import { Avatar } from "../components/Avatar.js";
import { ConfirmDialog } from "../components/ui.js";

// Split react-markdown out of the initial bundle (chat list code-splits it).
const MessageBody = lazy(() => import("../chat/markdown.js"));

function Attachments({ message }: { message: ChatMessage }): React.JSX.Element | null {
  if (message.attachments.length === 0) {
    return null;
  }
  return (
    <div className="mt-1 flex flex-col gap-2">
      {message.attachments.map((attachment) => {
        const isImage = attachment.mime.startsWith("image/");
        return (
          <div key={attachment.id}>
            {isImage ? (
              <a
                href={attachment.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open image ${attachment.filename}`}
              >
                <img
                  src={attachment.url}
                  alt={attachment.filename}
                  loading="lazy"
                  className="max-h-64 max-w-full rounded"
                />
              </a>
            ) : (
              <a
                href={attachment.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 rounded px-2 py-1.5 text-sm [background-color:var(--surface-1)] hover:brightness-110"
              >
                <FileText size={16} aria-hidden="true" />
                <span className="truncate">{attachment.filename}</span>
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function MessageItem({
  message,
  authorName,
  authorUsername,
  authorAvatar,
  isOwn,
  canModerate,
  usernames,
  mentioned,
}: {
  message: ChatMessage;
  authorName: string;
  authorUsername: string;
  authorAvatar: string | null;
  isOwn: boolean;
  canModerate: boolean;
  usernames: string[];
  mentioned: boolean;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canEdit = isOwn;
  const canDelete = isOwn || canModerate;

  const saveEdit = useMutation({
    mutationFn: () => editMessage(message.id, draft.trim()),
    onSuccess: () => {
      setEditing(false);
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Failed to edit");
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteMessage(message.id),
    onSuccess: () => setConfirmDelete(false),
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Failed to delete");
      setConfirmDelete(false);
    },
  });

  const submitEdit = (event: FormEvent): void => {
    event.preventDefault();
    if (draft.trim().length > 0 && draft !== message.content) {
      saveEdit.mutate();
    } else {
      setEditing(false);
    }
  };

  const { time, title } = formatMessageTime(message.createdAt);

  return (
    <div
      className={`group flex gap-3 rounded px-4 py-1.5 hover:[background-color:var(--surface-2)] ${
        mentioned ? "[background-color:color-mix(in_srgb,var(--accent)_12%,transparent)]" : ""
      }`}
    >
      <Avatar name={authorName} id={message.authorId} src={authorAvatar} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium">{authorName}</span>
          <span className="text-xs [color:var(--text-muted)]">@{authorUsername}</span>
          <time dateTime={message.createdAt} title={title} className="text-[11px] [color:var(--text-muted)]">
            {time}
          </time>
          {message.editedAt !== null ? (
            <span className="text-[11px] [color:var(--text-muted)]">(edited)</span>
          ) : null}
        </div>
        {editing ? (
          <form onSubmit={submitEdit} className="mt-1">
            <textarea
              aria-label="Edit message"
              autoFocus
              rows={2}
              value={draft}
              maxLength={4000}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setEditing(false);
                }
              }}
              className="w-full rounded px-2 py-1 text-sm [background-color:var(--surface-1)] outline-none focus:border-[var(--accent)]"
            />
            <div className="mt-1 flex gap-2 text-xs">
              <button
                type="submit"
                disabled={saveEdit.isPending}
              className="rounded px-2 py-0.5 text-white disabled:opacity-60"
              style={{ backgroundColor: "var(--accent-strong)" }}
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded px-2 py-0.5 [color:var(--text-muted)] hover:[background-color:var(--surface-3)]"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <Suspense fallback={<p className="text-sm">…</p>}>
            <MessageBody content={message.content} usernames={usernames} />
          </Suspense>
        )}
        <Attachments message={message} />
        {error === null ? null : (
          <p role="alert" className="mt-1 text-xs text-red-400">
            {error}
          </p>
        )}
      </div>
      {canEdit || canDelete ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label={`Message actions by ${authorName}`}
              className="h-fit rounded p-1 opacity-0 [color:var(--text-muted)] hover:[background-color:var(--surface-3)] focus:opacity-100 group-hover:opacity-100"
            >
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="left"
              align="start"
              className="z-50 min-w-32 rounded p-1 text-sm [background-color:var(--surface-1)]"
            >
              {canEdit ? (
                <DropdownMenu.Item
                  onSelect={() => {
                    setDraft(message.content);
                    setEditing(true);
                  }}
                  className="cursor-pointer rounded px-2 py-1.5 outline-none hover:[background-color:var(--surface-3)]"
                >
                  Edit message
                </DropdownMenu.Item>
              ) : null}
              {canDelete ? (
                <DropdownMenu.Item
                  onSelect={() => setConfirmDelete(true)}
                  className="cursor-pointer rounded px-2 py-1.5 text-red-400 outline-none hover:[background-color:var(--surface-3)]"
                >
                  Delete message
                </DropdownMenu.Item>
              ) : null}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : null}
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this message?"
        description="The message will be removed for everyone. This cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => remove.mutate()}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}
