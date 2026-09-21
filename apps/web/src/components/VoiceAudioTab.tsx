import { useEffect, useRef, useState } from "react";
import { analyserLevel, buildMicChain, type MicChain } from "../voice/chain.js";
import {
  listInputDevices,
  listOutputDevices,
  rebuildMicChain,
  setInputVolume,
  setOutputDevice,
  startAudioPlayback,
} from "../voice/room.js";
import { useVoiceConnection } from "../voice/store.js";
import { useVoiceSettings } from "../voice/settings.js";
import { Field, inputClass } from "./ui.js";

const supportsOutputSelection =
  typeof window !== "undefined" &&
  "HTMLMediaElement" in window &&
  "setSinkId" in HTMLMediaElement.prototype;

export function VoiceAudioTab(): React.JSX.Element {
  const settings = useVoiceSettings();
  const needsAudioGesture = useVoiceConnection((state) => state.needsAudioGesture);
  const audioNotice = useVoiceConnection((state) => state.audioNotice);
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [meter, setMeter] = useState(0);
  const [testing, setTesting] = useState(false);
  const [capturingKey, setCapturingKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chainRef = useRef<MicChain | null>(null);
  const rafRef = useRef(0);

  const reloadDevices = async (): Promise<void> => {
    try {
      const [ins, outs] = await Promise.all([listInputDevices(), listOutputDevices()]);
      setInputs(ins);
      setOutputs(outs);
      setError(null);
    } catch {
      setError("Could not list audio devices.");
    }
  };

  useEffect(() => {
    void reloadDevices();
  }, []);

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      chainRef.current?.cleanup();
      chainRef.current = null;
    },
    [],
  );

  const requestAccess = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) {
        track.stop();
      }
      await reloadDevices();
    } catch {
      setError("Microphone access was denied.");
    }
  };

  const toggleTest = async (): Promise<void> => {
    if (testing) {
      cancelAnimationFrame(rafRef.current);
      chainRef.current?.cleanup();
      chainRef.current = null;
      setTesting(false);
      setMeter(0);
      return;
    }
    try {
      const chain = await buildMicChain({
        deviceId: settings.inputDeviceId,
        noiseMode: settings.noiseMode,
        noiseSuppression: settings.noiseSuppression,
        echoCancellation: settings.echoCancellation,
        autoGainControl: settings.autoGainControl,
        inputVolume: settings.inputVolume,
        gateEnabled: settings.gateEnabled,
        gateThresholdDb: settings.gateThresholdDb,
        loopback: settings.hearMyself,
      });
      chainRef.current = chain;
      setTesting(true);
      const loop = (): void => {
        setMeter(analyserLevel(chain.analyser));
        rafRef.current = requestAnimationFrame(loop);
      };
      loop();
    } catch {
      setError("Microphone test failed: check the input device.");
    }
  };

  const changeInput = async (deviceId: string | null): Promise<void> => {
    settings.set({ inputDeviceId: deviceId });
    try {
      await rebuildMicChain();
    } catch {
      setError("Could not switch input while connected.");
    }
  };

  const applyLiveChange = (): void => {
    void rebuildMicChain()
      .then(() => setError(null))
      .catch(() => setError("Could not apply the new mode while connected."));
  };

  return (
    <div className="flex flex-col gap-4">
      {audioNotice === null ? null : (
        <p role="status" className="rounded px-3 py-2 text-xs [background-color:var(--surface-3)]">
          {audioNotice}
        </p>
      )}
      {needsAudioGesture ? (
        <button
          type="button"
          onClick={() => void startAudioPlayback()}
          className="rounded px-3 py-2 text-sm text-white"
          style={{ backgroundColor: "var(--accent-strong)" }}
        >
          Click to enable audio playback
        </button>
      ) : null}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Input device">
          <select
            aria-label="Input device"
            className={inputClass}
            value={settings.inputDeviceId ?? ""}
            onChange={(event) => void changeInput(event.target.value === "" ? null : event.target.value)}
          >
            <option value="">System default</option>
            {inputs.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label.length > 0 ? device.label : `Microphone ${device.deviceId.slice(0, 6)}`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Output device">
          <select
            aria-label="Output device"
            className={inputClass}
            value={settings.outputDeviceId ?? ""}
            disabled={!supportsOutputSelection}
            onChange={(event) =>
              void setOutputDevice(
                event.target.value === "" ? null : event.target.value,
              ).then((ok) => {
                if (!ok) {
                  setError("This browser refused the output switch.");
                }
              })
            }
          >
            <option value="">System default</option>
            {outputs.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label.length > 0 ? device.label : `Output ${device.deviceId.slice(0, 6)}`}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {!supportsOutputSelection ? (
        <p className="text-xs [color:var(--text-muted)]">
          This browser (Firefox/Safari) does not support per-app output switching
          (`setSinkId`); sound follows the system default output.
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void reloadDevices()}
          className="rounded px-3 py-1.5 text-sm [background-color:var(--surface-3)] hover:brightness-110"
        >
          Refresh devices
        </button>
        <button
          type="button"
          onClick={() => void requestAccess()}
          className="rounded px-3 py-1.5 text-sm [background-color:var(--surface-3)] hover:brightness-110"
        >
          Request mic access
        </button>
      </div>

      <fieldset>
        <legend className="mb-1 text-xs font-semibold uppercase tracking-wide [color:var(--text-muted)]">
          Noise suppression
        </legend>
        <div className="flex flex-col gap-1 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="noise-mode"
              checked={settings.noiseMode === "off"}
              onChange={() => {
                settings.set({ noiseMode: "off" });
                applyLiveChange();
              }}
            />
            Off — raw microphone
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="noise-mode"
              checked={settings.noiseMode === "standard"}
              onChange={() => {
                settings.set({ noiseMode: "standard" });
                applyLiveChange();
              }}
            />
            Standard — browser processing (toggles below)
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="noise-mode"
              checked={settings.noiseMode === "enhanced"}
              onChange={() => {
                settings.set({ noiseMode: "enhanced" });
                applyLiveChange();
              }}
            />
            Enhanced — RNNoise neural suppression (48 kHz, heavier CPU)
          </label>
        </div>
      </fieldset>
      {settings.noiseMode === "standard" ? (
        <div className="flex flex-col gap-1 text-sm">
          {(
            [
              ["noiseSuppression", "Noise suppression"],
              ["echoCancellation", "Echo cancellation"],
              ["autoGainControl", "Automatic gain control"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings[key]}
                onChange={(event) => settings.set({ [key]: event.target.checked })}
              />
              {label}
            </label>
          ))}
        </div>
      ) : null}

      <fieldset>
        <legend className="mb-1 text-xs font-semibold uppercase tracking-wide [color:var(--text-muted)]">
          Noise gate (optional, works in every mode)
        </legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.gateEnabled}
            onChange={(event) => {
              settings.set({ gateEnabled: event.target.checked });
              applyLiveChange();
            }}
          />
          Gate silence below the threshold
        </label>
        {settings.gateEnabled ? (
          <Field label={`Gate threshold — ${settings.gateThresholdDb} dB`}>
            <input
              aria-label="Gate threshold"
              type="range"
              min={-60}
              max={-10}
              value={settings.gateThresholdDb}
              onChange={(event) => {
                settings.set({ gateThresholdDb: Number(event.target.value) });
              }}
              // Rebuilding the chain per tick would flap the mic: apply on release.
              onPointerUp={() => applyLiveChange()}
              onBlur={() => applyLiveChange()}
              className="w-full"
            />
          </Field>
        ) : null}
      </fieldset>

      <Field label={`Input volume — ${Math.round(settings.inputVolume * 100)}%`}>
        <input
          aria-label="Input volume"
          type="range"
          min={0}
          max={200}
          value={Math.round(settings.inputVolume * 100)}
          onChange={(event) => void setInputVolume(Number(event.target.value) / 100)}
          className="w-full"
        />
      </Field>

      <div>
        <button
          type="button"
          onClick={() => void toggleTest()}
          className="rounded px-3 py-1.5 text-sm [background-color:var(--surface-3)] hover:brightness-110"
        >
          {testing ? "Stop mic test" : "Test microphone"}
        </button>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.hearMyself}
            onChange={(event) => settings.set({ hearMyself: event.target.checked })}
          />
          Hear myself (loopback — wear headphones to avoid feedback)
        </label>
        <div
          role="meter"
          aria-label="Microphone level"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(meter * 100)}
          className="mt-2 h-2 overflow-hidden rounded [background-color:var(--surface-1)]"
        >
          <div
            className="h-full"
            style={{ width: `${Math.round(meter * 100)}%`, backgroundColor: "var(--status-ok)" }}
          />
        </div>
      </div>

      <fieldset>
        <legend className="mb-1 text-xs font-semibold uppercase tracking-wide [color:var(--text-muted)]">
          Push to talk
        </legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.pttEnabled}
            onChange={(event) => settings.set({ pttEnabled: event.target.checked })}
          />
          Hold-to-talk (web: works while the tab is focused; a global hotkey
          needs the desktop app in Phase 6)
        </label>
        {settings.pttEnabled ? (
          <button
            type="button"
            onClick={() => setCapturingKey(true)}
            className="mt-2 rounded px-3 py-1.5 text-sm [background-color:var(--surface-3)] hover:brightness-110"
          >
            {capturingKey ? "Press a key…" : `Talk key: ${settings.pttKey}`}
          </button>
        ) : null}
      </fieldset>
      {capturingKey ? (
        <KeyCapture
          onCapture={(code) => {
            settings.set({ pttKey: code });
            setCapturingKey(false);
          }}
          onCancel={() => setCapturingKey(false)}
        />
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

function KeyCapture({
  onCapture,
  onCancel,
}: {
  onCapture: (code: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === "Escape") {
        onCancel();
      } else {
        onCapture(event.code);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onCapture, onCancel]);
  return (
    <p role="status" className="text-xs [color:var(--text-muted)]">
      Press any key for push-to-talk (Esc cancels)…
    </p>
  );
}
