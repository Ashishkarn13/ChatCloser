// electron-app/src/preload.cjs
// The only bridge between the renderer and the main process.
//
// It exposes a small, explicit API. The renderer never receives Node
// integration, never sees a file system handle, and never receives a
// credential.

const { contextBridge, ipcRenderer } = require("electron");

const ALLOWED = [
  "app:info",
  "app:status",
  "app:restart-bot",
  "app:open-external",
  "app:reveal-data-folder",
];

function invoke(channel, payload) {
  if (!ALLOWED.includes(channel)) {
    return Promise.reject(new Error(`Channel "${channel}" is not allowed.`));
  }
  return ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld("chatcloser", {
  info: () => invoke("app:info"),
  status: () => invoke("app:status"),
  restartBot: () => invoke("app:restart-bot"),
  openExternal: (url) => invoke("app:open-external", String(url || "")),
  revealDataFolder: () => invoke("app:reveal-data-folder"),
});
