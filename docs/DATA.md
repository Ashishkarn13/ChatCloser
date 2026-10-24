# Data, backups and restore

Everything ChatCloser knows is in one SQLite database plus the WhatsApp session
folder. That makes backup and migration simple, and it means you can move a
business to another computer by copying two directories.

---

## Where the data lives

| Item | Server (`CHATCLOSER_DATA_DIR`, default `./data`) | Desktop |
| --- | --- | --- |
| Database | `data/data.sqlite` (+ `-wal`, `-shm`) | `%APPDATA%\ChatCloser\data.sqlite` |
| WhatsApp session | `data/auth_info/` | `...\ChatCloser\auth_info\` |
| Backups | `data/backups/` | `...\ChatCloser\backups\` |
| Logs | `data/logs/` | `...\ChatCloser\desktop.log` |
| Keys | `.env` (`ENCRYPTION_KEY`, `SESSION_SECRET`) | `...\ChatCloser\secrets.json` |

`ENCRYPTION_KEY` decrypts the provider keys stored in the database. A backup
without the matching key restores the data but the stored provider credentials
must be re-entered.

---

## Backups

### From the console

**Settings → Backups → Create backup**. This uses `VACUUM INTO`, which produces
a consistent copy while the app is running, then encrypts it with
`ENCRYPTION_KEY` (AES-256-GCM, `.enc` files with a magic header).

Files are written to `data/backups/` as
`chatcloser-YYYYMMDD-HHMMSS.db.enc`. Download them from the same page, or copy
the folder.

### From the command line (server)

```bash
# stop the app, then copy the whole folder — simplest and safest
systemctl stop chatcloser
tar czf chatcloser-$(date +%F).tar.gz data/ .env
systemctl start chatcloser
```

Taking a copy while the app is running is safe if you copy `data.sqlite`,
`-wal` and `-shm` together, but a `VACUUM INTO` snapshot (the console button) is
cleaner.

### What to keep

| Item | Frequency | Retention |
| --- | --- | --- |
| Database backup | daily | 30 days |
| `.env` / `secrets.json` | whenever it changes, in a password manager | forever |
| `auth_info/` | with the database backup | until the number is re-linked |

Test a restore every few months. A backup that has never been restored is a
hope, not a backup.

---

## Restore

### In the app

**Settings → Backups → Restore** on a file in `data/backups/`. The current
database is copied to `pre-restore-<timestamp>.db` first, so a mistaken restore
can itself be undone. The application must be restarted afterwards — the restore
replaces the file underneath the open connection.

Restoring an encrypted backup needs the same `ENCRYPTION_KEY` that created it.

### Manually

```bash
systemctl stop chatcloser

cp data/data.sqlite data/data.sqlite.before-restore
cp /path/to/backup.db data/data.sqlite
rm -f data/data.sqlite-wal data/data.sqlite-shm

systemctl start chatcloser
```

The `-wal` and `-shm` files must be removed; leaving them behind gives a
database that looks restored but is inconsistent.

---

## Moving to another computer

1. Create a backup (or copy the whole data folder with the app stopped).
2. On the new machine, install ChatCloser.
3. Stop it. Replace the new data folder with the old one, **including**
   `secrets.json` (desktop) or copy `.env` (server).
4. Start it. The WhatsApp session survives, so the phone does not need
   re-linking.

If you copy the database but not the key, everything works except the stored
provider keys, which you re-enter in AI Configuration and Integrations.

---

## Export

**Settings → Export** gives CSV/JSON for customers, orders, catalogue and
invoices, for your accountant or for a spreadsheet. Exports are generated from
the database, not from the AI, and contain no provider secrets.

---

## Retention and deletion

- The audit log keeps entries; there is no automatic purge. Prune it yourself if
  you have a retention policy:
  `DELETE FROM audit_log WHERE created_at < date('now', '-365 days');`
- Deleting a customer is a soft delete (records stay for order history); ask for
  a hard delete in SQL if a customer exercises a data-deletion right, and take a
  backup first.
- Backups contain everything, so your retention policy for the database applies
  to them as well.
