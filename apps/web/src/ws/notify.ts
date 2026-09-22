import type { ChatMessage } from "@vitality/shared";
import { getDesktopBridge } from "../lib/desktop.js";
import { useSessionStore } from "../store/session.js";
import { useUiStore } from "../store/ui.js";

const MAX_BODY_CHARS = 200;

export interface MentionDecisionInput {
  message: ChatMessage;
  channelId: string;
  myUserId: string | null;
  /** Currently open channel (suppress the ping when already reading it focused). */
  selectedChannelId: string | null;
  focused: boolean;
}

/**
 * Pure mention-notification decision (unit-tested). Notify only for someone
 * else's non-deleted message that mentions me, and never when I am already
 * looking at that channel in a focused window — main drops focused-window
 * notifications too (defense in depth), the renderer check avoids the IPC
 * round-trip.
 */
export function shouldNotifyForMention(input: MentionDecisionInput): boolean {
  const { message, channelId, myUserId, selectedChannelId, focused } = input;
  if (myUserId === null) {
    return false;
  }
  if (message.authorId === myUserId) {
    return false;
  }
  if (message.deletedAt !== null) {
    return false;
  }
  if (!message.mentions.includes(myUserId)) {
    return false;
  }
  if (focused && selectedChannelId === channelId) {
    return false;
  }
  return true;
}

function snippet(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > MAX_BODY_CHARS ? `${flat.slice(0, MAX_BODY_CHARS)}…` : flat;
}

/**
 * Called from the socket `message.create` handler. Desktop-only: in a plain
 * browser there is no `window.desktop` bridge and this is a no-op (Web
 * Notification API permission UX is out of scope for the desktop step).
 */
export function notifyForMessage(channelId: string, message: ChatMessage): void {
  const bridge = getDesktopBridge();
  if (bridge === null) {
    return;
  }
  const myUserId = useSessionStore.getState().user?.id ?? null;
  const selectedChannelId = useUiStore.getState().selectedChannelId;
  const focused =
    typeof document === "undefined" ? true : document.hasFocus();
  if (
    !shouldNotifyForMention({ message, channelId, myUserId, selectedChannelId, focused })
  ) {
    return;
  }
  const body = snippet(message.content);
  void bridge
    .notify("You were mentioned", body.length > 0 ? body : "(attachment)", channelId)
    .catch(() => undefined);
}
