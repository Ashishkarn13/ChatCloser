# ChatCloser 2.0

<p align="center">
  <img src="assets/chatcloser-logo.png" alt="ChatCloser 2.0 — Conversations to Customers — Thirteen" width="720" />
</p>

An AI-run business, in one application: a WhatsApp assistant that answers
customers in Nepali or English, a real catalogue and stock ledger, orders that
exist only after the customer confirms them, payments that are only marked paid
when the provider says so, bookings, quotations, invoices, automation, and
reporting — on your own computer, with your own AI key.

ChatCloser runs as a **desktop application** (Windows, macOS, Linux) or as a
**headless server**. Both run the same code and the same database.

---

## Contents

- [What it does](#what-it-does)
- [The safety design](#the-safety-design-read-this-first)
- [Install](#install)
- [First run](#first-run)
- [Connect WhatsApp](#connect-whatsapp)
- [Choose an AI provider](#choose-an-ai-provider)
- [Take payments](#take-payments)
- [The console](#the-console)
- [Configuration](#configuration)
- [Data, backups and restore](#data-backups-and-restore)
- [Development](#development)
- [Security](#security)
- [Known limitations](#known-limitations)
- [Documentation](#documentation)
- [Licence](#licence)

---

## What it does

**Conversation.** Incoming WhatsApp messages become a thread on a customer
record. The assistant replies from your knowledge base and catalogue, detects
whether the customer is writing in Nepali, romanised Nepali or English, and
switches to a human on request, on a complaint, or on anything it is not allowed
to decide.

**Selling.** It can search the catalogue, check stock, add items to a draft
order, compute tax and delivery, quote a total, and hand the customer a summary
to confirm. The order is created only when the customer says yes. Prices always
come from the catalogue, never from the model's own text.

**Getting paid.** eSewa, Khalti, Stripe and manual bank transfer/QR. The order
becomes `paid` only after a verified provider response — a webhook with a valid
signature, or a server-side status call to the provider.

**Running the business.** Customers and addresses, catalogue with variants and
price lists, stock movements with reservations, bookings and resources,
quotations and invoices with printable documents, expenses, tasks, staff
accounts with roles, audit log, automation workflows, scheduled jobs, knowledge
base, notifications, and reports (sales trend, funnel, AI usage, accounting
summary, forecast that refuses to guess when there is no history).

**Staying in control.** Every AI action goes through a tool registry with
permissions and an approval queue for anything sensitive. Every table is scoped
by `business_id`. Every change is audited.

---

## The safety design (read this first)

These are not features, they are invariants the code enforces:

| Invariant | Where it is enforced |
| --- | --- |
| An order cannot exist without the customer confirming it | `src/services/orders.js` — `confirmDraft()` requires `customerApproved: true` |
| Prices never come from the model | `src/services/catalog.js` — totals are recomputed server-side from catalogue rows |
| A payment is never marked paid by the model, a link click, or a redirect | `src/services/payments/*` — only verified provider responses, deduplicated by event id |
| The assistant acts with a fixed role, not one supplied by the request | `src/services/ai/tools/index.js` — the effective role is `businesses.ai_operator_role` |
| Workflows cannot execute arbitrary code | `src/services/workflows.js` — actions are an allow-list |
| Customer text is never rendered as HTML | `dashboard/server.js` — `escapeHtml` on every interpolation |
| Every state-changing form is CSRF-protected | `src/server/app.js` — double-submit token, rotated on sign-in |
| The control API that can log WhatsApp out is loopback-only | `index.js` — `BOT_CONTROL_HOST=127.0.0.1` |
| A fresh install cannot start with placeholder secrets | `src/config.js` — `assertUsableConfig()` |

If you change the code, keep these true. The test suite asserts most of them.

---

## Install

### Desktop application (recommended)

Download the installer for your platform from the releases page, run it, and
open ChatCloser. The first launch creates its database, its encryption key and
an owner account, and shows you the credentials once.

To build the installer yourself:

```bash
npm install
npm --prefix electron-app install
npm run desktop:dist:win     # or :mac / :linux
```

The build writes `electron-app/dist/ChatCloser-Setup-<version>-x64.exe` (NSIS
installer) and `ChatCloser-Portable-<version>-x64.exe`. Both are smoke-tested:
the packaged application starts, the panel answers, sign-in works, and Node is
not reachable from the page. See [docs/DESKTOP.md](docs/DESKTOP.md) for build
requirements and what the desktop shell does.

### Server

Requires Node.js 22.13 or newer (Node 24 is what this release is tested on).

```bash
npm install
copy .env.example .env      # Windows:  Copy-Item .env.example .env
# edit .env: ENCRYPTION_KEY, SESSION_SECRET, ADMIN_PASSWORD
npm start
```

`npm start` runs the admin panel and the WhatsApp assistant in one process.
Open <http://127.0.0.1:3001> and sign in.

Step-by-step instructions, including a reverse proxy and a service definition:
[docs/INSTALL.md](docs/INSTALL.md) and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## First run

1. The application creates business `#1`, an owner account, and applies an
   industry template (default `retail`).
2. The generated password is printed once and written to
   `first-run-credentials.txt` in the data folder. **Sign in, change the
   password in Account, and delete that file.**
3. Set your business name, currency, tax rules and hours in **Settings**.
4. Pick the industry template that matches your business. Applying a template
   turns on the modules and custom fields that fit (order types, delivery,
   bookings, site visits, and so on). It never deletes records.

---

## Connect WhatsApp

In the console, open **Integrations → WhatsApp**, press *Connect*, and scan the
QR code from the phone (WhatsApp → Linked devices → Link a device). The session
is stored in the data folder, so it survives restarts.

**Read this before using a real business number.** ChatCloser connects through
Baileys, an unofficial library that automates a normal WhatsApp account rather
than Meta's Cloud API. Meta's terms do not permit this, and accounts have been
banned for it. Use a spare number until you have migrated to the Cloud API
(`src/services/ai/*` is independent of the transport, so a Cloud API adapter is
a drop-in replacement for `index.js`). See [docs/WHATSAPP.md](docs/WHATSAPP.md).

---

## Choose an AI provider

Configured in **AI Configuration**: Anthropic, OpenAI, Google, DeepSeek,
OpenRouter, NVIDIA NIM, Groq, or a **local model through Ollama** (nothing
leaves the machine). Keys are encrypted with `ENCRYPTION_KEY` before they touch
the database.

Any model id the provider accepts can be typed into the *Model* field; the
suggested list is only a starting point. There is a *Test* button that makes one
real call and reports the latency, the reply and an estimated cost.

If no key is configured the assistant does not invent replies — the panel says
so, and messages are queued for a human. Details:
[docs/AI.md](docs/AI.md).

---

## Take payments

| Provider | What you need | Verification |
| --- | --- | --- |
| **eSewa** | Merchant code, secret key (sandbox or production) | HMAC-signed request, then a server-side status lookup |
| **Khalti** | Public key, secret key (sandbox or production) | Server-side payment lookup by `pidx` |
| **Stripe** | Secret key, webhook signing secret | Signature-verified webhook event, then a server-side session check |
| **Manual** | Nothing | A staff member with the `payments.approve` permission confirms receipt; the approval is audited |

Provider setup, sandbox testing and the exact callback URLs:
[docs/PAYMENTS.md](docs/PAYMENTS.md).

---

## The console

| Module | What it is for |
| --- | --- |
| Overview | Today's numbers: revenue, orders, leads, escalations, stock alerts, AI runs |
| AI Command Center | What the assistant is doing, recent runs, approvals, escalations |
| Customer Inbox | WhatsApp threads, takeover and resume, notes |
| Leads & CRM | Pipeline, stages, follow-ups |
| Orders & Bookings | Draft → confirmed → paid → fulfilled, plus appointments and resources |
| Products & Services | Catalogue, variants, price lists, service duration |
| Inventory | Stock levels, movements, reservations, low-stock alerts |
| Quotations & Invoices | Printable documents, numbering, expenses |
| Payments | Every attempt, verification state, reconciliation |
| Customers | Records, addresses, order history, custom fields |
| Automation Studio | Triggers, conditions, actions, retries, dead-letter queue |
| Business Intelligence | Trends, funnel, AI usage and cost, accounting summary, forecast |
| AI Configuration | Provider, model, prompt, knowledge, tool permissions |
| Knowledge Base | Documents, chunking, search |
| Integrations | WhatsApp, payments, webhooks |
| Team & Permissions | Users, roles, per-permission overrides |
| Security & Audit Logs | Every privileged action, with actor and IP |
| Settings & Backups | Business profile, tax, modules, backup and restore |

---

## Configuration

Everything is environment variables; `.env.example` documents each one. The
important ones:

| Variable | Meaning |
| --- | --- |
| `ENCRYPTION_KEY` | 32 bytes, hex. Encrypts stored provider secrets. **Losing it means stored keys must be re-entered.** |
| `SESSION_SECRET` | Signs the admin session cookie. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | The owner account created on first run. |
| `BUSINESS_NAME`, `INDUSTRY_TEMPLATE` | Workspace name and starting template. |
| `DASHBOARD_HOST` / `DASHBOARD_PORT` | Where the panel listens. `127.0.0.1` by default. |
| `COOKIE_SECURE` | Set to `1` only when the panel is served over HTTPS. |
| `WHATSAPP_ENABLED` | `false` runs the console and payments without WhatsApp. |
| `CHATCLOSER_DATA_DIR` | Where the database, session, backups and logs live (default `./data`). |

The desktop application needs none of these: it generates and stores them in its
user-data folder on first launch.

---

## Data, backups and restore

Everything is in one SQLite database plus the WhatsApp session directory.
**Settings → Backups** creates a consistent snapshot (`VACUUM INTO`) and can
encrypt it with a passphrase (AES-256-GCM). Restore is a documented offline
procedure, not a button that swaps a live database.

Full procedure, including moving to a new computer:
[docs/DATA.md](docs/DATA.md).

---

## Development

```bash
npm test                 # 129 tests, node:test, no services required
npm run check            # syntax check + tests
npm run migrate          # apply migrations, list them
npm run seed             # load the example workspace (destructive on business 1)
npm run desktop          # run the desktop shell against the repo
```

Layout:

```
src/config.js            validated configuration
src/db/                  connection, migration runner, SQL migrations
src/core/                errors, validation, money, audit, RBAC
src/services/            business logic, one module per domain
src/services/ai/         prompt, reply validation, tool registry, model adapter
src/services/payments/   provider adapters
src/server/              HTTP app (sessions, CSRF, CSP) and the JSON API
dashboard/server.js      the server-rendered admin console
index.js                 WhatsApp channel + control API
scripts/server.js        `npm start` entry point
electron-app/            desktop shell (Electron)
test/                    the test suite
```

Tests run hermetically: each file gets its own temporary database.

---

## Security

- Passwords: scrypt with per-user salt.
- Provider secrets: AES-256-GCM with `ENCRYPTION_KEY`; never sent to the browser.
- Sessions: stored server-side, id regenerated on sign-in, CSRF token rotated.
- Headers: strict CSP with per-response nonces, `frame-ancestors 'none'`,
  `nosniff`, `no-referrer`, permissions policy.
- Login throttling with per-username/per-IP lockout.
- Audit log of every privileged action.
- Desktop shell: `contextIsolation`, `sandbox`, no Node in the renderer, a
  five-channel IPC allow-list, navigation locked to the local panel.

Threat model and what is deliberately *not* protected: [docs/SECURITY.md](docs/SECURITY.md).

---

## Known limitations

Honest list — read it before deploying to real customers:
[docs/LIMITATIONS.md](docs/LIMITATIONS.md). The short version:

- Baileys is unofficial and can get a number banned.
- Single-workspace per database in the packaged desktop app; the schema and the
  API are multi-tenant, but the desktop shell is not a multi-workspace client.
- No email/SMS channel yet; no Meta Cloud API adapter.
- Forecasting is a simple trend model and says so.
- eSewa/Khalti flows are implemented against their documented APIs and covered
  by unit tests with recorded payloads, but they must be rehearsed against your
  own sandbox merchant account before going live.

---

## Documentation

- [Install](docs/INSTALL.md) · [Deployment](docs/DEPLOYMENT.md) · [Desktop](docs/DESKTOP.md)
- [AI setup](docs/AI.md) · [WhatsApp](docs/WHATSAPP.md) · [Payments](docs/PAYMENTS.md)
- [Data and backups](docs/DATA.md) · [Security](docs/SECURITY.md) · [Limitations](docs/LIMITATIONS.md)
- [Upgrading from 1.x](docs/UPGRADING.md) · [Audit of 1.x](AUDIT.md)

---

## Licence

MIT. See [LICENSE](LICENSE).
