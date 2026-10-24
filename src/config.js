// src/config.js
// Single place where runtime configuration is read and validated.
//
// Everything the app needs from the environment is resolved here exactly
// once, so the rest of the codebase never touches process.env directly and
// the Electron main process can override the data directory before the
// database is opened.

import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const isElectron = Boolean(process.versions && process.versions.electron);

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/**
 * Reads a path-valued variable. `process.env.X = undefined` stores the
 * literal string "undefined", and a file called `undefined` in the working
 * directory is a very confusing way to discover that, so the two spellings
 * are treated as "not set".
 */
function envPath(name) {
  const raw = process.env[name];
  if (!raw || raw === "undefined" || raw === "null") return "";
  return raw;
}

/**
 * The directory that holds the SQLite database, WhatsApp credentials and
 * backups. In Electron this is the OS user-data folder; in a plain Node
 * process it defaults to the project root (matching the legacy behaviour
 * of ./data.sqlite).
 */
export function resolveDataDir() {
  const dataDir = envPath("CHATCLOSER_DATA_DIR");
  if (dataDir) {
    return path.resolve(dataDir);
  }
  if (isElectron) {
    // Lazily required so this module stays importable outside Electron.
    const { app } = require("electron");
    return app.getPath("userData");
  }
  return process.cwd();
}

export const config = {
  isElectron,

  env: process.env.NODE_ENV || "development",
  isProduction: process.env.NODE_ENV === "production",

  // Cookies are only marked Secure when the panel is actually served over
  // HTTPS. Marking them Secure on plain HTTP (the desktop application, or
  // a LAN deployment without TLS) makes browsers drop the session cookie
  // and every sign-in fails. Enable this when you put the panel behind
  // HTTPS; see docs/DEPLOYMENT.md.
  cookieSecure: envBool("COOKIE_SECURE", false),

  dataDir: resolveDataDir(),
  get dbPath() {
    const dbPath = envPath("CHATCLOSER_DB_PATH");
    return dbPath ? path.resolve(dbPath) : path.join(this.dataDir, "data.sqlite");
  },
  get authDir() {
    return path.join(this.dataDir, "auth_info");
  },
  get backupDir() {
    return path.join(this.dataDir, "backups");
  },
  get logDir() {
    return path.join(this.dataDir, "logs");
  },

  dashboardPort: envInt("DASHBOARD_PORT", 3001),

  // The admin panel listens on loopback by default. Set DASHBOARD_HOST=0.0.0.0
  // to reach it from other machines on the network, and put it behind HTTPS
  // (a reverse proxy, or COOKIE_SECURE with a TLS terminator).
  dashboardHost: process.env.DASHBOARD_HOST || "127.0.0.1",
  controlPort: envInt("BOT_CONTROL_PORT", 3002),
  controlHost: process.env.BOT_CONTROL_HOST || "127.0.0.1",

  // Multi-tenant: the default tenant used when a session has not been
  // bound to a business yet (single-business local installs).
  defaultBusinessId: envInt("BUSINESS_ID", 1),
  businessName: process.env.BUSINESS_NAME || "Your Company Name",
  industryTemplate: process.env.INDUSTRY_TEMPLATE || "retail",

  adminUsername: process.env.ADMIN_USERNAME || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "",

  encryptionKey: process.env.ENCRYPTION_KEY || "",
  sessionSecret: process.env.SESSION_SECRET || "",

  // Messaging
  whatsappEnabled: envBool("WHATSAPP_ENABLED", true),
  rateLimitPerChatPerMinute: envInt("RATE_LIMIT_PER_CHAT_PER_MIN", 6),
  rateLimitGlobalPerMinute: envInt("RATE_LIMIT_GLOBAL_PER_MIN", 30),
  nudgeAfterHours: envInt("NUDGE_AFTER_HOURS", 24),

  // Payments
  paymentSuccessUrl: process.env.PAYMENT_SUCCESS_URL || "",
  paymentCancelUrl: process.env.PAYMENT_CANCEL_URL || "",

  // Server mode (always-on deployments)
  serverMode: envBool("CHATCLOSER_SERVER_MODE", false),

  // Hardening switches
  strictSecrets: envBool("CHATCLOSER_STRICT_SECRETS", !isElectron),
  allowInsecureSecrets: envBool("CHATCLOSER_ALLOW_INSECURE_SECRETS", false),
};

/**
 * Validates the security-critical configuration. Returns a list of
 * human-readable problems; an empty list means the configuration is usable.
 */
export function validateConfig() {
  const problems = [];

  if (!config.encryptionKey || config.encryptionKey.length !== 64) {
    problems.push(
      "ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Generate one with:\n" +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  if (!config.sessionSecret || config.sessionSecret.length < 32) {
    problems.push(
      "SESSION_SECRET must be at least 32 characters. Generate one with:\n" +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  if (config.strictSecrets && !config.allowInsecureSecrets) {
    if (config.encryptionKey === "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef") {
      problems.push("ENCRYPTION_KEY is the documented placeholder value — replace it before use.");
    }
    if (config.sessionSecret === "change-this-session-secret") {
      problems.push("SESSION_SECRET is the documented placeholder value — replace it before use.");
    }
  }

  return problems;
}

/** Throws if the configuration is unsafe to run with. */
export function assertUsableConfig() {
  const problems = validateConfig();
  if (problems.length === 0) return;

  const message = `ChatCloser cannot start with an unsafe configuration:\n\n${problems
    .map((p) => `  • ${p}`)
    .join("\n\n")}`;

  // In Electron the user has no terminal, so persist the problem and let the
  // UI show it rather than crashing with an opaque stack trace.
  if (isElectron) {
    const reportPath = path.join(config.dataDir, "config-errors.txt");
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(reportPath, message, "utf8");
    } catch {
      /* best effort */
    }
    const err = new Error(message);
    err.reportPath = reportPath;
    throw err;
  }

  throw new Error(message);
}

/** Creates the directories the app writes into. */
export function ensureDataDirs() {
  for (const dir of [config.dataDir, config.backupDir, config.logDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Random opaque identifier used for idempotency keys and session ids. */
export function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}
