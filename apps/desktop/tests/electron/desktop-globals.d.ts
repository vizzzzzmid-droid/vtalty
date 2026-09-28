/**
 * Minimal `window.desktop` shape for the Electron smoke spec. Mirrors the
 * preload bridge (apps/desktop/src/preload.ts); only the members the spec
 * touches are declared.
 */
interface TestDesktopBridge {
  getVersion: () => Promise<string>;
  getCapabilities: () => Promise<{
    globalPtt: boolean;
    globalPttReason: string | null;
    screenPicker: boolean;
    systemAudio: "windows-loopback" | "unsupported";
  }>;
  pickScreenSource: (requestId: string, sourceId: string) => Promise<unknown>;
  onShowPicker: (callback: (request: unknown) => void) => () => void;
  onPttKey: (callback: (active: boolean) => void) => () => void;
  onToggleMute: (callback: () => void) => () => void;
  onNotificationClick: (callback: (channelId: string) => void) => () => void;
  getSetting: (key: string) => Promise<unknown>;
  setSetting: (key: string, value: unknown) => Promise<boolean>;
}

interface Window {
  desktop: TestDesktopBridge;
}
