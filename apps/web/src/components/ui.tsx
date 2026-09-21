import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import { X } from "lucide-react";
import type { ReactNode } from "react";

export function Tip({
  label,
  children,
  side,
}: {
  label: string;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}): ReactNode {
  return (
    <Tooltip.Root delayDuration={300}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side ?? "top"}
          className="z-50 rounded px-2 py-1 text-xs [background-color:var(--surface-3)] [color:var(--text-primary)]"
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}): ReactNode {
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
          className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg p-5 [background-color:var(--surface-2)]"
          aria-describedby={undefined}
        >
          <div className="flex items-start justify-between gap-4">
            <Dialog.Title className="text-base font-semibold">
              {title}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close dialog"
                className="rounded p-1 [color:var(--text-muted)] hover:[background-color:var(--surface-3)]"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="mt-2 text-sm [color:var(--text-muted)]">
            {description}
          </Dialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded px-4 py-2 text-sm [background-color:var(--surface-3)] hover:brightness-110"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500"
            >
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide [color:var(--text-muted)]">
        {label}
      </span>
      {children}
      {error === undefined || error.length === 0 ? null : (
        <span role="alert" className="mt-1 block text-xs text-red-400">
          {error}
        </span>
      )}
    </label>
  );
}

export const inputClass =
  "w-full rounded border border-transparent px-3 py-2 text-sm [background-color:var(--surface-3)] [color:var(--text-primary)] outline-none focus:border-[var(--accent)]";
