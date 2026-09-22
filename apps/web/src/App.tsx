import * as Tooltip from "@radix-ui/react-tooltip";
import { useQuery } from "@tanstack/react-query";
import { Suspense, lazy, useEffect, useState } from "react";
import { Menu, Users } from "lucide-react";
import { fetchServers, fetchState, fetchUnread } from "./api/resources.js";
import { AuthPage } from "./components/AuthPage.js";
import { ChannelSidebar } from "./components/ChannelSidebar.js";
import { QuickSwitcher } from "./components/QuickSwitcher.js";
import { OfflineBanner, Toaster, VoiceAnnouncer } from "./components/notifications.js";
import { MainView } from "./components/MainView.js";
import { MemberList } from "./components/MemberList.js";
import { ServerRail } from "./components/ServerRail.js";
import { ChatView } from "./chat/ChatView.js";
import { UserPanel } from "./components/UserPanel.js";
import { myAccess } from "./lib/membership.js";

// Settings (Radix dialogs, admin tabs, voice tab) load on first open.
const SettingsModal = lazy(() =>
  import("./components/SettingsModal.js").then((module) => ({
    default: module.SettingsModal,
  })),
);
import { useSessionStore } from "./store/session.js";
import { useUiStore } from "./store/ui.js";
import { getDesktopBridge, parseNotificationClick } from "./lib/desktop.js";
import {
  armUnloadCleanup,
  setPttActive,
  setSelfMuted,
  startAudioPlayback,
} from "./voice/room.js";
import { useVoiceConnection } from "./voice/store.js";
import { useVoiceSettings } from "./voice/settings.js";

function LoadingScreen(): React.JSX.Element {
  return (
    <main className="flex min-h-screen items-center justify-center [background-color:var(--surface-1)]">
      <p role="status" className="text-sm [color:var(--text-muted)]">
        Loading vitality…
      </p>
    </main>
  );
}

