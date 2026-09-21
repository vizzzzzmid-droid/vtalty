import * as Dialog from "@radix-ui/react-dialog";
import { useState, type FormEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import type { ContentHintMode, ScreenPresetId } from "../voice/store.js";
import { SHARE_PRESET_LABELS, describeShareError, startShare } from "../voice/screen.js";

const PRESETS: ScreenPresetId[] = ["720p30", "1080p30", "1080p60", "source"];

export function ScreenShareDialog({
  open,
  channelId,
  canShare,
  onClose,
}: {
  open: boolean;
  channelId: string;
  canShare: boolean;
  onClose: () => void;
}): ReactNode {
  const [preset, setPreset] = useState<ScreenPresetId>("1080p30");
  const [contentHint, setContentHint] = useState<ContentHintMode>("motion");
  const [withAudio, setWithAudio] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setPending(true);
    setError(null);
    startShare(channelId, { preset, contentHint, withAudio })
      .then(() => onClose())
      .catch((err: unknown) => {
        setError(describeShareError(err));
      })
      .finally(() => setPending(false));
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
          className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg p-5 [background-color:var(--surface-2)]"
        >
          <div className="flex items-start justify-between gap-4">
            <Dialog.Title className="text-base font-semibold">Share your screen</Dialog.Title>
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
          {!canShare ? (
            <p role="alert" className="mt-3 text-sm text-red-400">
              Your role cannot share the screen in this server.
            </p>
          ) : (
            <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
              <fieldset>
                <legend className="mb-1 text-xs font-semibold uppercase tracking-wide [color:var(--text-muted)]">
                  Quality preset
                </legend>
                <div className="flex flex-col gap-1 text-sm">
                  {PRESETS.map((id) => (
                    <label key={id} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="share-preset"
                        checked={preset === id}
                        onChange={() => setPreset(id)}
                      />
                      {SHARE_PRESET_LABELS[id]}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend className="mb-1 text-xs font-semibold uppercase tracking-wide [color:var(--text-muted)]">
                  Content type
                </legend>
                <div className="flex gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="content-hint"
                      checked={contentHint === "motion"}
                      onChange={() => setContentHint("motion")}
                    />
                    Motion (video, games)
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="content-hint"
                      checked={contentHint === "detail"}
                      onChange={() => setContentHint("detail")}
                    />
                    Text / detail (docs, code)
                  </label>
                </div>
              </fieldset>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={withAudio}
                  onChange={(event) => setWithAudio(event.target.checked)}
                />
                Share tab/system audio (browser- and OS-dependent: Chrome offers
                a checkbox in the picker; Firefox/Safari may share video only)
              </label>
              {error === null ? null : (
                <p role="alert" className="text-sm text-red-400">
                  {error}
                </p>
              )}
              <button
                type="submit"
                disabled={pending}
                className="rounded px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                style={{ backgroundColor: "var(--accent)" }}
              >
                {pending ? "Starting…" : "Start sharing"}
              </button>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
