import { create } from "zustand";

const SELECTED_SERVER_KEY = "vitality.selectedServer";
const SELECTED_CHANNEL_KEY = "vitality.selectedChannel";
const COLLAPSED_KEY = "vitality.collapsedCategories";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Private mode etc.: selection simply won't persist.
  }
}

function readCollapsed(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    if (raw === null) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    return parsed as Record<string, boolean>;
  } catch {
    return {};
  }
}

interface UiState {
  selectedServerId: string | null;
  selectedChannelId: string | null;
  settingsOpen: boolean;
  settingsTab: string;
  collapsedCategories: Record<string, boolean>;
  mobileNavOpen: boolean;
  mobileMembersOpen: boolean;
  selectServer: (id: string | null) => void;
  selectChannel: (id: string | null) => void;
  setSettings: (open: boolean, tab?: string) => void;
  toggleCategory: (id: string) => void;
  setMobileNav: (open: boolean) => void;
  setMobileMembers: (open: boolean) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  selectedServerId: read(SELECTED_SERVER_KEY),
  selectedChannelId: read(SELECTED_CHANNEL_KEY),
  settingsOpen: false,
  settingsTab: "account",
  collapsedCategories: readCollapsed(),
  mobileNavOpen: false,
  mobileMembersOpen: false,

  selectServer: (id) => {
    write(SELECTED_SERVER_KEY, id);
    write(SELECTED_CHANNEL_KEY, null);
    set({
      selectedServerId: id,
      selectedChannelId: null,
      mobileNavOpen: false,
      mobileMembersOpen: false,
    });
  },
  selectChannel: (id) => {
    write(SELECTED_CHANNEL_KEY, id);
    set({ selectedChannelId: id, mobileNavOpen: false, mobileMembersOpen: false });
  },
  setSettings: (open, tab) =>
    set((state) => ({
      settingsOpen: open,
      settingsTab: tab ?? state.settingsTab,
    })),
  toggleCategory: (id) =>
    set((state) => {
      const next = {
        ...state.collapsedCategories,
        [id]: !state.collapsedCategories[id],
      };
      try {
        window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      } catch {
        // Ignore persistence failures.
      }
      return { collapsedCategories: next };
    }),
  setMobileNav: (open) => set({ mobileNavOpen: open }),
  setMobileMembers: (open) => set({ mobileMembersOpen: open }),
}));
