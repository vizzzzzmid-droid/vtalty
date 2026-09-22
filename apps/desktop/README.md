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
- Mention notifications (step 2): the web client calls `notify` with a
  `channelId` on @-mentions while unfocused; main shows a native
  `Notification` (skipped when disabled via "Mention notifications" or when
  focused) and clicking it restores/focuses the window and sends
  `notification-click` so the client opens the channel.
- Settings (`vitality-desktop.json` in userData, zod-validated, corrupt
  files fall back to defaults): minimize-to-tray, start minimized, mention
  notifications, window bounds/maximized, recent servers (8), global PTT
  flag + keycode.

```bash
pnpm --filter @vitality/desktop lint / typecheck / test
VITALITY_SERVER_URL=https://localhost pnpm --filter @vitality/desktop dev
pnpm --filter @vitality/desktop dist   # one command, no Docker/bash
```