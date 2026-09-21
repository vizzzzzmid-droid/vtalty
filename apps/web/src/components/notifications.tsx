import { useEffect, useRef, useState } from "react";
import type { ServerState } from "@vitality/shared";
import { displayNameOf } from "../lib/format.js";
import { useUiStore } from "../store/ui.js";
import { X } from "lucide-react";

export function Toaster(): React.JSX.Element {
  const toasts = useUiStore((state) => state.toasts);
  const dismissToast = useUiStore((state) => state.dismissToast);
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-72 flex-col gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className="pointer-events-auto flex items-start gap-2 rounded px-3 py-2 text-sm shadow-lg [background-color:var(--surface-1)]"
        >
          <span className="flex-1">{toast.message}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => dismissToast(toast.id)}
            className="rounded p-0.5 [color:var(--text-muted)] hover:[color:var(--text-primary)]"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function OfflineBanner(): React.JSX.Element | null {
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  useEffect(() => {
    const up = (): void => setOnline(true);
    const down = (): void => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  if (online) {
    return null;
  }
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center justify-center bg-amber-900/40 px-3 py-1.5 text-xs"
    >
      You are offline — messages and voice will reconnect automatically.
    </div>
  );
}

/** Screen-reader announcements for voice joins/leaves (visual UI unchanged). */
export function VoiceAnnouncer({ state }: { state: ServerState | null }): React.JSX.Element {
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (state === null) {
      previous.current = new Map();
      return;
    }
    const current = new Map<string, string>();
    for (const channel of state.voice) {
      const name =
        state.channels.find((entry) => entry.id === channel.channelId)?.name ?? "voice";
      for (const participant of channel.participants) {
        current.set(`${channel.channelId}:${participant.userId}`, name);
        if (!previous.current.has(`${channel.channelId}:${participant.userId}`)) {
          const member = state.members.find(
            (entry) => entry.userId === participant.userId,
          );
          const who = member
            ? displayNameOf(member.user.displayName, member.user.username)
            : "Someone";
          setAnnouncement(`${who} joined ${name}`);
        }
      }
    }
    for (const [key, name] of previous.current) {
      if (!current.has(key)) {
        const userId = key.split(":")[1] ?? "";
        const member = state.members.find((entry) => entry.userId === userId);
        const who = member
          ? displayNameOf(member.user.displayName, member.user.username)
          : "Someone";
        setAnnouncement(`${who} left ${name}`);
      }
    }
    previous.current = current;
  }, [state]);

  return (
    <div aria-live="polite" role="status" className="sr-only">
      {announcement}
    </div>
  );
}
