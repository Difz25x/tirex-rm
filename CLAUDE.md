# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**TiRex RM** — An Electron-based Roblox Account Manager that lets users manage multiple Roblox accounts, launch multi-instance clients, manage Roblox versions, and tweak FFlags/performance settings.

- Electron 34 desktop app (main process + renderer)
- Single-page app with dark theme (purple/violet/teal palette)
- Uses Patchright (Playwright fork) for browser automation during login
- Hot-update system via GitHub releases (update-pack.zip)
- AGENTS.md contains a legacy custom personality prompt — not relevant to development

## Commands

```bash
# Run the app in development
npm start

# Build Windows installer (NSIS)
npm run build:win

# Build + publish to GitHub releases
npm run release
```

There are no test runners or linters configured.

## Architecture

### Main Process (`main.js`, ~7941 lines)
Electron main process. Handles all IPC with the renderer. Key subsystems:
- **Account Management** — save/load accounts (JSON), cookie validation via Roblox API
- **Login** — Patchright-based browser automation (cookie capture, Quick Sign-in code flow, auto-login with credentials)
- **Multi-Instance Guard** — mutex bypass to run multiple Roblox clients; process monitoring, crash detection, auto-reopen
- **Roblox Version Manager** — download/extract/manage specific Roblox versions from CDN
- **Settings** — compact encoded settings string (exportable/shareable), FFlags mapping to Roblox ClientSettings
- **Memory Optimization** — crash handler process management, memory trimming, system memory cleaner
- **Server Browser** — resolve share links, fetch game info and server lists via Roblox API
- **Process Monitor** — PID scanning, crash detection, auto-reopen with configurable retry

### Renderer (`index.html` + `js/` modules)
Single HTML page with tab-based navigation. 11 JS modules loaded as CommonJS via `<script>`:

| Module | Purpose |
|--------|---------|
| `js/shared.js` | Core helpers: cookie parsing, text normalization, Indonesian→English translation, format utils |
| `js/app.js` | App bootstrap, tab switching, startup sequence, IPC event listeners |
| `js/accounts.js` | Account grid render, CRUD, multi-select, search/filter, launch |
| `js/servers.js` | Server browser UI, game info, join flow |
| `js/instances.js` | Runtime instance monitor, guard status display |
| `js/settings.js` | Settings UI, export/import settings |
| `js/fflags.js` | Roblox FFlags/Graphics/Network toggles UI |
| `js/console.js` | App console log viewer |
| `js/notifications.js` | Toast notification system |
| `js/modals.js` | Modal dialogs (add account, edit, confirm) |
| `js/utilities.js` | General utility functions |

### Updater (`updater.js`)
Checks GitHub releases for `update-pack.zip`, downloads and applies hot-updates to the `userData/hot-update/` directory. Updates only source files (`index.html`, `styles.css`, `js/*.js`, `main.js`, `updater.js`, `package.json`). Falls back to full `.exe` download if hot-update isn't available.

### Build Hook (`afterAllArtifactBuild.js`)
Post electron-builder hook that creates `update-pack.zip` from the source files for the hot-update system.

### Data Storage
- `userData/data/accounts.json` — encrypted-ish cookie store (simple base64url-encoded secrets)
- `userData/data/settings.json` — user settings
- `userData/roblox-versions/` — downloaded Roblox client versions
- `userData/hot-update/` — hot-update overlay files
- `userData/downloads/` — Roblox CDN package downloads

### Key Dependencies
- **Electron 34** — desktop framework
- **Patchright** — browser automation fork of Playwright (login flows)
- **Axios** — HTTP client for Roblox API calls
- **adm-zip** — zip extraction for Roblox versions
- **fs-extra** — enhanced file system operations
- **TailwindCSS + PostCSS + Autoprefixer** — build-time CSS (pre-compiled into `styles.css`)

## Key Roblox API Patterns

- Cookie validation: `https://www.roblox.com/mobileapi/userinfo`
- CSRF tokens: POST to `https://auth.roblox.com/v2/logout` and read `x-csrf-token` header
- Auth tickets: POST `https://auth.roblox.com/v1/authentication-ticket`
- Quick Sign-in: Roblox cross-device login flow via Patchright browser automation
- Deploy history: `https://setup-aws.rbxcdn.com/{channel}/DeployHistory.txt`
- Manifest/Packages: `https://setup-aws.rbxcdn.com/{version}-{hash}-manifest.json`

## Security Notes

- Account cookies (`.ROBLOSECURITY`) are stored in `accounts.json` with base64url encoding (not true encryption)
- Settings can be exported as a compact encoded string (boolean tokens mapped to random-looking codes)
- The app interacts with Roblox API endpoints directly (no proxy by default)
- Rate limiting and IP bans are real risks — the main process has retry/backoff logic baked in

## Git Conventions

- Branch from `main`
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- PR bodies end with: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
