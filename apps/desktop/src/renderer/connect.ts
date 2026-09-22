/**
 * Local connect screen logic. Runs with the same `window.desktop` bridge
 * as the remote app; talks to main only through validated IPC.
 */
import {
  acceleratorConflictsPtt,
  keycodeLabel,
  validateAccelerator,
  validatePttDomCode,
} from "../keymap.js";

async function getSetting(key: string): Promise<unknown> {
  return window.desktop.getSetting(key);
}

async function setSetting(key: string, value: unknown): Promise<boolean> {
  return window.desktop.setSetting(key, value);
}

function showError(message: string): void {
  const el = document.getElementById("error");
  if (el !== null) {
    el.textContent = message;
  }
}

function bindCheckbox(id: string, key: string): void {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLInputElement)) {
    return;
  }
  void getSetting(key).then((value) => {
    el.checked = value === true;
  });
  el.addEventListener("change", () => {
    void setSetting(key, el.checked);
  });
}

function keysError(message: string): void {
  const el = document.getElementById("keys-error");
  if (el !== null) {
    el.textContent = message;
  }
}

async function currentPttKeycode(): Promise<number> {
  const value = await getSetting("globalPttKeycode");
  return typeof value === "number" && Number.isInteger(value) ? value : 41;
}

async function refreshPttLabel(): Promise<void> {
  const label = document.getElementById("ptt-key-label");
  if (label !== null) {
    label.textContent = keycodeLabel(await currentPttKeycode());
  }
}

function armPttCapture(): void {
  const hint = document.getElementById("ptt-hint");
  const button = document.getElementById("ptt-rebind");
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  keysError("");
  if (hint !== null) {
    hint.textContent = "Listening… press a key (Esc cancels).";
  }
  button.disabled = true;
  const onKey = (event: KeyboardEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    window.removeEventListener("keydown", onKey, true);
    button.disabled = false;
    if (hint !== null) {
      hint.textContent = "";
    }
    if (event.code === "Escape") {
      return;
    }
    const result = validatePttDomCode(event.code);
    if ("error" in result) {
      keysError(result.error);
      return;
    }
    void setSetting("globalPttKeycode", result.keycode).then(() => {
      keysError("");
      return refreshPttLabel();
    });
  };
  window.addEventListener("keydown", onKey, true);
}

async function initKeySettings(): Promise<void> {
  await refreshPttLabel();
  const rebind = document.getElementById("ptt-rebind");
  if (rebind instanceof HTMLButtonElement) {
    rebind.addEventListener("click", armPttCapture);
  }
  const accInput = document.getElementById("opt-mute-acc");
  if (accInput instanceof HTMLInputElement) {
    const current = await getSetting("globalMuteAccelerator");
    accInput.value = typeof current === "string" ? current : "";
    const save = document.getElementById("mute-save");
    if (save instanceof HTMLButtonElement) {
      save.addEventListener("click", () => {
        const error = validateAccelerator(accInput.value);
        if (error !== null) {
          keysError(error);
          return;
        }
        void currentPttKeycode().then((keycode) => {
          if (acceleratorConflictsPtt(accInput.value.trim(), keycode)) {
            keysError("That shortcut uses the same key as push-to-talk.");
            return;
          }
          void setSetting("globalMuteAccelerator", accInput.value.trim()).then(
            (saved) => {
              keysError(saved ? "" : "Could not save (restart and retry).");
            },
          );
        });
      });
    }
  }
}

async function renderRecent(): Promise<void> {
  const list = document.getElementById("recent");
  if (!(list instanceof HTMLUListElement)) {
    return;
  }
  list.textContent = "";
  const servers = await window.desktop.getRecentServers();
  for (const server of servers) {
    const item = document.createElement("li");
    const code = document.createElement("code");
    code.textContent = server.url;
    const go = document.createElement("button");
    go.type = "button";
    go.textContent = "Connect";
    go.addEventListener("click", () => {
      void connect(server.url);
    });
    const forget = document.createElement("button");
    forget.type = "button";
    forget.textContent = "Forget";
    forget.className = "ghost";
    forget.addEventListener("click", () => {
      void window.desktop.forgetServer(server.url).then(() => renderRecent());
    });
    item.append(code, go, forget);
    list.append(item);
  }
}

async function connect(rawUrl: string): Promise<void> {
  showError("");
  const button = document.getElementById("connect-btn");
  if (button instanceof HTMLButtonElement) {
    button.disabled = true;
  }
  try {
    const result = await window.desktop.connectToServer(rawUrl.trim());
    if (!result.ok) {
      showError(result.error ?? "Connection failed");
    }
    // On success main swaps the window to the instance; nothing to do here.
  } finally {
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
    }
  }
}

async function init(): Promise<void> {
  const version = await window.desktop.getVersion().catch(() => "unknown");
  const footer = document.getElementById("version");
  if (footer !== null) {
    footer.textContent = `vitality desktop ${version}`;
  }
  const caps = await window.desktop.getCapabilities().catch(() => null);
  const capsEl = document.getElementById("caps");
  if (capsEl !== null) {
    capsEl.textContent =
      caps === null
        ? "capabilities unavailable"
        : [
            `screen picker: ${caps.screenPicker ? "yes" : "no"}`,
            `system audio: ${caps.systemAudio}`,
            caps.globalPttReason !== null
              ? `global PTT: unavailable (${caps.globalPttReason})`
              : "global PTT: available",
          ].join(" · ");
  }
  const form = document.getElementById("connect-form");
  const input = document.getElementById("url");
  if (form instanceof HTMLFormElement && input instanceof HTMLInputElement) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void connect(input.value);
    });
  }
  bindCheckbox("opt-tray", "minimizeToTray");
  bindCheckbox("opt-start-min", "startMinimized");
  bindCheckbox("opt-notify", "notificationsEnabled");
  bindCheckbox("opt-ptt", "globalPttEnabled");
  await initKeySettings();
  await renderRecent();
}

void init();
