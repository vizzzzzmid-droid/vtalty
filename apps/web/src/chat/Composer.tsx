import { useMutation } from "@tanstack/react-query";
import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Paperclip, Send, X } from "lucide-react";
import type { MemberWithUser, MessageAttachment } from "@vitality/shared";
import { ApiError } from "../api/http.js";
import { sendMessage, uploadAttachments } from "../api/resources.js";
import { displayNameOf } from "../lib/format.js";
import { sendTyping } from "../ws/socket.js";

const MENTION_TOKEN_RE = /@([A-Za-z0-9_.-]*)$/;

export function Composer({
  channelId,
  members,
  myUserId,
}: {
  channelId: string;
  members: MemberWithUser[];
  myUserId: string;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<MessageAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mentionToken, setMentionToken] = useState<{ token: string; start: number } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const others = members.filter((member) => member.userId !== myUserId);
  const suggestions =
    mentionToken === null
      ? []
      : others
          .filter((member) =>
            member.user.username.toLowerCase().startsWith(mentionToken.token.toLowerCase()),
          )
          .slice(0, 5);

  const send = useMutation({
    mutationFn: () =>
      sendMessage(channelId, {
        content: text,
        attachmentIds: pending.map((attachment) => attachment.id),
      }),
    onSuccess: () => {
      setText("");
      setPending([]);
      setMentionToken(null);
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Failed to send");
    },
  });

  const submit = (): void => {
    if (send.isPending || uploading) {
      return;
    }
    if (text.trim().length === 0 && pending.length === 0) {
      return;
    }
    send.mutate();
  };

  const completeMention = (username: string): void => {
    if (mentionToken === null || areaRef.current === null) {
      return;
    }
    const caret = areaRef.current.selectionStart ?? text.length;
    const next = `${text.slice(0, mentionToken.start)}@${username} ${text.slice(caret)}`;
    setText(next);
    setMentionToken(null);
    areaRef.current.focus();
  };

  const handleChange = (value: string, caret: number): void => {
    setText(value);
    sendTyping(channelId);
    const before = value.slice(0, caret);
    const match = MENTION_TOKEN_RE.exec(before);
    if (match !== null && match[1] !== undefined) {
      setMentionToken({ token: match[1], start: caret - match[0].length });
      setMentionIndex(0);
    } else {
      setMentionToken(null);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (suggestions.length > 0 && mentionToken !== null) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex((index) => {
          const delta = event.key === "ArrowDown" ? 1 : -1;
          return (index + delta + suggestions.length) % suggestions.length;
        });
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const picked = suggestions[mentionIndex];
        if (picked !== undefined) {
          event.preventDefault();
          completeMention(picked.user.username);
          return;
        }
      }
      if (event.key === "Escape") {
        setMentionToken(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const handleFiles = (files: FileList | null): void => {
    if (files === null || files.length === 0) {
      return;
    }
    setUploading(true);
    setError(null);
    uploadAttachments(channelId, [...files])
      .then((uploaded) => {
        setPending((current) => [...current, ...uploaded]);
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Upload failed");
      })
      .finally(() => {
        setUploading(false);
        if (fileRef.current !== null) {
          fileRef.current.value = "";
        }
      });
  };

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    submit();
  };

  return (
    <div className="shrink-0 px-4 pb-4">
      {suggestions.length > 0 ? (
        <ul
          role="listbox"
          aria-label="Mention suggestions"
          className="mb-1 max-h-40 overflow-y-auto rounded p-1 [background-color:var(--surface-1)]"
        >
          {suggestions.map((member, index) => (
            <li key={member.userId} role="option" aria-selected={index === mentionIndex}>
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  completeMention(member.user.username);
                }}
                className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${
                  index === mentionIndex ? "[background-color:var(--surface-3)]" : ""
                }`}
              >
                <span className="font-medium">
                  {displayNameOf(member.user.displayName, member.user.username)}
                </span>
                <span className="text-xs [color:var(--text-muted)]">@{member.user.username}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {pending.length > 0 || uploading ? (
        <div className="mb-1 flex flex-wrap gap-2" aria-label="Pending attachments">
          {pending.map((attachment) => (
            <span
              key={attachment.id}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs [background-color:var(--surface-1)]"
            >
              {attachment.mime.startsWith("image/") ? (
                <img src={attachment.url} alt="" aria-hidden="true" className="h-8 w-8 rounded object-cover" />
              ) : null}
              <span className="max-w-40 truncate">{attachment.filename}</span>
              <button
                type="button"
                aria-label={`Remove ${attachment.filename}`}
                onClick={() =>
                  setPending((current) => current.filter((entry) => entry.id !== attachment.id))
                }
                className="rounded p-0.5 [color:var(--text-muted)] hover:[color:var(--text-primary)]"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
          {uploading ? (
            <span role="status" className="px-2 py-1 text-xs [color:var(--text-muted)]">
              Uploading…
            </span>
          ) : null}
        </div>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="mb-1 text-xs text-red-400">
          {error}
        </p>
      )}
      <form
        onSubmit={onSubmit}
        className="flex items-end gap-2 rounded-lg px-3 py-2 [background-color:var(--surface-2)]"
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          aria-label="Attach files"
          onChange={(event) => handleFiles(event.target.files)}
        />
        <button
          type="button"
          aria-label="Attach files"
          onClick={() => fileRef.current?.click()}
          className="rounded p-1.5 [color:var(--text-muted)] hover:[color:var(--text-primary)]"
        >
          <Paperclip size={18} aria-hidden="true" />
        </button>
        <label htmlFor="composer-input" className="sr-only">
          Message text
        </label>
        <textarea
          id="composer-input"
          ref={areaRef}
          rows={1}
          value={text}
          maxLength={4000}
          onChange={(event) =>
            handleChange(event.target.value, event.target.selectionStart ?? 0)
          }
          onKeyDown={handleKeyDown}
          placeholder="Message… (Enter to send, Shift+Enter for a new line)"
          className="max-h-32 flex-1 resize-none bg-transparent text-sm outline-none placeholder:[color:var(--text-muted)]"
        />
        <button
          type="submit"
          aria-label="Send message"
          disabled={send.isPending || uploading}
          className="rounded p-1.5 text-white disabled:opacity-50"
          style={{ backgroundColor: "var(--accent-strong)" }}
        >
          <Send size={16} aria-hidden="true" />
        </button>
      </form>
    </div>
  );
}