function Shell(): React.JSX.Element {
  const user = useSessionStore((state) => state.user);
  const logout = useSessionStore((state) => state.logout);
  const selectedServerId = useUiStore((state) => state.selectedServerId);
  const selectedChannelId = useUiStore((state) => state.selectedChannelId);
  const selectServer = useUiStore((state) => state.selectServer);
  const selectChannel = useUiStore((state) => state.selectChannel);
  const mobileNavOpen = useUiStore((state) => state.mobileNavOpen);
  const setMobileNav = useUiStore((state) => state.setMobileNav);
  const mobileMembersOpen = useUiStore((state) => state.mobileMembersOpen);
  const setMobileMembers = useUiStore((state) => state.setMobileMembers);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // Desktop: a clicked mention notification focuses the window (main) and
  // asks us to open the channel. Unknown ids render MainView — safe.
  useEffect(() => {
    const bridge = getDesktopBridge();
    if (bridge === null) {
      return;
    }
    return bridge.onNotificationClick((channelId) => {
      if (parseNotificationClick({ channelId }) !== null) {
        selectChannel(channelId);
      }
    });
  }, [selectChannel]);

  // Ctrl+K / Cmd+K quick channel switcher.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.code === "KeyK") {
        event.preventDefault();
        setSwitcherOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const serversQuery = useQuery({ queryKey: ["servers"], queryFn: fetchServers });

  // Voice lifecycle: unload cleanup, mute shortcut, push-to-talk keys.
  // Inside the desktop app the main process ALSO forwards global PTT
  // hold/release (uiohook key-up/down) and a global mute toggle via
  // window.desktop — the tab-focused handlers below stay as fallback.
  useEffect(() => {
    armUnloadCleanup();
    const bridge = getDesktopBridge();
    const offPtt = bridge?.onPttKey((active) => setPttActive(active));
    const offMute = bridge?.onToggleMute(() => {
      const voice = useVoiceConnection.getState();
      void setSelfMuted(!voice.selfMuted);
    });
    const isFormTarget = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable);
    const down = (event: KeyboardEvent): void => {
      if (isFormTarget(event.target) || event.isComposing) {
        return;
      }
      const prefs = useVoiceSettings.getState();
      if (prefs.pttEnabled && event.code === prefs.pttKey && !event.repeat) {
        event.preventDefault();
        setPttActive(true);
        return;
      }
      if (event.code === "KeyM" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const voice = useVoiceConnection.getState();
        void setSelfMuted(!voice.selfMuted);
      }
    };
    const up = (event: KeyboardEvent): void => {
      const prefs = useVoiceSettings.getState();
      if (prefs.pttEnabled && event.code === prefs.pttKey) {
        setPttActive(false);
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      offPtt?.();
      offMute?.();
    };
  }, []);

  useEffect(() => {
    if (
      selectedServerId === null &&
      serversQuery.data !== undefined &&
      serversQuery.data.length > 0
    ) {
      const first = serversQuery.data[0];
      if (first !== undefined) {
        selectServer(first.id);
      }
    }
  }, [selectedServerId, serversQuery.data, selectServer]);

  const activeServerId =
    selectedServerId !== null &&
    serversQuery.data?.some((server) => server.id === selectedServerId) === true
      ? selectedServerId
      : null;

  const stateQuery = useQuery({
    queryKey: ["state", activeServerId],
    queryFn: () => fetchState(activeServerId ?? ""),
    enabled: activeServerId !== null,
  });

  const unreadQuery = useQuery({
    queryKey: ["unread", activeServerId],
    queryFn: () => fetchUnread(activeServerId ?? ""),
    enabled: activeServerId !== null,
  });
  const unreadMap: Record<string, { unreadCount: number; mentionCount: number }> = {};
  for (const entry of unreadQuery.data ?? []) {
    unreadMap[entry.channelId] = {
      unreadCount: entry.unreadCount,
      mentionCount: entry.mentionCount,
    };
  }

  if (user === null) {
    return <LoadingScreen />;
  }

  const state = stateQuery.data ?? null;
  const access = state === null ? null : myAccess(state, user.id);
  const channel =
    state?.channels.find((entry) => entry.id === selectedChannelId) ?? null;
  const voiceChannelId = useVoiceConnection((state) => state.channelId);
  const needsAudioGesture = useVoiceConnection((state) => state.needsAudioGesture);
  const voiceChannelName =
    voiceChannelId === null
      ? null
      : (state?.channels.find((entry) => entry.id === voiceChannelId)?.name ?? "Voice");

  return (
    <div className="flex h-screen overflow-hidden [background-color:var(--surface-1)]">
      <ServerRail servers={serversQuery.data ?? []} selectedId={activeServerId} />

      {state === null ? (
        <div className="flex flex-1 items-center justify-center px-6">
          {stateQuery.isPending || serversQuery.isPending ? (
            <p role="status" className="text-sm [color:var(--text-muted)]">
              Loading server…
            </p>
          ) : serversQuery.isError ? (
            <div className="flex max-w-sm flex-col items-center gap-3 text-center">
              <p role="alert" className="text-sm text-red-400">
                Could not load your servers. Check your connection and retry.
              </p>
              <button
                type="button"
                onClick={() => void serversQuery.refetch()}
                className="rounded px-4 py-2 text-sm text-white"
                style={{ backgroundColor: "var(--accent-strong)" }}
              >
                Retry
              </button>
            </div>
          ) : (
            <div className="flex max-w-sm flex-col items-center gap-3 text-center">
              <p className="text-sm [color:var(--text-muted)]">
                {stateQuery.isError
                  ? "This server is unavailable (deleted, or you were removed). Pick another one."
                  : "Select a server to get started."}
              </p>
              {stateQuery.isError ? (
                <button
                  type="button"
                  onClick={() => selectServer(null)}
                  className="rounded px-4 py-2 text-sm text-white"
                  style={{ backgroundColor: "var(--accent-strong)" }}
                >
                  Back to servers
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="hidden h-full flex-col md:flex">
            <div className="flex min-h-0 flex-1">
              <ChannelSidebar
                state={state}
                access={access}
                unread={unreadMap}
                myUserId={user.id}
              />
            </div>
            <UserPanel
              user={user}
              channelId={voiceChannelId}
              channelName={voiceChannelName}
              canShareScreen={access?.canShareScreen === true}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <OfflineBanner />
            {needsAudioGesture ? (
              <div className="flex shrink-0 items-center justify-center gap-2 bg-amber-900/40 px-3 py-1.5 text-xs">
                <span>Your browser blocked audio playback.</span>
                <button
                  type="button"
                  onClick={() => void startAudioPlayback()}
                  className="rounded px-2 py-0.5 text-white"
                  style={{ backgroundColor: "var(--accent-strong)" }}
                >
                  Click to enable audio
                </button>
              </div>
            ) : null}
            <div className="flex items-center gap-1 px-2 pt-2 md:hidden">
              <button
                type="button"
                aria-label="Open channels"
                onClick={() => setMobileNav(true)}
                className="rounded p-2 [color:var(--text-muted)] hover:[background-color:var(--surface-2)]"
              >
                <Menu size={18} aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="Open members"
                onClick={() => setMobileMembers(true)}
                className="rounded p-2 [color:var(--text-muted)] hover:[background-color:var(--surface-2)]"
              >
                <Users size={18} aria-hidden="true" />
              </button>
            </div>
            <div className="flex min-h-0 flex-1">
              {channel !== null && channel.type === "text" ? (
                <ChatView
                  key={channel.id}
                  channel={channel}
                  state={state}
                  myUserId={user.id}
                />
              ) : (
                <MainView channel={channel} state={state} />
              )}
              <div className="hidden md:flex">
                <MemberList state={state} myUserId={user.id} />
              </div>
            </div>
          </div>
        </>
      )}

      {mobileNavOpen && state !== null ? (
        <div className="fixed inset-0 z-30 flex md:hidden" role="dialog" aria-label="Channels">
          <div className="flex h-full flex-col">
            <div className="flex min-h-0 flex-1">
              <ChannelSidebar
                state={state}
                access={access}
                unread={unreadMap}
                myUserId={user.id}
              />
            </div>
            <UserPanel
              user={user}
              channelId={voiceChannelId}
              channelName={voiceChannelName}
              canShareScreen={access?.canShareScreen === true}
            />
          </div>
          <button
            type="button"
            aria-label="Close channels"
            onClick={() => setMobileNav(false)}
            className="flex-1 bg-black/60"
          />
        </div>
      ) : null}

      {mobileMembersOpen && state !== null ? (
        <div className="fixed inset-0 z-30 flex justify-end md:hidden" role="dialog" aria-label="Members">
          <button
            type="button"
            aria-label="Close members"
            onClick={() => setMobileMembers(false)}
            className="flex-1 bg-black/60"
          />
          <div className="flex h-full w-60 flex-col overflow-y-auto [background-color:var(--surface-2)]">
            <MemberList state={state} myUserId={user.id} />
          </div>
        </div>
      ) : null}

      <Suspense fallback={null}>
        <SettingsModal state={state} myUserId={user.id} />
      </Suspense>
      {state !== null ? (
        <QuickSwitcher
          open={switcherOpen}
          onClose={() => setSwitcherOpen(false)}
          state={state}
        />
      ) : null}
      <VoiceAnnouncer state={state} />
      <Toaster />
      {serversQuery.isError ? (
        <button
          type="button"
          onClick={() => void logout()}
          className="fixed bottom-3 right-3 rounded px-3 py-1.5 text-xs [background-color:var(--surface-2)] [color:var(--text-muted)]"
        >
          Sign out
        </button>
      ) : null}
    </div>
  );
}

export default function App(): React.JSX.Element {
  const status = useSessionStore((state) => state.status);
  const boot = useSessionStore((state) => state.boot);

  useEffect(() => {
    void boot();
  }, [boot]);

  return (
    <Tooltip.Provider>
      {status === "loading" ? <LoadingScreen /> : null}
      {status === "guest" ? <AuthPage /> : null}
      {status === "authed" ? <Shell /> : null}
    </Tooltip.Provider>
  );
}
