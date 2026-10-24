// electron-app/src/electron/main.js
// The ChatCloser desktop application.
//
// The desktop shell is deliberately thin: it starts the same Express admin
// panel and the same WhatsApp bot that the server deployment runs, and
// shows the admin panel in a window. That means there is exactly one
// implementation of the business logic, and the desktop app cannot drift
// away from it.
//
// Security posture (see README "Desktop security"):
//   * contextIsolation on, nodeIntegration off, sandbox on
//   * a strict Content Security Policy
//   * every IPC message validated against an explicit allow-list
//   * provider credentials never reach the renderer
//   * the privileged bot control API stays bound to 127.0.0.1

import { app, BrowserWindow, ipcMain, session, Tray, Menu, nativeImage, shell, dialog } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

// The desktop app keeps its data in the OS user-data folder.
const dataDir = app.getPath("userData");
process.env.CHATCLOSER_DATA_DIR = dataDir;
process.env.CHATCLOSER_DB_PATH = path.join(dataDir, "data.sqlite");
process.env.NODE_ENV = process.env.NODE_ENV || "production";

// Pin the working directory to the data folder. The backend reads a .env
// from the current directory, and a shortcut or a shell launched from
// somewhere else must not change which configuration the app picks up.
try {
  fs.mkdirSync(dataDir, { recursive: true });
  process.chdir(dataDir);
} catch {
  /* keep the inherited working directory */
}

// The backend lives inside the app directory once it has been staged by
// scripts/prepare-backend.mjs. In a development run it is the repository
// root one level above electron-app.
const backendRoot = fs.existsSync(path.join(here, "..", "..", "backend"))
  ? path.resolve(here, "..", "..", "backend")
  : path.resolve(here, "..", "..", "..");

let mainWindow = null;
let tray = null;
let dashboardServer = null;
let shuttingDown = false;

const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 3001);
const BOT_CONTROL_PORT = Number(process.env.CONTROL_PORT || 3002);

// ---------- diagnostics ----------
//
// A packaged application has no terminal, so every important event is also
// written to a log file next to the database. "Open data folder" in the
// tray menu leads straight to it.

const logFile = path.join(dataDir, "desktop.log");

function log(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}\n`;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(logFile, line);
  } catch {
    /* logging must never break the application */
  }
  if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.log(line.trimEnd());
  }
}

process.on("uncaughtException", (err) => {
  log("error", `uncaughtException: ${err?.stack || err}`);
});

process.on("unhandledRejection", (err) => {
  log("error", `unhandledRejection: ${err?.stack || err}`);
});

// ---------- first-run secrets ----------

/**
 * The encryption key and the session secret are generated once and stored
 * in the user-data folder with owner-only permissions. They never leave
 * this machine and are never sent to the renderer.
 */
function ensureSecrets() {
  const secretsPath = path.join(dataDir, "secrets.json");

  let secrets = {};
  if (fs.existsSync(secretsPath)) {
    try {
      secrets = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
    } catch {
      secrets = {};
    }
  }

  let changed = false;
  if (!secrets.encryptionKey || secrets.encryptionKey.length !== 64) {
    secrets.encryptionKey = require("crypto").randomBytes(32).toString("hex");
    changed = true;
  }
  if (!secrets.sessionSecret || secrets.sessionSecret.length < 32) {
    secrets.sessionSecret = require("crypto").randomBytes(32).toString("hex");
    changed = true;
  }
  if (!secrets.adminPassword) {
    secrets.adminPassword = require("crypto").randomBytes(9).toString("base64url");
    changed = true;
  }

  if (changed) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(secretsPath, 0o600);
    } catch {
      /* not supported on every platform */
    }
  }

  process.env.ENCRYPTION_KEY = secrets.encryptionKey;
  process.env.SESSION_SECRET = secrets.sessionSecret;
  process.env.ADMIN_USERNAME = secrets.adminUsername || "admin";
  process.env.ADMIN_PASSWORD = secrets.adminPassword;

  return { secrets, firstRun: changed };
}

// ---------- backend ----------

async function startBackend() {
  const { secrets, firstRun } = ensureSecrets();

  // The admin panel is the same Express app the server deployment runs.
  // It must not start its own listener: the desktop app binds it to the
  // loopback interface only.
  process.env.CHATCLOSER_NO_LISTEN = "1";
  const dashboardModule = await import(
    pathToFileURL(path.join(backendRoot, "dashboard", "server.js")).href
  );
  const dashboardApp = dashboardModule.default;

  await new Promise((resolve, reject) => {
    dashboardServer = dashboardApp.listen(DASHBOARD_PORT, "127.0.0.1", (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  // The WhatsApp bot runs in this process so that the desktop app and the
  // bot share the same database and the same credentials. The flag above
  // only exists to stop the dashboard from opening a second listener, so it
  // is cleared before the bot module is loaded: that module starts the
  // WhatsApp socket and its loopback control API on import.
  delete process.env.CHATCLOSER_NO_LISTEN;
  try {
    await import(pathToFileURL(path.join(backendRoot, "index.js")).href);
  } catch (err) {
    console.error("Could not start the WhatsApp bot:", err.message);
  }

  return { secrets, firstRun };
}

// ---------- window ----------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: "#FAF7F0",
    title: "ChatCloser",
    icon: path.join(here, "..", "assets", "icon.png"),
    webPreferences: {
      preload: path.join(here, "..", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  mainWindow.removeMenu();

  // Anything that wants to open a new window opens in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  // Nothing may navigate away from the local admin panel.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = `http://127.0.0.1:${DASHBOARD_PORT}`;
    if (!url.startsWith(allowed)) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  mainWindow.webContents.on("did-finish-load", () => {
    log("info", "admin panel loaded");
  });

  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    log("error", `admin panel failed to load (${code} ${description}) ${url}`);
    mainWindow?.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        "<body style='font-family:system-ui;padding:48px;color:#15130E;background:#FAF7F0'>" +
          "<h1>ChatCloser</h1><p>The admin panel could not be loaded.</p>" +
          `<p style='color:#6b6152'>${description} (${code})</p>` +
          "<p>Quit and start the application again. Diagnostics are in the data folder.</p></body>"
      )}`
    );
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadURL(`http://127.0.0.1:${DASHBOARD_PORT}/login`);
}

