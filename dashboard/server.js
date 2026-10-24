// dashboard/server.js
// The admin panel.
//
// ChatCloser 2.0 keeps the server-rendered admin panel that ChatCloser 1.x
// shipped — it works, it needs no build step, and it is what the desktop
// application embeds — and extends it with the modules a full business
// operating system needs.
//
// Everything that changed for 2.0, and why:
//
//   * every value that came from a customer, a staff member or an external
//     system is HTML-escaped before it is rendered (1.x interpolated raw
//     customer text into the page, which was a stored-XSS hole)
//   * authorisation is per-permission (owner / staff) rather than a single
//     owner flag, and it is checked on the server for every route
//   * every state-changing form carries a CSRF token
//   * the JSON API (src/server/routes/api.js) is mounted at /api

import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createApp, escapeHtml } from "../src/server/app.js";
import { createApiRouter } from "../src/server/routes/api.js";
import { config } from "../src/config.js";
import { getDb } from "../src/db/connection.js";

import {
  getLeads,
  updateLeadStatus,
  getLeadStats,
  getPriceList,
  getWebhooks,
  createWebhook,
  deleteWebhook,
  getWebhookDeliveries,
  logAudit,
  getAuditLog,
  getConversionRate,
} from "../db.js";

import {
  listUsers,
  getUser,
  createUser,
  setUserPassword,
  deleteUser,
  countOwners,
} from "../src/services/auth.js";

import { encrypt, decrypt, maskKey, verifyPassword } from "../crypto-utils.js";
import { getProvider, SUPPORTED_PROVIDERS } from "../providers/index.js";
import { PERMISSIONS, can, resolvePermissions } from "../src/core/rbac.js";
import * as businesses from "../src/services/businesses.js";
import * as bootstrap from "../src/services/bootstrap.js";
import * as customers from "../src/services/customers.js";
import * as catalog from "../src/services/catalog.js";
import * as inventory from "../src/services/inventory.js";
import * as orders from "../src/services/orders.js";
import * as bookings from "../src/services/bookings.js";
import * as quotations from "../src/services/quotations.js";
import * as conversations from "../src/services/conversations.js";
import * as tasks from "../src/services/tasks.js";
import * as workflows from "../src/services/workflows.js";
import * as reports from "../src/services/reports.js";
import * as knowledge from "../src/services/knowledge.js";
import * as payments from "../src/services/payments/index.js";
import * as industry from "../src/services/industry.js";
import * as backups from "../src/services/backups.js";
import { listToolsForBusiness, listApprovals, setToolPermission, TOOL_DEFINITIONS } from "../src/services/ai/tools/index.js";
import { testModel } from "../src/services/ai/model-adapter.js";

const PORT = config.dashboardPort;
const BUSINESS_ID = config.defaultBusinessId;
const BOT_CONTROL_PORT = config.controlPort;
const BOT_CONTROL_URL = `http://127.0.0.1:${BOT_CONTROL_PORT}`;

const app = createApp({ businessId: BUSINESS_ID });

// A business row always exists from the moment the dashboard starts: a
// fresh database is provisioned with one business and one owner account.
const bootstrapResult = bootstrap.ensureReady(BUSINESS_ID, {
  name: config.businessName,
  industryTemplate: config.industryTemplate,
  ownerUsername: config.adminUsername,
  ownerPassword: config.adminPassword,
});

if (bootstrapResult.owner) {
  console.log("");
  console.log("  First run: an owner account has been created.");
  console.log(`    username: ${bootstrapResult.owner.username}`);
  console.log(`    password: ${bootstrapResult.owner.password}`);
  if (bootstrapResult.owner.generated) {
    console.log("  Change this password from Account after signing in.");
  }
  console.log("");

  // The password is shown once. Writing it to a file in the data folder
  // means an operator who missed the console output can still find it,
  // and deleting the file removes the copy.
  try {
    fs.writeFileSync(
      path.join(config.dataDir, "first-run-credentials.txt"),
      `ChatCloser — first run\n\nUsername: ${bootstrapResult.owner.username}\nPassword: ${bootstrapResult.owner.password}\n\nSign in, then change this password and delete this file.\n`,
      { mode: 0o600 }
    );
  } catch {
    /* best effort */
  }
}

const db = getDb();

// ---------- helpers ----------

const e = escapeHtml;

