# Upgrading from 1.x

ChatCloser 2.0 keeps the 1.x tables and migrates them in place. There is no
export/import step, but the upgrade is not a drop-in: the login flow, the
configuration and several behaviours changed. Read this before you run it on a
database that matters.

---

## Before you start

1. **Stop the application.** Do not upgrade while the bot is answering.
2. **Copy the data folder** (`data/` or `%APPDATA%\ChatCloser`) and `.env`
   somewhere safe. A file copy is enough; the database is idle.
3. **Rotate the leaked secrets.** 1.x had no `.gitignore`, so if the repository
   ever held a real `.env` (it did, in the original working tree), assume
   `ENCRYPTION_KEY` and `ADMIN_PASSWORD` are compromised:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ENCRYPTION_KEY
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # SESSION_SECRET
   ```
   Changing `ENCRYPTION_KEY` means previously stored provider/payment keys can
   no longer be decrypted — re-enter them in the console. Old *backups* also need
   the old key to restore, so keep it until you no longer need them.
4. **Note your bot settings.** WhatsApp session (`data/auth_info/`) carries over
   untouched; API keys you will re-enter.

---

## Upgrade

```bash
git pull                     # or unpack the release over the old folder
npm install
npm test                     # 129 tests, all should pass
npm start
```

Migrations run on the first database open (`src/db/connection.js` →
`runMigrations`), so there is no separate migrate step. They are recorded in
`schema_migrations` and are not re-run.

What the migrations do:

| Migration | Effect on your data |
| --- | --- |
| `001_core` | `CREATE TABLE IF NOT EXISTS` for every 1.x table — a no-op on an existing database |
| `002_tenancy` | Rebuilds `users` with `business_id` and a `(business_id, username)` unique key; copies every existing user to business 1; adds role/permission columns |
| `003_commerce` | Catalogue, inventory, orders with lifecycle, order items, payments, invoices |
| `004_conversations` | Thread state (takeover, escalation), messages index, attachments, message rate-limit bookkeeping |
| `005_ai` | AI settings per business, tool permissions, run history, token usage |
| `006_workflows` | Workflows, versions, steps, runs, approvals, tasks |

New columns on the 1.x tables are added with `ensureColumns()`, which checks
`PRAGMA table_info` first, so re-running is safe.

---

## What changed for users

**Sign-in now needs a username.** 1.x asked for a password only. Existing users
are copied with their old `username` (or the password-owner account), and
existing password hashes keep working — the scrypt format did not change. If you
never had a username, try `admin`.

**Sessions are stored in the database.** Everyone is signed out by the upgrade
(1.x lost sessions on restart anyway). Sign in again.

**Role names.** 1.x stored `owner` for accounts created before roles existed.
Unknown role names fall back to `staff` privileges, so after the upgrade open
**Team** and confirm the owner still has `owner`.

**Fake payment links no longer exist.** 1.x created eSewa/Khalti "links" with
`https://esewa.com.np/pay?amount=…` and a made-up session id, and never verified
anything. Those orders cannot be reconciled because no provider ever knew about
them. Treat them as unpaid: either collect manually and approve the payment, or
cancel them. New orders need real credentials in **Integrations → Payments**.

**Escalation now ends.** 1.x kept escalated chats in a set that was never
cleared, so a customer was silenced forever. Now escalation is a thread state
with *Take over* and *Resume*.

**Bot control API is loopback-only.** 1.x bound it to `0.0.0.0` with no auth.
If something on your network was polling `/status`, it must now go through a
proxy or run on the same machine.

**Price and order rules are enforced.** Prices come from the catalogue only, and
an order is created only after the customer confirms. If your 1.x flow created
orders from the AI's own text, those orders stay where they are but new ones
follow the new rules.

---

## Configuration changes

Additions and behaviour changes in `.env` (see `.env.example` for the full list):

| Variable | Change |
| --- | --- |
| `ENCRYPTION_KEY` | **Required.** Startup refuses to run without it or with the placeholder. |
| `SESSION_SECRET` | **Required**, at least 32 characters. The silent fallback to `"change-this-session-secret"` was removed. |
| `ADMIN_PASSWORD` | No longer required. If set and the database has no users, it becomes the first owner's password; otherwise one is generated and printed. |
| `DASHBOARD_HOST` | New, default `127.0.0.1`. Set `0.0.0.0` only if you understand what that exposes. |
| `COOKIE_SECURE` | New, default `0`. Set to `1` when the panel is served over HTTPS. |
| `WHATSAPP_ENABLED` | New, default `true`. Set to `false` to run the console without a WhatsApp socket (useful for setup and demos). |
| `INDUSTRY_TEMPLATE` | New, default `retail`. Seeds starter catalogue/knowledge entries for a new business. |
| `NODE_ENV` | No longer changes webhook behaviour. Sandbox vs production is now a per-provider setting in the console. |

Removed: `BUSINESS_ID` is still read, but the app now provisions rather than
assuming a business row exists. `ADMIN_PASSWORD`-only login is gone.

---

## Rollback

The migrations add tables and rebuild `users`; they do not delete 1.x tables.
Rolling back the *code* to 1.x is possible but not supported: 1.x will see the
new tables and ignore them, and the rebuilt `users` table is compatible with
1.x's queries (same columns plus extra ones). The reliable path is to restore
the copy you took in step 2.

If you must return:

```bash
# stop the app
rm data/data.sqlite data/data.sqlite-wal data/data.sqlite-shm
cp /path/to/copy/data.sqlite data/
# check out the 1.x tag, npm install, start
```

---

## After the upgrade

1. Sign in and change the password (Account).
2. Confirm **Team** roles.
3. Re-enter AI provider keys (**AI Configuration → Test**).
4. Re-enter payment credentials, staying in sandbox; run one test transaction.
5. Re-link WhatsApp only if the session did not survive (it normally does).
6. Open **Catalogue** and confirm prices — the assistant cannot quote what is
   not there.
7. Create a backup so the upgraded state is captured.
