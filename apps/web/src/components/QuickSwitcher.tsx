import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { Hash, Volume2 } from "lucide-react";
import type { Channel, ServerState } from "@vitality/shared";
import { useUiStore } from "../store/ui.js";
import { joinVoiceChannel } from "../voice/room.js";

export function QuickSwitcher({
  open,
  onClose,
  state,
}: {
  open: boolean;
  onClose: () => void;
  state: ServerState;
}): React.JSX.Element {
  const selectChannel = useUiStore((store) => store.selectChannel);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const channels = [...state.channels].sort((a, b) => a.position - b.position);
    const filtered =
      needle.length === 0
        ? channels
        : channels.filter((channel) => channel.name.toLowerCase().includes(needle));
    return filtered.slice(0, 12).map((channel) => ({
      channel,
      category:
        state.categories.find((entry) => entry.id === channel.categoryId)?.name ?? null,
    }));
  }, [query, state]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      const timer = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [open ]);

  const pick = (channel: Channel): void => {
    selectChannel(channel.id);
    if (channel.type === "voice") {
      void joinVoiceChannel(channel.id);
    }
    onClose();
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) {
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[20%] z-50 w-[min(92vw,32rem)] -translate-x-1/2 rounded-lg p-3 [background-color:var(--surface-2)]"
        >
          <Dialog.Title className="sr-only">Jump to channel</Dialog.Title>
          <input
            ref={inputRef}
            aria-label="Jump to channel"
            placeholder="Type a channel name… (Esc to close)"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setIndex((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setIndex((i) =>
                  results.length === 0 ? 0 : (i - 1 + results.length) % results.length,
                );
              } else if (event.key === "Enter") {
                const hit = results[index];
                if (hit !== undefined) {
                  pick(hit.channel);
                }
              }
            }}
            className="w-full rounded px-3 py-2 text-sm [background-color:var(--surface-3)] outline-none focus:border-[var(--accent)]"
          />
          <ul role="listbox" aria-label="Channels" className="mt-2 max-h-64 overflow-y-auto">
            {results.map(({ channel, category }, i) => {
              const Icon = channel.type === "voice" ? Volume2 : Hash;
              return (
                <li key={channel.id} role="option" aria-selected={i === index}>
                  <button
                    type="button"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      pick(channel);
                    }}
                    onMouseEnter={() => setIndex(i)}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
                      i === index ? "[background-color:var(--surface-3)]" : ""
                    }`}
                  >
                    <Icon size={15} aria-hidden="true" className="[color:var(--text-muted)]" />
                    <span className="truncate">{channel.name}</span>
                    {category === null ? null : (
                      <span className="ml-auto shrink-0 text-xs [color:var(--text-muted)]">
                        {category}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
