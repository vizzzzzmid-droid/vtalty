import { create } from "zustand";
import { TYPING_TTL_MS, type PresenceStatus } from "@vitality/shared";

interface PresenceState {
  statuses: Record<string, PresenceStatus>;
  typing: Record<string, Record<string, number>>;
  applyPresence: (userId: string, status: PresenceStatus) => void;
  applyTyping: (channelId: string, userId: string) => void;
  typingUsers: (channelId: string) => string[];
  reset: () => void;
}

export const usePresenceStore = create<PresenceState>()((set, get) => ({
  statuses: {},
  typing: {},

  applyPresence: (userId, status) =>
    set((state) => ({ statuses: { ...state.statuses, [userId]: status } })),

  applyTyping: (channelId, userId) => {
    set((state) => {
      const expires = Date.now() + TYPING_TTL_MS;
      const channel = { ...(state.typing[channelId] ?? {}), [userId]: expires };
      // Opportunistic prune of expired entries on every write.
      const now = Date.now();
      for (const [id, until] of Object.entries(channel)) {
        if (until <= now) {
          delete channel[id];
        }
      }
      return { typing: { ...state.typing, [channelId]: channel } };
    });
    scheduleTypingExpiry();
  },

  typingUsers: (channelId) => {
    const channel = get().typing[channelId] ?? {};
    const now = Date.now();
    return Object.entries(channel)
      .filter(([, until]) => until > now)
      .map(([id]) => id);
  },

  reset: () => {
    clearTypingExpiry();
    set({ statuses: {}, typing: {} });
  },
}));

/**
 * Nothing else expires a typing indicator: without this, "X is typing…" stays
 * on screen until someone types in THIS channel again, because the store only
 * re-renders subscribers on a write. The timer rewrites the map without
 * expired entries, which is what makes subscribers drop the stale line.
 */
let typingExpiryTimer: ReturnType<typeof setTimeout> | null = null;

function clearTypingExpiry(): void {
  if (typingExpiryTimer !== null) {
    clearTimeout(typingExpiryTimer);
    typingExpiryTimer = null;
  }
}

function scheduleTypingExpiry(): void {
  const typing = usePresenceStore.getState().typing;
  let earliest = Number.POSITIVE_INFINITY;
  for (const channel of Object.values(typing)) {
    for (const until of Object.values(channel)) {
      if (until > 0 && until < earliest) {
        earliest = until;
      }
    }
  }
  if (!Number.isFinite(earliest)) {
    clearTypingExpiry();
    return;
  }
  const delay = Math.max(0, earliest - Date.now());
  clearTypingExpiry();
  typingExpiryTimer = setTimeout(() => {
    typingExpiryTimer = null;
    const now = Date.now();
    usePresenceStore.setState((state) => {
      let changed = false;
      const next: Record<string, Record<string, number>> = {};
      for (const [channelId, channel] of Object.entries(state.typing)) {
        const kept = Object.fromEntries(
          Object.entries(channel).filter(([, until]) => until > now),
        );
        if (Object.keys(kept).length !== Object.keys(channel).length) {
          changed = true;
        }
        if (Object.keys(kept).length > 0) {
          next[channelId] = kept;
        }
      }
      return changed ? { typing: next } : {};
    });
    // Another entry may still be pending (written after this timer armed).
    scheduleTypingExpiry();
  }, delay);
  // A pending timer would keep a headless run alive; the expiry is cosmetic.
  if (typeof (typingExpiryTimer as { unref?: () => void }).unref === "function") {
    (typingExpiryTimer as { unref: () => void }).unref();
  }
}

export function statusOf(userId: string): PresenceStatus {
  return usePresenceStore.getState().statuses[userId] ?? "offline";
}
