/**
 * Windows application identity.
 *
 * `APP_ID` MUST stay equal to `appId` in `electron-builder.yml`. The NSIS
 * installer stamps that ID as the AppUserModelID of every shortcut it creates
 * (`WinShell::SetLnkAUMI "${APP_ID}"` in electron-builder's `installer.nsh`),
 * and Microsoft's AppUserModelID guidance is explicit: an app that uses an
 * explicit ID "must also assign the same AppUserModelID to all running windows
 * or processes, shortcuts, and file associations" — the ID "allows an
 * application to group its associated processes and windows under a single
 * taskbar button", and it must be set "during an application's initial startup
 * routine before the application presents any UI"
 * (`SetCurrentProcessExplicitAppUserModelID`).
 *
 * Without this, Electron falls back to its own generated ID,
 * `electron.app.<product_name>` — `product_name` read from the exe version
 * resource, i.e. `"electron.app.Electron"` for an unpackaged run
 * (`shell/common/application_info_win.cc` → `GetRawAppUserModelID`). That never
 * equals the installer's `appId`, so Windows treated the app's processes and
 * windows as a different application than its own shortcuts: Task Manager
 * showed flat, ungrouped process entries and notifications/taskbar fell back
 * to the Electron identity.
 *
 * Guarded by `tests/metadata.test.ts` (config ↔ code consistency).
 */
export const APP_ID = "shop.kirskiy.vitality";

/**
 * Product name shown by Windows for the app's display identity and used by
 * Electron for `app.getName()` (which names the `userData` directory). Mirrors
 * `productName` in `package.json` and `electron-builder.yml`; electron-builder
 * writes it into the exe version resource as `ProductName` + `FileDescription`,
 * which is also the value Electron's fallback AUMID would embed.
 */
export const PRODUCT_NAME = "vitality";
