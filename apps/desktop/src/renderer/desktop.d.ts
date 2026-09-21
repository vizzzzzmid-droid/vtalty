import type { DesktopBridge } from "../preload.js";

declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}

export {};
