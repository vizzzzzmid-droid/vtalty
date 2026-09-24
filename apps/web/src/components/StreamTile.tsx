import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize, Volume2, VolumeX, X } from "lucide-react";
import { useVoiceSettings } from "../voice/settings.js";
import {
  attachStreamAudio,
  attachStreamVideo,
  debugAudio,
  isDegradedQuality,
  setStreamQuality,
  setStreamVolume,
  sharerQuality,
  unwatchStream,
  watchStream,
} from "../voice/screen.js";
import { useVoiceConnection, type StreamQuality } from "../voice/store.js";
import { Avatar } from "./Avatar.js";
import { Tip } from "./ui.js";

/**
 * Opt-in screen viewer card. Nothing subscribes until "Watch stream" is
 * clicked; unmounting or "Stop watching" unsubscribes immediately
 * (bandwidth stops). Fullscreen is a custom in-app overlay (a fixed
 * full-viewport portal), NOT the native Fullscreen API — the native API
 * shows generic OS/browser chrome and is broken in the Electron desktop
 * client.
 */
export function StreamTile({
  sharerId,
  sharerName,
  sharerAvatarUrl,
}: {
  sharerId: string;
  sharerName: string;
  sharerAvatarUrl?: string | null;
}): React.JSX.Element {
  const watching = useVoiceConnection((state) => state.watching[sharerId]);
  const startWatching = useVoiceConnection((state) => state.startWatching);
  const stopWatching = useVoiceConnection((state) => state.stopWatching);
  const setWatchQuality = useVoiceConnection((state) => state.setWatchQuality);
  const streamVolume = useVoiceSettings((state) => state.streamVolumes[sharerId] ?? 1);
  const setStreamVolumeSetting = useVoiceSettings((state) => state.setStreamVolume);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayVideoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [muted, setMuted] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  // (Re)attach loop while watching: tracks may arrive after the click.
  // Runs again when the overlay opens so its video element gets the track.
  useEffect(() => {
    if (watching === undefined) {
      return undefined;
    }
    watchStream(sharerId);
    const attach = (): void => {
      // TEMP-DEBUG(screen-audio): is the (re)attach loop running at all, and
      // do the media elements exist when attachStreamAudio is invoked?
      debugAudio("tile:attach-tick", {
        sharerId,
        hasVideoElement: videoRef.current !== null,
        hasOverlayVideoElement: overlayVideoRef.current !== null,
        hasAudioElement: audioRef.current !== null,
      });
      if (videoRef.current !== null) {
        attachStreamVideo(sharerId, videoRef.current);
      }
      if (overlayVideoRef.current !== null) {
        attachStreamVideo(sharerId, overlayVideoRef.current);
      }
      if (audioRef.current !== null) {
        attachStreamAudio(sharerId, audioRef.current);
      }
      setDegraded(isDegradedQuality(sharerQuality(sharerId)));
    };
    attach();
    const timer = setInterval(attach, 1000);
    return () => {
      clearInterval(timer);
      unwatchStream(sharerId);
    };
  }, [watching, sharerId, fullscreen]);

  useEffect(() => {
    void setStreamVolume(sharerId, muted ? 0 : streamVolume);
  }, [sharerId, muted, streamVolume]);

  // Escape closes the overlay; lock background scroll while it is open.
  useEffect(() => {
    if (!fullscreen) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setFullscreen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [fullscreen]);

  const onVolumeChange = (next: number): void => {
    setStreamVolumeSetting(sharerId, next);
    void setStreamVolume(sharerId, muted ? 0 : next);
  };

  if (watching === undefined) {
    return (
      <div className="flex flex-col overflow-hidden rounded-lg ring-1 ring-white/5 [background-color:var(--surface-2)]">
        <div className="relative flex aspect-video flex-col items-center justify-center gap-2 bg-black/50 px-3">
          <span
            aria-label="Live stream"
            className="absolute left-2 top-2 rounded px-1.5 py-0.5 text-[10px] font-bold text-white"
            style={{ backgroundColor: "var(--live)" }}
          >
            LIVE
          </span>
          <Avatar name={sharerName} src={sharerAvatarUrl ?? null} size={40} />
          <span className="max-w-full truncate text-sm [color:var(--text-muted)]">
            {sharerName} is sharing their screen
          </span>
          <button
            type="button"
            onClick={() => startWatching(sharerId)}
            className="rounded px-3 py-1.5 text-xs font-medium text-white hover:brightness-110"
            style={{ backgroundColor: "var(--accent-strong)" }}
          >
            Watch stream
          </button>
        </div>
      </div>
    );
  }

  const quality = watching.quality;
  return (
    <>
      <div
        className="flex flex-col overflow-hidden rounded-lg ring-1 ring-white/5 [background-color:var(--surface-2)]"
        aria-label={`Screen stream by ${sharerName}`}
      >
        <div className="group relative bg-black">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            aria-label={`Screen share video by ${sharerName}`}
            className="aspect-video w-full object-contain"
          />
          {/* Hover chrome: fullscreen top-right, sharer name bottom. */}
          <div className="absolute right-2 top-2 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            <Tip label="Fullscreen" side="left">
              <button
                type="button"
                aria-label={`Open ${sharerName}'s stream fullscreen`}
                onClick={() => setFullscreen(true)}
                className="rounded bg-black/70 p-1.5 text-white hover:bg-black/90"
              >
                <Maximize size={14} aria-hidden="true" />
              </button>
            </Tip>
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2.5 pb-1.5 pt-6 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            <span className="block truncate text-xs font-medium text-white">
              {sharerName}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 px-2.5 py-1.5">
          <span
            aria-label="Live stream"
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold text-white"
            style={{ backgroundColor: "var(--live)" }}
          >
            LIVE
          </span>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{sharerName}</span>
          {degraded ? (
            <span role="status" className="shrink-0 text-[11px] text-amber-400">
              Degraded
            </span>
          ) : null}
          <label className="flex shrink-0 items-center gap-1 text-[11px] [color:var(--text-muted)]">
            Quality
            <select
              aria-label="Stream quality"
              value={quality}
              onChange={(event) => {
                const next = event.target.value as StreamQuality;
                setWatchQuality(sharerId, next);
                void setStreamQuality(sharerId, next);
              }}
              className="rounded px-1 py-0.5 text-[11px] [background-color:var(--surface-1)]"
            >
              <option value="auto">Auto</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <Tip label="Stream volume" side="top">
            <span className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                aria-label={muted ? "Unmute stream" : "Mute stream"}
                onClick={() => setMuted((value) => !value)}
                className="rounded p-1 [color:var(--text-muted)] hover:[color:var(--text-primary)]"
              >
                {muted ? (
                  <VolumeX size={14} aria-hidden="true" />
                ) : (
                  <Volume2 size={14} aria-hidden="true" />
                )}
              </button>
              <input
                aria-label="Stream volume"
                type="range"
                min={0}
                max={100}
                value={Math.round(streamVolume * 100)}
                onChange={(event) => onVolumeChange(Number(event.target.value) / 100)}
                className="w-20"
              />
            </span>
          </Tip>
          <button
            type="button"
            aria-label="Stop watching"
            onClick={() => stopWatching(sharerId)}
            className="shrink-0 rounded p-1 [color:var(--text-muted)] hover:[color:var(--text-primary)]"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
        {/* Screen-share audio rides a separate track (muted video avoids
            double). Visually hidden but NOT display:none: Chromium suspends
            media in display:none subtrees (same convention as remoteAudio). */}
        <audio
          ref={audioRef}
          autoPlay
          aria-hidden="true"
          className="pointer-events-none absolute h-px w-px overflow-hidden opacity-0"
        />
      </div>
      {fullscreen
        ? createPortal(
            <StreamOverlay
              sharerName={sharerName}
              sharerAvatarUrl={sharerAvatarUrl ?? null}
              videoRef={overlayVideoRef}
              muted={muted}
              streamVolume={streamVolume}
              onToggleMute={() => setMuted((value) => !value)}
              onVolumeChange={onVolumeChange}
              onClose={() => setFullscreen(false)}
            />,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * Custom in-app fullscreen layer. Deliberately avoids the native
 * Fullscreen API, which shows generic OS/browser chrome and does not work
 * in the Electron desktop client. The tile's
 * hidden <audio> element stays mounted underneath, so stream audio keeps
 * playing while the overlay is open.
 */
function StreamOverlay({
  sharerName,
  sharerAvatarUrl,
  videoRef,
  muted,
  streamVolume,
  onToggleMute,
  onVolumeChange,
  onClose,
}: {
  sharerName: string;
  sharerAvatarUrl: string | null;
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  muted: boolean;
  streamVolume: number;
  onToggleMute: () => void;
  onVolumeChange: (next: number) => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${sharerName}'s screen stream, fullscreen`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black"
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        aria-label={`Screen share video by ${sharerName}, fullscreen`}
        className="h-full w-full object-contain"
      />
      {/* Top bar: identity + controls, always visible. */}
      <div className="absolute inset-x-0 top-0 flex items-center gap-3 bg-gradient-to-b from-black/80 to-transparent px-4 pb-10 pt-3">
        <Avatar name={sharerName} src={sharerAvatarUrl} size={28} />
        <span className="truncate text-sm font-medium text-white">{sharerName}</span>
        <span
          aria-label="Live stream"
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold text-white"
          style={{ backgroundColor: "var(--live)" }}
        >
          LIVE
        </span>
        <div className="flex-1" />
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label={muted ? "Unmute stream" : "Mute stream"}
            onClick={onToggleMute}
            className="rounded p-1.5 text-white hover:bg-white/10"
          >
            {muted ? (
              <VolumeX size={16} aria-hidden="true" />
            ) : (
              <Volume2 size={16} aria-hidden="true" />
            )}
          </button>
          <input
            aria-label="Stream volume"
            type="range"
            min={0}
            max={100}
            value={Math.round(streamVolume * 100)}
            onChange={(event) => onVolumeChange(Number(event.target.value) / 100)}
            className="w-24"
          />
        </span>
        <button
          type="button"
          aria-label="Close fullscreen"
          onClick={onClose}
          className="rounded p-1.5 text-white hover:bg-white/10"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