function money(value, currency = "NPR") {
  const n = Number(value || 0);
  return e(`${currency === "NPR" ? "Rs. " : `${currency} `}${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
}

function statusPill(value) {
  const map = {
    paid: "connected",
    succeeded: "connected",
    delivered: "connected",
    confirmed: "connected",
    active: "connected",
    completed: "connected",
    pending: "waiting",
    awaiting_confirmation: "waiting",
    draft: "waiting",
    scheduled: "waiting",
    processing: "waiting",
    open: "waiting",
    new: "waiting",
    requires_review: "waiting",
    failed: "disconnected",
    cancelled: "disconnected",
    rejected: "disconnected",
    error: "disconnected",
    closed: "closed",
    paid_manual: "closed",
  };
  const cls = map[String(value || "").toLowerCase()] || "closed";
  return `<span class="pill ${cls}">${e(String(value || "").replace(/_/g, " "))}</span>`;
}

function emptyRow(columns, message) {
  return `<tr><td colspan="${columns}" class="muted">${e(message)}</td></tr>`;
}

function csvEscape(value) {
  const str = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(rows, columns) {
  const header = columns.map((c) => csvEscape(c.label)).join(",");
  const lines = rows.map((row) => columns.map((c) => csvEscape(row[c.key])).join(","));
  return [header, ...lines].join("\r\n");
}

// ---------- shared shell ----------

const BASE_STYLES = `
  :root {
    --ivory: #FAF7F0;
    --ivory-deep: #F1ECE1;
    --black: #15130E;
    --black-soft: #2A2721;
    --gold: #A8853B;
    --gold-soft: #C9A863;
    --border: #E2DAC8;
    --danger: #8B2E2E;
    --danger-soft: #A83E3E;
    --success: #2E5E3E;
    --muted: #8A8474;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
    margin: 0; background: var(--ivory); color: var(--black);
    -webkit-font-smoothing: antialiased; font-size: 15px;
  }
  .app { display: flex; min-height: 100vh; }
  .sidebar {
    width: 252px; flex-shrink: 0; background: var(--black); color: var(--ivory);
    display: flex; flex-direction: column; position: sticky; top: 0; height: 100vh;
    overflow-y: auto;
  }
  .brand { padding: 24px 22px 18px; border-bottom: 1px solid #2E2A22; }
  .brand-name { font-size: 1.05rem; font-weight: 600; letter-spacing: 0.02em; }
  .brand-sub { font-size: 0.7rem; color: var(--gold-soft); text-transform: uppercase; letter-spacing: 0.08em; margin-top: 4px; }
  nav.nav-list { padding: 12px 10px; flex: 1; }
  .nav-group { font-size: 0.64rem; text-transform: uppercase; letter-spacing: 0.1em; color: #6E6858; padding: 14px 12px 6px; }
  .nav-item {
    display: flex; align-items: center; gap: 11px; padding: 9px 12px; margin-bottom: 1px;
    color: #B9B3A0; text-decoration: none; font-size: 0.86rem; border-radius: 6px; transition: background 0.12s;
  }
  .nav-icon { font-size: 0.85rem; width: 15px; text-align: center; color: var(--gold-soft); }
  .nav-item:hover { background: #201D17; color: var(--ivory); }
  .nav-item.active { background: rgba(168, 133, 59, 0.18); color: var(--ivory); font-weight: 600; }
  .sidebar-footer { padding: 14px 22px 20px; border-top: 1px solid #2E2A22; font-size: 0.76rem; color: #8A8474; }
  .sidebar-footer a { color: var(--gold-soft); text-decoration: none; }
  .main { flex: 1; min-width: 0; }
  .topbar {
    background: #fff; border-bottom: 1px solid var(--border); padding: 16px 34px;
    display: flex; justify-content: space-between; align-items: center; gap: 16px;
  }
  .topbar h1 { margin: 0; font-size: 1.12rem; font-weight: 600; }
  .topbar .meta { font-size: 0.8rem; color: var(--muted); }
  .content { padding: 28px 34px 60px; max-width: 1180px; }
  .card {
    background: #fff; border: 1px solid var(--border); border-radius: 8px;
    padding: 22px 24px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(21,19,14,0.04);
  }
  .card h2 { margin: 0 0 5px; font-size: 1.08rem; font-weight: 600; }
  .card .card-sub { color: var(--muted); font-size: 0.84rem; margin: 0 0 18px; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px; margin-bottom: 20px; }
  .stat-card { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 18px 20px; box-shadow: 0 1px 3px rgba(21,19,14,0.04); }
  .stat-card .stat-value { font-size: 1.8rem; font-weight: 700; line-height: 1.1; }
  .stat-card .stat-label { font-size: 0.74rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-top: 7px; }
  .stat-card.accent .stat-value { color: var(--gold); }
  .stat-card.warn .stat-value { color: var(--danger); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--border); font-size: 0.85rem; vertical-align: top; }
  th { font-weight: 600; text-transform: uppercase; font-size: 0.68rem; letter-spacing: 0.05em; color: var(--muted); }
  tr:last-child td { border-bottom: none; }
  a.link { color: var(--gold); text-decoration: none; font-weight: 600; }
  a.link:hover { text-decoration: underline; }
  .status-form select { padding: 5px 7px; border-radius: 4px; border: 1px solid var(--border); font-family: inherit; font-size: 0.8rem; }
  .bubble { max-width: 72%; padding: 9px 13px; border-radius: 10px; margin-bottom: 9px; font-size: 0.88rem; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
  .bubble.user { background: var(--ivory-deep); margin-right: auto; border: 1px solid var(--border); border-bottom-left-radius: 2px; }
  .bubble.assistant { background: var(--black); color: var(--ivory); margin-left: auto; border-bottom-right-radius: 2px; }
  .msg-time { font-size: 0.68rem; opacity: 0.55; margin-top: 4px; }
  label { display: block; font-weight: 600; margin-top: 16px; font-size: 0.82rem; color: var(--black-soft); }
  input[type=text], input[type=password], input[type=number], input[type=date], input[type=email], textarea, select {
    width: 100%; padding: 9px 11px; margin-top: 5px; border: 1px solid var(--border);
    border-radius: 6px; box-sizing: border-box; font-family: inherit; font-size: 0.88rem; background: var(--ivory);
  }
  input:focus, textarea:focus, select:focus { outline: none; border-color: var(--gold); box-shadow: 0 0 0 3px rgba(168,133,59,0.12); }
  textarea { min-height: 60px; resize: vertical; }
  button, .btn {
    margin-top: 18px; padding: 10px 20px; background: var(--black); color: var(--ivory);
    border: 1px solid var(--black); border-radius: 6px; cursor: pointer; font-size: 0.84rem;
    letter-spacing: 0.02em; font-family: inherit; font-weight: 600;
  }
  button:hover, .btn:hover { background: var(--black-soft); }
  button.secondary { background: transparent; color: var(--black); border: 1px solid var(--border); }
  button.secondary:hover { background: var(--ivory-deep); }
  button.danger { background: var(--danger); border-color: var(--danger); }
  button.danger:hover { background: var(--danger-soft); }
  button.small { padding: 5px 11px; margin-top: 4px; font-size: 0.76rem; }
  .chat-list a { display: block; padding: 12px 14px; border-bottom: 1px solid var(--border); text-decoration: none; color: var(--black); font-size: 0.87rem; }
  .chat-list a:hover { background: var(--ivory-deep); }
  .save-note { color: var(--success); font-size: 0.84rem; margin-top: 12px; font-weight: 600; }
  .error-note { color: var(--danger); font-size: 0.84rem; margin-top: 12px; font-weight: 600; }
  .pill { display: inline-block; padding: 3px 11px; border-radius: 999px; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; white-space: nowrap; }
  .pill.connected { background: #E4EFE6; color: var(--success); }
  .pill.disconnected { background: #F4E4E4; color: var(--danger); }
  .pill.waiting { background: #FBF0D9; color: var(--gold); }
  .pill.new { background: #FBF0D9; color: var(--gold); }
  .pill.contacted { background: #E1EAF7; color: #2E4E8B; }
  .pill.booked { background: #E4EFE6; color: var(--success); }
  .pill.closed { background: #ECEAE4; color: #6E6A5C; }
  .muted { color: var(--muted); font-size: 0.83rem; }
  .key-display { font-family: "SF Mono", "Courier New", monospace; background: var(--ivory-deep); padding: 10px 12px; border-radius: 6px; margin-top: 5px; font-size: 0.82rem; border: 1px solid var(--border); word-break: break-all; }
  .field-row { display: flex; gap: 10px; align-items: flex-start; }
  .field-row .field-inputs { flex: 1; }
  .divider { border: none; border-top: 1px solid var(--border); margin: 22px 0; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
  .bar { height: 8px; background: var(--ivory-deep); border-radius: 4px; overflow: hidden; }
  .bar > span { display: block; height: 100%; background: var(--gold); }
  .tool-list li { margin-bottom: 8px; }
  code { background: var(--ivory-deep); padding: 1px 5px; border-radius: 4px; font-size: 0.82rem; }
  @media (max-width: 900px) { .grid-2, .grid-3 { grid-template-columns: 1fr; } .sidebar { width: 200px; } }
`;

const NAV_GROUPS = [
  {
    title: "Workspace",
    items: [
      { id: "overview", label: "Overview", href: "/overview", icon: "◈", perm: PERMISSIONS.DASHBOARD_VIEW },
      { id: "command-center", label: "AI Command Center", href: "/command-center", icon: "✦", perm: PERMISSIONS.AI_VIEW },
      { id: "inbox", label: "Customer Inbox", href: "/inbox", icon: "☰", perm: PERMISSIONS.CONVERSATIONS_VIEW },
      { id: "crm", label: "Leads & CRM", href: "/leads", icon: "◆", perm: PERMISSIONS.LEADS_VIEW },
      { id: "orders", label: "Orders & Bookings", href: "/orders", icon: "▤", perm: PERMISSIONS.ORDERS_VIEW },
      { id: "catalog", label: "Products & Services", href: "/catalog", icon: "◫", perm: PERMISSIONS.CATALOG_VIEW },
      { id: "inventory", label: "Inventory", href: "/inventory", icon: "▥", perm: PERMISSIONS.INVENTORY_VIEW },
      { id: "documents", label: "Quotations & Invoices", href: "/documents", icon: "▧", perm: PERMISSIONS.QUOTES_VIEW },
      { id: "payments", label: "Payments", href: "/payments", icon: "◐", perm: PERMISSIONS.PAYMENTS_VIEW },
      { id: "customers", label: "Customers", href: "/customers", icon: "◎", perm: PERMISSIONS.CUSTOMERS_VIEW },
    ],
  },
  {
    title: "Automation",
    items: [
      { id: "workflows", label: "Automation Studio", href: "/workflows", icon: "⚙", perm: PERMISSIONS.WORKFLOWS_VIEW },
      { id: "reports", label: "Business Intelligence", href: "/reports", icon: "◫", perm: PERMISSIONS.REPORTS_VIEW },
    ],
  },
  {
    title: "Configuration",
    items: [
      { id: "ai-settings", label: "AI Configuration", href: "/settings/ai", icon: "✧", perm: PERMISSIONS.AI_VIEW },
      { id: "knowledge", label: "Knowledge Base", href: "/knowledge", icon: "❑", perm: PERMISSIONS.KNOWLEDGE_VIEW },
      { id: "integrations", label: "Integrations", href: "/integrations", icon: "⇄", perm: PERMISSIONS.INTEGRATIONS_VIEW },
      { id: "team", label: "Team & Permissions", href: "/team", icon: "◫", perm: PERMISSIONS.TEAM_VIEW },
      { id: "audit-log", label: "Security & Audit Logs", href: "/audit-log", icon: "≡", perm: PERMISSIONS.AUDIT_VIEW },
      { id: "settings", label: "Settings & Backups", href: "/settings", icon: "●", perm: PERMISSIONS.SETTINGS_VIEW },
    ],
  },
];

// Every form in the panel must carry the double-submit token. The token is
// readable from the csrf_token cookie (it is deliberately not HttpOnly) and
// is copied into a hidden input on page load. The script is allowed by the
// Content Security Policy through the per-response nonce.
const CSRF_SCRIPT = `
    (function () {
      var token = document.cookie.split("; ").find(function (c) { return c.indexOf("csrf_token=") === 0; });
      token = token ? decodeURIComponent(token.split("=").slice(1).join("=")) : "";
      document.querySelectorAll("form").forEach(function (form) {
        if (form.querySelector('input[name="_csrf"]')) return;
        var input = document.createElement("input");
        input.type = "hidden";
        input.name = "_csrf";
        input.value = token;
        form.appendChild(input);
      });
    })();
  `;

function csrfScriptTag(req) {
  return `<script nonce="${e(req.cspNonce || "")}">${CSRF_SCRIPT}</script>`;
}

function layout(req, title, activeTab, body, opts = {}) {
  const business = businesses.getBusinessConfig(BUSINESS_ID);
  const businessName = business.name || "Your Company";
  const user = req.user || {};
  const nonce = req.cspNonce || "";
  const role = user.role || "staff";
  const isOwner = role === "owner";

  const nav = NAV_GROUPS.map((group) => {
    const visible = group.items.filter((item) => isOwner || can(user, item.perm));
    if (visible.length === 0) return "";
    return `<div class="nav-group">${e(group.title)}</div>` + visible
      .map(
        (item) => `<a href="${e(item.href)}" class="nav-item ${item.id === activeTab ? "active" : ""}">
        <span class="nav-icon">${item.icon}</span>${e(item.label)}</a>`
      )
      .join("");
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <title>${e(title)} — ${e(businessName)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${BASE_STYLES}</style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-name">${e(businessName)}</div>
        <div class="brand-sub">ChatCloser 2.0</div>
      </div>
      <nav class="nav-list">${nav}</nav>
      <div class="sidebar-footer">
        Signed in as <strong style="color:var(--ivory)">${e(user.username || "")}</strong>
        <span style="color:var(--gold-soft); text-transform:capitalize;">(${e(role)})</span><br>
        <a href="/logout">Sign out</a>
      </div>
    </aside>
    <div class="main">
      <div class="topbar">
        <h1>${e(title)}</h1>
        <span class="meta">${e(new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" }))}</span>
      </div>
      <div class="content">${body}</div>
    </div>
  </div>
  ${csrfScriptTag(req)}
</body>
</html>`;
}

function authLayout(req, title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <title>${e(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    ${BASE_STYLES}
    body { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .auth-card {
      background: #fff; border: 1px solid #E2DAC8; border-radius: 10px; padding: 38px 36px;
      width: 100%; max-width: 380px; box-shadow: 0 4px 24px rgba(21,19,14,0.08); border-top: 4px solid var(--gold);
    }
    .auth-card h1 { margin: 0 0 6px; font-size: 1.25rem; font-weight: 700; }
    .auth-card p.sub { margin: 0 0 24px; color: var(--muted); font-size: 0.87rem; }
    .auth-card button { width: 100%; margin-top: 22px; }
  </style>
</head>
<body>
  <div class="auth-card">${body}</div>
  ${csrfScriptTag(req)}
</body>
</html>`;
}

// ---------- auth ----------

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.redirect("/login");
    if (can(req.user, permission)) return next();
    return res.status(403).send(
      authLayout(
        req,
        "Access restricted",
        `<h1>Access restricted</h1><p class="sub">Your role (${e(req.user.role)}) does not include the "${e(permission)}" permission. Ask the workspace owner for access, or <a class="link" href="/overview">go back to the dashboard</a>.</p>`
      )
    );
  };
}

// The session cookie carries the business id; every query below uses it.
app.use((req, res, next) => {
  if (req.session && !req.session.businessId) req.session.businessId = BUSINESS_ID;
  next();
});

app.get("/login", (req, res) => {
  const body = `
    <h1>Sign in</h1>
    <p class="sub">ChatCloser business console.</p>
    <form method="POST" action="/login">
      <label>Username</label>
      <input type="text" name="username" required autofocus autocomplete="username" />
      <label>Password</label>
      <input type="password" name="password" required autocomplete="current-password" />
      <button type="submit">Sign In</button>
    </form>
    ${req.query.error ? '<p class="error-note">Incorrect username or password.</p>' : ""}
    ${req.query.locked ? '<p class="error-note">Too many failed attempts. Wait 15 minutes and try again.</p>' : ""}
    ${req.query.changed ? '<p class="save-note">Password updated. Please sign in again.</p>' : ""}
  `;
  res.send(authLayout(req, "Sign In", body));
});

app.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  const ip = req.ip || "";

  if (!username || !password) return res.redirect("/login?error=1");

  const locked = isLockedOut(username, ip);
  if (locked) return res.redirect("/login?locked=1");

  const user = getUser(BUSINESS_ID, username);
  const ok = user && user.status === "active" && verifyPassword(String(password), user.password_hash);

  recordLoginAttempt(username, ip, Boolean(ok));

  if (!ok) {
    logAudit(BUSINESS_ID, username || "unknown", "auth.login_failed", "");
    return res.redirect("/login?error=1");
  }

  db.prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?").run(user.id);

  // A fresh session id after sign-in, so a session id planted before the
  // sign-in cannot be reused afterwards.
  req.app.locals.regenerateSession(
    req,
    res,
    {
      username: user.username,
      role: user.role,
      businessId: BUSINESS_ID,
      permissions: JSON.parse(user.permissions || "{}"),
    },
    () => {
      logAudit(BUSINESS_ID, user.username, "auth.login_success", "");
      res.redirect("/overview");
    }
  );
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// ---------- login throttling ----------

function recordLoginAttempt(username, ip, success) {
  db.prepare(
    "INSERT INTO login_attempts (username, ip_address, success, created_at) VALUES (?, ?, ?, ?)"
  ).run(username, ip || "", success ? 1 : 0, Date.now());
  db.prepare("DELETE FROM login_attempts WHERE created_at < ?").run(Date.now() - 60 * 60 * 1000);
}

function isLockedOut(username, ip) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM login_attempts
       WHERE success = 0 AND created_at > ? AND (username = ? OR ip_address = ?)`
    )
    .get(Date.now() - 15 * 60 * 1000, username, ip || "");
  return row.c >= 8;
}

// ---------- API ----------

app.use("/api", createApiRouter());

// ---------- overview ----------

app.get("/overview", requirePermission(PERMISSIONS.DASHBOARD_VIEW), (req, res) => {
  const data = reports.overview(BUSINESS_ID);
  const business = businesses.getBusinessConfig(BUSINESS_ID);
  const counts = conversations.inboxCounts(BUSINESS_ID);
  const openTasks = tasks.countOpenTasks(BUSINESS_ID);
  const trend = reports.revenueTrend(BUSINESS_ID, 14);
  const maxRevenue = Math.max(1, ...trend.map((t) => t.revenue));

  const trendRows = trend
    .map(
      (t) => `<tr>
        <td>${e(t.day)}</td>
        <td>${money(t.revenue, business.currency)}</td>
        <td>${t.orders}</td>
        <td style="width:180px;"><div class="bar"><span style="width:${Math.round((t.revenue / maxRevenue) * 100)}%"></span></div></td>
      </tr>`
    )
    .join("");

  const body = `
    <div class="stat-grid">
      <div class="stat-card accent"><div class="stat-value">${money(data.revenue, business.currency)}</div><div class="stat-label">Revenue (paid)</div></div>
      <div class="stat-card"><div class="stat-value">${data.paidOrders}</div><div class="stat-label">Paid orders</div></div>
      <div class="stat-card ${data.pendingOrders > 0 ? "warn" : ""}"><div class="stat-value">${data.pendingOrders}</div><div class="stat-label">Pending orders</div></div>
      <div class="stat-card"><div class="stat-value">${data.newLeads}</div><div class="stat-label">New leads</div></div>
      <div class="stat-card"><div class="stat-value">${data.leadConversionRate}%</div><div class="stat-label">Lead conversion</div></div>
      <div class="stat-card ${counts.unread > 0 ? "warn" : ""}"><div class="stat-value">${counts.unread}</div><div class="stat-label">Awaiting reply</div></div>
      <div class="stat-card ${data.lowStockCount > 0 ? "warn" : ""}"><div class="stat-value">${data.lowStockCount}</div><div class="stat-label">Low-stock alerts</div></div>
      <div class="stat-card ${data.unverifiedPayments > 0 ? "warn" : ""}"><div class="stat-value">${data.unverifiedPayments}</div><div class="stat-label">Unverified payments</div></div>
      <div class="stat-card ${data.failedWorkflows > 0 ? "warn" : ""}"><div class="stat-value">${data.failedWorkflows}</div><div class="stat-label">Failed workflows</div></div>
      <div class="stat-card ${data.pendingApprovals > 0 ? "warn" : ""}"><div class="stat-value">${data.pendingApprovals}</div><div class="stat-label">Awaiting approval</div></div>
      <div class="stat-card"><div class="stat-value">${openTasks}</div><div class="stat-label">Open tasks</div></div>
      <div class="stat-card"><div class="stat-value">${data.ai.runs30d}</div><div class="stat-label">AI runs (30 days)</div></div>
    </div>

    ${
      data.hasData
        ? ""
        : `<div class="card"><h2>No activity yet</h2><p class="card-sub">These numbers come straight from your database — nothing is pre-filled. Set up your company profile, AI configuration and catalogue, and the dashboard will fill in as you work.</p></div>`
    }

    <div class="card">
      <h2>Sales — last 14 days</h2>
      <p class="card-sub">Paid orders per day, from real order records.</p>
      <table>
        <thead><tr><th>Day</th><th>Revenue</th><th>Orders</th><th></th></tr></thead>
        <tbody>${trendRows || emptyRow(4, "No orders in this period.")}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Getting started</h2>
      <p class="card-sub">Set these up in order to go live.</p>
      <table>
        <tr><td>1. Company profile &amp; industry template</td><td>${business.industry_template ? "✓ " + e(business.industry_template) : "Not started"}</td><td><a class="link" href="/settings">Configure &rarr;</a></td></tr>
        <tr><td>2. AI configuration</td><td>${business.ai_provider ? "✓ " + e(business.ai_provider) : "Not started"}</td><td><a class="link" href="/settings/ai">Configure &rarr;</a></td></tr>
        <tr><td>3. Catalogue</td><td>${catalog.listProducts(BUSINESS_ID, { limit: 1 }).length > 0 ? "✓ Items added" : "Not started"}</td><td><a class="link" href="/catalog">Add items &rarr;</a></td></tr>
        <tr><td>4. Knowledge base</td><td>${knowledge.listDocuments(BUSINESS_ID, { limit: 1 }).length > 0 ? "✓ Documents added" : "Not started"}</td><td><a class="link" href="/knowledge">Add documents &rarr;</a></td></tr>
        <tr><td>5. WhatsApp connection</td><td>Check status</td><td><a class="link" href="/integrations">View &rarr;</a></td></tr>
      </table>
    </div>
  `;
  res.send(layout(req, "Overview", "overview", body));
});

// ---------- AI command center ----------

app.get("/command-center", requirePermission(PERMISSIONS.AI_VIEW), (req, res) => {
  const usage = reports.aiUsage(BUSINESS_ID, { days: 30 });
  const runs = db
    .prepare(
      `SELECT id, provider, model, intent, language, latency_ms, outcome, created_at, tool_calls
       FROM ai_runs WHERE business_id = ? ORDER BY id DESC LIMIT 25`
    )
    .all(BUSINESS_ID);

  const runRows = runs
    .map(
      (r) => `<tr>
        <td>${e(r.created_at)}</td>
        <td>${e(r.provider)} / ${e(r.model)}</td>
        <td>${e(r.intent)}</td>
        <td>${e(r.language)}</td>
        <td>${r.latency_ms} ms</td>
        <td>${statusPill(r.outcome)}</td>
        <td>${e((r.tool_calls || "[]").slice(0, 80))}</td>
      </tr>`
    )
    .join("");

  const usageRows = usage
    .map(
      (u) => `<tr>
        <td>${e(u.provider)} / ${e(u.model)}</td>
        <td>${u.runs}</td>
        <td>${u.avg_latency} ms</td>
        <td>${u.prompt_tokens + u.completion_tokens}</td>
        <td>$${Number(u.cost).toFixed(4)}</td>
      </tr>`
    )
    .join("");

  const tools = listToolsForBusiness(BUSINESS_ID);

  const body = `
    <div class="stat-grid">
      <div class="stat-card accent"><div class="stat-value">${usage.reduce((s, u) => s + u.runs, 0)}</div><div class="stat-label">AI runs (30 days)</div></div>
      <div class="stat-card"><div class="stat-value">${usage.reduce((s, u) => s + u.avg_latency, 0) > 0 ? Math.round(usage.reduce((s, u) => s + u.avg_latency, 0) / usage.length) : 0} ms</div><div class="stat-label">Average latency</div></div>
      <div class="stat-card"><div class="stat-value">$${usage.reduce((s, u) => s + Number(u.cost), 0).toFixed(4)}</div><div class="stat-label">Estimated cost (30 days)</div></div>
      <div class="stat-card"><div class="stat-value">${tools.length}</div><div class="stat-label">Tools enabled</div></div>
    </div>

    <div class="card">
      <h2>Model usage</h2>
      <p class="card-sub">Token counts and cost are estimates derived from each provider's response — they are not a billing statement.</p>
      <table>
        <thead><tr><th>Model</th><th>Runs</th><th>Avg latency</th><th>Tokens</th><th>Est. cost</th></tr></thead>
        <tbody>${usageRows || emptyRow(5, "No AI runs recorded yet.")}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Recent conversations handled by the assistant</h2>
      <table>
        <thead><tr><th>When</th><th>Model</th><th>Intent</th><th>Language</th><th>Latency</th><th>Outcome</th><th>Tools</th></tr></thead>
        <tbody>${runRows || emptyRow(7, "No AI runs recorded yet.")}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Tools the assistant may use</h2>
      <p class="card-sub">Each tool is validated and permission-checked before it runs. Enable or disable them from <a class="link" href="/settings/ai">AI Configuration</a>.</p>
      <ul class="tool-list">
        ${tools.map((t) => `<li><strong>${e(t.name)}</strong> — ${e(t.description)} <span class="muted">(${e(t.sideEffects)})</span></li>`).join("") || '<li class="muted">No tools are enabled for this workspace.</li>'}
      </ul>
    </div>
  `;
  res.send(layout(req, "AI Command Center", "command-center", body));
});

// ---------- inbox ----------

app.get("/inbox", requirePermission(PERMISSIONS.CONVERSATIONS_VIEW), (req, res) => {
  const status = req.query.status || "";
  const threads = conversations.listThreads(BUSINESS_ID, { status: status || null, search: req.query.q || "" });
  const counts = conversations.inboxCounts(BUSINESS_ID);

  const rows = threads
    .map(
      (t) => `<tr>
        <td>${e(t.last_message_at)}</td>
        <td><a class="link" href="/inbox/${t.id}">${e(t.customer_name || t.external_id)}</a></td>
        <td>${e(String(t.last_message_preview || "").slice(0, 90))}</td>
        <td>${statusPill(t.status)}</td>
        <td>${statusPill(t.ai_mode === "off" ? "taken over" : t.ai_mode)}</td>
        <td>${statusPill(t.priority)}</td>
        <td>${e(t.assigned_to || "—")}</td>
        <td>${t.unread_count > 0 ? `<strong>${t.unread_count}</strong>` : ""}</td>
      </tr>`
    )
    .join("");

  const body = `
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-value">${counts.open}</div><div class="stat-label">Open</div></div>
      <div class="stat-card"><div class="stat-value">${counts.unread}</div><div class="stat-label">Unread</div></div>
      <div class="stat-card"><div class="stat-value">${counts.takenOver}</div><div class="stat-label">With a human</div></div>
      <div class="stat-card"><div class="stat-value">${counts.total}</div><div class="stat-label">Total</div></div>
    </div>

    <div class="card">
      <h2>Customer inbox</h2>
      <p class="card-sub">Every conversation across your connected channels. Take over a conversation to stop the assistant replying.</p>
      <form method="GET" action="/inbox" style="display:flex; gap:10px; align-items:flex-end; margin-bottom:14px;">
        <div style="flex:1;">
          <label>Search</label>
          <input type="text" name="q" value="${e(req.query.q || "")}" placeholder="Name, number or message text" />
        </div>
        <div>
          <label>Status</label>
          <select name="status">
            <option value="">All</option>
            ${["open", "pending", "closed"].map((s) => `<option value="${s}" ${s === status ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </div>
        <button type="submit" class="secondary" style="margin-top:0;">Filter</button>
      </form>
      <table>
        <thead><tr><th>Last message</th><th>Customer</th><th>Preview</th><th>Status</th><th>AI</th><th>Priority</th><th>Assigned</th><th>Unread</th></tr></thead>
        <tbody>${rows || emptyRow(8, "No conversations yet.")}</tbody>
      </table>
    </div>
  `;
  res.send(layout(req, "Customer Inbox", "inbox", body));
});

app.get("/inbox/:id", requirePermission(PERMISSIONS.CONVERSATIONS_VIEW), (req, res) => {
  const thread = conversations.getThread(BUSINESS_ID, Number(req.params.id));
  const messages = conversations.getThreadMessages(BUSINESS_ID, thread.id);
  const notes = conversations.listNotes(BUSINESS_ID, thread.id);

  const bubbles = messages
    .map(
      (m) =>
        `<div class="bubble ${m.role === "user" ? "user" : "assistant"}">${e(m.content)}<div class="msg-time">${e(m.created_at)}</div></div>`
    )
    .join("");

  const noteRows = notes
    .map((n) => `<tr><td>${e(n.created_at)}</td><td>${e(n.author)}</td><td>${e(n.body)}</td></tr>`)
    .join("");

  const body = `
    <div class="card">
      <p><a class="link" href="/inbox">&larr; All conversations</a></p>
      <h2>${e(thread.customer_name || thread.external_id)}</h2>
      <p class="card-sub">${e(thread.external_id)} · status ${e(thread.status)} · AI mode ${e(thread.ai_mode)} · priority ${e(thread.priority)}${thread.assigned_to ? ` · assigned to ${e(thread.assigned_to)}` : ""}</p>
      ${bubbles || '<p class="muted">No messages yet.</p>'}
    </div>

    <div class="card">
      <h2>Manage this conversation</h2>
      <div class="grid-3">
        <form method="POST" action="/inbox/${thread.id}/takeover">
          <label>Hand over to a human</label>
          <textarea name="summary" placeholder="What does the next person need to know?"></textarea>
          <button type="submit" class="secondary">Take over</button>
        </form>
        <form method="POST" action="/inbox/${thread.id}/resume">
          <label>Let the assistant reply again</label>
          <p class="muted">The assistant resumes automatic replies for this conversation.</p>
          <button type="submit" class="secondary">Resume AI</button>
        </form>
        <form method="POST" action="/inbox/${thread.id}/assign">
          <label>Assign to</label>
          <input type="text" name="assignedTo" value="${e(thread.assigned_to || "")}" placeholder="Username" />
          <button type="submit" class="secondary">Assign</button>
        </form>
      </div>
    </div>

    <div class="card">
      <h2>Internal notes</h2>
      <p class="card-sub">Notes are never shown to the customer.</p>
      <table><tbody>${noteRows || emptyRow(3, "No notes yet.")}</tbody></table>
      <form method="POST" action="/inbox/${thread.id}/notes">
        <label>Add a note</label>
        <textarea name="body" required></textarea>
        <button type="submit">Save note</button>
      </form>
    </div>
  `;
  res.send(layout(req, "Conversation", "inbox", body));
});

app.post("/inbox/:id/takeover", requirePermission(PERMISSIONS.CONVERSATIONS_TAKEOVER), (req, res) => {
  conversations.takeoverThread(BUSINESS_ID, Number(req.params.id), {
    actor: req.user.username,
    reason: "Manual takeover",
    summary: req.body?.summary || "",
  });
  res.redirect(`/inbox/${req.params.id}`);
});

app.post("/inbox/:id/resume", requirePermission(PERMISSIONS.CONVERSATIONS_TAKEOVER), (req, res) => {
  conversations.resumeAi(BUSINESS_ID, Number(req.params.id), { actor: req.user.username });
  res.redirect(`/inbox/${req.params.id}`);
});

app.post("/inbox/:id/assign", requirePermission(PERMISSIONS.CONVERSATIONS_REPLY), (req, res) => {
  conversations.assignThread(BUSINESS_ID, Number(req.params.id), req.body?.assignedTo || "", req.user.username);
  res.redirect(`/inbox/${req.params.id}`);
});

app.post("/inbox/:id/notes", requirePermission(PERMISSIONS.CONVERSATIONS_REPLY), (req, res) => {
  conversations.addNote(BUSINESS_ID, Number(req.params.id), req.user.username, req.body?.body || "");
  res.redirect(`/inbox/${req.params.id}`);
});

// ---------- leads (CRM) ----------

app.get("/leads", requirePermission(PERMISSIONS.LEADS_VIEW), (req, res) => {
  const leads = getLeads(BUSINESS_ID);
  const stats = getLeadStats(BUSINESS_ID);

  const rows = leads
    .map(
      (lead) => `<tr>
        <td>${e(lead.created_at)}</td>
        <td>${e(lead.customer_name || "—")}</td>
        <td>${e(lead.service_requested || "—")}</td>
        <td>${e(lead.location || "—")}</td>
        <td>${e(lead.urgency || "—")}</td>
        <td>
          <form class="status-form" method="POST" action="/leads/${lead.id}/status">
            <select name="status" onchange="this.form.submit()">
              ${["new", "contacted", "booked", "closed"]
                .map((s) => `<option value="${s}" ${s === lead.status ? "selected" : ""}>${s}</option>`)
                .join("")}
            </select>
          </form>
        </td>
        <td>${e(lead.chat_id)}</td>
      </tr>`
    )
    .join("");

  const body = `
    <div class="stat-grid">
      <div class="stat-card accent"><div class="stat-value">${stats.new}</div><div class="stat-label">New</div></div>
      <div class="stat-card"><div class="stat-value">${stats.contacted}</div><div class="stat-label">Contacted</div></div>
      <div class="stat-card"><div class="stat-value">${stats.booked}</div><div class="stat-label">Booked</div></div>
      <div class="stat-card"><div class="stat-value">${stats.closed}</div><div class="stat-label">Closed</div></div>
      <div class="stat-card"><div class="stat-value">${getConversionRate(BUSINESS_ID)}%</div><div class="stat-label">Conversion</div></div>
    </div>

    <div class="card">
      <h2>Leads</h2>
      <p class="card-sub">Captured by the assistant. <a class="link" href="/leads/export.csv">Export CSV &darr;</a></p>
      <table>
        <thead><tr><th>Received</th><th>Name</th><th>Service</th><th>Location</th><th>Urgency</th><th>Status</th><th>Chat</th></tr></thead>
        <tbody>${rows || emptyRow(7, "No leads yet.")}</tbody>
      </table>
    </div>
  `;
  res.send(layout(req, "Leads & CRM", "crm", body));
});

app.get("/leads/export.csv", requirePermission(PERMISSIONS.LEADS_VIEW), (req, res) => {
  const csv = toCsv(getLeads(BUSINESS_ID), [
    { key: "created_at", label: "Received" },
    { key: "customer_name", label: "Name" },
    { key: "contact_number", label: "Contact" },
    { key: "service_requested", label: "Service" },
    { key: "location", label: "Location" },
    { key: "urgency", label: "Urgency" },
    { key: "preferred_date", label: "Preferred Date" },
    { key: "notes", label: "Notes" },
    { key: "status", label: "Status" },
  ]);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

app.post("/leads/:id/status", requirePermission(PERMISSIONS.LEADS_EDIT), (req, res) => {
  updateLeadStatus(BUSINESS_ID, Number(req.params.id), req.body?.status);
  res.redirect("/leads");
});

// ---------- customers ----------

app.get("/customers", requirePermission(PERMISSIONS.CUSTOMERS_VIEW), (req, res) => {
  const rows = customers
    .listCustomers(BUSINESS_ID, { search: req.query.q || "" })
    .map(
      (c) => `<tr>
        <td>${e(c.name)}</td>
        <td>${e(c.phone)}</td>
        <td>${e(c.company || "—")}</td>
        <td>${e([c.province, c.district, c.municipality, c.ward, c.locality].filter(Boolean).join(", ") || "—")}</td>
        <td>${money(c.lifetime_value, businesses.getBusinessConfig(BUSINESS_ID).currency)}</td>
        <td>${c.total_orders}</td>
        <td>${e(c.last_order_at || "—")}</td>
        <td><a class="link" href="/customers/${c.id}">Open</a></td>
      </tr>`
    )
    .join("");

  const body = `
    <div class="card">
      <h2>Customers</h2>
      <p class="card-sub">Every customer record in this workspace, with the Nepal address structure.</p>
      <form method="GET" action="/customers" style="display:flex; gap:10px; align-items:flex-end; margin-bottom:14px;">
        <div style="flex:1;"><label>Search</label><input type="text" name="q" value="${e(req.query.q || "")}" placeholder="Name, phone, company or locality" /></div>
        <button type="submit" class="secondary" style="margin-top:0;">Search</button>
      </form>
      <table>
        <thead><tr><th>Name</th><th>Phone</th><th>Company</th><th>Address</th><th>Lifetime value</th><th>Orders</th><th>Last order</th><th></th></tr></thead>
        <tbody>${rows || emptyRow(8, "No customers yet.")}</tbody>
      </table>
    </div>
  `;
  res.send(layout(req, "Customers", "customers", body));
});

app.get("/customers/:id", requirePermission(PERMISSIONS.CUSTOMERS_VIEW), (req, res) => {
  const history = customers.getCustomerHistory(BUSINESS_ID, Number(req.params.id));
  const orderRows = history.orders
    .map(
      (o) => `<tr><td>${e(o.created_at)}</td><td>${e(o.order_number)}</td><td>${e(o.item_name)}</td><td>${money(o.amount, o.currency)}</td><td>${statusPill(o.payment_status)}</td><td>${statusPill(o.state)}</td></tr>`
    )
    .join("");

  const body = `
    <div class="card">
      <p><a class="link" href="/customers">&larr; All customers</a></p>
      <h2>${e(history.customer.name)}</h2>
      <p class="card-sub">
        ${e(history.customer.phone)} ${history.customer.email ? `· ${e(history.customer.email)}` : ""}<br>
        ${e([history.customer.province, history.customer.district, history.customer.municipality, history.customer.ward, history.customer.locality, history.customer.address].filter(Boolean).join(", ") || "No address on file")}
      </p>
      <table>
        <tr><td>Lifetime value</td><td>${money(history.customer.lifetime_value, businesses.getBusinessConfig(BUSINESS_ID).currency)}</td></tr>
        <tr><td>Orders</td><td>${history.customer.total_orders}</td></tr>
        <tr><td>Tags</td><td>${e((history.customer.tags || []).join(", ") || "—")}</td></tr>
      </table>
    </div>

    <div class="card">
      <h2>Orders</h2>
      <table><thead><tr><th>When</th><th>Number</th><th>Items</th><th>Amount</th><th>Payment</th><th>State</th></tr></thead>
      <tbody>${orderRows || emptyRow(6, "No orders yet.")}</tbody></table>
    </div>
  `;
  res.send(layout(req, "Customer", "customers", body));
});

// ---------- catalogue ----------

app.get("/catalog", requirePermission(PERMISSIONS.CATALOG_VIEW), (req, res) => {
  const products = catalog.listProducts(BUSINESS_ID, { search: req.query.q || "", includeInactive: true });
  const currency = businesses.getBusinessConfig(BUSINESS_ID).currency;

  const rows = products
    .map(
      (p) => `<tr>
        <td>${e(p.name)}</td>
        <td>${e(p.type)}</td>
        <td>${e(p.sku || "—")}</td>
        <td>${e(p.category || "—")}</td>
        <td>${money(p.price, currency)}</td>
        <td>${p.track_inventory ? inventory.getStock(BUSINESS_ID, p.id).available : "—"}</td>
        <td>${p.is_active ? "Active" : "Hidden"}</td>
      </tr>`
    )
    .join("");

  const body = `
    <div class="card">
      <h2>Products &amp; services</h2>
      <p class="card-sub">This catalogue is the assistant's <strong>only</strong> source of product names and prices. Anything not listed here cannot be quoted.</p>
      <form method="GET" action="/catalog" style="display:flex; gap:10px; align-items:flex-end; margin-bottom:14px;">
        <div style="flex:1;"><label>Search</label><input type="text" name="q" value="${e(req.query.q || "")}" /></div>
        <button type="submit" class="secondary" style="margin-top:0;">Search</button>
      </form>
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>SKU</th><th>Category</th><th>Price</th><th>Available</th><th>Status</th></tr></thead>
        <tbody>${rows || emptyRow(7, "No catalogue items yet.")}</tbody>
      </table>
    </div>

    ${
      can(req.user, PERMISSIONS.CATALOG_EDIT)
        ? `<div class="card">
      <h2>Add an item</h2>
      <form method="POST" action="/catalog">
        <div class="grid-2">
          <div><label>Name</label><input type="text" name="name" required /></div>
          <div><label>Type</label><select name="type"><option value="product">Product</option><option value="service">Service</option></select></div>
        </div>
        <div class="grid-3">
          <div><label>Price</label><input type="number" step="0.01" name="price" required /></div>
          <div><label>Currency</label><input type="text" name="currency" value="${e(currency)}" /></div>
          <div><label>Tax rate</label><input type="number" step="0.01" name="tax_rate" value="0" /></div>
        </div>
        <div class="grid-2">
          <div><label>SKU</label><input type="text" name="sku" /></div>
          <div><label>Category</label><input type="text" name="category" /></div>
        </div>
        <label>Description</label>
        <textarea name="description"></textarea>
        <label style="display:flex; align-items:center; gap:8px; font-weight:400; margin-top:14px;">
          <input type="checkbox" name="track_inventory" value="1" style="width:auto; margin:0;" /> Track stock for this item
        </label>
        <button type="submit">Add item</button>
        ${req.query.saved ? '<p class="save-note">Saved.</p>' : ""}
      </form>
    </div>`
        : ""
    }
  `;
  res.send(layout(req, "Products & Services", "catalog", body));
});

app.post("/catalog", requirePermission(PERMISSIONS.CATALOG_EDIT), (req, res) => {
  const b = req.body || {};
  try {
    catalog.createProduct(
      BUSINESS_ID,
      {
        name: b.name,
        type: b.type,
        price: Number(b.price),
        currency: b.currency,
        tax_rate: Number(b.tax_rate || 0),
        sku: b.sku,
        category: b.category,
        description: b.description,
        track_inventory: b.track_inventory === "1",
      },
      req.user.username
    );
    res.redirect("/catalog?saved=1");
  } catch (err) {
    res.redirect("/catalog?error=" + encodeURIComponent(err.message));
  }
});

// ---------- inventory ----------

app.get("/inventory", requirePermission(PERMISSIONS.INVENTORY_VIEW), (req, res) => {
  const stock = inventory.listStock(BUSINESS_ID);
  const valuation = inventory.inventoryValuation(BUSINESS_ID);

  const rows = stock
    .map(
      (s) => `<tr>
        <td>${e(s.product_name)}</td>
        <td>${e(s.variant_name || "—")}</td>
        <td>${e(s.sku || "—")}</td>
        <td>${s.quantity_on_hand}</td>
        <td>${s.quantity_reserved}</td>
        <td>${s.available}</td>
        <td>${s.reorder_level}</td>
      </tr>`
    )
    .join("");

  const body = `
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-value">${valuation.units}</div><div class="stat-label">Units in stock</div></div>
      <div class="stat-card accent"><div class="stat-value">${money(valuation.costValue)}</div><div class="stat-label">Cost valuation</div></div>
      <div class="stat-card"><div class="stat-value">${money(valuation.retailValue)}</div><div class="stat-label">Retail valuation</div></div>
      <div class="stat-card ${inventory.lowStockAlerts(BUSINESS_ID).length > 0 ? "warn" : ""}"><div class="stat-value">${inventory.lowStockAlerts(BUSINESS_ID).length}</div><div class="stat-label">Below reorder level</div></div>
    </div>

    <div class="card">
      <h2>Stock levels</h2>
      <table>
        <thead><tr><th>Item</th><th>Variant</th><th>SKU</th><th>On hand</th><th>Reserved</th><th>Available</th><th>Reorder at</th></tr></thead>
        <tbody>${rows || emptyRow(7, "No stock-tracked items yet.")}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Recent stock movements</h2>
      <table>
        <thead><tr><th>When</th><th>Item</th><th>Type</th><th>Qty</th><th>Balance</th><th>Reference</th></tr></thead>
        <tbody>
          ${
            inventory
              .listMovements(BUSINESS_ID, { limit: 25 })
              .map(
                (m) =>
                  `<tr><td>${e(m.created_at)}</td><td>${e(m.product_name)}</td><td>${e(m.type)}</td><td>${m.quantity}</td><td>${m.balance_after}</td><td>${e(m.reference_type || "—")} ${m.reference_id || ""}</td></tr>`
              )
              .join("") || emptyRow(6, "No movements recorded yet.")
          }
        </tbody>
      </table>
    </div>
  `;
  res.send(layout(req, "Inventory", "inventory", body));
});

// ---------- orders ----------

app.get("/orders", requirePermission(PERMISSIONS.ORDERS_VIEW), (req, res) => {
  const rows = orders
    .listOrders(BUSINESS_ID, { state: req.query.state || null, limit: 200 })
    .map(
      (o) => `<tr>
        <td>${e(o.created_at)}</td>
        <td>${e(o.order_number || `#${o.id}`)}</td>
        <td>${e(o.item_name)}</td>
        <td>${money(o.total_amount ?? o.amount, o.currency)}</td>
        <td>${statusPill(o.state)}</td>
        <td>${statusPill(o.payment_status)}</td>
        <td>${e(o.chat_id)}</td>
      </tr>`
    )
    .join("");

  const drafts = orders
    .findDrafts(BUSINESS_ID, { state: "awaiting_confirmation" })
    .map(
      (d) => `<tr>
        <td>${e(d.created_at)}</td>
        <td>${e(d.summary)}</td>
        <td>${money(d.total, d.currency)}</td>
        <td>${e(d.chat_id)}</td>
        <td>
          ${
            can(req.user, PERMISSIONS.ORDERS_CREATE)
              ? `<form method="POST" action="/orders/drafts/${d.id}/confirm" style="display:inline;">
                   <button type="submit" class="secondary small">Confirm for customer</button>
                 </form>`
              : ""
          }
        </td>
      </tr>`
    )
    .join("");

  const body = `
    <div class="card">
      <h2>Orders</h2>
      <p class="card-sub">
        Every order, in its real lifecycle state. An order only reaches <em>confirmed</em> after the customer approves the summary.
        <a class="link" href="/orders/export.csv">Export CSV &darr;</a>
      </p>
      <form method="GET" action="/orders" style="display:flex; gap:10px; align-items:flex-end; margin-bottom:14px;">
        <div>
          <label>State</label>
          <select name="state">
            <option value="">All</option>
            ${orders.ORDER_STATES.map((s) => `<option value="${s}" ${s === req.query.state ? "selected" : ""}>${s.replace(/_/g, " ")}</option>`).join("")}
          </select>
        </div>
        <button type="submit" class="secondary" style="margin-top:0;">Filter</button>
      </form>
      <table>
        <thead><tr><th>Created</th><th>Number</th><th>Items</th><th>Total</th><th>State</th><th>Payment</th><th>Chat</th></tr></thead>
        <tbody>${rows || emptyRow(7, "No orders yet.")}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Pending order drafts</h2>
      <p class="card-sub">Summaries the assistant has shown to a customer and is waiting for an explicit approval on.</p>
      <table>
        <thead><tr><th>Created</th><th>Summary</th><th>Total</th><th>Chat</th><th></th></tr></thead>
        <tbody>${drafts || emptyRow(5, "No drafts waiting for confirmation.")}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Bookings</h2>
      <table>
        <thead><tr><th>Starts</th><th>Title</th><th>Status</th><th>Assigned</th></tr></thead>
        <tbody>
          ${
            bookings
              .listBookings(BUSINESS_ID, { limit: 50 })
              .map((b) => `<tr><td>${e(b.starts_at)}</td><td>${e(b.title)}</td><td>${statusPill(b.status)}</td><td>${e(b.assigned_to || "—")}</td></tr>`)
              .join("") || emptyRow(4, "No bookings yet.")
          }
        </tbody>
      </table>
    </div>
  `;
  res.send(layout(req, "Orders & Bookings", "orders", body));
});

app.get("/orders/export.csv", requirePermission(PERMISSIONS.ORDERS_VIEW), (req, res) => {
  const csv = toCsv(orders.listOrders(BUSINESS_ID, { limit: 5000 }), [
    { key: "created_at", label: "Created" },
    { key: "order_number", label: "Order number" },
    { key: "item_name", label: "Items" },
    { key: "total_amount", label: "Total" },
    { key: "currency", label: "Currency" },
    { key: "state", label: "State" },
    { key: "payment_status", label: "Payment" },
    { key: "chat_id", label: "Chat ID" },
  ]);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

app.post("/orders/drafts/:id/confirm", requirePermission(PERMISSIONS.ORDERS_CREATE), (req, res) => {
  try {
    orders.confirmDraft(BUSINESS_ID, Number(req.params.id), {
      actor: req.user.username,
      customerApproved: true,
      idempotencyKey: `staff-${req.params.id}`,
    });
    res.redirect("/orders");
  } catch (err) {
    res.redirect("/orders?error=" + encodeURIComponent(err.message));
  }
});

// ---------- quotations & invoices ----------

app.get("/documents", requirePermission(PERMISSIONS.QUOTES_VIEW), (req, res) => {
  const quoteRows = quotations
    .listQuotations(BUSINESS_ID, { limit: 100 })
    .map(
      (q) =>
        `<tr><td>${e(q.number)}</td><td>${e(q.created_at)}</td><td>${statusPill(q.status)}</td><td>${money(q.total, q.currency)}</td><td>${e(q.valid_until || "—")}</td></tr>`
    )
    .join("");

  const invoiceRows = quotations
    .listInvoices(BUSINESS_ID, { limit: 100 })
    .map(
      (i) =>
        `<tr><td>${e(i.number)}</td><td>${e(i.created_at)}</td><td>${statusPill(i.status)}</td><td>${money(i.total, i.currency)}</td><td>${money(i.amount_paid, i.currency)}</td><td>${money(i.balance, i.currency)}</td><td><a class="link" href="/documents/invoice/${i.id}">Print</a></td></tr>`
    )
    .join("");

  const body = `
    <div class="card">
      <h2>Quotations</h2>
      <table>
        <thead><tr><th>Number</th><th>Created</th><th>Status</th><th>Total</th><th>Valid until</th></tr></thead>
        <tbody>${quoteRows || emptyRow(5, "No quotations yet.")}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Invoices</h2>
      <table>
        <thead><tr><th>Number</th><th>Created</th><th>Status</th><th>Total</th><th>Paid</th><th>Balance</th><th></th></tr></thead>
        <tbody>${invoiceRows || emptyRow(7, "No invoices yet.")}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Expenses</h2>
      <table>
        <thead><tr><th>Date</th><th>Category</th><th>Paid to</th><th>Amount</th><th>Note</th></tr></thead>
        <tbody>
          ${
            quotations
              .listExpenses(BUSINESS_ID, { limit: 50 })
              .map((x) => `<tr><td>${e(x.spent_at)}</td><td>${e(x.category)}</td><td>${e(x.paid_to || "—")}</td><td>${money(x.amount, x.currency)}</td><td>${e(x.note || "")}</td></tr>`)
              .join("") || emptyRow(5, "No expenses recorded yet.")
          }
        </tbody>
      </table>
    </div>
  `;
  res.send(layout(req, "Quotations & Invoices", "documents", body));
});

app.get("/documents/invoice/:id", requirePermission(PERMISSIONS.INVOICES_VIEW), (req, res) => {
  const business = businesses.getBusinessConfig(BUSINESS_ID);
  const invoice = quotations.getInvoice(BUSINESS_ID, Number(req.params.id));
  res.type("html").send(quotations.renderDocument(business, invoice, "invoice"));
});

// ---------- payments ----------

app.get("/payments", requirePermission(PERMISSIONS.PAYMENTS_VIEW), (req, res) => {
  const rows = payments
    .listPayments(BUSINESS_ID, { limit: 200 })
    .map(
      (p) => `<tr>
        <td>${e(p.created_at)}</td>
        <td>${e(p.provider)}</td>
        <td>${e(p.provider_ref)}</td>
        <td>${money(p.amount, p.currency)}</td>
        <td>${statusPill(p.status)}</td>
        <td>${p.verified ? "Verified" : "Not verified"}</td>
        <td>${e(p.verification_detail || "")}</td>
      </tr>`
    )
    .join("");

  const body = `
    <div class="card">
      <h2>Payments</h2>
      <p class="card-sub">
        A payment is only marked <strong>succeeded</strong> after the payment provider itself confirms it.
        Screenshots, customer messages and AI statements are never treated as proof.
      </p>
      <table>
        <thead><tr><th>When</th><th>Provider</th><th>Reference</th><th>Amount</th><th>Status</th><th>Verified</th><th>Detail</th></tr></thead>
        <tbody>${rows || emptyRow(7, "No payments recorded yet.")}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Payment providers</h2>
      <table>
        <thead><tr><th>Provider</th><th>Needs</th><th>Automatic verification</th></tr></thead>
        <tbody>
          ${payments
            .listAdapters()
            .map(
              (a) =>
                `<tr><td>${e(a.label)}</td><td>${e(a.credentialFields.map((f) => f.label).join(", ") || "Nothing")}</td><td>${a.requiresManualApproval ? "Manual staff approval" : "Yes — provider callback + server-side check"}</td></tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
  res.send(layout(req, "Payments", "payments", body));
});

// ---------- workflows ----------

app.get("/workflows", requirePermission(PERMISSIONS.WORKFLOWS_VIEW), (req, res) => {
  const rows = workflows
    .listWorkflows(BUSINESS_ID)
    .map(
      (w) => `<tr>
        <td>${e(w.name)}</td>
        <td>${e(workflows.TRIGGER_LABELS[w.trigger_type] || w.trigger_type)}</td>
        <td>${(w.actions || []).map((a) => e(workflows.ACTION_LABELS[a.type] || a.type)).join(", ")}</td>
        <td>${w.enabled ? "On" : "Off"}</td>
        <td>${w.run_count}</td>
        <td>${e(w.last_run_at || "—")}</td>
      </tr>`
    )
    .join("");

  const runRows = workflows
    .listRuns(BUSINESS_ID, { limit: 40 })
    .map(
      (r) =>
        `<tr><td>${e(r.created_at)}</td><td>${e(r.workflow_id)}</td><td>${statusPill(r.status)}</td><td>${r.attempts}</td><td>${e(r.error || "")}</td></tr>`
    )
    .join("");

  const body = `
    <div class="card">
      <h2>Automation workflows</h2>
      <p class="card-sub">
        A workflow is data: a trigger, conditions and actions. Nothing in a workflow is executed as code,
        so a definition can never run arbitrary commands.
      </p>
      <table>
        <thead><tr><th>Name</th><th>Trigger</th><th>Actions</th><th>Enabled</th><th>Runs</th><th>Last run</th></tr></thead>
        <tbody>${rows || emptyRow(6, "No workflows defined yet.")}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Execution log</h2>
      <table>
        <thead><tr><th>When</th><th>Workflow</th><th>Status</th><th>Attempts</th><th>Error</th></tr></thead>
        <tbody>${runRows || emptyRow(5, "No workflow runs yet.")}</tbody>
      </table>
    </div>

    ${
      can(req.user, PERMISSIONS.WORKFLOWS_EDIT)
        ? `<div class="card">
      <h2>Create a workflow</h2>
      <form method="POST" action="/workflows">
        <div class="grid-2">
          <div><label>Name</label><input type="text" name="name" required /></div>
          <div><label>Trigger</label><select name="trigger_type">${Object.entries(workflows.TRIGGER_LABELS).map(([k, v]) => `<option value="${k}">${e(v)}</option>`).join("")}</select></div>
        </div>
        <label>Conditions <span class="muted">(JSON list, e.g. [{"field":"order.total_amount","operator":"greater_than","value":5000}])</span></label>
        <textarea name="conditions" placeholder="[]">[]</textarea>
        <label>Actions <span class="muted">(JSON list, e.g. [{"type":"create_task","args":{"title":"Call the customer"}}])</span></label>
        <textarea name="actions" placeholder="[]">[]</textarea>
        <button type="submit">Create workflow</button>
        ${req.query.error ? `<p class="error-note">${e(req.query.error)}</p>` : ""}
        ${req.query.saved ? '<p class="save-note">Workflow created.</p>' : ""}
      </form>
    </div>`
        : ""
    }
  `;
  res.send(layout(req, "Automation Studio", "workflows", body));
});

app.post("/workflows", requirePermission(PERMISSIONS.WORKFLOWS_EDIT), (req, res) => {
  try {
    const conditions = JSON.parse(req.body?.conditions || "[]");
    const actions = JSON.parse(req.body?.actions || "[]");
    workflows.createWorkflow(
      BUSINESS_ID,
      { name: req.body?.name, trigger_type: req.body?.trigger_type, conditions, actions },
      req.user.username
    );
    res.redirect("/workflows?saved=1");
  } catch (err) {
    res.redirect("/workflows?error=" + encodeURIComponent(err.message));
  }
});

// ---------- reports ----------

app.get("/reports", requirePermission(PERMISSIONS.REPORTS_VIEW), (req, res) => {
  const accounting = reports.accountingSummary(BUSINESS_ID);
  const funnel = reports.leadFunnel(BUSINESS_ID);
  const byProduct = reports.revenueByProduct(BUSINESS_ID);
  const forecast = reports.demandForecast(BUSINESS_ID);
  const inventoryRisk = reports.inventoryRisk(BUSINESS_ID);
  const currency = businesses.getBusinessConfig(BUSINESS_ID).currency;

  const body = `
    <div class="stat-grid">
      <div class="stat-card accent"><div class="stat-value">${money(accounting.revenue, currency)}</div><div class="stat-label">Revenue</div></div>
      <div class="stat-card"><div class="stat-value">${money(accounting.grossProfit, currency)}</div><div class="stat-label">Gross profit (est.)</div></div>
      <div class="stat-card"><div class="stat-value">${accounting.grossMarginPercent}%</div><div class="stat-label">Gross margin</div></div>
      <div class="stat-card"><div class="stat-value">${money(accounting.expenses, currency)}</div><div class="stat-label">Expenses</div></div>
      <div class="stat-card"><div class="stat-value">${money(accounting.taxCollected, currency)}</div><div class="stat-label">Tax collected</div></div>
      <div class="stat-card"><div class="stat-value">${accounting.orders}</div><div class="stat-label">Paid orders</div></div>
    </div>

    <div class="card">
      <h2>Accounting summary</h2>
      <p class="card-sub">${e(accounting.disclaimer)}</p>
    </div>

    <div class="card">
      <h2>Revenue by product or service</h2>
      <table>
        <thead><tr><th>Item</th><th>Quantity</th><th>Revenue</th></tr></thead>
        <tbody>${byProduct.map((p) => `<tr><td>${e(p.name)}</td><td>${p.quantity}</td><td>${money(p.revenue, currency)}</td></tr>`).join("") || emptyRow(3, "No paid orders yet.")}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Lead funnel</h2>
      <p class="card-sub">${funnel.total} leads · ${funnel.converted} converted · ${funnel.conversionRate}% conversion</p>
      <table>
        <thead><tr><th>Status</th><th>Count</th></tr></thead>
        <tbody>${Object.entries(funnel.byStatus).map(([k, v]) => `<tr><td>${e(k)}</td><td>${v}</td></tr>`).join("") || emptyRow(2, "No leads yet.")}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Forecast</h2>
      ${
        forecast.available
          ? `<p class="card-sub">${e(forecast.method)} · ${e(forecast.confidence)}</p>
             <p>Average daily revenue <strong>${money(forecast.averageDailyRevenue, currency)}</strong>,
             expected range ${money(forecast.lowerBound, currency)} – ${money(forecast.upperBound, currency)}.</p>`
          : `<p class="card-sub">${e(forecast.reason)}</p>`
      }
    </div>

    <div class="card">
      <h2>Inventory risk</h2>
      <table>
        <thead><tr><th>Item</th><th>Available</th><th>Reorder at</th></tr></thead>
        <tbody>${inventoryRisk.lowStock.map((s) => `<tr><td>${e(s.product_name)}</td><td>${s.available}</td><td>${s.reorder_level}</td></tr>`).join("") || emptyRow(3, "No items below their reorder level.")}</tbody>
      </table>
    </div>
  `;
  res.send(layout(req, "Business Intelligence", "reports", body));
});

// ---------- AI configuration ----------

app.get("/settings/ai", requirePermission(PERMISSIONS.AI_VIEW), (req, res) => {
  const business = businesses.getBusinessConfig(BUSINESS_ID);
  const currentProvider = business.ai_provider || "";
  const currentModel = business.ai_model || "";

  let keyDisplay = "No API key added yet.";
  if (business.ai_api_key_encrypted) {
    try {
      keyDisplay = maskKey(decrypt(business.ai_api_key_encrypted));
    } catch {
      keyDisplay = "Stored (unable to preview — ENCRYPTION_KEY may have changed).";
    }
  }

  const providerOptions = SUPPORTED_PROVIDERS.map(
    (p) => `<option value="${p.id}" ${p.id === currentProvider ? "selected" : ""}>${e(p.label)}</option>`
  ).join("");

  const modelDatalist = SUPPORTED_PROVIDERS.flatMap((p) => p.models).map((m) => `<option value="${e(m)}">`).join("");
  const providerModelMap = JSON.stringify(
    Object.fromEntries(
      SUPPORTED_PROVIDERS.map((p) => [
        p.id,
        { defaultModel: p.defaultModel, models: p.models, freeTier: p.freeTier, freeTierNote: p.freeTierNote || "" },
      ])
    )
  );

  const freeProviders = SUPPORTED_PROVIDERS.filter((p) => p.freeTier);

  const toolRows = TOOL_DEFINITIONS.map((t) => {
    const permission = db
      .prepare("SELECT * FROM ai_tool_permissions WHERE business_id = ? AND tool_name = ?")
      .get(BUSINESS_ID, t.name);
    const enabled = permission ? permission.enabled : 1;
    const approval = permission ? permission.requires_approval : t.approvalRequired ? 1 : 0;
    return `<tr>
        <td><strong>${e(t.name)}</strong></td>
        <td>${e(t.description)}</td>
        <td>${e(t.sideEffects)}</td>
        <td>
          <form method="POST" action="/settings/ai/tool/${e(t.name)}" style="display:inline;">
            <input type="hidden" name="enabled" value="${enabled ? "0" : "1"}" />
            <button type="submit" class="secondary small">${enabled ? "Disable" : "Enable"}</button>
          </form>
        </td>
        <td>
          <form method="POST" action="/settings/ai/tool/${e(t.name)}" style="display:inline;">
            <input type="hidden" name="enabled" value="${enabled}" />
            <input type="hidden" name="requiresApproval" value="${approval ? "0" : "1"}" />
            <button type="submit" class="secondary small">${approval ? "Auto" : "Needs approval"}</button>
          </form>
        </td>
      </tr>`;
  }).join("");

  const body = `
    <div class="card">
      <h2>AI configuration</h2>
      <p class="card-sub">Choose a provider and paste in your own key. Keys are encrypted before storage and never shown in full again.</p>
      <label>Current key</label>
      <div class="key-display">${e(keyDisplay)}${currentProvider ? ` &nbsp;·&nbsp; provider: ${e(currentProvider)} &nbsp;·&nbsp; model: ${e(currentModel || "(default)")}` : ""}</div>

      ${
        can(req.user, PERMISSIONS.AI_EDIT)
          ? `<form method="POST" action="/settings/ai" id="ai-form">
        <label for="provider">AI provider</label>
        <select name="provider" id="provider">
          <option value="">Choose a provider…</option>
          ${providerOptions}
        </select>
        <div id="free-tier-note" class="muted" style="margin-top:8px;"></div>

        <label for="model">Model</label>
        <input list="model-list" type="text" name="model" id="model" value="${e(currentModel)}" placeholder="Auto-fills when you pick a provider" />
        <datalist id="model-list">${modelDatalist}</datalist>

        <label for="apiKey">API key <span class="muted">(leave blank to keep the current key)</span></label>
        <input type="password" name="apiKey" id="apiKey" placeholder="Paste your API key" autocomplete="off" />

        <label for="disclosure">AI disclosure <span class="muted">(what the assistant says it is — e.g. "You are chatting with our virtual assistant")</span></label>
        <input type="text" name="ai_disclosure" id="disclosure" value="${e(business.ai_disclosure || "")}" />

        <label style="display:flex; align-items:center; gap:8px; font-weight:400; margin-top:16px;">
          <input type="checkbox" name="ai_local_only" value="1" ${business.ai_local_only ? "checked" : ""} style="width:auto; margin:0;" />
          Local-only mode — never send conversation data to a cloud provider
        </label>

        <label for="operatorRole">Role the assistant acts as</label>
        <select name="ai_operator_role" id="operatorRole">
          ${["owner", "manager", "staff", "accountant", "viewer"].map((r) => `<option value="${r}" ${r === (business.ai_operator_role || "owner") ? "selected" : ""}>${e(r)}</option>`).join("")}
        </select>

        <div class="grid-2">
          <div><label for="temperature">Temperature</label><input type="number" step="0.1" min="0" max="2" name="ai_temperature" id="temperature" value="${e(String(business.ai_temperature ?? 0.4))}" /></div>
          <div><label for="maxTokens">Max tokens</label><input type="number" min="64" max="8000" name="ai_max_tokens" id="maxTokens" value="${e(String(business.ai_max_tokens ?? 500))}" /></div>
        </div>

        <button type="button" class="secondary" id="test-btn">Test connection</button>
        <div id="test-result"></div>
        <button type="submit">Save settings</button>
      </form>`
          : `<p class="muted">You can view the configuration but not change it. Ask an owner for access.</p>`
      }
      ${req.query.saved ? '<p class="save-note">Saved.</p>' : ""}
    </div>

    ${
      can(req.user, PERMISSIONS.AI_EDIT)
        ? `<div class="card">
      <h2>Tools the assistant may use</h2>
      <p class="card-sub">Every tool the assistant calls is validated against its schema and checked against the permissions of the role above. Sensitive tools can require a human approval.</p>
      <table>
        <thead><tr><th>Tool</th><th>What it does</th><th>Side effects</th><th>Enabled</th><th>Approval</th></tr></thead>
        <tbody>${toolRows}</tbody>
      </table>
    </div>`
        : ""
    }

    <div class="card">
      <h2>Providers with a free tier</h2>
      <table>
        <thead><tr><th>Provider</th><th>Free tier</th></tr></thead>
        <tbody>${freeProviders.map((p) => `<tr><td>${e(p.label.split(" — ")[0].split(" (")[0])}</td><td>${e(p.freeTierNote)}</td></tr>`).join("")}</tbody>
      </table>
    </div>

    <script nonce="${e(req.cspNonce || "")}">
      const PROVIDER_MODELS = ${providerModelMap};
      const providerSelect = document.getElementById("provider");
      const modelInput = document.getElementById("model");
      const freeTierNoteEl = document.getElementById("free-tier-note");
      if (providerSelect && modelInput) {
        let lastAutoFilledModel = ${JSON.stringify(currentModel)};
        function updateFreeTierNote() {
          const meta = PROVIDER_MODELS[providerSelect.value];
          freeTierNoteEl.textContent = meta && meta.freeTier ? "✓ " + meta.freeTierNote : "";
        }
        updateFreeTierNote();
        providerSelect.addEventListener("change", function () {
          const meta = PROVIDER_MODELS[providerSelect.value];
          if (!meta) return;
          if (!modelInput.value || modelInput.value === lastAutoFilledModel) {
            modelInput.value = meta.defaultModel;
            lastAutoFilledModel = meta.defaultModel;
          }
          updateFreeTierNote();
        });
        const testBtn = document.getElementById("test-btn");
        if (testBtn) {
          testBtn.addEventListener("click", async function () {
            const resultEl = document.getElementById("test-result");
            resultEl.textContent = "Testing…";
            resultEl.style.color = "#8A8474";
            try {
              const res = await fetch("/api/ai/test", {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-CSRF-Token": readCsrf() },
                body: JSON.stringify({
                  provider: providerSelect.value,
                  model: modelInput.value,
                  apiKey: document.getElementById("apiKey").value,
                }),
              });
              const data = await res.json();
              resultEl.textContent = data.ok ? "✓ Connection successful (model: " + data.model + ")" : "✗ " + data.error;
              resultEl.style.color = data.ok ? "#2E5E3E" : "#8B2E2E";
            } catch (err) {
              resultEl.textContent = "✗ Request failed: " + err.message;
              resultEl.style.color = "#8B2E2E";
            }
          });
        }
      }
      function readCsrf() {
        var token = document.cookie.split("; ").find(function (c) { return c.indexOf("csrf_token=") === 0; });
        return token ? decodeURIComponent(token.split("=").slice(1).join("=")) : "";
      }
    </script>
  `;
  res.send(layout(req, "AI Configuration", "ai-settings", body));
});

app.post("/settings/ai", requirePermission(PERMISSIONS.AI_EDIT), (req, res) => {
  const body = req.body || {};
  const business = businesses.getBusinessConfig(BUSINESS_ID);

  try {
    const chosenProvider = body.provider || business.ai_provider;
    const providerMeta = SUPPORTED_PROVIDERS.find((p) => p.id === chosenProvider);
    const resolvedModel =
      body.model && (!providerMeta || providerMeta.models.includes(body.model))
        ? body.model
        : providerMeta
          ? providerMeta.defaultModel
          : business.ai_model;

    businesses.updateBusinessConfig(
      BUSINESS_ID,
      {
        ai_disclosure: body.ai_disclosure,
        ai_local_only: body.ai_local_only === "1",
        ai_operator_role: body.ai_operator_role || "owner",
        ai_temperature: Number(body.ai_temperature ?? 0.4),
        ai_max_tokens: Number(body.ai_max_tokens ?? 500),
      },
      req.user.username
    );

    if (body.apiKey) {
      db.prepare("UPDATE businesses SET ai_api_key_encrypted = ? WHERE id = ?").run(
        encrypt(body.apiKey),
        BUSINESS_ID
      );
    }
    db.prepare("UPDATE businesses SET ai_provider = ?, ai_model = ? WHERE id = ?").run(
      chosenProvider || "",
      resolvedModel || "",
      BUSINESS_ID
    );

    logAudit(BUSINESS_ID, req.user.username, "ai_settings.updated", {
      provider: chosenProvider,
      model: resolvedModel,
      key_changed: Boolean(body.apiKey),
    });
    res.redirect("/settings/ai?saved=1");
  } catch (err) {
    res.status(500).send(
      layout(req, "AI Configuration", "ai-settings", `<div class="card"><h2>AI Configuration</h2><p class="error-note">Couldn't save: ${e(err.message)}</p></div>`)
    );
  }
});

app.post("/settings/ai/tool/:name", requirePermission(PERMISSIONS.AI_EDIT), (req, res) => {
  const body = req.body || {};
  setToolPermission(
    BUSINESS_ID,
    req.params.name,
    {
      enabled: body.enabled !== undefined ? body.enabled === "1" : undefined,
      requiresApproval: body.requiresApproval !== undefined ? body.requiresApproval === "1" : undefined,
    },
    req.user.username
  );
  res.redirect("/settings/ai");
});

// ---------- knowledge base ----------

app.get("/knowledge", requirePermission(PERMISSIONS.KNOWLEDGE_VIEW), (req, res) => {
  const docs = knowledge.listDocuments(BUSINESS_ID);
  const rows = docs
    .map(
      (d) => `<tr>
        <td>${e(d.title)}</td>
        <td>${e(d.category)}</td>
        <td>${statusPill(d.status)}</td>
        <td>${e(d.source || "—")}</td>
        <td>v${d.version}</td>
        <td>${e(d.updated_at)}</td>
      </tr>`
    )
    .join("");

  const results = req.query.q
    ? knowledge
        .search(BUSINESS_ID, req.query.q, { limit: 10 })
        .map(
          (r) =>
            `<tr><td>${e(r.title)}</td><td>${e(r.chunk.slice(0, 200))}</td><td>${r.score.toFixed(2)}</td><td>${e(r.source || "—")}</td></tr>`
        )
        .join("")
    : "";

  const body = `
    <div class="card">
      <h2>Knowledge base</h2>
      <p class="card-sub">Searchable, versioned business information. The assistant answers only from what is here (and from the catalogue) and cites the source.</p>
      <form method="GET" action="/knowledge" style="display:flex; gap:10px; align-items:flex-end; margin-bottom:14px;">
        <div style="flex:1;"><label>Search the knowledge base</label><input type="text" name="q" value="${e(req.query.q || "")}" /></div>
        <button type="submit" class="secondary" style="margin-top:0;">Search</button>
      </form>
      ${
        req.query.q
          ? `<table><thead><tr><th>Document</th><th>Match</th><th>Score</th><th>Source</th></tr></thead><tbody>${results || emptyRow(4, "No matches.")}</tbody></table>`
          : ""
      }
    </div>

    <div class="card">
      <h2>Documents</h2>
      <table>
        <thead><tr><th>Title</th><th>Category</th><th>Status</th><th>Source</th><th>Version</th><th>Updated</th></tr></thead>
        <tbody>${rows || emptyRow(6, "No documents yet.")}</tbody>
      </table>
    </div>

    ${
      can(req.user, PERMISSIONS.KNOWLEDGE_EDIT)
        ? `<div class="card">
      <h2>Add or update a document</h2>
      <form method="POST" action="/knowledge">
        <div class="grid-2">
          <div><label>Title</label><input type="text" name="title" required /></div>
          <div><label>Category</label><input type="text" name="category" value="general" /></div>
        </div>
        <label>Content</label>
        <textarea name="content" required style="min-height:180px;"></textarea>
        <div class="grid-2">
          <div><label>Source</label><input type="text" name="source" placeholder="e.g. price list 2026" /></div>
          <div><label>Status</label><select name="status"><option value="published">Published</option><option value="draft">Draft</option></select></div>
        </div>
        <button type="submit">Save document</button>
        ${req.query.saved ? '<p class="save-note">Saved and reindexed.</p>' : ""}
      </form>
    </div>`
        : ""
    }
  `;
  res.send(layout(req, "Knowledge Base", "knowledge", body));
});

app.post("/knowledge", requirePermission(PERMISSIONS.KNOWLEDGE_EDIT), (req, res) => {
  const body = req.body || {};
  knowledge.upsertDocument(
    BUSINESS_ID,
    { title: body.title, content: body.content, category: body.category, source: body.source, status: body.status },
    req.user.username
  );
  res.redirect("/knowledge?saved=1");
});

// ---------- integrations ----------

// The bot control API is loopback-only and is not reachable from the
// browser, so the console reads the WhatsApp state through this process.
// The QR code WhatsApp issues expires after about a minute, which is why
// the page polls instead of rendering it once and hoping.
async function whatsappState() {
  try {
    const r = await fetch(`${BOT_CONTROL_URL}/qr`);
    const data = await r.json();
    return { status: data.status, qrDataUrl: data.qrDataUrl || null };
  } catch {
    return { status: "offline", qrDataUrl: null };
  }
}

app.get(
  "/integrations/whatsapp/status",
  requirePermission(PERMISSIONS.INTEGRATIONS_VIEW),
  async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await whatsappState());
  }
);

app.get("/integrations", requirePermission(PERMISSIONS.INTEGRATIONS_VIEW), async (req, res) => {
  const business = businesses.getBusinessConfig(BUSINESS_ID);

  const { status, qrDataUrl } = await whatsappState();

  const webhookRows = getWebhooks(BUSINESS_ID)
    .map(
      (w) =>
        `<tr><td style="word-break:break-all;">${e(w.url)}</td><td>${e((w.events || []).join(", "))}</td><td>${e(w.created_at)}</td>
         <td><form method="POST" action="/integrations/webhooks/${w.id}/delete" style="display:inline;"><button type="submit" class="secondary small">Remove</button></form></td></tr>`
    )
    .join("");

  const deliveryRows = getWebhookDeliveries(BUSINESS_ID, 30)
    .map(
      (d) =>
        `<tr><td>${e(d.created_at)}</td><td>${e(d.event)}</td><td>${e(d.success ? "delivered" : "failed")}</td><td>${d.response_status ?? "—"}</td><td>${d.attempt}</td></tr>`
    )
    .join("");

  const body = `
    <div class="card">
      <h2>WhatsApp connection</h2>
      <p>Status: <span id="wa-status">${statusPill(status === "connected" ? "connected" : status === "waiting_for_qr" ? "waiting" : "disconnected")}</span></p>
      <div id="wa-qr-box" style="background:#fff; border:1px solid var(--border); border-radius:8px; padding:18px; display:${status === "waiting_for_qr" && qrDataUrl ? "inline-block" : "none"};">
        <img id="qr-image" src="${qrDataUrl ? e(qrDataUrl) : ""}" alt="WhatsApp QR code" width="260" height="260" style="display:block;" />
      </div>
      <p class="muted" id="wa-hint">${
        status === "waiting_for_qr"
          ? "Scan this code with WhatsApp on your phone: Settings → Linked devices → Link a device. The code is replaced automatically when it expires."
          : status === "connected"
            ? "The assistant is connected and answering messages."
            : "Waiting for the bot to produce a QR code…"
      }</p>
      <form method="POST" action="/integrations/whatsapp/logout" onsubmit="return confirm('Log out the connected WhatsApp account?');">
        <button type="submit" class="danger">Log out WhatsApp</button>
      </form>
    </div>

    <script nonce="${e(req.cspNonce || "")}">
      (function () {
        var img = document.getElementById("qr-image");
        var box = document.getElementById("wa-qr-box");
        var hint = document.getElementById("wa-hint");
        var statusEl = document.getElementById("wa-status");
        var current = img ? img.getAttribute("src") : "";
        var timer = null;

        function label(status) {
          var text = status === "connected" ? "connected" : status === "waiting_for_qr" ? "waiting" : "disconnected";
          statusEl.textContent = text;
          statusEl.className = "pill " + text;
        }

        async function refresh() {
          try {
            var res = await fetch("/integrations/whatsapp/status", { headers: { Accept: "application/json" } });
            if (!res.ok) return;
            var data = await res.json();
            label(data.status);
            if (data.status === "connected") {
              box.style.display = "none";
              hint.textContent = "The assistant is connected and answering messages.";
              if (timer) clearInterval(timer);
              return;
            }
            if (data.status === "waiting_for_qr" && data.qrDataUrl) {
              if (data.qrDataUrl !== current) {
                current = data.qrDataUrl;
                img.src = current;
              }
              box.style.display = "inline-block";
              hint.textContent =
                "Scan this code with WhatsApp on your phone: Settings → Linked devices → Link a device. The code is replaced automatically when it expires.";
              return;
            }
            box.style.display = "none";
            hint.textContent = "Waiting for the bot to produce a QR code…";
          } catch (err) {
            hint.textContent = "Cannot reach the bot right now. Is the application still running?";
          }
        }

        refresh();
        timer = setInterval(refresh, 5000);
      })();
    </script>

    <div class="card">
      <h2>Payment providers</h2>
      <p class="card-sub">Keys are encrypted at rest with AES-256-GCM and are never displayed in full again.</p>
      <form method="POST" action="/integrations/payments">
        <div class="grid-2">
          <div><label>Stripe secret key</label><input type="password" name="stripeSecretKey" placeholder="sk_live_… (leave blank to keep)" autocomplete="off" /></div>
          <div><label>Stripe webhook signing secret</label><input type="password" name="stripeWebhookSecret" placeholder="whsec_… (leave blank to keep)" autocomplete="off" /></div>
        </div>
        <div class="grid-2">
          <div><label>eSewa / Khalti merchant code</label><input type="text" name="paymentKeyId" value="${e(business.payment_gateway_key_id || "")}" /></div>
          <div><label>eSewa / Khalti secret key</label><input type="password" name="paymentSecret" placeholder="leave blank to keep" autocomplete="off" /></div>
        </div>
        <label>Default provider</label>
        <select name="npr_payment_method">
          <option value="">None</option>
          ${["stripe", "esewa", "khalti", "cash_on_delivery", "bank_transfer"].map((p) => `<option value="${p}" ${business.npr_payment_method === p ? "selected" : ""}>${e(p)}</option>`).join("")}
        </select>
        <button type="submit">Save payment settings</button>
        ${req.query.saved ? '<p class="save-note">Saved.</p>' : ""}
      </form>
      <p class="muted" style="margin-top:16px;">Webhook endpoint for Stripe: <code>http://YOUR-HOST:${BOT_CONTROL_PORT}/webhooks/stripe</code></p>
    </div>

    <div class="card">
      <h2>Outgoing webhooks</h2>
      <table>
        <thead><tr><th>URL</th><th>Events</th><th>Added</th><th></th></tr></thead>
        <tbody>${webhookRows || emptyRow(4, "No webhooks yet.")}</tbody>
      </table>
      <form method="POST" action="/integrations/webhooks">
        <label>Endpoint URL</label>
        <input type="text" name="url" required placeholder="https://your-server.com/webhook" />
        <label>Secret <span class="muted">(leave blank to auto-generate)</span></label>
        <input type="text" name="secret" />
        <label>Events</label>
        ${["lead.captured", "order.paid", "escalation.triggered", "order.confirmed"]
          .map((ev) => `<label style="display:flex; align-items:center; gap:8px; font-weight:400; margin-top:8px;"><input type="checkbox" name="events" value="${ev}" style="width:auto; margin:0;" /> ${e(ev)}</label>`)
          .join("")}
        <button type="submit">Add webhook</button>
        ${req.query.created ? `<p class="save-note">Webhook added. Secret: <code>${e(req.query.created)}</code> — copy it now.</p>` : ""}
      </form>
    </div>

    <div class="card">
      <h2>Recent webhook deliveries</h2>
      <table>
        <thead><tr><th>When</th><th>Event</th><th>Result</th><th>HTTP</th><th>Attempt</th></tr></thead>
        <tbody>${deliveryRows || emptyRow(5, "No deliveries yet.")}</tbody>
      </table>
    </div>
  `;
  res.send(layout(req, "Integrations", "integrations", body));
});

app.post("/integrations/payments", requirePermission(PERMISSIONS.INTEGRATIONS_EDIT), (req, res) => {
  const body = req.body || {};
  const business = businesses.getBusinessConfig(BUSINESS_ID);

  const sets = [];
  const params = [];
  if (body.stripeSecretKey) {
    sets.push("stripe_secret_key_encrypted = ?");
    params.push(encrypt(body.stripeSecretKey));
  }
  if (body.stripeWebhookSecret) {
    sets.push("stripe_webhook_secret_encrypted = ?");
    params.push(encrypt(body.stripeWebhookSecret));
  }
  if (body.paymentSecret) {
    sets.push("payment_gateway_secret_encrypted = ?");
    params.push(encrypt(body.paymentSecret));
  }
  if (body.paymentKeyId !== undefined) {
    sets.push("payment_gateway_key_id = ?");
    params.push(body.paymentKeyId);
  }
  if (body.npr_payment_method !== undefined) {
    sets.push("npr_payment_method = ?");
    params.push(body.npr_payment_method);
  }
  if (sets.length > 0) {
    params.push(BUSINESS_ID);
    db.prepare(`UPDATE businesses SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  logAudit(BUSINESS_ID, req.user.username, "payment_settings.updated", { provider: body.npr_payment_method });
  res.redirect("/integrations?saved=1");
});

app.post("/integrations/webhooks", requirePermission(PERMISSIONS.INTEGRATIONS_EDIT), (req, res) => {
  const url = (req.body?.url || "").trim();
  if (!url) return res.redirect("/integrations");
  const secret = (req.body?.secret || "").trim() || crypto.randomBytes(24).toString("hex");
  const events = Array.isArray(req.body?.events) ? req.body.events : req.body?.events ? [req.body.events] : [];
  createWebhook(BUSINESS_ID, { url, secret, events });
  logAudit(BUSINESS_ID, req.user.username, "webhook.created", { url, events });
  res.redirect(`/integrations?created=${encodeURIComponent(secret)}`);
});

app.post("/integrations/webhooks/:id/delete", requirePermission(PERMISSIONS.INTEGRATIONS_EDIT), (req, res) => {
  deleteWebhook(BUSINESS_ID, Number(req.params.id));
  res.redirect("/integrations");
});

app.post("/integrations/whatsapp/logout", requirePermission(PERMISSIONS.INTEGRATIONS_EDIT), async (req, res) => {
  try {
    await fetch(`${BOT_CONTROL_URL}/logout`, { method: "POST" });
  } catch {
    /* the bot process may not be running */
  }
  logAudit(BUSINESS_ID, req.user.username, "whatsapp.logged_out", "");
  res.redirect("/integrations");
});

// ---------- team ----------

app.get("/team", requirePermission(PERMISSIONS.TEAM_VIEW), (req, res) => {
  const users = listUsers(BUSINESS_ID);
  const rows = users
    .map(
      (u) => `<tr>
        <td>${e(u.username)}</td>
        <td>${e(u.role)}</td>
        <td>${e(u.created_at)}</td>
        <td>${
          u.username !== req.user.username
            ? `<form method="POST" action="/team/${encodeURIComponent(u.username)}/delete" onsubmit="return confirm('Remove ${e(u.username)}?');" style="display:inline;"><button type="submit" class="secondary small">Remove</button></form>`
            : '<span class="muted">You</span>'
        }</td>
      </tr>`
    )
    .join("");

  const body = `
    <div class="card">
      <h2>Team</h2>
      <p class="card-sub">
        <strong>Owner</strong> has everything. <strong>Manager</strong>, <strong>Staff</strong>, <strong>Accountant</strong> and
        <strong>Viewer</strong> are role bundles; each account can also carry extra permissions. Permissions are enforced on the server for every request.
      </p>
      <table>
        <thead><tr><th>Username</th><th>Role</th><th>Added</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    ${
      can(req.user, PERMISSIONS.TEAM_EDIT)
        ? `<div class="card">
      <h2>Add a team member</h2>
      <form method="POST" action="/team">
        <div class="grid-2">
          <div><label>Username</label><input type="text" name="username" required /></div>
          <div><label>Temporary password</label><input type="password" name="password" required minlength="8" /></div>
        </div>
        <label>Role</label>
        <select name="role">
          ${["staff", "manager", "accountant", "viewer", "owner"].map((r) => `<option value="${r}">${e(r)}</option>`).join("")}
        </select>
        <button type="submit">Add team member</button>
        ${req.query.error ? `<p class="error-note">${e(req.query.error)}</p>` : ""}
      </form>
    </div>`
        : ""
    }
  `;
  res.send(layout(req, "Team & Permissions", "team", body));
});

app.post("/team", requirePermission(PERMISSIONS.TEAM_EDIT), (req, res) => {
  const username = (req.body?.username || "").trim();
  const password = req.body?.password || "";
  const role = ["staff", "manager", "accountant", "viewer", "owner"].includes(req.body?.role)
    ? req.body.role
    : "staff";

  if (!username || password.length < 8) {
    return res.redirect("/team?error=" + encodeURIComponent("Username required and password must be at least 8 characters."));
  }
  if (getUser(BUSINESS_ID, username)) {
    return res.redirect("/team?error=" + encodeURIComponent("That username is already taken."));
  }

  createUser(BUSINESS_ID, { username, password, role }, req.user.username);
  logAudit(BUSINESS_ID, req.user.username, "team.member_added", { username, role });
  res.redirect("/team");
});

app.post("/team/:username/delete", requirePermission(PERMISSIONS.TEAM_EDIT), (req, res) => {
  const target = req.params.username;
  if (target === req.user.username) {
    return res.redirect("/team?error=" + encodeURIComponent("You can't remove your own account."));
  }
  const targetUser = getUser(BUSINESS_ID, target);
  if (targetUser?.role === "owner" && countOwners(BUSINESS_ID) <= 1) {
    return res.redirect("/team?error=" + encodeURIComponent("Can't remove the last owner account."));
  }
  deleteUser(BUSINESS_ID, target, req.user.username);
  logAudit(BUSINESS_ID, req.user.username, "team.member_removed", { username: target });
  res.redirect("/team");
});

// ---------- audit log ----------

app.get("/audit-log", requirePermission(PERMISSIONS.AUDIT_VIEW), (req, res) => {
  const entries = getAuditLog(BUSINESS_ID, 300);
  const rows = entries
    .map(
      (entry) => `<tr>
        <td>${e(entry.created_at)}</td>
        <td>${e(entry.actor)}</td>
        <td>${e(entry.action)}</td>
        <td>${e(entry.severity || "info")}</td>
        <td style="max-width:420px; word-break:break-word;">${e(entry.details)}</td>
      </tr>`
    )
    .join("");

  const body = `
    <div class="card">
      <h2>Security &amp; audit logs</h2>
      <p class="card-sub">Every privileged action, with who did it and when. Secret-looking values are redacted before they are written.</p>
      <table>
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Severity</th><th>Details</th></tr></thead>
        <tbody>${rows || emptyRow(5, "No actions logged yet.")}</tbody>
      </table>
    </div>
  `;
  res.send(layout(req, "Security & Audit Logs", "audit-log", body));
});

// ---------- settings & backups ----------

app.get("/settings", requirePermission(PERMISSIONS.SETTINGS_VIEW), (req, res) => {
  const business = businesses.getBusinessConfig(BUSINESS_ID);
  const templates = industry.listTemplates();
  const modules = businesses.listModules(BUSINESS_ID);
  const backupList = backups.listBackups();

  const templateOptions = templates
    .map(
      (t) =>
        `<option value="${e(t.key)}" ${business.industry_template === t.key ? "selected" : ""}>${e(t.name)} — ${e(t.description)}</option>`
    )
    .join("");

  const moduleRows = modules
    .map(
      (m) => `<tr>
        <td>${e(m.module_key)}</td>
        <td>${m.enabled ? "Enabled" : "Disabled"}</td>
        <td>
          <form method="POST" action="/settings/modules" style="display:inline;">
            <input type="hidden" name="moduleKey" value="${e(m.module_key)}" />
            <input type="hidden" name="enabled" value="${m.enabled ? "0" : "1"}" />
            <button type="submit" class="secondary small">${m.enabled ? "Disable" : "Enable"}</button>
          </form>
        </td>
      </tr>`
    )
    .join("");

  const backupRows = backupList
    .map(
      (b) => `<tr>
        <td>${e(b.name)}</td>
        <td>${e(b.createdAt)}</td>
        <td>${(b.bytes / 1024).toFixed(0)} KB</td>
        <td>${b.encrypted ? "Encrypted" : "Plain"}</td>
        <td>
          <form method="POST" action="/settings/backups/${encodeURIComponent(b.name)}/restore" onsubmit="return confirm('Restore this backup? The current database will be replaced and the app must be restarted.');" style="display:inline;">
            <button type="submit" class="danger small">Restore</button>
          </form>
        </td>
      </tr>`
    )
    .join("");

  const body = `
    <div class="card">
      <h2>Company profile</h2>
      <form method="POST" action="/settings">
        <div class="grid-2">
          <div><label>Business name</label><input type="text" name="name" value="${e(business.name)}" /></div>
          <div><label>Language / locale</label><input type="text" name="locale" value="${e(business.locale || "en")}" /></div>
        </div>
        <div class="grid-3">
          <div><label>Currency</label><input type="text" name="currency" value="${e(business.currency || "NPR")}" /></div>
          <div><label>Country</label><input type="text" name="country" value="${e(business.country || "NP")}" /></div>
          <div><label>Timezone</label><input type="text" name="timezone" value="${e(business.timezone || "Asia/Kathmandu")}" /></div>
        </div>
        <label>Industry template</label>
        <select name="industry_template">
          <option value="">Keep current</option>
          ${templateOptions}
        </select>
        <p class="muted" style="margin-top:6px;">Applying a template enables its modules and fields. Existing records are never deleted.</p>

        <hr class="divider" />
        <h3 style="margin:0 0 4px; font-size:1rem;">Pricing &amp; tax</h3>
        <div class="grid-3">
          <div><label>Tax enabled</label><select name="tax_enabled"><option value="0" ${!business.tax_enabled ? "selected" : ""}>No</option><option value="1" ${business.tax_enabled ? "selected" : ""}>Yes</option></select></div>
          <div><label>Tax rate</label><input type="number" step="0.01" name="tax_rate" value="${e(String(business.tax_rate ?? 0))}" /></div>
          <div><label>Tax inclusive in prices</label><select name="tax_inclusive"><option value="0" ${!business.tax_inclusive ? "selected" : ""}>No</option><option value="1" ${business.tax_inclusive ? "selected" : ""}>Yes</option></select></div>
        </div>
        <div class="grid-2">
          <div><label>Delivery fee</label><input type="number" step="0.01" name="delivery_fee" value="${e(String(business.delivery_fee ?? 0))}" /></div>
          <div><label>Free delivery above</label><input type="number" step="0.01" name="delivery_free_above" value="${e(String(business.delivery_free_above ?? 0))}" /></div>
        </div>
        <label>Require customer confirmation before an order is created</label>
        <select name="requires_order_confirmation"><option value="1" ${business.requires_order_confirmation ? "selected" : ""}>Yes — always ask</option><option value="0" ${!business.requires_order_confirmation ? "selected" : ""}>No</option></select>

        <hr class="divider" />
        <h3 style="margin:0 0 4px; font-size:1rem;">Assistant behaviour</h3>
        <label>Escalation message</label>
        <textarea name="escalation_message">${e(business.escalation_message)}</textarea>
        <label>Escalation keywords <span class="muted">(comma separated)</span></label>
        <textarea name="escalation_keywords">${e((business.escalation_keywords || []).join(", "))}</textarea>
        <label>Away message</label>
        <textarea name="away_message">${e(business.away_message)}</textarea>
        <label>System instructions (what the assistant is told)</label>
        <textarea name="system_prompt_extra" style="min-height:140px;">${e(business.system_prompt_extra)}</textarea>

        <button type="submit">Save settings</button>
        ${req.query.saved ? '<p class="save-note">Saved.</p>' : ""}
      </form>
    </div>

    <div class="card">
      <h2>Knowledge base (company profile)</h2>
      <p class="card-sub">These key/value entries are what the assistant may tell customers. For full documents with search, use the <a class="link" href="/knowledge">Knowledge Base</a> page.</p>
      <table>
        <tbody>
          ${Object.entries(business.knowledge_base || {})
            .map(([k, v]) => `<tr><td>${e(k.replace(/_/g, " "))}</td><td>${e(String(v).slice(0, 220))}</td></tr>`)
            .join("") || '<tr><td colspan="2" class="muted">No entries yet.</td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>Modules</h2>
      <p class="card-sub">Turn individual areas of ChatCloser on or off for this workspace.</p>
      <table>
        <thead><tr><th>Module</th><th>State</th><th></th></tr></thead>
        <tbody>${moduleRows || emptyRow(3, "No modules configured yet — apply an industry template to enable them.")}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Backups</h2>
      <p class="card-sub">A backup is a consistent snapshot of the database, encrypted with your ENCRYPTION_KEY. Restoring replaces the live database — restart the application afterwards.</p>
      <form method="POST" action="/settings/backups">
        <button type="submit">Create a backup now</button>
      </form>
      <table style="margin-top:14px;">
        <thead><tr><th>Name</th><th>Created</th><th>Size</th><th>Encryption</th><th></th></tr></thead>
        <tbody>${backupRows || emptyRow(5, "No backups yet.")}</tbody>
      </table>
    </div>
  `;
  res.send(layout(req, "Settings & Backups", "settings", body));
});

app.post("/settings", requirePermission(PERMISSIONS.SETTINGS_EDIT), (req, res) => {
  const body = req.body || {};

  businesses.updateBusinessConfig(
    BUSINESS_ID,
    {
      name: body.name,
      locale: body.locale,
      currency: body.currency,
      country: body.country,
      timezone: body.timezone,
      industry_template: body.industry_template || undefined,
      tax_enabled: body.tax_enabled === "1",
      tax_rate: Number(body.tax_rate || 0),
      tax_inclusive: body.tax_inclusive === "1",
      delivery_fee: Number(body.delivery_fee || 0),
      delivery_free_above: Number(body.delivery_free_above || 0),
      requires_order_confirmation: body.requires_order_confirmation === "1",
      escalation_message: body.escalation_message,
      escalation_keywords: String(body.escalation_keywords || "")
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
      away_message: body.away_message,
      system_prompt_extra: body.system_prompt_extra,
    },
    req.user.username
  );

  if (body.industry_template) {
    industry.applyTemplate(BUSINESS_ID, body.industry_template, req.user.username);
  }

  logAudit(BUSINESS_ID, req.user.username, "business.settings_updated", { name: body.name });
  res.redirect("/settings?saved=1");
});

app.post("/settings/modules", requirePermission(PERMISSIONS.SETTINGS_EDIT), (req, res) => {
  businesses.setModuleEnabled(
    BUSINESS_ID,
    req.body?.moduleKey,
    req.body?.enabled === "1",
    req.user.username
  );
  res.redirect("/settings");
});

app.post("/settings/backups", requirePermission(PERMISSIONS.BACKUPS_MANAGE), (req, res) => {
  backups.backupDatabase({ businessId: BUSINESS_ID, actor: req.user.username });
  res.redirect("/settings?saved=1");
});

app.post("/settings/backups/:name/restore", requirePermission(PERMISSIONS.BACKUPS_MANAGE), (req, res) => {
  backups.restoreBackup(req.params.name, { businessId: BUSINESS_ID, actor: req.user.username });
  res.redirect("/settings?saved=1");
});

// ---------- account ----------

app.get("/account", (req, res) => {
  const body = `
    <div class="card">
      <h2>Account</h2>
      <p class="card-sub">Signed in as <strong>${e(req.user.username)}</strong> (${e(req.user.role)}).</p>
      <form method="POST" action="/account/password">
        <label>Current password</label>
        <input type="password" name="currentPassword" required autocomplete="current-password" />
        <label>New password</label>
        <input type="password" name="newPassword" required minlength="8" autocomplete="new-password" />
        <button type="submit">Update password</button>
      </form>
      ${req.query.updated ? '<p class="save-note">Password updated.</p>' : ""}
      ${req.query.error ? '<p class="error-note">Current password is incorrect.</p>' : ""}
    </div>
  `;
  res.send(layout(req, "Account", "account", body));
});

app.post("/account/password", (req, res) => {
  const user = getUser(BUSINESS_ID, req.user.username);
  if (!user || !verifyPassword(String(req.body?.currentPassword || ""), user.password_hash)) {
    return res.redirect("/account?error=1");
  }
  setUserPassword(BUSINESS_ID, req.user.username, String(req.body?.newPassword || ""), req.user.username);
  logAudit(BUSINESS_ID, req.user.username, "account.password_changed", "");
  res.redirect("/account?updated=1");
});

// ---------- root & errors ----------

app.get("/", (req, res) => res.redirect("/overview"));

app.use((req, res) => {
  res.status(404).send(layout(req, "Not found", "", `<div class="card"><h2>Not found</h2><p><a class="link" href="/overview">&larr; Back to the dashboard</a></p></div>`));
});

app.use((err, req, res, _next) => {
  console.error("Request failed:", err);
  const message = err.expose ? err.message : "Something went wrong.";
  if (req.path.startsWith("/api/")) {
    return res.status(err.status || 500).json({ error: message });
  }
  res.status(err.status || 500).send(
    layout(req, "Error", "", `<div class="card"><h2>Something went wrong</h2><p class="error-note">${e(message)}</p><p><a class="link" href="/overview">&larr; Back to the dashboard</a></p></div>`)
  );
});

if (process.env.CHATCLOSER_NO_LISTEN !== "1") {
  const host = config.dashboardHost;
  app.listen(PORT, host, () => {
    const shown = host === "0.0.0.0" ? "localhost" : host;
    console.log(`Admin panel running at http://${shown}:${PORT}`);
  });
}

export default app;
