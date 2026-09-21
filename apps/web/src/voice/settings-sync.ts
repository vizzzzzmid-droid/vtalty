import { voiceSettingsSchema, type VoiceSettings } from "@vitality/shared";
import { fetchVoiceSettings, putVoiceSettings } from "../api/resources.js";
import { useVoiceSettings } from "./settings.js";

let activeUser: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let silenced = false;
let unsubscribe: (() => void) | null = null;

function serverFields(state: ReturnType<typeof useVoiceSettings.getState>): VoiceSettings {
  return {
    noiseMode: state.noiseMode,
    noiseSuppression: state.noiseSuppression,
    echoCancellation: state.echoCancellation,
    autoGainControl: state.autoGainControl,
    gateEnabled: state.gateEnabled,
    gateThresholdDb: state.gateThresholdDb,
    hearMyself: state.hearMyself,
    inputVolume: state.inputVolume,
    inputDeviceId: state.inputDeviceId,
    outputDeviceId: state.outputDeviceId,
    pttEnabled: state.pttEnabled,
    pttKey: state.pttKey,
  };
}

async function pullSettings(): Promise<void> {
  try {
    const data: unknown = await fetchVoiceSettings();
    const parsed = voiceSettingsSchema.safeParse(data);
    if (!parsed.success || activeUser === null) {
      return;
    }
    silenced = true;
    useVoiceSettings.getState().set(parsed.data);
    queueMicrotask(() => {
      silenced = false;
    });
  } catch {
    // Offline or pre-Phase-5 server: local settings keep working.
  }
}

/** Start syncing local voice prefs to the server (call after login). */
export function startSettingsSync(userId: string): void {
  stopSettingsSync();
  activeUser = userId;
  void pullSettings();
  unsubscribe = useVoiceSettings.subscribe((state) => {
    if (silenced || activeUser === null) {
      return;
    }
    if (timer !== null) {
      clearTimeout(timer);
    }
    const snapshot = serverFields(state);
    timer = setTimeout(() => {
      putVoiceSettings(snapshot).catch(() => undefined);
    }, 800);
  });
}

export function stopSettingsSync(): void {
  activeUser = null;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (unsubscribe !== null) {
    unsubscribe();
    unsubscribe = null;
  }
}
