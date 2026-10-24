# ChatCloser — Repository Audit (Phase 1)

Audit date: 2026-10-22. Audited tree: `F:\ChatCloser` (commit `1662f99` + uncommitted work),
copied verbatim into this workspace (`F:\chatcloser 2.0 Nepal`) so git history and the existing
working state are preserved.

Everything below was verified by reading the code, not inferred from the README.

---

## 1. Actual stack (verified)

| Concern | Reality |
|---|---|
| Runtime | Node.js ESM (`"type": "module"`), engines `>=22.5.0` |
| Database | **Node built-in `node:sqlite`** (`DatabaseSync`), file `./data.sqlite`, WAL mode |
| HTTP | Express 4 + `express-session` (MemoryStore) |
| Admin UI | **Server-rendered HTML strings** in `dashboard/server.js` (no framework, no bundler) |
| Messaging | `@whiskeysockets/baileys` (unofficial WhatsApp Web protocol) |
| Payments | `stripe` SDK only |
| AI | 7 provider adapters in `providers/` — anthropic, openai, google, deepseek, openrouter, nvidia, groq |
| Tests | **None.** No test script, no test runner, no test files |
| Build | **None.** No bundler, no transpiler, no TypeScript |
| Desktop | `electron-app/` — **present but non-functional** (see §4) |
| CI | Deleted upstream (`.github/workflows` removed in `1662f99`) |

## 2. What works today

