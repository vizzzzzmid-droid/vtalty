/**
 * Local connect screen logic. Runs with the same `window.desktop` bridge
 * as the remote app; talks to main only through validated IPC.
 */

async function getSetting(key: string): Promise<unknown> {
  return window.desktop.getSetting(key);
}

async function setSetting(key: string, value: unknown): Promise<void> {
  await window.desktop.setSetting(key, value);
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
  bindCheckbox("opt-ptt", "globalPttEnabled");
  await renderRecent();
}

void init();
