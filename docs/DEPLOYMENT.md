# Deployment

A single process (`npm start`) serves the admin panel and runs the WhatsApp
assistant. This page covers running it reliably, and exposing only what has to
be public.

---

## The two listeners

| Listener | Default | What it serves | Expose publicly? |
| --- | --- | --- | --- |
| Admin panel | `127.0.0.1:3001` | The console, the JSON API, sign-in | Only behind HTTPS and a proxy |
| Control API | `127.0.0.1:3002` | `/status`, `/health`, `/qr`, `/logout`, payment webhooks | Only the webhook paths |

The control API can log the WhatsApp account out, so it must not be reachable
from the internet. Payment providers, however, need to reach the webhooks from
outside. Proxy only these paths:

```
POST /webhooks/stripe
POST /webhooks/nepal/esewa
POST /webhooks/nepal/khalti
```

---

## Reverse proxy (nginx)

```nginx
server {
  listen 443 ssl http2;
  server_name chat.example.com;

  ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

  client_max_body_size 10m;

  # The console and API
  location / {
    proxy_pass         http://127.0.0.1:3001;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
  }

  # Payment callbacks only
  location ~ ^/webhooks/(stripe|nepal/(esewa|khalti))$ {
    proxy_pass         http://127.0.0.1:3002;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
  }
}
```

Behind this proxy set:

```
COOKIE_SECURE=1
PAYMENT_SUCCESS_URL=https://chat.example.com/orders?paid=1
PAYMENT_CANCEL_URL=https://chat.example.com/orders?cancelled=1
```

`app.set("trust proxy", 1)` is already in the code, so the session cookie and
the login throttle see the real client address.

Caddy is simpler if you have the choice:

```
chat.example.com {
  handle /webhooks/* {
    reverse_proxy 127.0.0.1:3002
  }
  reverse_proxy 127.0.0.1:3001
}
```

---

## Running as a service

### systemd (Linux)

```ini
# /etc/systemd/system/chatcloser.service
[Unit]
Description=ChatCloser 2.0
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=chatcloser
WorkingDirectory=/opt/chatcloser
EnvironmentFile=/opt/chatcloser/.env
ExecStart=/usr/bin/node scripts/server.js
Restart=on-failure
RestartSec=5

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/chatcloser/data
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now chatcloser
journalctl -u chatcloser -f
```

### Windows (NSSM or Task Scheduler)

```powershell
# with NSSM installed
nssm install ChatCloser "C:\Program Files\nodejs\node.exe" "F:\chatcloser\scripts\server.js"
nssm set ChatCloser AppDirectory "F:\chatcloser"
nssm set ChatCloser AppStdout "F:\chatcloser\logs\server.log"
nssm set ChatCloser AppStderr "F:\chatcloser\logs\server.log"
nssm start ChatCloser
```

Or use the desktop application, which already runs everything and has a tray
menu with *Launch on startup*.

---

## Upgrades

```bash
git pull                      # or unpack the new release
npm install
npm test                      # expects 129 passing
npm run migrate               # applies any new migrations
sudo systemctl restart chatcloser
```

Migrations are additive and idempotent; the runner records each applied
version in `schema_migrations`. **Take a backup before a version upgrade** —
Settings → Backups.

---

## Health checks and monitoring

```bash
curl -s http://127.0.0.1:3002/health
# {"status":"ok","whatsapp":"connected","uptimeSeconds":1234}
```

`whatsapp` is one of `connected`, `waiting_for_qr`, `disconnected`, `starting`,
`disabled`. Alert when it stays `disconnected` for more than a few minutes — no
messages are being answered. `GET /qr` returns a data URL for the current QR
code, which the console shows under Integrations → WhatsApp.

Logs go to stdout (captured by systemd/NSSM) and, in the desktop app, to
`desktop.log`. Levels are deliberately quiet; add your own logging around custom
integrations rather than raising the noise floor.

---

## Scale and backups

One process, one SQLite file, WAL mode. That comfortably handles a few thousand
messages a day and a catalogue of tens of thousands of items. It does *not*
support multiple application instances sharing one file — if you need
horizontal scale, the services layer is written against a small query helper
(`src/db/connection.js`) and can be ported to Postgres, but that work has not
been done.

Back up the data folder nightly (see [DATA.md](DATA.md)); the database is safe
to copy while running because of `VACUUM INTO`, which is what the built-in
backup uses.