- Business profile bootstrap + knowledge-base editing (`/company-profile`).
- Provider registry with 7 adapters and a shared OpenAI-compatible factory.
- AI reply generation with two tools: `capture_lead`, `close_sale`.
- Price-list–backed sale verification (AI's `item_name` is looked up in the real
  `price_list` table — the AI's claimed price is never trusted).
- Stripe Checkout session creation + **signature-verified** webhook that is the only
  path that can set `payment_status = 'paid'`.
- Session login, scrypt password hashing, owner/staff roles enforced server-side.
- Audit log, outbound HMAC-signed webhooks with one retry, CSV exports.
- Escalation keyword fast-path (no AI reply attempted on match).
- WhatsApp QR login rendered in-browser as a data URL.

## 3. Confirmed defects (reproducible by reading the code)

| # | Severity | File | Defect |
|---|---|---|---|
| D1 | **Crash** | `db.js:458` | `attachNepalSession()` writes column `payment_method` which is **never created** in the `orders` table → `SQLITE_ERROR` on every Nepal payment path. |
| D2 | **Crash** | `index.js:428` | Nepal webhook branch calls `db.prepare(...)` but `db` is **not imported** in `index.js` → `ReferenceError`. `attachNepalSession` is also not imported. |
| D3 | Data loss | `db.js:213` | `upsertBusiness()` ignores `locale` / `country` / `timezone` even though the dashboard posts them → **Locale is silently never saved.** |
| D4 | XSS | `dashboard/server.js` (many) | User-controlled values (lead names, message bodies, knowledge base, prices, webhook URLs) are interpolated into HTML **without escaping**. A customer can inject markup into the admin panel. |
| D5 | Security | `dashboard/server.js:73` | Session secret silently falls back to `"change-this-session-secret"`. |
| D6 | Security | `dashboard/server.js` | **No CSRF protection** on any state-changing POST form. |
| D7 | Security | `dashboard/server.js` | **No login rate limiting** → unlimited password brute force. |
| D8 | Availability | `dashboard/server.js:78` | `express-session` **MemoryStore** — sessions are lost on restart and leak memory; unusable for a real deployment. |
| D9 | Logic | `index.js:59,327` | `escalatedChats` is an in-memory `Set` that is **never cleared** → once a chat escalates, that customer is **permanently** silenced for the life of the process, with no human-takeover/resume path. |
| D10 | Logic | `index.js:334` | After escalation the bot `continue`s for every later message, so the customer never gets another reply and no handover is recorded. |
| D11 | Safety | `index.js:171` | The Nepal gateway decrypts the **Stripe** key and uses it as an eSewa/Khalti credential (`gatewaySecret` is computed and never used). Credentials for different providers are mixed. |
| D12 | Honesty | `index.js:168-206` | eSewa/Khalti "payment links" are fabricated URLs (`https://esewa.com.np/pay?amount=...`). The order is created with a **fake** session id and there is **no verification path at all**, so these orders can never be legitimately paid or reconciled. |
| D13 | Money | `db.js` / `index.js` | Orders have **no lifecycle**: no DRAFT → AWAITING_CONFIRMATION → CONFIRMED states, no explicit customer approval step, no atomicity with inventory, no idempotency against webhook retries. |
| D14 | Money | `db.js:475` | `markOrderPaid()` sets `paid` for any matching session id with no check that the event was not already processed (double-processing) and no amount/currency verification against the order. |
| D15 | Tenancy | whole app | `BUSINESS_ID` is read from env and hardcoded into every query. `users` has **no `business_id`** → staff of business A can log into business B's panel. |
| D16 | Ports | `index.js:474` | The bot control API (`/status`, `/qr`, `/logout`, `/webhooks/stripe`) binds to **all interfaces** with no authentication → anyone on the LAN can log the WhatsApp account out. |
| D17 | Packaging | `electron-app/` | See §4 — the desktop app cannot start. |
| D18 | Data | `data.sqlite` | A live database file sits in the repo working tree and `.env` contains a real-looking `ENCRYPTION_KEY`. Both are untracked; `.gitignore` does not exist in the tree, so nothing prevents committing them. |

## 4. `electron-app/` status: **non-functional**

It is untracked work-in-progress. It has never been run.

- `src/preload.js:7` — `contextBridge.exposeInMainWorld("api, {` — malformed, **syntax error**.
- `src/preload.js:69` — `window.CONTROL_PORT = ${process.env.BOT_CONTROL_PORT || 3002};` — template
  literal outside a template, **syntax error**.
- `src/preload.js` uses `require()` in a file loaded as an ES module (no `type: "module"`).
- `src/electron/main.js` mixes `import` statements with `require()` **and** `module.exports` in one
  file — cannot load under either module system.
- `src/electron/main.js:9-12` imports `./crypto-utils.js`, `./db.js`, `./ai.js` — **none of those
  files exist** in `electron-app/`.
- `src/electron/main.js:160,391,509` calls `decrypt()` — **never imported** → `ReferenceError`.
- `src/electron/main.js:260` uses `Boom` — **never imported**.
- `src/electron/main.js:37` calls `require("node:sqlite")` inside an ESM file.
- `src/renderer.js:4` calls `require("electron")` in the renderer — requires `nodeIntegration`,
  which the security spec forbids; there is no `contextIsolation` configuration at all.
- `src/renderer.js` calls `ipcRenderer.invoke("bot:logout")` and `"get-encryption-key"` — no such
  handlers are registered in `main.js`.
- `electron-app/package.json` declares `"main": "dist/electron/main.js"` and a `vite build` script,
  but **there is no `vite.config.js`**, no `vite` dependency resolution for the Electron main
  process, and no `index.html` entry wiring. `electron-builder` is not even a dependency.
- `electron-app/src/assets/icon.ico` / `icon.icns` **do not exist** but are referenced by the
  build config.
- No IPC input validation, no CSP, no `contextIsolation`, no `nodeIntegration: false`.

## 5. Capability gaps against the ChatCloser 2.0 brief

Present: business profile, knowledge base (flat key/value), price list, leads, conversations,
orders (payment-link only), Stripe, audit log, webhooks, team roles, WhatsApp.

Missing entirely: products/catalog, inventory, bookings, quotations, invoices, payments ledger,
customer records (contacts), multi-tenant isolation, industry templates, dynamic configuration,
tool registry with schemas + permissions, knowledge retrieval/search with sources, AI memory
model, AI usage/cost tracking, local model support (Ollama), Nepali language handling beyond a
prompt hint, workflow automation, business intelligence/reporting, human takeover, approval
queue, backups, offline behaviour, visual workflow builder, desktop shell.

## 6. Implementation plan adopted

Preserve the existing architecture and extend it — no rewrite.

1. **Foundation** — shared `node:sqlite` connection + versioned migration runner; ChatCloser 2.0
   schema added additively so existing databases upgrade in place. Fix D1–D18.
2. **Business core** — per-business users, RBAC, business configuration, industry templates,
   customers/CRM.
3. **Commerce** — catalog, inventory with transactional movements, quotations, invoices, bookings.
4. **Orders** — explicit draft → confirmation → fulfilment state machine, atomic creation,
   idempotency keys, stock reservation, re-validation before commit.
5. **Payments** — provider-independent adapter interface; Stripe preserved; eSewa/Khalti adapters
   implementing the providers' documented signature verification; idempotent webhook intake;
   simulated provider sandbox for tests. Fabricated payment URLs removed.
6. **AI engine** — provider-independent model adapter (adds local/Ollama), knowledge retrieval
   with source references, tool registry with JSON schemas + per-business permissions + approval
   gates, orchestrator implementing the 12-step conversation lifecycle, usage/cost ledger.
7. **Conversations** — threads, assignment, human takeover, AI pause/resume, handover summaries.
8. **Workflows** — triggers/conditions/actions with retries, timeouts and dead-letter handling.
9. **Desktop** — Electron shell that embeds the existing admin panel, secure by construction.
10. **Tests** — `node:test` suites for the transaction and security paths.

## 7. Baseline test status

There were no tests to run. `npm test` did not exist. Every claim of "it works" in this
repository was previously made without an executable check. ChatCloser 2.0 therefore adds
`npm test` (Node's built-in test runner, zero new dependencies) and every new module is
covered before it is reported as working.
