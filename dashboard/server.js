// dashboard/server.js
// The full admin panel: real username/password login (sessions, hashed
// passwords), a sidebar layout with a live Overview page, Leads,
// Conversations, a Company Profile tab any business can fully configure
// through the UI (no code editing, no seed.js required), AI Settings
// (bring-your-own provider + key), and WhatsApp connection management.

import "dotenv/config";
import express from "express";
import session from "express-session";
import {
  getBusiness,
  upsertBusiness,
  updateAISettings,
  updateStripeSettings,
  ensureBusiness,
  getLeads,
  updateLeadStatus,
  getLeadStats,
  getConversationCount,
  getAllChatIds,
  getConversation,
  countUsers,
  countOwners,
  getUserByUsername,
  getAllUsers,
  createUser,
  updateUserPassword,
  deleteUser,
  getPriceList,
  upsertPriceItem,
  deletePriceItem,
  getOrders,
  getWebhooks,
  createWebhook,
  deleteWebhook,
  getWebhookDeliveries,
  logAudit,
  getAuditLog,
  getConversionRate,
  getAverageResponseSeconds,
} from "../db.js";
import crypto from "crypto";
import { encrypt, decrypt, maskKey, hashPassword, verifyPassword } from "../crypto-utils.js";
import { getProvider, SUPPORTED_PROVIDERS } from "../providers/index.js";

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3001;
const BUSINESS_ID = Number(process.env.BUSINESS_ID || 1);
const BOT_CONTROL_PORT = process.env.BOT_CONTROL_PORT || 3002;
const BOT_CONTROL_URL = `http://localhost:${BOT_CONTROL_PORT}`;

// A business row always exists from the moment the dashboard starts, so a
// new company can configure everything from the Company Profile tab
// without ever touching seed.js.
ensureBusiness(BUSINESS_ID, process.env.BUSINESS_NAME || "Your Company Name");

// Bootstrap the first admin account from .env, once, as the owner role.
// After this, the account lives in the database (with a hashed password)
// and .env values are no longer read for login — change the password
// from the Account tab, and add staff accounts from the Team tab.
if (countUsers() === 0) {
  const bootstrapUser = process.env.ADMIN_USERNAME || "admin";
  const bootstrapPass = process.env.ADMIN_PASSWORD || "changeme";
  createUser(bootstrapUser, hashPassword(bootstrapPass), "owner");
  console.log(`Created initial owner account "${bootstrapUser}" from .env. Change the password from the Account tab after logging in.`);
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-session-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 12 }, // 12 hours
  })
);

function requireAuth(req, res, next) {
  if (req.session && req.session.username) return next();
  return res.redirect("/login");
}

// Staff accounts can view leads/conversations/orders and work leads, but
// can't touch anything that costs money, exposes secrets, or affects
// other accounts — those routes require the owner role.
function requireOwner(req, res, next) {
  if (req.session && req.session.role === "owner") return next();
  return res.status(403).send(
    authLayout(
      "Access restricted",
      `<h1>Owner access required</h1><p class="sub">This section is restricted to owner accounts. Ask your business owner for access, or <a href="/overview">go back to the dashboard</a>.</p>`
    )
  );
}

// Turns an array of objects into a CSV string. Simple and dependency-free
// — good enough for exporting leads/orders, not a general CSV library.
function toCsv(rows, columns) {
  const escape = (val) => {
    const str = val === null || val === undefined ? "" : String(val);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const header = columns.map((c) => escape(c.label)).join(",");
  const lines = rows.map((row) => columns.map((c) => escape(row[c.key])).join(","));
  return [header, ...lines].join("\r\n");
}

// ---------- Shared visual shell: ivory & black, sidebar layout ----------

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
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
    margin: 0;
    background: var(--ivory);
    color: var(--black);
    -webkit-font-smoothing: antialiased;
  }
  .serif { font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif; }