// ---------- tray ----------

function createTray() {
  const iconPath = path.join(here, "..", "assets", "icon.png");
  const image = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();

  tray = new Tray(image);
  tray.setToolTip("ChatCloser");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open ChatCloser", click: () => showMainWindow() },
      { type: "separator" },
      {
        label: "Launch on startup",
        type: "checkbox",
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath });
        },
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ])
  );

  tray.on("click", () => showMainWindow());
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

// ---------- IPC ----------
//
// Only these channels exist. Each handler validates its input, and none of
// them can reach the database or a credential directly. The preload script
// enforces the same list, so an untrusted page cannot even ask for a
// channel that is not described here.

ipcMain.handle("app:info", async () => {
  return {
    name: "ChatCloser",
    version: app.getVersion(),
    platform: process.platform,
    dataDir,
    dashboardUrl: `http://127.0.0.1:${DASHBOARD_PORT}`,
    electron: process.versions.electron,
    node: process.versions.node,
  };
});

ipcMain.handle("app:status", async () => {
  try {
    const response = await fetch(`http://127.0.0.1:${BOT_CONTROL_PORT}/health`);
    const data = await response.json();
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message, whatsapp: "offline" };
  }
});

ipcMain.handle("app:restart-bot", async () => {
  try {
    await fetch(`http://127.0.0.1:${BOT_CONTROL_PORT}/logout`, { method: "POST" });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("app:open-external", async (_event, url) => {
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) {
    return { ok: false, error: "Only https URLs may be opened." };
  }
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle("app:reveal-data-folder", async () => {
  shell.openPath(dataDir);
  return { ok: true };
});

// ---------- lifecycle ----------

// One copy of the application at a time. A second launch focuses the
// existing window instead of fighting over the database and the ports.
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
}

app.whenReady().then(async () => {
  log("info", `starting ChatCloser ${app.getVersion()} (data: ${dataDir})`);

  // The admin panel needs no device permissions, so none are granted.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });

  let boot;
  try {
    boot = await startBackend();
  } catch (err) {
    log("error", `startup failed: ${err?.stack || err}`);
    dialog.showErrorBox(
      "ChatCloser could not start",
      `The admin panel could not be started.\n\n${err.message}\n\n` +
        `Details: ${logFile}\nData folder: ${dataDir}`
    );
    app.quit();
    return;
  }

  log("info", `admin panel listening on 127.0.0.1:${DASHBOARD_PORT}`);

  // Smoke test for automated builds: start everything, confirm that the
  // admin panel answers, and exit. CHATCLOSER_DESKTOP_SMOKE=2 also loads
  // the window offscreen and writes a screenshot, which verifies the
  // renderer and the preload bridge.
  const smokeMode = process.env.CHATCLOSER_DESKTOP_SMOKE;
  if (smokeMode === "1" || smokeMode === "2") {
    const response = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/login`);
    const out = process.env.CHATCLOSER_SMOKE_OUT || path.join(dataDir, "smoke-result.json");
    const report = {
      smoke: "ok",
      dashboard: response.status,
      dataDir,
      backendRoot,
      electron: process.versions.electron,
    };

    if (smokeMode === "2") {
      createWindow();
      await new Promise((resolve) => {
        if (mainWindow.webContents.isLoading()) {
          mainWindow.webContents.once("did-finish-load", resolve);
        } else {
          resolve();
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const image = await mainWindow.webContents.capturePage();
      const shot = out.replace(/\.json$/i, "") + ".png";
      fs.writeFileSync(shot, image.toPNG());
      report.screenshot = shot;
      report.preload = await mainWindow.webContents.executeJavaScript(
        "typeof window.chatcloser === 'object' && typeof window.chatcloser.info === 'function'"
      );
      report.nodeInRenderer = await mainWindow.webContents.executeJavaScript(
        "typeof window.require === 'function' || typeof window.process === 'object'"
      );

      // Optional: sign in and capture the console itself, so that the
      // authenticated screens can be checked in a build.
      const user = process.env.CHATCLOSER_SMOKE_USER;
      const pass = process.env.CHATCLOSER_SMOKE_PASSWORD;
      if (user && pass) {
        const loaded = new Promise((resolve) =>
          mainWindow.webContents.once("did-finish-load", resolve)
        );
        await mainWindow.webContents.executeJavaScript(`
          (() => {
            const form = document.querySelector("form");
            form.querySelector('input[name="username"]').value = ${JSON.stringify(user)};
            form.querySelector('input[name="password"]').value = ${JSON.stringify(pass)};
            form.submit();
            return true;
          })()
        `);
        await loaded;
        await new Promise((resolve) => setTimeout(resolve, 1200));

        const pages = (process.env.CHATCLOSER_SMOKE_PAGES || "/overview")
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);

        report.pages = [];
        for (const pagePath of pages) {
          const pageLoaded = new Promise((resolve) =>
            mainWindow.webContents.once("did-finish-load", resolve)
          );
          mainWindow.loadURL(`http://127.0.0.1:${DASHBOARD_PORT}${pagePath}`);
          await pageLoaded;
          await new Promise((resolve) => setTimeout(resolve, 700));
          const slug = pagePath.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root";
          const shot = `${out.replace(/\.json$/i, "")}-${slug}.png`;
          fs.writeFileSync(shot, (await mainWindow.webContents.capturePage()).toPNG());
          report.pages.push({ path: pagePath, url: mainWindow.webContents.getURL(), shot });
        }

        report.consoleUrl = mainWindow.webContents.getURL();
      }
    }

    // A GUI process has no usable stdout on Windows, so the result is
    // written to a file that the build script can read.
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    app.quit();
    return;
  }

  createWindow();
  createTray();

  // On a brand-new installation the operator has no terminal to read the
  // generated password from, so it is shown once, here.
  if (boot.firstRun) {
    dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Welcome to ChatCloser",
      message: "Your administrator account is ready.",
      detail:
        `Username: ${boot.secrets.adminUsername || "admin"}\n` +
        `Password: ${boot.secrets.adminPassword}\n\n` +
        "Change the password from the Account page after signing in.\n" +
        `Your data is stored in:\n${dataDir}`,
      buttons: ["Continue"],
      noLink: true,
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // Closing the window does not stop the business: the application keeps
  // running in the tray so that the assistant still answers messages.
  // "Quit" in the tray menu is the way out.
  log("info", "window closed; still running in the tray");
});

app.on("before-quit", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "shutting down");
  if (dashboardServer) {
    try {
      dashboardServer.close();
    } catch {
      /* already closed */
    }
  }
});
