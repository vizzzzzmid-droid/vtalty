import * as Tooltip from "@radix-ui/react-tooltip";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Menu, Users } from "lucide-react";
import { fetchServers, fetchState } from "./api/resources.js";
import { AuthPage } from "./components/AuthPage.js";
import { ChannelSidebar } from "./components/ChannelSidebar.js";
import { MainView } from "./components/MainView.js";
import { MemberList } from "./components/MemberList.js";
import { ServerRail } from "./components/ServerRail.js";
import { SettingsModal } from "./components/SettingsModal.js";
import { UserPanel } from "./components/UserPanel.js";
import { myAccess } from "./lib/membership.js";
import { useSessionStore } from "./store/session.js";
import { useUiStore } from "./store/ui.js";
import { connectSocket } from "./ws/socket.js";

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
  const accessToken = useSessionStore((state) => state.accessToken);
  const logout = useSessionStore((state) => state.logout);
  const selectedServerId = useUiStore((state) => state.selectedServerId);
  const selectedChannelId = useUiStore((state) => state.selectedChannelId);
  const selectServer = useUiStore((state) => state.selectServer);
  const mobileNavOpen = useUiStore((state) => state.mobileNavOpen);
  const setMobileNav = useUiStore((state) => state.setMobileNav);
  const mobileMembersOpen = useUiStore((state) => state.mobileMembersOpen);
  const setMobileMembers = useUiStore((state) => state.setMobileMembers);

  useEffect(() => {
    if (accessToken !== null) {
      connectSocket(accessToken);
    }
  }, [accessToken]);

  const serversQuery = useQuery({ queryKey: ["servers"], queryFn: fetchServers });

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

  if (user === null) {
    return <LoadingScreen />;
  }

  const state = stateQuery.data ?? null;
  const access = state === null ? null : myAccess(state, user.id);
  const channel =
    state?.channels.find((entry) => entry.id === selectedChannelId) ?? null;

  return (
    <div className="flex h-screen overflow-hidden [background-color:var(--surface-1)]">
      <ServerRail servers={serversQuery.data ?? []} selectedId={activeServerId} />

      {state === null ? (
        <div className="flex flex-1 items-center justify-center px-6">
          {stateQuery.isPending ? (
            <p role="status" className="text-sm [color:var(--text-muted)]">
              Loading server…
            </p>
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
                  style={{ backgroundColor: "var(--accent)" }}
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
              <ChannelSidebar state={state} access={access} />
            </div>
            <UserPanel user={user} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
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
              <MainView channel={channel} />
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
              <ChannelSidebar state={state} access={access} />
            </div>
            <UserPanel user={user} />
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

      <SettingsModal state={state} myUserId={user.id} />
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