`;

function layout(title, activeTab, body, opts = {}) {
  const business = getBusiness(BUSINESS_ID);
  const businessName = business?.name || "Your Company";

  const navItems = [
    { id: "overview", label: "Overview", href: "/overview", icon: "◈" },
    { id: "leads", label: "Leads", href: "/leads", icon: "◆" },
    { id: "conversations", label: "Conversations", href: "/conversations", icon: "☰" },
    { id: "company-profile", label: "Company Profile", href: "/company-profile", icon: "✎", ownerOnly: true },
    { id: "sales", label: "Sales & Pricing", href: "/sales", icon: "$", ownerOnly: true },
    { id: "orders", label: "Orders", href: "/orders", icon: "▤" },
    { id: "webhooks", label: "Webhooks", href: "/webhooks", icon: "⇄", ownerOnly: true },
    { id: "ai-settings", label: "AI Settings", href: "/settings/ai", icon: "✦", ownerOnly: true },
    { id: "payments", label: "Payments", href: "/settings/payments", icon: "◐", ownerOnly: true },
    { id: "whatsapp", label: "WhatsApp", href: "/settings/whatsapp", icon: "◎", ownerOnly: true },
    { id: "audit-log", label: "Audit Log", href: "/audit-log", icon: "≡", ownerOnly: true },
    { id: "team", label: "Team", href: "/team", icon: "◫", ownerOnly: true },
    { id: "account", label: "Account", href: "/account", icon: "●" },
  ];

  const isOwner = opts.role === "owner";
  const nav = navItems
    .filter((t) => !t.ownerOnly || isOwner)
    .map(
      (t) => `
      <a href="${t.href}" class="nav-item ${t.id === activeTab ? "active" : ""}">
        <span class="nav-icon">${t.icon}</span>${t.label}
      </a>`
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <title>${title} — ${businessName} Admin</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    ${BASE_STYLES}
    .app { display: flex; min-height: 100vh; }
    .sidebar {
      width: 250px; flex-shrink: 0; background: var(--black); color: var(--ivory);
      display: flex; flex-direction: column; position: sticky; top: 0; height: 100vh;
    }
    .brand { padding: 26px 24px 20px; border-bottom: 1px solid #2E2A22; }
    .brand-name { font-size: 1.05rem; font-weight: 600; letter-spacing: 0.02em; }
    .brand-sub { font-size: 0.72rem; color: var(--gold-soft); text-transform: uppercase; letter-spacing: 0.08em; margin-top: 4px; }
    nav.nav-list { padding: 14px 10px; flex: 1; }
    .nav-item {
      display: flex; align-items: center; gap: 12px; padding: 11px 14px; margin-bottom: 2px;
      color: #B9B3A0; text-decoration: none; font-size: 0.88rem; border-radius: 6px;
      transition: background 0.12s;
    }
    .nav-icon { font-size: 0.9rem; width: 16px; text-align: center; color: var(--gold-soft); }
    .nav-item:hover { background: #201D17; color: var(--ivory); }
    .nav-item.active { background: rgba(168, 133, 59, 0.18); color: var(--ivory); font-weight: 600; }
    .sidebar-footer { padding: 16px 24px 22px; border-top: 1px solid #2E2A22; font-size: 0.78rem; color: #8A8474; }
    .sidebar-footer a { color: var(--gold-soft); text-decoration: none; }
    .main { flex: 1; min-width: 0; }
    .topbar {
      background: #fff; border-bottom: 1px solid var(--border); padding: 18px 36px;
      display: flex; justify-content: space-between; align-items: center;
    }
    .topbar h1 { margin: 0; font-size: 1.15rem; font-weight: 600; }
    .topbar .meta { font-size: 0.82rem; color: #8A8474; }
    .content { padding: 32px 36px 60px; max-width: 1080px; }
    .card {
      background: #fff; border: 1px solid var(--border); border-radius: 8px;
      padding: 26px 28px; margin-bottom: 22px; box-shadow: 0 1px 3px rgba(21,19,14,0.04);
    }
    .card h2 {
      margin: 0 0 6px; font-size: 1.15rem; font-weight: 600; color: var(--black);
    }
    .card .card-sub { color: #8A8474; font-size: 0.85rem; margin: 0 0 20px; }
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 22px; }
    .stat-card {
      background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 20px 22px;
      box-shadow: 0 1px 3px rgba(21,19,14,0.04);
    }
    .stat-card .stat-value { font-size: 2rem; font-weight: 700; color: var(--black); line-height: 1; }
    .stat-card .stat-label { font-size: 0.78rem; color: #8A8474; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 8px; }
    .stat-card.accent .stat-value { color: var(--gold); }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 12px 10px; border-bottom: 1px solid var(--border); font-size: 0.87rem; }
    th { font-weight: 600; text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.05em; color: #8A8474; }
    tr:last-child td { border-bottom: none; }
    a.link { color: var(--gold); text-decoration: none; font-weight: 600; }
    a.link:hover { text-decoration: underline; }
    .status-form select { padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); font-family: inherit; }
    .bubble { max-width: 70%; padding: 10px 14px; border-radius: 10px; margin-bottom: 10px; font-size: 0.9rem; line-height: 1.45; }
    .bubble.user { background: var(--ivory-deep); margin-right: auto; border: 1px solid var(--border); border-bottom-left-radius: 2px; }
    .bubble.assistant { background: var(--black); color: var(--ivory); margin-left: auto; border-bottom-right-radius: 2px; }
    .msg-time { font-size: 0.7rem; opacity: 0.55; margin-top: 4px; }
    label { display: block; font-weight: 600; margin-top: 18px; font-size: 0.84rem; color: var(--black-soft); }
    input[type=text], input[type=password], textarea, select {
      width: 100%; padding: 10px 12px; margin-top: 6px; border: 1px solid var(--border);
      border-radius: 6px; box-sizing: border-box; font-family: inherit; font-size: 0.9rem; background: var(--ivory);
    }
    input:focus, textarea:focus, select:focus { outline: none; border-color: var(--gold); box-shadow: 0 0 0 3px rgba(168,133,59,0.12); }
    textarea { min-height: 64px; resize: vertical; }
    button, .btn {
      margin-top: 22px; padding: 11px 22px; background: var(--black); color: var(--ivory);
      border: 1px solid var(--black); border-radius: 6px; cursor: pointer; font-size: 0.85rem;
      letter-spacing: 0.02em; font-family: inherit; font-weight: 600;
    }
    button:hover, .btn:hover { background: var(--black-soft); }
    button.secondary { background: transparent; color: var(--black); border: 1px solid var(--border); }
    button.secondary:hover { background: var(--ivory-deep); }
    button.danger { background: var(--danger); border-color: var(--danger); }
    button.danger:hover { background: var(--danger-soft); }
    button.small { padding: 6px 12px; margin-top: 6px; font-size: 0.78rem; }
    .chat-list a { display: block; padding: 13px 14px; border-bottom: 1px solid var(--border); text-decoration: none; color: var(--black); font-size: 0.88rem; }
    .chat-list a:hover { background: var(--ivory-deep); }
    .save-note { color: var(--success); font-size: 0.85rem; margin-top: 12px; font-weight: 600; }
    .error-note { color: var(--danger); font-size: 0.85rem; margin-top: 12px; font-weight: 600; }
    .pill { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; }
    .pill.connected { background: #E4EFE6; color: var(--success); }
    .pill.disconnected { background: #F4E4E4; color: var(--danger); }
    .pill.waiting { background: #FBF0D9; color: var(--gold); }
    .pill.new { background: #FBF0D9; color: var(--gold); }
    .pill.contacted { background: #E1EAF7; color: #2E4E8B; }
    .pill.booked { background: #E4EFE6; color: var(--success); }
    .pill.closed { background: #ECEAE4; color: #6E6A5C; }
    .muted { color: #8A8474; font-size: 0.85rem; }
    .key-display { font-family: "SF Mono", "Courier New", monospace; background: var(--ivory-deep); padding: 11px 13px; border-radius: 6px; margin-top: 6px; font-size: 0.85rem; border: 1px solid var(--border); }
    .field-row { display: flex; gap: 10px; align-items: flex-start; }
    .field-row .field-inputs { flex: 1; }
    .field-row button.small { margin-top: 6px; }
    .divider { border: none; border-top: 1px solid var(--border); margin: 24px 0; }
    #test-result, #logout-result { margin-top: 14px; font-size: 0.87rem; font-weight: 600; }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-name">${businessName}</div>
        <div class="brand-sub">Admin Panel</div>
      </div>
      <nav class="nav-list">${nav}</nav>
      <div class="sidebar-footer">
        Signed in as <strong style="color:var(--ivory)">${opts.username || ""}</strong> <span style="color:var(--gold-soft); text-transform:capitalize;">(${opts.role || ""})</span><br>
        <a href="/logout">Sign out</a>
      </div>
    </aside>
    <div class="main">
      <div class="topbar">
        <h1>${title}</h1>
        <span class="meta">${new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</span>
      </div>
      <div class="content">${body}</div>
    </div>
  </div>
</body>
</html>`;
}

