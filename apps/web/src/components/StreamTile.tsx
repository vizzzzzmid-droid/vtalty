import { useEffect, useRef, useState } from "react";
import { Maximize, Minimize, PictureInPicture2, Volume2, VolumeX, X } from "lucide-react";
import { useVoiceSettings } from "../voice/settings.js";
import {
  attachStreamAudio,
  attachStreamVideo,
  isDegradedQuality,
  setStreamQuality,
  setStreamVolume,
  sharerQuality,
  unwatchStream,
  watchStream,
} from "../voice/screen.js";
import { useVoiceConnection, type StreamQuality } from "../voice/store.js";
import { Tip } from "./ui.js";

/**
 * Opt-in screen viewer. Nothing subscribes until "Watch stream" is clicked;
 * unmounting or "Stop watching" unsubscribes immediately (bandwidth stops).
 */
export function StreamTile({
  sharerId,
  sharerName,
  theater,
  onTheater,
}: {
  sharerId: string;
  sharerName: string;
  theater: boolean;
  onTheater: (sharerId: string | null) => void;
}): React.JSX.Element {
  const watching = useVoiceConnection((state) => state.watching[sharerId]);
  const startWatching = useVoiceConnection((state) => state.startWatching);
  const stopWatching = useVoiceConnection((state) => state.stopWatching);
  const setWatchQuality = useVoiceConnection((state) => state.setWatchQuality);
  const streamVolume = useVoiceSettings((state) => state.streamVolumes[sharerId] ?? 1);
  const setStreamVolumeSetting = useVoiceSettings((state) => state.setStreamVolume);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [muted, setMuted] = useState(false);
  const [degraded, setDegraded] = useState(false);

  // (Re)attach loop while watching: tracks may arrive after the click.
  useEffect(() => {
    if (watching === undefined) {
      return undefined;
    }
    watchStream(sharerId);
    const timer = setInterval(() => {
      if (videoRef.current !== null) {
        attachStreamVideo(sharerId, videoRef.current);
      }
      if (audioRef.current !== null) {
        attachStreamAudio(sharerId, audioRef.current);
      }
      setDegraded(isDegradedQuality(sharerQuality(sharerId)));
    }, 1000);
    return () => {
      clearInterval(timer);
      unwatchStream(sharerId);
    };
  }, [watching, sharerId]);

  useEffect(() => {
    void setStreamVolume(sharerId, muted ? 0 : streamVolume);
  }, [sharerId, muted, streamVolume]);

  if (watching === undefined) {
    return (
      <div className="flex items-center justify-between gap-2 rounded px-3 py-2 [background-color:var(--surface-2)]">
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <span
            aria-label="Live stream"
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold text-white"
            style={{ backgroundColor: "var(--live)" }}
          >
            LIVE
          </span>
          <span className="truncate">
            {sharerName} is sharing their screen
          </span>
        </span>
        <button
          type="button"
          onClick={() => startWatching(sharerId)}
          className="shrink-0 rounded px-3 py-1 text-xs font-medium text-white"
          style={{ backgroundColor: "var(--accent-strong)" }}
        >
          Watch stream
        </button>
      </div>
    );
  }

  const quality = watching.quality;
  return (
    <div
      ref={boxRef}
      className={`flex flex-col gap-1 rounded p-2 [background-color:var(--surface-2)] ${
        theater ? "fixed inset-4 z-40" : ""
      }`}
      aria-label={`Screen stream by ${sharerName}`}
    >
      <div className="flex items-center gap-2">
        <span
          aria-label="Live stream"
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold text-white"
          style={{ backgroundColor: "#ed4245" }}
        >
          LIVE
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{sharerName}</span>
        {degraded ? (
          <span role="status" className="shrink-0 text-[11px] text-amber-400">
            Stream quality degraded
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
              onChange={(event) => {
                const next = Number(event.target.value) / 100;
                setStreamVolumeSetting(sharerId, next);
                void setStreamVolume(sharerId, muted ? 0 : next);
              }}
              className="w-20"
            />
          </span>
        </Tip>
        <Tip label={theater ? "Exit theater" : "Theater mode"} side="top">
          <button
            type="button"
            aria-label={theater ? "Exit theater mode" : "Open theater mode"}
            onClick={() => onTheater(theater ? null : sharerId)}
            className="rounded p-1 [color:var(--text-muted)] hover:[color:var(--text-primary)]"
          >
            {theater ? (
              <Minimize size={14} aria-hidden="true" />
            ) : (
              <PictureInPicture2 size={14} aria-hidden="true" />
            )}
          </button>
        </Tip>
        <Tip label="Fullscreen" side="top">
          <button
            type="button"
            aria-label="Fullscreen stream"
            onClick={() => {
              if (document.fullscreenElement !== null) {
                void document.exitFullscreen();
              } else {
                void boxRef.current?.requestFullscreen().catch(() => undefined);
              }
            }}
            className="rounded p-1 [color:var(--text-muted)] hover:[color:var(--text-primary)]"
          >
            <Maximize size={14} aria-hidden="true" />
          </button>
        </Tip>
        <button
          type="button"
          aria-label="Stop watching"
          onClick={() => stopWatching(sharerId)}
          className="rounded p-1 [color:var(--text-muted)] hover:[color:var(--text-primary)]"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        aria-label={`Screen share video by ${sharerName}`}
        className={`w-full rounded bg-black ${theater ? "max-h-full flex-1" : "max-h-64"}`}
      />
      {/* Screen-share audio rides a separate track (muted video avoids double). */}
      <audio ref={audioRef} autoPlay aria-hidden="true" className="hidden" />
    </div>
  );
}
