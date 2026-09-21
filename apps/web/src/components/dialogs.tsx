import * as Dialog from "@radix-ui/react-dialog";
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import type { ChannelType } from "@vitality/shared";
import { queryClient } from "../api/queryClient.js";
import {
  createCategory,
  createChannel,
  createServer,
  patchCategory,
  patchChannel,
} from "../api/resources.js";
import { Field, inputClass } from "./ui.js";

function Shell({
  title,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
  children: ReactNode;
}): ReactNode {
  return (
    <>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg p-5 [background-color:var(--surface-2)]">
        <div className="flex items-start justify-between gap-4">
          <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
          <Dialog.Close asChild>
            <button
              type="button"
              aria-label="Close dialog"
              onClick={onClose}
              className="rounded p-1 [color:var(--text-muted)] hover:[background-color:var(--surface-3)]"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </Dialog.Close>
        </div>
        <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
          {children}
        </form>
      </Dialog.Content>
    </>
  );
}

function SubmitRow({ label, pending }: { label: string; pending: boolean }): ReactNode {
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-1 rounded px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      style={{ backgroundColor: "var(--accent)" }}
    >
      {pending ? "Saving…" : label}
    </button>
  );
}

export function CreateServerDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}): ReactNode {
  const [name, setName] = useState("");
  const mutation = useMutation({
    mutationFn: () => createServer(name.trim()),
    onSuccess: (server) => {
      void queryClient.invalidateQueries({ queryKey: ["servers"] });
      setName("");
      onClose();
      onCreated(server.id);
    },
  });
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
        <Shell
          title="Create a server"
          onClose={onClose}
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim().length > 0) {
              mutation.mutate();
            }
          }}
        >
          <Field label="Server name">
            <input
              aria-label="Server name"
              className={inputClass}
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              placeholder="friends"
            />
          </Field>
          <SubmitRow label="Create" pending={mutation.isPending} />
        </Shell>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function CategoryDialog({
  open,
  serverId,
  initial,
  onClose,
}: {
  open: boolean;
  serverId: string;
  initial?: { id: string; name: string };
  onClose: () => void;
}): ReactNode {
  const [name, setName] = useState(initial?.name ?? "");
  const mutation = useMutation({
    mutationFn: () => {
      const trimmed = name.trim();
      return initial === undefined
        ? createCategory(serverId, trimmed).then(() => undefined)
        : patchCategory(initial.id, { name: trimmed }).then(() => undefined);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["state", serverId] });
      setName("");
      onClose();
    },
  });
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
        <Shell
          title={initial === undefined ? "Create category" : "Rename category"}
          onClose={onClose}
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim().length > 0) {
              mutation.mutate();
            }
          }}
        >
          <Field label="Category name">
            <input
              aria-label="Category name"
              className={inputClass}
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <SubmitRow label={initial === undefined ? "Create" : "Save"} pending={mutation.isPending} />
        </Shell>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ChannelDialog({
  open,
  serverId,
  categoryId,
  initial,
  onClose,
}: {
  open: boolean;
  serverId: string;
  categoryId?: string | null;
  initial?: { id: string; name: string };
  onClose: () => void;
}): ReactNode {
  const [name, setName] = useState(initial?.name ?? "");
  const [channelType, setChannelType] = useState<ChannelType>("text");
  const mutation = useMutation({
    mutationFn: () => {
      const trimmed = name.trim();
      return initial === undefined
        ? createChannel(serverId, {
            name: trimmed,
            type: channelType,
            categoryId: categoryId ?? null,
          }).then(() => undefined)
        : patchChannel(initial.id, { name: trimmed }).then(() => undefined);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["state", serverId] });
      setName("");
      onClose();
    },
  });
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
        <Shell
          title={initial === undefined ? "Create channel" : "Rename channel"}
          onClose={onClose}
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim().length > 0) {
              mutation.mutate();
            }
          }}
        >
          <Field label="Channel name">
            <input
              aria-label="Channel name"
              className={inputClass}
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              placeholder="general"
            />
          </Field>
          {initial === undefined ? (
            <fieldset className="flex gap-4 text-sm">
              <legend className="mb-1 text-xs font-semibold uppercase tracking-wide [color:var(--text-muted)]">
                Channel type
              </legend>
              {(["text", "voice"] as const).map((value) => (
                <label key={value} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="channel-type"
                    value={value}
                    checked={channelType === value}
                    onChange={() => setChannelType(value)}
                  />
                  {value === "text" ? "Text" : "Voice"}
                </label>
              ))}
            </fieldset>
          ) : null}
          <SubmitRow label={initial === undefined ? "Create" : "Save"} pending={mutation.isPending} />
        </Shell>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
