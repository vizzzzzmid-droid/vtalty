# Desktop — Electron wrapper (Phase 6b, steps 1–2)

Security shell + connect screen + unit tests. The window loads the instance
URL **remotely** (same-origin web client) after a `/api/v1/health` check.

- `window.desktop` preload bridge (contextBridge, no Node in renderers);
  the web client feature-detects it and works unchanged in a browser.
- Navigation locked to the instance origin (`will-navigate` +
  `setWindowOpenHandler`); external links go through `shell.openExternal`
  (http/https only). Permissions: deny-by-default `setPermissionCheckHandler`
  + request handler granting only media/display-capture/notifications for
  the instance origin.
- Every IPC handler validates the sender frame origin (connect screen
  `file://…/connect.html` is trusted only before connecting and only for
  the connect flow) and the payload with zod.
- `VITALITY_SERVER_URL` dev entry is validated like typed input (https
  unless loopback); `loadInstance` refuses non-http(s) URLs.
- Screen capture uses `setDisplayMediaRequestHandler` + a custom picker
  with thumbnails; the request's `securityOrigin` must match the instance
  origin and `audio: "loopback"` (system audio) is only offered on Windows
  — other platforms get video-only capture (stated in the connect-screen
  capabilities line).
- Global push-to-talk uses `uiohook-napi` (key-down + key-up; globalShortcut
  alone is press-only) behind a settings flag with graceful degradation on
  Wayland / macOS-permission / missing-prebuild systems; `Ctrl+Shift+M`
  toggle-mute uses globalShortcut.
- No auto-accepted certificate errors anywhere (no
  `setCertificateVerifyProc` / `certificate-error` handler by design).
- Windows identity (AUMID): `app.setAppUserModelId(APP_ID)` runs at startup
  before the first window, where `APP_ID` = `shop.kirskiy.vitality` — the same
  value electron-builder's NSIS installer stamps on the shortcuts it creates
  (`WinShell::SetLnkAUMI ${APP_ID}`). Without an explicit ID Electron falls
  back to `electron.app.<product_name>` (`product_name` comes from the exe
  version resource; `electron.app.Electron` in an unpackaged run,
  `shell/common/application_info_win.cc`), which never equals the installer's
  `appId` — Windows then treats the processes/windows as a different
  application than the app's own shortcuts, so Task Manager shows flat,
  ungrouped entries and notifications/taskbar fall back to the Electron
  identity. `productName: vitality` in `package.json` keeps `app.getName()`
  (and the `userData` directory) off the scoped package name
  `@vitality/desktop`, and `executableName: vitality` in `electron-builder.yml`
  keeps the exe basename (InternalName) equal to ProductName/FileDescription.
  `tests/metadata.test.ts` guards config ↔ code consistency,
  `tests/electron/connect.spec.mts` asserts `app.getName()`/`userData` at
  runtime.
- Mention notifications (step 2): the web client calls `notify` with a
  `channelId` on @-mentions while unfocused; main shows a native
  `Notification` (skipped when disabled via "Mention notifications" or when
  focused) and clicking it restores/focuses the window and sends
  `notification-click` so the client opens the channel.
- Settings (`vitality-desktop.json` in userData, zod-validated, corrupt
  files fall back to defaults): minimize-to-tray, start minimized, mention
  notifications, window bounds/maximized, recent servers (8), global PTT
  flag + keycode.
- Global PTT key is rebindable on the connect screen ("Rebind…" capture
  mode; typing keys and bare modifiers rejected). The toggle-mute
  accelerator is editable too (modifier required, OS-reserved combos
  rejected, conflict-checked against the PTT key). Key changes apply after
  restart.
- Platform limits: global PTT needs `uiohook-napi` — no hook on
  Wayland-without-permission, macOS-without-Input-Monitoring approval, or
  missing prebuilds (in-app tab-focused PTT remains the fallback);
  system-audio loopback is Windows-only; tray icons/badges vary by OS.
- Download: CI `desktop` workflow builds the NSIS installer (Windows) and
  AppImage (Linux) on every `main` push; tagged `v*` releases attach them
  via the `release` job. Builds are unsigned (SmartScreen/Gatekeeper
  prompts expected) — see ROADMAP for the signing decision.

```bash
pnpm --filter @vitality/desktop lint / typecheck / test
pnpm --filter @vitality/desktop test:electron   # boots the real app (needs a display; xvfb in CI)
VITALITY_SERVER_URL=https://localhost pnpm --filter @vitality/desktop dev
pnpm --filter @vitality/desktop dist   # one command, no Docker/bash
```