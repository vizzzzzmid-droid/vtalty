import {
  app,
  BrowserWindow,
  desktopCapturer,
  Menu,
  nativeImage,
  Tray,
} from "electron";
import path from "node:path";
import { serverUrlSchema, normalizeServerUrl } from "./shared.js";
import { decideNavigation, decidePermission, frameBelongsToWindow } from "./security.js";
import { listScreenSources, requestScreenPick, cancelScreenPicks } from "./picker.js";
import {
  registerMuteShortcut,
  startGlobalPtt,
  stopGlobalPtt,
  unregisterShortcuts,
} from "./ptt.js";
import { loadSettings, saveSettings } from "./store.js";
import { openExternalSafe, registerIpc } from "./ipc.js";
import { APP_ID } from "./identity.js";
import { existsSync } from "node:fs";
import {
  FALLBACK_TRAY_PNG_BASE64,
  pickTrayIconPath,
  shouldHideToTray,
  trayIconCandidates,
} from "./tray.js";

// Compiled CJS layout: __dirname is dist/, one level below the app root.
const ROOT = path.resolve(__dirname, "..");

// Windows app identity (AppUserModelID). electron-builder's NSIS installer
// stamps `${APP_ID}` onto the shortcuts it creates (installer.nsh →
// WinShell::SetLnkAUMI), while Electron only sets an explicit AUMID if the app
// asks for one: its fallback is `electron.app.<product_name read from the exe
// version resource>` (shell/common/application_info_win.cc → GetRawAppUserModelID;
// "electron.app.Electron" in an unpackaged run). Those two identities never
// match, so Windows saw the app's processes/windows as a different application
// than its own shortcuts — Task Manager listed the processes as flat,
// ungrouped entries and notifications/taskbar fell back to the Electron
// identity. One explicit AUMID shared by processes, windows and shortcuts is
// the documented requirement (see src/identity.ts). Must run before any UI.
if (process.platform === "win32") {
  app.setAppUserModelId(APP_ID);
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** True only after a tray icon actually exists — gate for hiding the window. */
let trayReady = false;
let instanceOrigin = "";

function preloadPath(): string {
  return path.join(ROOT, "dist", "preload.js");
}

function connectPageUrl(): string {
  return `file://${path.join(ROOT, "dist", "renderer", "connect.html")}`;
}

function applyWindowState(window: BrowserWindow): void {
  const settings = loadSettings();
  const bounds = settings.windowBounds;
  if (bounds !== null) {
    try {
      window.setBounds({ x: bounds.x ?? 100, y: bounds.y ?? 100, width: bounds.width, height: bounds.height });
    } catch {
      // Off-screen coordinates (monitor unplugged): keep defaults.
    }
  }
  if (settings.windowMaximized) {
    window.maximize();
  }
}

let quitting = false;

function persistWindowState(window: BrowserWindow): void {
  const settings = loadSettings();
  const bounds = window.getBounds();
  saveSettings({
    ...settings,
    windowBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    windowMaximized: window.isMaximized(),
  });
}

function loadInstance(url: string): Promise<void> {
  const window = mainWindow;
  if (window === null || window.isDestroyed()) {
    return Promise.resolve();
  }
  // Re-validate at the call site (defense in depth): callers pass
  // already-validated URLs, but the loader never trusts them blindly —
  // credentials, fragments, and non-loopback http are stripped/rejected.
  const normalized = normalizeServerUrl(url);
  if (normalized === null) {
    return Promise.resolve();
  }
  instanceOrigin = new URL(normalized).origin;
  return window.loadURL(normalized);
}

function showConnectScreen(): void {
  const window = mainWindow;
  if (window === null || window.isDestroyed()) {
    return;
  }
  instanceOrigin = "";
  cancelScreenPicks();
  void window.loadURL(connectPageUrl());
}

function createWindow(startMinimized: boolean): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: "#1e1f22",
    show: !startMinimized,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  applyWindowState(window);

  // Preload failures are silent by default (no bridge, no message) — log
  // them so a broken preload can never hide behind a working page.
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`[desktop] preload failed: ${preloadPath}: ${String(error)}`);
  });

  // --- Navigation lockdown ---
  window.webContents.on("will-navigate", (event, url) => {
    const decision = decideNavigation(url, instanceOrigin);
    if (decision !== "allow") {
      event.preventDefault();
      if (decision === "external") {
        openExternalSafe(url);
      }
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    const decision = decideNavigation(url, instanceOrigin);
    if (decision === "external") {
      openExternalSafe(url);
    }
    return { action: "deny" };
  });

  // --- Permissions: media/display-capture/notifications for our origin only ---
  // Deny-by-default check handler closes the grant path that the request
  // handler alone leaves open (Electron requires both for full handling).
  window.webContents.session.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin) => {
      const origin =
        requestingOrigin.length > 0 ? requestingOrigin : webContents?.getURL() ?? "";
      return decidePermission(permission, origin, instanceOrigin) !== "other";
    },
  );
  window.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const requestingUrl =
        details.requestingUrl ?? webContents.getURL();
      const allowed =
        (decidePermission(permission, requestingUrl, instanceOrigin) !== "other");
      callback(allowed);
    },
  );

  // --- Display-capture interception: custom source picker ---
  window.webContents.session.setDisplayMediaRequestHandler(
    (request, callback) => {
      if (!request.videoRequested) {
        callback({});
        return;
      }
      // The request must come from the connected instance origin: a stale
      // frame from a previous origin (or the connect screen) cannot be
      // granted capture of the user's screens.
      let originOk = false;
      try {
        originOk =
          instanceOrigin.length > 0 &&
          new URL(request.securityOrigin).origin === new URL(instanceOrigin).origin;
      } catch {
        originOk = false;
      }
      if (!originOk) {
        callback({});
        return;
      }
      if (
        request.frame !== null &&
        !frameBelongsToWindow(request.frame, window)
      ) {
        callback({});
        return;
      }
      void (async () => {
        if (instanceOrigin.length === 0) {
          callback({});
          return;
        }
        try {
          const sources = await listScreenSources(window);
          if (sources.length === 0) {
            callback({});
            return;
          }
          const { sourceId } = await requestScreenPick(window);
          if (sourceId === null) {
            callback({});
            return;
          }
          const full = await desktopCapturer.getSources({
            types: ["screen", "window"],
            thumbnailSize: { width: 0, height: 0 },
            fetchWindowIcons: false,
          });
          const match = full.find((entry) => entry.id === sourceId);
          if (match === undefined) {
            callback({});
            return;
          }
          // System-audio loopback is Windows-only (see Electron `Streams`
          // docs); other platforms silently get video-only capture.
          callback({
            video: match,
            ...(request.audioRequested && process.platform === "win32"
              ? { audio: "loopback" as const }
              : {}),
          });
        } catch {
          callback({});
        }
      })();
    },
  );

  window.on("minimize", () => {
    // Only hide when the setting is on AND a tray icon really exists;
    // otherwise minimize normally so the window stays reachable on the
    // taskbar (regression: hidden window with no tray = "app disappeared").
    if (shouldHideToTray(loadSettings().minimizeToTray, trayReady)) {
      window.hide();
    }
  });
  window.on("close", (event) => {
    if (!quitting && shouldHideToTray(loadSettings().minimizeToTray, trayReady)) {
      event.preventDefault();
      window.hide();
      return;
    }
    persistWindowState(window);
    cancelScreenPicks();
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  const startUrl = process.env["VITALITY_SERVER_URL"];
  if (
    typeof startUrl === "string" &&
    startUrl.length > 0 &&
    serverUrlSchema.safeParse(startUrl).success
  ) {
    void loadInstance(startUrl);
  } else {
    void window.loadURL(connectPageUrl());
  }
}

function setupTray(): void {
  trayReady = false;
  try {
    // Packaged: extraResources ships assets/ as a real file next to the asar;
    // dev: the project dir sits one level above dist/ (see src/tray.ts).
    const picked = pickTrayIconPath(
      trayIconCandidates(process.resourcesPath, ROOT),
      existsSync,
    );
    let image =
      picked !== null ? nativeImage.createFromPath(picked) : nativeImage.createEmpty();
    if (image.isEmpty()) {
      // Last-resort embedded icon: a visible tray beats a perfect one — an
      // invisible/absent tray with a hidden window strands the user.
      image = nativeImage.createFromDataURL(
        `data:image/png;base64,${FALLBACK_TRAY_PNG_BASE64}`,
      );
    }
    if (image.isEmpty()) {
      console.error(
        "[desktop] no tray icon available — minimize-to-tray stays off for this run",
      );
      return;
    }
    image = image.resize({ width: 16, height: 16 });
    tray = new Tray(image);
    tray.setToolTip("vitality");
    const menu = Menu.buildFromTemplate([
      {
        label: "Show",
        click: () => {
          mainWindow?.show();
        },
      },
      {
        label: "Change server…",
        click: () => {
          mainWindow?.show();
          showConnectScreen();
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
    tray.on("click", () => {
      if (mainWindow === null || mainWindow.isDestroyed()) {
        return;
      }
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
      }
    });
    // Only now may window handlers hide the window into this tray.
    trayReady = !tray.isDestroyed();
  } catch (error) {
    tray = null;
    trayReady = false;
    console.error("[desktop] tray setup failed, minimize-to-tray disabled:", error);
  }
}

async function bootstrap(): Promise<void> {
  const single = app.requestSingleInstanceLock();
  if (!single) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });

  await app.whenReady();
  const startMinimized =
    process.argv.includes("--hidden") || loadSettings().startMinimized;
  createWindow(startMinimized);
  setupTray();

  const menu = Menu.buildFromTemplate([
    {
      label: "Server",
      submenu: [
        {
          label: "Change server…",
          click: () => {
            mainWindow?.show();
            showConnectScreen();
          },
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);

  registerIpc({
    window: () => mainWindow,
    instanceOrigin: () => instanceOrigin,
    loadInstance,
    showConnectScreen,
  });

  if (mainWindow !== null) {
    registerMuteShortcut(mainWindow);
    void startGlobalPtt(mainWindow, () => undefined).catch(() => undefined);
  }

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
  app.on("activate", () => {
    if (mainWindow === null || mainWindow.isDestroyed()) {
      createWindow(false);
    } else {
      mainWindow.show();
    }
  });
  app.on("before-quit", () => {
    quitting = true;
    stopGlobalPtt();
    unregisterShortcuts();
    trayReady = false;
    // Remove the notification-area icon explicitly so no ghost icon is left
    // behind in the Windows tray after quit.
    if (tray !== null && !tray.isDestroyed()) {
      tray.destroy();
    }
    tray = null;
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      persistWindowState(mainWindow);
    }
  });
}

void bootstrap();
