// test/api.test.js
// The HTTP layer: sessions, CSRF, permissions and output escaping.
//
// The admin panel and the JSON API are exercised over real HTTP against a
// real server, because the things being tested (cookies, CSRF, status
// codes, escaping) only exist at that boundary.

import test from "node:test";
import assert from "node:assert/strict";
import { makeBusiness } from "./helpers.js";

let server;
let baseUrl;
const cookieJar = new Map();

async function start() {
  if (server) return;
  const { default: app } = await import("../dashboard/server.js");
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
});

function storeCookies(response) {
  const raw = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  for (const c of raw) {
    const [pair] = c.split(";");
    const index = pair.indexOf("=");
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    // A later Set-Cookie for the same name replaces the earlier one.
    cookieJar.set(name, value);
  }
}

function cookies() {
  return [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function csrfToken() {
  return cookieJar.get("csrf_token") || "";
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookieJar.size > 0) headers.Cookie = cookies();
  if (options.method && options.method !== "GET") {
    headers["X-CSRF-Token"] = csrfToken();
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers, redirect: "manual" });
  storeCookies(response);
  return response;
}

async function login(username, password) {
  // Fetch the login page first so the CSRF token cookie exists, exactly as
  // a browser would.
  await request("/login");
  const response = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookies(),
      "X-CSRF-Token": csrfToken(),
    },
    body: new URLSearchParams({ username, password }).toString(),
    redirect: "manual",
  });
  storeCookies(response);
  return response;
}

async function setupUsers() {
  const { createUser } = await import("../src/services/auth.js");
  const { getDb } = await import("../src/db/connection.js");
  const businessId = Number(process.env.BUSINESS_ID || 1);

  // Make sure the default business exists, exactly as the dashboard does.
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO businesses (id, name, locale, country, timezone, currency)
       VALUES (?, 'Test Workspace', 'en', 'NP', 'Asia/Kathmandu', 'NPR')`
    )
    .run(businessId);

  createUser(businessId, { username: "owner", password: "owner-password", role: "owner" });
  createUser(businessId, { username: "staffer", password: "staff-password", role: "staff" });
  return businessId;
}

test.before(async () => {
  await makeBusiness("Other Business");
  await setupUsers();
  await start();
});

test("the API refuses an unauthenticated request", async () => {
  const response = await request("/api/overview");
  assert.equal(response.status, 401);
});

test("a wrong password is rejected and a right one signs in", async () => {
  const bad = await login("owner", "wrong-password");
  assert.ok(bad.status === 302 || bad.status === 401);

  const good = await login("owner", "owner-password");
  assert.equal(good.status, 302);
  assert.ok(cookieJar.has("chatcloser.sid"));
});

test("the sign-in page gives the browser a way to send the CSRF token", async () => {
  const response = await fetch(`${baseUrl}/login`, { redirect: "manual" });
  storeCookies(response);
  const html = await response.text();

  // The panel's Content Security Policy only allows scripts that carry the
  // response nonce, so the token-injection script must have one.
  assert.match(html, /<script nonce="[^"]+">/);

  // ...and it must be the script that fills in the hidden field, because
  // that is the only thing that makes the sign-in form work in a browser.
  assert.match(html, /input\.name = "_csrf"/);
});

test("signing in with the form token (the browser path) succeeds", async () => {
  const page = await fetch(`${baseUrl}/login`, { redirect: "manual" });
  storeCookies(page);

  // This mirrors what the injected script does: copy the readable cookie
  // into the form body. It deliberately sends no X-CSRF-Token header.
  const response = await fetch(`${baseUrl}/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookies(),
    },
    body: new URLSearchParams({
      username: "owner",
      password: "owner-password",
      _csrf: csrfToken(),
    }).toString(),
  });

  assert.equal(response.status, 302);
  storeCookies(response);
  assert.ok(cookieJar.has("chatcloser.sid"));
});

test("a state-changing request without a CSRF token is refused", async () => {
  const response = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookies() },
    body: JSON.stringify({ title: "No CSRF token" }),
  });
  assert.equal(response.status, 403);
});

test("a state-changing request with a CSRF token is accepted", async () => {
  const response = await request("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ title: "With a CSRF token" }),
  });
  assert.equal(response.status, 201);
});

test("the overview reports real numbers, not placeholders", async () => {
  const response = await request("/api/overview");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(typeof data.revenue, "number");
  assert.equal(typeof data.pendingOrders, "number");
  assert.equal(data.hasData, false);
});

test("a staff account cannot reach owner-only pages", async () => {
  await login("staffer", "staff-password");

  const page = await request("/settings");
  assert.equal(page.status, 403);

  const api = await request("/api/business");
  assert.equal(api.status, 403);

  const allowed = await request("/api/overview");
  assert.equal(allowed.status, 200);
});

test("a staff account cannot reach owner-only API actions", async () => {
  await login("staffer", "staff-password");

  const response = await request("/api/ai/tools/search_products", {
    method: "POST",
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(response.status, 403);
});

test("customer-supplied text is escaped in the rendered HTML", async () => {
  const { createLead } = await import("../db.js");
  const { getDb } = await import("../src/db/connection.js");
  const businessId = Number(process.env.BUSINESS_ID || 1);

  createLead(businessId, "9800000000", {
    customer_name: "<script>alert('xss')</script>",
    service_requested: "<img src=x onerror=alert(1)>",
  });

  await login("owner", "owner-password");
  const response = await request("/leads");
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.ok(!html.includes("<script>alert('xss')</script>"), "the script tag must be escaped");
  assert.ok(html.includes("&lt;script&gt;"), "the payload must be rendered as text");
  assert.ok(!html.includes("<img src=x onerror=alert(1)>"), "the img payload must be escaped");
});

test("the security headers are set", async () => {
  await login("owner", "owner-password");
  const response = await request("/overview");

  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("content-security-policy") || "", /default-src 'self'/);
  assert.match(response.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
});

test("the admin panel never leaks the encryption key", async () => {
  await login("owner", "owner-password");
  const response = await request("/settings/ai");
  const html = await response.text();
  assert.ok(!html.includes(process.env.ENCRYPTION_KEY));
});
