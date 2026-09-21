import { Settings } from "lucide-react";
import type { User } from "@vitality/shared";
import { displayNameOf } from "../lib/format.js";
import { useUiStore } from "../store/ui.js";
import { Avatar } from "./Avatar.js";
import { Tip } from "./ui.js";

export function UserPanel({ user }: { user: User }): React.JSX.Element {
  const setSettings = useUiStore((state) => state.setSettings);
  const name = displayNameOf(user.displayName, user.username);

  return (
    <div className="flex h-[52px] shrink-0 items-center gap-2 px-2 [background-color:var(--surface-1)]">
      <Avatar name={name} src={user.avatarUrl} size={32} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{name}</div>
        <div className="truncate text-xs [color:var(--text-muted)]">
          @{user.username}
        </div>
      </div>
      <Tip label="User settings" side="top">
        <button
          type="button"
          aria-label="Open user settings"
          onClick={() => setSettings(true, "account")}
          className="rounded p-1.5 [color:var(--text-muted)] hover:[background-color:var(--surface-3)] hover:[color:var(--text-primary)]"
        >
          <Settings size={18} aria-hidden="true" />
        </button>
      </Tip>
    </div>
  );
}
