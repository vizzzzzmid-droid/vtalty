import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import type { ContentHintMode, ScreenPresetId } from "../voice/store.js";
import { SHARE_PRESET_LABELS, describeShareError, startShare } from "../voice/screen.js";
import { getDesktopBridge, parsePickerRequest } from "../lib/desktop.js";

const PRESETS: ScreenPresetId[] = ["720p30", "1080p30", "1080p60", "source"];

function DesktopPickNote(): React.JSX.Element | null {
  const [caps, setCaps] = useState<{
    systemAudio: "windows-loopback" | "unsupported";
  } | null>(null);
  useEffect(() => {
    const bridge = getDesktopBridge();
    if (bridge === null) {
      return;
    }
    let cancelled = false;
    void bridge
      .getCapabilities()
      .then((value) => {
        if (!cancelled) {
          setCaps({ systemAudio: value.systemAudio });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  if (caps === null) {
    return null;
  }
  return (
    <p className="text-xs [color:var(--text-muted)]">
      {caps.systemAudio === "windows-loopback"
        ? "Desktop app: pick a screen or window below; system audio is captured automatically when you tick audio."
        : "Desktop app: system-audio capture is Windows-only — on this OS screen shares are video-only."}
    </p>
  );
}

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
  // Desktop flow: the Electron main process shows OUR picker (thumbnails)
  // via onShowPicker; the browser's getDisplayMedia picker never appears.
  const [desktopPick, setDesktopPick] = useState<{
    requestId: string;
    sources: { id: string; name: string; thumbnail: string }[];
  } | null>(null);

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (bridge === null || !open) {
      return;
    }
    return bridge.onShowPicker((request) => {
      const parsed = parsePickerRequest(request);
      setDesktopPick(parsed);
      if (parsed === null) {
        setError("Desktop screen picker sent an invalid response.");
      }
    });
  }, [open ]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setPending(true);
    setError(null);
    setDesktopPick(null);
    startShare(channelId, { preset, contentHint, withAudio })
      .then(() => onClose())
      .catch((err: unknown) => {
        setError(describeShareError(err));
      })
      .finally(() => setPending(false));
  };

  const cancelDesktopPick = (): void => {
    const pick = desktopPick;
    setDesktopPick(null);
    if (pick !== null) {
      const bridge = getDesktopBridge();
      // Empty sourceId = user cancelled: main denies the capture.
      void bridge?.pickScreenSource(pick.requestId, "").catch(() => undefined);
    }
    setPending(false);
    setError("Screen sharing was cancelled in the desktop picker.");
  };

  const chooseDesktopSource = (sourceId: string): void => {
    const pick = desktopPick;
    setDesktopPick(null);
    if (pick !== null) {
      const bridge = getDesktopBridge();
      void bridge?.pickScreenSource(pick.requestId, sourceId).catch(() => undefined);
    }
    // startShare's getDisplayMedia call is already pending inside main's
    // display-media handler; the pick resolves it. Keep `pending` until the
    // share either starts (dialog closes) or fails (error below).
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
              <DesktopPickNote />
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
          {desktopPick !== null ? (
            <div
              role="dialog"
              aria-label="Choose a screen to share"
              className="mt-4 rounded border border-white/10 p-3"
            >
              <p className="text-sm font-medium">Choose a screen to share</p>
              <ul className="mt-2 grid max-h-64 grid-cols-2 gap-2 overflow-y-auto">
                {desktopPick.sources.map((source) => (
                  <li key={source.id}>
                    <button
                      type="button"
                      onClick={() => chooseDesktopSource(source.id)}
                      className="flex w-full flex-col gap-1 rounded p-1 text-left text-xs [background-color:var(--surface-1)] hover:brightness-125"
                    >
                      {source.thumbnail.length > 0 ? (
                        <img src={source.thumbnail} alt="" className="aspect-video w-full rounded object-cover" />
                      ) : (
                        <span aria-hidden="true" className="flex aspect-video w-full items-center justify-center rounded [background-color:var(--surface-3)]">
                          No preview
                        </span>
                      )}
                      <span className="truncate px-1">{source.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={cancelDesktopPick}
                className="mt-3 rounded px-3 py-1.5 text-sm [background-color:var(--surface-3)] hover:brightness-110"
              >
                Cancel
              </button>
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
