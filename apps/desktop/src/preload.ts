import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type DesktopBridgeShape } from "./shared.js";

/**
 * Minimal preload bridge. No Node.js access is exposed to renderers
 * (sandbox on, nodeIntegration off): only these typed, main-validated
 * channels. Both the local connect screen and the remote web app use
 * `window.desktop` — the web app feature-detects it and works unchanged
 * in a normal browser.
 */
const desktop: DesktopBridgeShape = {
  platform: process.platform as "win32" | "linux" | "darwin",

  getVersion: (): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.getVersion),

  getCapabilities: (): Promise<{
    globalPtt: boolean;
    globalPttReason: string | null;
    screenPicker: boolean;
    systemAudio: "windows-loopback" | "unsupported";
  }> => ipcRenderer.invoke(IPC_CHANNELS.getCapabilities),

  connectToServer: (url: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.connectToServer, { url }),

  getRecentServers: (): Promise<{ url: string; lastUsed: number }[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.getRecentServers),

  forgetServer: (url: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.forgetServer, { url }),

  backToConnect: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.backToConnect),

  notify: (title: string, body: string, channelId?: string): Promise<void> =>
    ipcRenderer.invoke(
      IPC_CHANNELS.notify,
      channelId === undefined ? { title, body } : { title, body, channelId },
    ),

  setBadge: (count: number): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.setBadge, { count }),

  getSetting: (key: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.getSetting, { key }),

  setSetting: (key: string, value: unknown): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.setSetting, { [key]: value }),

  onShowPicker: (
    callback: (request: { requestId: string; sources: { id: string; name: string; thumbnail: string }[] }) => void,
  ): (() => void) => {
    const listener = (
      _event: unknown,
      request: { requestId: string; sources: { id: string; name: string; thumbnail: string }[] },
    ): void => callback(request);
    ipcRenderer.on(IPC_CHANNELS.showPicker, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.showPicker, listener);
    };
  },

  pickScreenSource: (requestId: string, sourceId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.screenPick, { requestId, sourceId }),

  onPttKey: (callback: (active: boolean) => void): (() => void) => {
    const listener = (_event: unknown, state: { active: boolean }): void =>
      callback(state.active === true);
    ipcRenderer.on(IPC_CHANNELS.pttKey, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.pttKey, listener);
    };
  },

  onToggleMute: (callback: () => void): (() => void) => {
    const listener = (): void => callback();
    ipcRenderer.on(IPC_CHANNELS.toggleMute, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.toggleMute, listener);
    };
  },

  onNotificationClick: (callback: (channelId: string) => void): (() => void) => {
    const listener = (_event: unknown, body: unknown): void => {
      if (
        typeof body === "object" &&
        body !== null &&
        "channelId" in body &&
        typeof body.channelId === "string" &&
        body.channelId.length > 0
      ) {
        callback(body.channelId);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.notificationClick, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.notificationClick, listener);
    };
  },
};

contextBridge.exposeInMainWorld("desktop", desktop);

export type DesktopBridge = typeof desktop;
