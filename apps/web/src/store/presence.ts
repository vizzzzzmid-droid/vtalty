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

  applyTyping: (channelId, userId) =>
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
    }),

  typingUsers: (channelId) => {
    const channel = get().typing[channelId] ?? {};
    const now = Date.now();
    return Object.entries(channel)
      .filter(([, until]) => until > now)
      .map(([id]) => id);
  },

  reset: () => set({ statuses: {}, typing: {} }),
}));

export function statusOf(userId: string): PresenceStatus {
  return usePresenceStore.getState().statuses[userId] ?? "offline";
}
