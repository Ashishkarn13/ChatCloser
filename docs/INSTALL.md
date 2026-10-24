# Install

Two ways to run ChatCloser 2.0: the desktop application, or a server
installation. They run identical code; pick one.

---

## A. Desktop application

### From an installer

1. Run `ChatCloser-Setup-2.0.0-x64.exe` (or the `.dmg` / `.AppImage`).
2. Launch ChatCloser. Windows SmartScreen may warn about an unsigned
   installer — *More info → Run anyway*, or build your own signed installer.
3. A dialog shows the administrator username and password. Write them down.
4. Sign in and change the password in **Account**.

Data lives in:

| Platform | Folder |
| --- | --- |
| Windows | `%APPDATA%\ChatCloser` |
| macOS | `~/Library/Application Support/ChatCloser` |
| Linux | `~/.config/ChatCloser` |

Inside that folder: `data.sqlite` (everything), `auth_info/` (WhatsApp session),
`backups/`, `secrets.json` (encryption + session keys), `desktop.log`.

### From source

Requirements: Node.js 22.13+ (Node 24 recommended), npm, ~1 GB free disk.

```bash
npm install                      # backend dependencies
npm --prefix electron-app install  # Electron runtime + packager
npm run desktop                  # runs the app from the repository
```

`npm run desktop` copies the backend into `electron-app/backend` and starts the
shell. The copy exists so the packaged app is self-contained; re-run the same
command after backend changes and it re-copies.

### Building installers

```bash
npm run desktop:dist:win     # installer + portable .exe
npm run desktop:dist         # whatever the current platform needs
```

Output in `electron-app/dist/`:

| File | What it is |
| --- | --- |
| `ChatCloser-Setup-2.0.0-x64.exe` | Assisted NSIS installer (per-user by default, choose the folder) |
| `ChatCloser-Portable-2.0.0-x64.exe` | Single-file portable build, no installation |
| `win-unpacked/` | The unpacked application, useful for testing |

The installer is unsigned: Windows SmartScreen will warn until you sign it with
your own certificate (`CSC_LINK` + `CSC_KEY_PASSWORD`).

Windows builds need no extra tools; macOS builds need Xcode command line tools,
Linux builds need `rpm`/`fakeroot` for `.deb`. The macOS and Linux desktop
builds are defined but have not been exercised as thoroughly as Windows.

The first build downloads the Electron runtime and the NSIS toolchain. On a
network that blocks GitHub releases, point both at a mirror first:

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run desktop:dist:win
```

The build stages the backend itself: it copies `src/`, `dashboard/`, the root
module files and the repository's `node_modules` into `electron-app/`, so run
`npm install` in the repository root before packaging. The app package's
dependency list must match the root one — the staging script refuses to build
otherwise, because a mismatch silently drops packages from the bundle.

Verifying a build without installing it:

```powershell
$env:CHATCLOSER_DESKTOP_SMOKE = "1"
$env:CHATCLOSER_SMOKE_OUT = "$env:TEMP\smoke.json"
& .\electron-app\dist\win-unpacked\ChatCloser.exe
Get-Content "$env:TEMP\smoke.json"   # {"smoke":"ok","dashboard":200,...}
```

---

## B. Server

Requirements: Node.js 22.13+ and a writable folder for the data directory.
SQLite is bundled with Node (`node:sqlite`); there is no separate database
server to install.

```bash
npm install
cp .env.example .env
```

Edit `.env` and set at least:

```
ENCRYPTION_KEY=<64 hex chars>
SESSION_SECRET=<at least 32 chars>
ADMIN_PASSWORD=<a strong password>
BUSINESS_NAME=Your Business
```

Generate the keys:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Start:

```bash
npm start
```

Expected output:

```
  ChatCloser 2.0
  ---------------------------------------------
  Admin panel   http://127.0.0.1:3001
  Bot control   http://127.0.0.1:3002 (local only)
  Database      .../data/data.sqlite
  Environment   production
  WhatsApp      enabled
  ---------------------------------------------
```

Open <http://127.0.0.1:3001>.

### Reaching it from another computer

The panel listens on loopback on purpose. To reach it over the network, either
put a reverse proxy in front of it (recommended, see
[DEPLOYMENT.md](DEPLOYMENT.md)) or set `DASHBOARD_HOST=0.0.0.0` and understand
that the password is then the only thing protecting the console.

When you serve the panel over HTTPS, also set `COOKIE_SECURE=1`.

---

## Verifying the installation

```bash
npm test          # 129 tests, uses temporary databases
npm run migrate   # prints the applied migrations and the table list
```

If `npm test` fails on a machine where `npm install` succeeded, check that the
system clock is correct — npm refuses certificates that appear to be issued in
the future, and the same clock skew breaks TLS calls to AI providers.
