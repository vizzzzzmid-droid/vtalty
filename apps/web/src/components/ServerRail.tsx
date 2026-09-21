import { useState } from "react";
import { Plus } from "lucide-react";
import type { ServerSummary } from "../api/resources.js";
import { useUiStore } from "../store/ui.js";
import { CreateServerDialog } from "./dialogs.js";
import { Tip } from "./ui.js";

export function ServerRail({
  servers,
  selectedId,
}: {
  servers: ServerSummary[];
  selectedId: string | null;
}): React.JSX.Element {
  const selectServer = useUiStore((state) => state.selectServer);
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <nav
      aria-label="Servers"
      className="flex w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto py-3 [background-color:var(--surface-1)]"
    >
      <Tip label="vitality home" side="right">
        <button
          type="button"
          aria-label="vitality home"
          onClick={() => {
            if (servers[0] !== undefined) {
              selectServer(servers[0].id);
            }
          }}
          className="flex h-12 w-12 items-center justify-center rounded-2xl text-xl font-bold text-white"
          style={{ backgroundColor: "var(--accent-strong)" }}
        >
          v
        </button>
      </Tip>
      <div aria-hidden="true" className="h-0.5 w-8 rounded [background-color:var(--surface-3)]" />
      {servers.map((server) => {
        const selected = server.id === selectedId;
        return (
          <Tip key={server.id} label={server.name} side="right">
            <button
              type="button"
              aria-label={`Open server ${server.name}`}
              aria-current={selected ? "true" : undefined}
              onClick={() => selectServer(server.id)}
              className={`flex h-12 w-12 items-center justify-center rounded-full text-lg font-semibold transition-all hover:rounded-2xl ${
                selected ? "rounded-2xl text-white" : "[color:var(--text-primary)]"
              }`}
              style={
                selected
                  ? { backgroundColor: "var(--accent-strong)" }
                  : { backgroundColor: "var(--surface-2)" }
              }
            >
              {server.name.slice(0, 1).toUpperCase()}
            </button>
          </Tip>
        );
      })}
      <Tip label="Create a server" side="right">
        <button
          type="button"
          aria-label="Create a server"
          onClick={() => setCreateOpen(true)}
          className="flex h-12 w-12 items-center justify-center rounded-full [background-color:var(--surface-2)] [color:var(--text-muted)] transition-all hover:rounded-2xl hover:text-white"
        >
          <Plus size={20} aria-hidden="true" />
        </button>
      </Tip>
      <CreateServerDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => selectServer(id)}
      />
    </nav>
  );
}