function authLayout(title, body) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>${title}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    ${BASE_STYLES}
    body { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .auth-card {
      background: #fff; border: 1px solid #E2DAC8; border-radius: 10px; padding: 40px 38px;
      width: 100%; max-width: 380px; box-shadow: 0 4px 24px rgba(21,19,14,0.08);
      border-top: 4px solid var(--gold);
    }
    .auth-card h1 { margin: 0 0 6px; font-size: 1.3rem; font-weight: 700; }
    .auth-card p.sub { margin: 0 0 26px; color: #8A8474; font-size: 0.88rem; }
    label { display: block; font-weight: 600; margin-top: 16px; font-size: 0.84rem; color: #2A2721; }
    input[type=text], input[type=password] {
      width: 100%; padding: 11px 12px; margin-top: 6px; border: 1px solid #E2DAC8;
      border-radius: 6px; box-sizing: border-box; font-family: inherit; font-size: 0.92rem; background: #FAF7F0;
    }
    input:focus { outline: none; border-color: var(--gold); box-shadow: 0 0 0 3px rgba(168,133,59,0.12); }
    button {
      width: 100%; margin-top: 24px; padding: 12px; background: #15130E; color: #FAF7F0;
      border: none; border-radius: 6px; cursor: pointer; font-size: 0.9rem; font-weight: 600;
    }
    button:hover { background: #2A2721; }
    .error-note { color: #8B2E2E; font-size: 0.85rem; margin-top: 14px; font-weight: 600; }
    .save-note { color: #2E5E3E; font-size: 0.85rem; margin-top: 14px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="auth-card">${body}</div>
</body>
</html>`;
}

// ---------- Auth: login / logout ----------

app.get("/login", (req, res) => {
  const body = `
    <h1>Admin Panel</h1>
    <p class="sub">Sign in to manage your AI WhatsApp assistant.</p>
    <form method="POST" action="/login">
      <label>Username</label>
      <input type="text" name="username" required autofocus />
      <label>Password</label>
      <input type="password" name="password" required />
      <button type="submit">Sign In</button>
    </form>
    ${req.query.error ? '<p class="error-note">Incorrect username or password.</p>' : ""}
    ${req.query.changed ? '<p class="save-note">Password updated. Please sign in again.</p>' : ""}
  `;
  res.send(authLayout("Sign In", body));
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const user = getUserByUsername(username);
  if (user && verifyPassword(password, user.password_hash)) {
    req.session.username = user.username;
    req.session.role = user.role;
    logAudit(BUSINESS_ID, user.username, "auth.login_success", "");
    return res.redirect("/overview");
  }
  logAudit(BUSINESS_ID, username || "unknown", "auth.login_failed", "");
  res.redirect("/login?error=1");
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// Everything below requires a signed-in session.
app.use(requireAuth);

// ---------- Overview ----------

app.get("/overview", (req, res) => {
  const business = getBusiness(BUSINESS_ID);
  const stats = getLeadStats(BUSINESS_ID);
  const conversationCount = getConversationCount(BUSINESS_ID);
  const hasAI = Boolean(business.ai_api_key_encrypted && business.ai_provider);
  const conversionRate = getConversionRate(BUSINESS_ID);
  const avgResponseSeconds = getAverageResponseSeconds(BUSINESS_ID);

  const formatDuration = (seconds) => {
    if (seconds === null) return "—";
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remSeconds = seconds % 60;
    return `${minutes}m ${remSeconds}s`;
  };

  const body = `
    <div class="stat-grid">
      <div class="stat-card accent"><div class="stat-value">${stats.new}</div><div class="stat-label">New Leads</div></div>
      <div class="stat-card"><div class="stat-value">${stats.total}</div><div class="stat-label">Total Leads</div></div>
      <div class="stat-card"><div class="stat-value">${conversationCount}</div><div class="stat-label">Conversations</div></div>
      <div class="stat-card"><div class="stat-value">${hasAI ? "✓" : "—"}</div><div class="stat-label">AI Configured</div></div>
      <div class="stat-card"><div class="stat-value">${conversionRate}%</div><div class="stat-label">Conversion Rate</div></div>
      <div class="stat-card"><div class="stat-value">${formatDuration(avgResponseSeconds)}</div><div class="stat-label">Avg. Response Time</div></div>
    </div>
    <p class="muted" style="margin-top:-14px; margin-bottom:22px;">Conversion rate = leads reaching "booked" or "closed" status &divide; total leads.</p>

    <div class="card">
      <h2>Getting started</h2>
      <p class="card-sub">Set these up in order to go live.</p>
      <table>
        <tr><td>1. Company Profile</td><td>${business.name !== "Your Company Name" ? "✓ Done" : "Not started"}</td><td><a class="link" href="/company-profile">Edit &rarr;</a></td></tr>
        <tr><td>2. AI Settings</td><td>${hasAI ? "✓ Done" : "Not started"}</td><td><a class="link" href="/settings/ai">Edit &rarr;</a></td></tr>
        <tr><td>3. WhatsApp Connection</td><td>Check status</td><td><a class="link" href="/settings/whatsapp">View &rarr;</a></td></tr>
      </table>
    </div>

    <div class="card">
      <h2>Recent leads</h2>
      <p class="card-sub">Your five most recent captures.</p>
      <table>
        <thead><tr><th>Received</th><th>Name</th><th>Interested in</th><th>Status</th></tr></thead>
        <tbody>
          ${getLeads(BUSINESS_ID).slice(0, 5).map((l) => `
            <tr>
              <td>${l.created_at}</td>
              <td>${l.customer_name || "—"}</td>
              <td>${l.service_requested || "—"}</td>
              <td><span class="pill ${l.status}">${l.status}</span></td>
            </tr>`).join("") || '<tr><td colspan="4" class="muted">No leads yet.</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
  res.send(layout("Overview", "overview", body, { username: req.session.username, role: req.session.role }));
});

// ---------- Leads ----------

app.get("/leads", (req, res) => {
  const leads = getLeads(BUSINESS_ID);
  const rows = leads
    .map(
      (lead) => `
    <tr>
      <td>${lead.created_at}</td>
      <td>${lead.customer_name || "—"}</td>
      <td>${lead.service_requested || "—"}</td>
      <td>${lead.location || "—"}</td>
      <td>${lead.urgency || "—"}</td>
      <td>
        <form class="status-form" method="POST" action="/leads/${lead.id}/status">
          <select name="status" onchange="this.form.submit()">
            ${["new", "contacted", "booked", "closed"]
              .map((s) => `<option value="${s}" ${s === lead.status ? "selected" : ""}>${s}</option>`)
              .join("")}
          </select>
        </form>
      </td>
      <td><a class="link" href="/conversations/${encodeURIComponent(lead.chat_id)}">View chat</a></td>
    </tr>`
    )
    .join("");

  const body = `
    <div class="card">
      <h2>Leads</h2>
      <p class="card-sub">Every lead captured by the assistant, most recent first. &nbsp;<a class="link" href="/leads/export.csv">Export CSV &darr;</a></p>
      <table>
        <thead><tr><th>Received</th><th>Name</th><th>Service</th><th>Location</th><th>Urgency</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="muted">No leads yet.</td></tr>'}</tbody>
      </table>
    </div>`;
  res.send(layout("Leads", "leads", body, { username: req.session.username, role: req.session.role }));
});

app.get("/leads/export.csv", (req, res) => {
  const leads = getLeads(BUSINESS_ID);
  const csv = toCsv(leads, [
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

app.post("/leads/:id/status", (req, res) => {
  updateLeadStatus(BUSINESS_ID, Number(req.params.id), req.body.status);
  res.redirect("/leads");
});

// ---------- Conversations ----------

app.get("/conversations", (req, res) => {
  const chatIds = getAllChatIds(BUSINESS_ID);
  const items = chatIds
    .map((id) => `<a href="/conversations/${encodeURIComponent(id)}">${id}</a>`)
    .join("");

  const body = `
    <div class="card">
      <h2>Conversations</h2>
      <p class="card-sub">Every customer who has messaged this WhatsApp number.</p>
      <div class="chat-list">${items || '<p class="muted">No conversations yet.</p>'}</div>
    </div>`;
  res.send(layout("Conversations", "conversations", body, { username: req.session.username, role: req.session.role }));
});

app.get("/conversations/:chatId", (req, res) => {
  const chatId = req.params.chatId;
  const messages = getConversation(BUSINESS_ID, chatId);
  const bubbles = messages
    .map((m) => `<div class="bubble ${m.role}">${m.content}<div class="msg-time">${m.created_at}</div></div>`)
    .join("");

  const body = `
    <div class="card">
      <p><a class="link" href="/conversations">&larr; All conversations</a></p>
      <h2>${chatId}</h2>
      ${bubbles || '<p class="muted">No messages.</p>'}
    </div>`;
  res.send(layout("Conversation", "conversations", body, { username: req.session.username, role: req.session.role }));
});

// ---------- Company Profile (fully customizable by any business) ----------

app.get("/company-profile", requireOwner, (req, res) => {
  const business = getBusiness(BUSINESS_ID);
  const kbEntries = Object.entries(business.knowledge_base);

  const kbFields = kbEntries
    .map(
      ([key, value]) => `
    <div class="field-row">
      <div class="field-inputs">
        <label>${key.replace(/_/g, " ")}</label>
        <textarea name="kb_${key}">${value}</textarea>
      </div>
      <label style="visibility:hidden;">.</label>
      <label style="display:flex; align-items:center; gap:6px; font-weight:400; white-space:nowrap;">
        <input type="checkbox" name="remove_${key}" style="width:auto; margin:0;" /> Remove
      </label>
    </div>`
    )
    .join("");

  const body = `
    <div class="card">
      <h2>Company Profile</h2>
      <p class="card-sub">This is what your AI assistant knows about your business. Any business can fill this in from scratch — nothing here requires touching code.</p>
      <form method="POST" action="/company-profile">
        <label>Business name</label>
        <input type="text" name="name" value="${business.name}" />

        <hr class="divider" />

        <label>Escalation message <span class="muted">(sent when a complaint/safety/dispute keyword is matched)</span></label>
        <textarea name="escalation_message">${business.escalation_message}</textarea>

        <label>Away message <span class="muted">(outside business hours)</span></label>
        <textarea name="away_message">${business.away_message}</textarea>

        <label>Escalation keywords <span class="muted">(comma-separated)</span></label>
        <textarea name="escalation_keywords">${business.escalation_keywords.join(", ")}</textarea>

        <hr class="divider" />
        <h3 style="margin:0 0 4px; font-size:1rem;">Knowledge base</h3>
        <p class="muted" style="margin:0 0 14px;">Whatever you write here is exactly what the AI is allowed to tell customers — hours, services, prices, policies, anything relevant.</p>
        ${kbFields}

        <div class="field-row" style="margin-top:20px; padding-top:20px; border-top: 1px dashed var(--border);">
          <div class="field-inputs">
            <label>Add a new field — name</label>
            <input type="text" name="new_field_key" placeholder="e.g. payment_terms" />
          </div>
          <div class="field-inputs">
            <label>Value</label>
            <textarea name="new_field_value" placeholder="e.g. 50% deposit, balance on completion"></textarea>
          </div>
        </div>

        <button type="submit">Save Company Profile</button>
      </form>
      ${req.query.saved ? '<p class="save-note">Saved. Changes apply to the assistant immediately — no restart needed.</p>' : ""}
    </div>`;
  res.send(layout("Company Profile", "company-profile", body, { username: req.session.username, role: req.session.role }));
});

app.post("/company-profile", requireOwner, (req, res) => {
  const business = getBusiness(BUSINESS_ID);
  const knowledge_base = {};

  for (const [key, value] of Object.entries(req.body)) {
    if (key.startsWith("kb_")) {
      const fieldKey = key.slice(3);
      if (req.body[`remove_${fieldKey}`] === "on") continue; // skip fields marked for removal
      knowledge_base[fieldKey] = value;
    }
  }

  const newKey = (req.body.new_field_key || "").trim().toLowerCase().replace(/\s+/g, "_");
  if (newKey && req.body.new_field_value) {
    knowledge_base[newKey] = req.body.new_field_value;
  }

  upsertBusiness(BUSINESS_ID, {
    name: req.body.name,
    system_prompt_extra: business.system_prompt_extra,
    knowledge_base,
    escalation_keywords: req.body.escalation_keywords.split(",").map((k) => k.trim()).filter(Boolean),
    escalation_message: req.body.escalation_message,
    away_message: req.body.away_message,
  });
  logAudit(BUSINESS_ID, req.session.username, "company_profile.updated", { name: req.body.name });

  res.redirect("/company-profile?saved=1");
});

// ---------- Sales & Pricing (the fixed price list the AI is allowed to sell from) ----------

app.get("/sales", requireOwner, (req, res) => {
  const items = getPriceList(BUSINESS_ID);

  const rows = items
    .map(
      (item) => `
    <tr>
      <td>${item.item_name}</td>
      <td>${item.price_amount} ${item.currency}</td>
      <td>${item.description || "—"}</td>
      <td>
        <form method="POST" action="/sales/${item.id}/delete" onsubmit="return confirm('Remove this item? The AI will no longer be able to sell it.');" style="display:inline;">
          <button type="submit" class="secondary small">Remove</button>
        </form>
      </td>
    </tr>`
    )
    .join("");

  const body = `
    <div class="card">
      <h2>Sales &amp; Pricing</h2>
      <p class="card-sub">This is the <strong>only</strong> price list your AI assistant is allowed to quote or sell from — it can never invent a price or discount. When a customer agrees to buy, the assistant generates a real payment link automatically.</p>
      <table>
        <thead><tr><th>Item</th><th>Price</th><th>Description</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="muted">No items yet — add one below.</td></tr>'}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Add an item</h2>
      <form method="POST" action="/sales">
        <label>Item name</label>
        <input type="text" name="item_name" required placeholder="e.g. Bathroom remodel — standard package" />
        <div style="display:flex; gap:14px;">
          <div style="flex:1;">
            <label>Price</label>
            <input type="text" name="price_amount" required placeholder="e.g. 3000" />
          </div>
          <div style="flex:1;">
            <label>Currency</label>
            <input type="text" name="currency" value="USD" placeholder="USD" />
          </div>
        </div>
        <label>Description <span class="muted">(optional, shown to the AI for context)</span></label>
        <textarea name="description" placeholder="What's included, timeframe, etc."></textarea>
        <button type="submit">Add Item</button>
      </form>
      ${req.query.saved ? '<p class="save-note">Saved.</p>' : ""}
    </div>`;
  res.send(layout("Sales & Pricing", "sales", body, { username: req.session.username, role: req.session.role }));
});

app.post("/sales", requireOwner, (req, res) => {
  const amount = parseFloat(req.body.price_amount);
  if (!req.body.item_name || Number.isNaN(amount)) {
    return res.redirect("/sales");
  }
  upsertPriceItem(BUSINESS_ID, {
    item_name: req.body.item_name,
    price_amount: amount,
    currency: req.body.currency || "USD",
    description: req.body.description || "",
  });
  logAudit(BUSINESS_ID, req.session.username, "price_item.saved", { item_name: req.body.item_name, price_amount: amount });
  res.redirect("/sales?saved=1");
});

app.post("/sales/:id/delete", requireOwner, (req, res) => {
  deletePriceItem(BUSINESS_ID, Number(req.params.id));
  res.redirect("/sales");
});

// ---------- Orders (payment status — driven only by verified Stripe events) ----------

app.get("/orders", (req, res) => {
  const orders = getOrders(BUSINESS_ID);
  const rows = orders
    .map(
      (o) => `
    <tr>
      <td>${o.created_at}</td>
      <td>${o.item_name}</td>
      <td>${o.amount} ${o.currency}</td>
      <td><span class="pill ${o.payment_status === "paid" ? "connected" : o.payment_status === "pending" ? "waiting" : "disconnected"}">${o.payment_status}</span></td>
      <td><a class="link" href="/conversations/${encodeURIComponent(o.chat_id)}">View chat</a></td>
    </tr>`
    )
    .join("");

  const body = `
    <div class="card">
      <h2>Orders</h2>
      <p class="card-sub">Every payment link the assistant has generated. Status only ever changes to "paid" once Stripe confirms a real payment — never based on the conversation text alone. &nbsp;<a class="link" href="/orders/export.csv">Export CSV &darr;</a></p>
      <table>
        <thead><tr><th>Created</th><th>Item</th><th>Amount</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="muted">No orders yet.</td></tr>'}</tbody>
      </table>
    </div>`;
  res.send(layout("Orders", "orders", body, { username: req.session.username, role: req.session.role }));
});

app.get("/orders/export.csv", (req, res) => {
  const orders = getOrders(BUSINESS_ID);
  const csv = toCsv(orders, [
    { key: "created_at", label: "Created" },
    { key: "item_name", label: "Item" },
    { key: "amount", label: "Amount" },
    { key: "currency", label: "Currency" },
    { key: "payment_status", label: "Status" },
    { key: "chat_id", label: "Chat ID" },
    { key: "stripe_checkout_session_id", label: "Stripe Session ID" },
  ]);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

// ---------- Webhooks (outbound notifications to your own systems) ----------

const WEBHOOK_EVENTS = [
  { id: "lead.captured", label: "Lead captured" },
  { id: "order.paid", label: "Order paid" },
  { id: "escalation.triggered", label: "Escalated to human" },
];

app.get("/webhooks", requireOwner, (req, res) => {
  const webhooks = getWebhooks(BUSINESS_ID);

  const rows = webhooks
    .map(
      (w) => `
    <tr>
      <td style="word-break:break-all;">${w.url}</td>
      <td>${w.events.join(", ") || "—"}</td>
      <td>${w.created_at}</td>
      <td>
        <form method="POST" action="/webhooks/${w.id}/delete" onsubmit="return confirm('Remove this webhook?');" style="display:inline;">
          <button type="submit" class="secondary small">Remove</button>
        </form>
      </td>
    </tr>`
    )
    .join("");

  const eventCheckboxes = WEBHOOK_EVENTS
    .map(
      (e) => `
    <label style="display:flex; align-items:center; gap:8px; font-weight:400; margin-top:10px;">
      <input type="checkbox" name="events" value="${e.id}" style="width:auto; margin:0;" /> ${e.label}
    </label>`
    )
    .join("");

  const deliveries = getWebhookDeliveries(BUSINESS_ID, 50);
  const deliveryRows = deliveries
    .map(
      (d) => `
    <tr>
      <td>${d.created_at}</td>
      <td>${d.event}</td>
      <td style="word-break:break-all;">${d.url}</td>
      <td><span class="pill ${d.success ? "connected" : "disconnected"}">${d.success ? "delivered" : "failed"}</span></td>
      <td>${d.response_status ?? "—"}</td>
      <td>${d.attempt}</td>
    </tr>`
    )
    .join("");

  const body = `
    <div class="card">
      <h2>Webhooks</h2>
      <p class="card-sub">Notify your own systems (a CRM, Zapier, Slack, a custom endpoint) when something happens. Every delivery is signed with your webhook's secret via the <code>X-Webhook-Signature</code> header (HMAC-SHA256) so you can verify it really came from here.</p>
      <table>
        <thead><tr><th>URL</th><th>Events</th><th>Added</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="muted">No webhooks yet.</td></tr>'}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Add a webhook</h2>
      <form method="POST" action="/webhooks">
        <label>Endpoint URL</label>
        <input type="text" name="url" required placeholder="https://your-server.com/webhook" />
        <label>Secret <span class="muted">(leave blank to auto-generate one)</span></label>
        <input type="text" name="secret" placeholder="Used to sign every delivery" />
        <label>Events to notify on</label>
        ${eventCheckboxes}
        <button type="submit">Add Webhook</button>
      </form>
      ${req.query.created ? `<p class="save-note">Webhook added. Secret: <code>${req.query.created}</code> — copy this now, it won't be shown again in full.</p>` : ""}
    </div>

    <div class="card">
      <h2>Recent deliveries</h2>
      <p class="card-sub">Last 50 delivery attempts, including automatic retries. A failed delivery is retried once after 30 seconds, then logged as attempt #2.</p>
      <table>
        <thead><tr><th>When</th><th>Event</th><th>URL</th><th>Result</th><th>HTTP Status</th><th>Attempt</th></tr></thead>
        <tbody>${deliveryRows || '<tr><td colspan="6" class="muted">No deliveries yet.</td></tr>'}</tbody>
      </table>
    </div>`;
  res.send(layout("Webhooks", "webhooks", body, { username: req.session.username, role: req.session.role }));
});

app.post("/webhooks", requireOwner, (req, res) => {
  const url = (req.body.url || "").trim();
  if (!url) return res.redirect("/webhooks");

  const secret = (req.body.secret || "").trim() || crypto.randomBytes(24).toString("hex");
  const events = Array.isArray(req.body.events) ? req.body.events : (req.body.events ? [req.body.events] : []);

  createWebhook(BUSINESS_ID, { url, secret, events });
  logAudit(BUSINESS_ID, req.session.username, "webhook.created", { url, events });

  res.redirect(`/webhooks?created=${encodeURIComponent(secret)}`);
});

app.post("/webhooks/:id/delete", requireOwner, (req, res) => {
  deleteWebhook(BUSINESS_ID, Number(req.params.id));
  logAudit(BUSINESS_ID, req.session.username, "webhook.deleted", { id: req.params.id });
  res.redirect("/webhooks");
});

// ---------- Audit Log ----------

app.get("/audit-log", requireOwner, (req, res) => {
  const entries = getAuditLog(BUSINESS_ID, 200);

  const rows = entries
    .map(
      (e) => `
    <tr>
      <td>${e.created_at}</td>
      <td>${e.actor}</td>
      <td>${e.action}</td>
      <td style="max-width:400px; word-break:break-word;">${e.details}</td>
    </tr>`
    )
    .join("");

  const body = `
    <div class="card">
      <h2>Audit Log</h2>
      <p class="card-sub">Who changed what, and when — the last 200 admin actions on this business.</p>
      <table>
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="muted">No actions logged yet.</td></tr>'}</tbody>
      </table>
    </div>`;
  res.send(layout("Audit Log", "audit-log", body, { username: req.session.username, role: req.session.role }));
});

// ---------- AI Settings ----------

app.get("/settings/ai", requireOwner, (req, res) => {
  const business = getBusiness(BUSINESS_ID);
  const currentProvider = business.ai_provider || "";
  const currentModel = business.ai_model || "";

  let currentKeyDisplay = "No API key added yet.";
  if (business.ai_api_key_encrypted) {
    try {
      currentKeyDisplay = maskKey(decrypt(business.ai_api_key_encrypted));
    } catch {
      currentKeyDisplay = "Stored (unable to preview — check ENCRYPTION_KEY hasn't changed).";
    }
  }

  const providerOptions = SUPPORTED_PROVIDERS
    .map((p) => `<option value="${p.id}" ${p.id === currentProvider ? "selected" : ""}>${p.label}</option>`)
    .join("");

  const modelDatalist = SUPPORTED_PROVIDERS
    .flatMap((p) => p.models)
    .map((m) => `<option value="${m}">`)
    .join("");

  // Fed to client-side JS so the model field can auto-sync to whichever
  // provider is selected — this is what prevents "provider says Google
  // but model field still says claude-sonnet-4-6" mismatches. Also
  // carries each provider's free-tier note for the info box below.
  const providerModelMap = JSON.stringify(
    Object.fromEntries(SUPPORTED_PROVIDERS.map((p) => [
      p.id,
      { defaultModel: p.defaultModel, models: p.models, freeTier: p.freeTier, freeTierNote: p.freeTierNote || "" },
    ]))
  );

  const freeProviders = SUPPORTED_PROVIDERS.filter((p) => p.freeTier);

  const body = `
    <div class="card">
      <h2>AI Settings</h2>
      <p class="card-sub">Choose any supported AI provider and paste in your own API key. It's encrypted before storage and used only for this business's replies. Saving applies immediately.</p>

      <label>Current key</label>
      <div class="key-display">${currentKeyDisplay}${currentProvider ? ` &nbsp;·&nbsp; provider: ${currentProvider} &nbsp;·&nbsp; model: ${currentModel || "(default)"}` : ""}</div>

      <form method="POST" action="/settings/ai" id="ai-form">
        <label for="provider">AI Provider</label>
        <select name="provider" id="provider">
          <option value="">Choose a provider…</option>
          ${providerOptions}
        </select>
        <div id="free-tier-note" class="muted" style="margin-top:8px;"></div>

        <label for="model">Model</label>
        <input list="model-list" type="text" name="model" id="model" value="${currentModel}" placeholder="Auto-fills when you pick a provider" />
        <datalist id="model-list">${modelDatalist}</datalist>
        <p class="muted" style="margin-top:6px;">Switching provider automatically updates this to a known-good model for that provider. Only change it if you specifically want a different model.</p>

        <label for="apiKey">API Key <span class="muted">(leave blank to keep the current key — you can still Test Connection below without re-entering it)</span></label>
        <input type="password" name="apiKey" id="apiKey" placeholder="Paste your API key" autocomplete="off" />

        <button type="button" class="secondary" id="test-btn">Test Connection</button>
        <div id="test-result"></div>

        <button type="submit">Save Settings</button>
      </form>
    </div>

    <div class="card">
      <h2>Don't want to pay for an API key?</h2>
      <p class="card-sub">These providers offer genuinely free access — no credit card needed to get an API key:</p>
      <table>
        <thead><tr><th>Provider</th><th>Free tier</th></tr></thead>
        <tbody>
          ${freeProviders.map((p) => `<tr><td>${p.label.split(" — ")[0].split(" (")[0]}</td><td>${p.freeTierNote}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>
    ${req.query.saved ? '<p class="save-note">Saved.</p>' : ""}

    <script>
      const PROVIDER_MODELS = ${providerModelMap};
      const providerSelect = document.getElementById("provider");
      const modelInput = document.getElementById("model");
      const freeTierNoteEl = document.getElementById("free-tier-note");
      let lastAutoFilledModel = ${JSON.stringify(currentModel)};

      function updateFreeTierNote() {
        const meta = PROVIDER_MODELS[providerSelect.value];
        freeTierNoteEl.textContent = meta && meta.freeTier ? "✓ " + meta.freeTierNote : "";
      }
      updateFreeTierNote();

      providerSelect.addEventListener("change", () => {
        const meta = PROVIDER_MODELS[providerSelect.value];
        if (!meta) return;
        // Only auto-overwrite if the field is empty or still holds a value
        // we auto-filled earlier — never clobber something the person typed themselves.
        if (!modelInput.value || modelInput.value === lastAutoFilledModel) {
          modelInput.value = meta.defaultModel;
          lastAutoFilledModel = meta.defaultModel;
        }
        updateFreeTierNote();
      });

      document.getElementById("test-btn").addEventListener("click", async () => {
        const provider = providerSelect.value;
        const model = modelInput.value;
        const apiKey = document.getElementById("apiKey").value;
        const resultEl = document.getElementById("test-result");

        if (!provider) {
          resultEl.textContent = "Choose a provider first.";
          resultEl.style.color = "#8B2E2E";
          return;
        }

        resultEl.textContent = "Testing…";
        resultEl.style.color = "#8A8474";

        try {
          const res = await fetch("/settings/ai/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider, model, apiKey }),
          });
          const data = await res.json();
          resultEl.textContent = data.ok
            ? "✓ Connection successful (model: " + data.modelUsed + (apiKey ? "" : ", using your saved key") + ")."
            : "✗ " + data.error;
          resultEl.style.color = data.ok ? "#2E5E3E" : "#8B2E2E";
        } catch (err) {
          resultEl.textContent = "✗ Request failed: " + err.message;
          resultEl.style.color = "#8B2E2E";
        }
      });
    </script>`;
  res.send(layout("AI Settings", "ai-settings", body, { username: req.session.username, role: req.session.role }));
});

app.post("/settings/ai/test", async (req, res) => {
  const { provider, model } = req.body;
  let apiKey = req.body.apiKey;

  try {
    if (!provider) throw new Error("Choose a provider first.");

    const providerMeta = SUPPORTED_PROVIDERS.find((p) => p.id === provider);
    if (!providerMeta) throw new Error(`Unknown provider "${provider}".`);

    // No key typed in? Fall back to the already-saved key for this
    // provider, so you can verify a saved setup without re-pasting it.
    if (!apiKey) {
      const business = getBusiness(BUSINESS_ID);
      if (business.ai_provider === provider && business.ai_api_key_encrypted) {
        apiKey = decrypt(business.ai_api_key_encrypted);
      } else {
        throw new Error("No saved key for this provider yet — enter an API key to test it.");
      }
    }

    // Resolve blank/mismatched model against the provider's own known
    // list rather than trusting an empty or stale value.
    const resolvedModel = model && providerMeta.models.includes(model)
      ? model
      : (model || providerMeta.defaultModel);

    const providerModule = getProvider(provider);
    await providerModule.testConnection({ apiKey, model: resolvedModel });
    res.json({ ok: true, modelUsed: resolvedModel });
  } catch (err) {
    res.json({ ok: false, error: err.message || "Connection failed." });
  }
});

app.post("/settings/ai", requireOwner, (req, res) => {
  const { provider, model, apiKey } = req.body;
  const business = getBusiness(BUSINESS_ID);

  try {
    const chosenProvider = provider || business.ai_provider;
    const providerMeta = SUPPORTED_PROVIDERS.find((p) => p.id === chosenProvider);

    // Always resolve to a real, known model for the chosen provider —
    // never save an empty model or one left over from a different
    // provider. This is the fix for the class of bug where the model
    // field silently didn't match the selected provider.
    const resolvedModel = model && (!providerMeta || providerMeta.models.includes(model))
      ? model
      : (providerMeta ? providerMeta.defaultModel : business.ai_model);

    const encryptedKey = apiKey ? encrypt(apiKey) : business.ai_api_key_encrypted;

    updateAISettings(BUSINESS_ID, {
      provider: chosenProvider,
      model: resolvedModel,
      encryptedKey,
    });
    logAudit(BUSINESS_ID, req.session.username, "ai_settings.updated", {
      provider: chosenProvider, model: resolvedModel, key_changed: Boolean(apiKey),
    });
    res.redirect("/settings/ai?saved=1");
  } catch (err) {
    res.status(500).send(
      layout(
        "AI Settings", "ai-settings",
        `<div class="card"><h2>AI Settings</h2><p class="error-note">Couldn't save: ${err.message}</p><p><a class="link" href="/settings/ai">&larr; Back</a></p></div>`,
        { username: req.session.username, role: req.session.role }
      )
    );
  }
});

// ---------- Payments (Stripe, bring-your-own keys) ----------

app.get("/settings/payments", requireOwner, (req, res) => {
  const business = getBusiness(BUSINESS_ID);

  let secretKeyDisplay = "No Stripe secret key added yet.";
  if (business.stripe_secret_key_encrypted) {
    try {
      secretKeyDisplay = maskKey(decrypt(business.stripe_secret_key_encrypted));
    } catch {
      secretKeyDisplay = "Stored (unable to preview).";
    }
  }
  let webhookSecretDisplay = "No webhook signing secret added yet.";
  if (business.stripe_webhook_secret_encrypted) {
    try {
      webhookSecretDisplay = maskKey(decrypt(business.stripe_webhook_secret_encrypted));
    } catch {
      webhookSecretDisplay = "Stored (unable to preview).";
    }
  }

  const body = `
    <div class="card">
      <h2>Payments</h2>
      <p class="card-sub">Connect your own Stripe account so the assistant can generate real payment links and confirm sales automatically. Your keys are encrypted before storage.</p>

      <label>Current secret key</label>
      <div class="key-display">${secretKeyDisplay}</div>
      <label>Current webhook signing secret</label>
      <div class="key-display">${webhookSecretDisplay}</div>

      <form method="POST" action="/settings/payments">
        <label>Stripe secret key <span class="muted">(starts with sk_ — leave blank to keep current)</span></label>
        <input type="password" name="stripeSecretKey" placeholder="sk_live_… or sk_test_…" autocomplete="off" />

        <label>Stripe webhook signing secret <span class="muted">(starts with whsec_ — leave blank to keep current)</span></label>
        <input type="password" name="stripeWebhookSecret" placeholder="whsec_…" autocomplete="off" />

        <button type="submit">Save Payment Settings</button>
      </form>
      ${req.query.saved ? '<p class="save-note">Saved.</p>' : ""}
    </div>

    <div class="card">
      <h2>Webhook setup</h2>
      <p class="card-sub">In your Stripe Dashboard, add a webhook endpoint pointing to this bot process, listening for the <code>checkout.session.completed</code> event:</p>
      <div class="key-display">http://YOUR-SERVER-ADDRESS:${process.env.BOT_CONTROL_PORT || 3002}/webhooks/stripe</div>
      <p class="muted" style="margin-top:14px;">Stripe needs to reach this URL over the internet — <code>localhost</code> only works if you're testing with the <a class="link" href="https://stripe.com/docs/stripe-cli" target="_blank" rel="noopener">Stripe CLI</a> (<code>stripe listen --forward-to localhost:${process.env.BOT_CONTROL_PORT || 3002}/webhooks/stripe</code>) or a tunnel like ngrok. Copy the signing secret Stripe gives you into the field above.</p>
    </div>`;
  res.send(layout("Payments", "payments", body, { username: req.session.username, role: req.session.role }));
});

app.post("/settings/payments", requireOwner, (req, res) => {
  const { stripeSecretKey, stripeWebhookSecret } = req.body;
  const business = getBusiness(BUSINESS_ID);

  try {
    const secretKeyEncrypted = stripeSecretKey ? encrypt(stripeSecretKey) : business.stripe_secret_key_encrypted;
    const webhookSecretEncrypted = stripeWebhookSecret ? encrypt(stripeWebhookSecret) : business.stripe_webhook_secret_encrypted;

    updateStripeSettings(BUSINESS_ID, { secretKeyEncrypted, webhookSecretEncrypted });
    logAudit(BUSINESS_ID, req.session.username, "payment_settings.updated", {
      secret_key_changed: Boolean(stripeSecretKey), webhook_secret_changed: Boolean(stripeWebhookSecret),
    });
    res.redirect("/settings/payments?saved=1");
  } catch (err) {
    res.status(500).send(
      layout(
        "Payments", "payments",
        `<div class="card"><h2>Payments</h2><p class="error-note">Couldn't save: ${err.message}</p><p><a class="link" href="/settings/payments">&larr; Back</a></p></div>`,
        { username: req.session.username, role: req.session.role }
      )
    );
  }
});

// ---------- WhatsApp connection (status + logout) ----------

app.get("/settings/whatsapp", requireOwner, async (req, res) => {
  let status = "unknown";
  let qrDataUrl = null;
  let fetchError = null;
  try {
    const r = await fetch(`${BOT_CONTROL_URL}/qr`);
    const data = await r.json();
    status = data.status;
    qrDataUrl = data.qrDataUrl;
  } catch (err) {
    fetchError = "Couldn't reach the bot process. Make sure it's running (npm start).";
  }

  const pillClass = status === "connected" ? "connected" : status === "waiting_for_qr" ? "waiting" : "disconnected";
  const pillLabel = status === "connected" ? "Connected" : status === "waiting_for_qr" ? "Waiting for QR scan" : status === "disconnected" ? "Disconnected" : "Unknown";

  const body = `
    <div class="card">
      <h2>WhatsApp Connection</h2>
      <p>Status: <span class="pill ${pillClass}" id="status-pill">${pillLabel}</span></p>
      ${fetchError ? `<p class="error-note">${fetchError}</p>` : ""}

      <div id="qr-section" style="${status === "waiting_for_qr" ? "" : "display:none;"}">
        <p class="card-sub">Scan this with WhatsApp: <strong>Settings &gt; Linked Devices &gt; Link a Device</strong>.</p>
        <div style="background:#fff; border:1px solid var(--border); border-radius:8px; padding:20px; display:inline-block;">
          <img id="qr-image" src="${qrDataUrl || ""}" alt="WhatsApp QR code" width="280" height="280" style="display:block;" />
        </div>
        <p class="muted" style="margin-top:10px;">This code refreshes automatically every ~20 seconds — no need to reload the page.</p>
      </div>

      <div id="connected-section" style="${status === "connected" ? "" : "display:none;"}">
        <p class="save-note">✓ WhatsApp is connected and the assistant is live.</p>
      </div>

      <div id="disconnected-section" style="${status !== "connected" && status !== "waiting_for_qr" ? "" : "display:none;"}">
        <p class="muted">Not connected yet. Make sure the bot process is running (<code>npm start</code>) — a QR code will appear here automatically once it's ready to link.</p>
      </div>

      <hr class="divider" />
      <p class="muted">Logging out disconnects this WhatsApp account from the bot and clears the saved session. You'll need to restart the bot process to link an account again — a fresh QR code will appear here.</p>
      <form method="POST" action="/settings/whatsapp/logout" onsubmit="return confirm('Log out the connected WhatsApp account? You will need to re-scan a QR code to reconnect.');">
        <button type="submit" class="danger">Log Out WhatsApp</button>
      </form>
      ${req.query.loggedOut ? '<p class="save-note">Logged out. Restart the bot process (npm start) to link a new account.</p>' : ""}
    </div>

    <script>
      // Poll every 3 seconds so the QR code and connection status update
      // live in the browser — no manual refresh needed.
      async function pollWhatsAppStatus() {
        try {
          const res = await fetch("/settings/whatsapp/status.json");
          const data = await res.json();

          document.getElementById("status-pill").textContent =
            data.status === "connected" ? "Connected" :
            data.status === "waiting_for_qr" ? "Waiting for QR scan" :
            data.status === "disconnected" ? "Disconnected" : "Unknown";
          document.getElementById("status-pill").className =
            "pill " + (data.status === "connected" ? "connected" : data.status === "waiting_for_qr" ? "waiting" : "disconnected");

          document.getElementById("qr-section").style.display = data.status === "waiting_for_qr" ? "" : "none";
          document.getElementById("connected-section").style.display = data.status === "connected" ? "" : "none";
          document.getElementById("disconnected-section").style.display =
            (data.status !== "connected" && data.status !== "waiting_for_qr") ? "" : "none";

          if (data.status === "waiting_for_qr" && data.qrDataUrl) {
            document.getElementById("qr-image").src = data.qrDataUrl;
          }

          // Stop polling once connected — nothing left to watch for.
          if (data.status === "connected") {
            clearInterval(pollHandle);
          }
        } catch (err) {
          // Bot process probably isn't running — just keep trying quietly.
        }
      }
      const pollHandle = setInterval(pollWhatsAppStatus, 3000);
    </script>`;
  res.send(layout("WhatsApp", "whatsapp", body, { username: req.session.username, role: req.session.role }));
});

// Lightweight JSON proxy so the client-side poll above doesn't need to
// know about (or directly reach) the bot's internal control port.
app.get("/settings/whatsapp/status.json", async (req, res) => {
  try {
    const r = await fetch(`${BOT_CONTROL_URL}/qr`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.json({ status: "unknown", qrDataUrl: null });
  }
});

app.post("/settings/whatsapp/logout", requireOwner, async (req, res) => {
  try {
    await fetch(`${BOT_CONTROL_URL}/logout`, { method: "POST" });
  } catch (err) {
    console.error("Failed to reach bot control API for logout:", err.message);
  }
  logAudit(BUSINESS_ID, req.session.username, "whatsapp.logged_out", "");
  res.redirect("/settings/whatsapp?loggedOut=1");
});

// ---------- Team (owner-only: add/remove staff accounts) ----------

app.get("/team", requireOwner, (req, res) => {
  const users = getAllUsers();

  const rows = users
    .map(
      (u) => `
    <tr>
      <td>${u.username}</td>
      <td style="text-transform:capitalize;">${u.role}</td>
      <td>${u.created_at}</td>
      <td>
        ${u.username !== req.session.username ? `
        <form method="POST" action="/team/${encodeURIComponent(u.username)}/delete" onsubmit="return confirm('Remove ${u.username}? They will lose admin panel access immediately.');" style="display:inline;">
          <button type="submit" class="secondary small">Remove</button>
        </form>` : '<span class="muted">You</span>'}
      </td>
    </tr>`
    )
    .join("");

  const body = `
    <div class="card">
      <h2>Team</h2>
      <p class="card-sub"><strong>Owner</strong> accounts have full access. <strong>Staff</strong> accounts can view Overview, Leads (and update status), Conversations, and Orders — everything involving money, secrets, or other accounts is owner-only.</p>
      <table>
        <thead><tr><th>Username</th><th>Role</th><th>Added</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Add a team member</h2>
      <form method="POST" action="/team">
        <label>Username</label>
        <input type="text" name="username" required />
        <label>Temporary password <span class="muted">(they should change it after first login, from Account)</span></label>
        <input type="text" name="password" required minlength="8" />
        <label>Role</label>
        <select name="role">
          <option value="staff">Staff</option>
          <option value="owner">Owner</option>
        </select>
        <button type="submit">Add Team Member</button>
      </form>
      ${req.query.error ? `<p class="error-note">${req.query.error}</p>` : ""}
    </div>`;
  res.send(layout("Team", "team", body, { username: req.session.username, role: req.session.role }));
});

app.post("/team", requireOwner, (req, res) => {
  const username = (req.body.username || "").trim();
  const password = req.body.password || "";
  const role = req.body.role === "owner" ? "owner" : "staff";

  if (!username || password.length < 8) {
    return res.redirect("/team?error=" + encodeURIComponent("Username required and password must be at least 8 characters."));
  }
  if (getUserByUsername(username)) {
    return res.redirect("/team?error=" + encodeURIComponent("That username is already taken."));
  }

  createUser(username, hashPassword(password), role);
  logAudit(BUSINESS_ID, req.session.username, "team.member_added", { username, role });
  res.redirect("/team");
});

app.post("/team/:username/delete", requireOwner, (req, res) => {
  const targetUsername = req.params.username;

  if (targetUsername === req.session.username) {
    return res.redirect("/team?error=" + encodeURIComponent("You can't remove your own account."));
  }
  const target = getUserByUsername(targetUsername);
  if (target?.role === "owner" && countOwners() <= 1) {
    return res.redirect("/team?error=" + encodeURIComponent("Can't remove the last owner account."));
  }

  deleteUser(targetUsername);
  logAudit(BUSINESS_ID, req.session.username, "team.member_removed", { username: targetUsername });
  res.redirect("/team");
});

// ---------- Account (change admin password) ----------

app.get("/account", (req, res) => {
  const body = `
    <div class="card">
      <h2>Account</h2>
      <p class="card-sub">Signed in as <strong>${req.session.username}</strong>.</p>
      <form method="POST" action="/account/password">
        <label>Current password</label>
        <input type="password" name="currentPassword" required />
        <label>New password</label>
        <input type="password" name="newPassword" required minlength="8" />
        <button type="submit">Update Password</button>
      </form>
      ${req.query.updated ? '<p class="save-note">Password updated.</p>' : ""}
      ${req.query.error ? '<p class="error-note">Current password is incorrect.</p>' : ""}
    </div>`;
  res.send(layout("Account", "account", body, { username: req.session.username, role: req.session.role }));
});

app.post("/account/password", (req, res) => {
  const user = getUserByUsername(req.session.username);
  if (!user || !verifyPassword(req.body.currentPassword, user.password_hash)) {
    return res.redirect("/account?error=1");
  }
  updateUserPassword(req.session.username, hashPassword(req.body.newPassword));
  logAudit(BUSINESS_ID, req.session.username, "account.password_changed", "");
  res.redirect("/account?updated=1");
});

app.get("/", (req, res) => res.redirect("/overview"));

app.listen(PORT, () => {
  console.log(`Admin panel running at http://localhost:${PORT}`);
});
