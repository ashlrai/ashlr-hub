# Ashlr Desktop

A Tauri v2 desktop app that wraps the Ashlr Mission Control web UI in a native window, manages the daemon lifecycle, and adds a system tray icon.

Targets: macOS (.dmg) · Windows (.msi / .exe) · Linux (.deb).
Installed size: ~10–15 MB (Rust WebView runtime + bundled ashlr binary).

---

## Install

Download the latest installer from GitHub Releases:

**https://github.com/ashlrai/ashlr-hub/releases**

| Platform | File | Install |
|----------|------|---------|
| macOS | `.dmg` | Open the DMG, drag Ashlr to Applications |
| Windows | `.msi` or `.exe` | Run the installer |
| Linux | `.deb` | `sudo dpkg -i ashlr_*.deb` |

### First-launch security prompts (unsigned builds)

Current releases are unsigned. You will see a one-time OS warning:

**macOS — Gatekeeper:** Right-click (or Control-click) `Ashlr.app` and choose **Open**, then click Open again in the dialog. You only need to do this once.

**Windows — SmartScreen:** Click **More info → Run anyway**.

**Linux:** No warning.

---

## What the app does

- Bundles the `ashlr` CLI binary as a sidecar — no separate Node.js or npm install needed.
- On first launch, runs `ashlr setup --yes` automatically (writes config, detects engines, installs the daemon). A "Setting up…" banner appears while this runs; the app continues even if setup partially fails.
- Starts `ashlr serve` and waits for the server to be ready, then shows the Mission Control window at `http://127.0.0.1:7777`.
- Closing the window hides it to the tray — the daemon keeps running. The only way to fully quit is via the tray menu.

### Tray menu

| Item | Action |
|------|--------|
| Open Dashboard | Show + focus the main window |
| Start Daemon | Runs `ashlr daemon start` |
| Stop Daemon | Runs `ashlr daemon stop` |
| Kill Switch: OFF/ON | Touches / removes `~/.ashlr/KILL`; label updates live |
| Quit Ashlr | Kills the sidecar, exits the app |

### Re-running setup

To force the first-run wizard to run again:

```sh
rm ~/.ashlr/.desktop-initialized
```

Then relaunch the app.

---

## Security posture

- The webview only ever loads `http://127.0.0.1:7777` — no remote origins.
- CSP restricts `default-src`, `connect-src`, `script-src`, `style-src`, `img-src`, and `font-src` to `self` and `http://127.0.0.1:7777`.
- `shell.open` is disabled — the app cannot open arbitrary URLs in the browser.
- Tauri IPC is not exposed to the webview; the web UI communicates solely over the existing ashlr HTTP/WS API on localhost.

---

## Build from source

### Prerequisites

| Tool | Min version | Install |
|------|-------------|---------|
| Rust + Cargo | 1.85 | `curl https://sh.rustup.rs -sSf \| sh` |
| Tauri CLI | 2.x | `cargo install tauri-cli --version "^2"` |
| Bun | 1.x | `curl -fsSL https://bun.sh/install \| bash` |
| Node.js | 18+ | https://nodejs.org |

Platform-specific WebKit dependencies — follow the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/).

### Development build

```sh
# 1. Build the Bun SEA sidecar (repo root)
node scripts/build-sea.mjs

# 2. Stage the sidecar binary into src-tauri/binaries/
node desktop/scripts/prepare-sidecar.mjs

# 3. Start Tauri dev mode (opens a native window loading http://127.0.0.1:7777)
cd desktop
cargo tauri dev
# or: npm run dev
```

### Production build

```sh
# 1. Build @ashlr/hub + SEA sidecar (repo root)
bun install --frozen-lockfile
bun run build
node scripts/build-sea.mjs

# 2. Stage sidecar
node desktop/scripts/prepare-sidecar.mjs

# 3. Generate app icons from the SVG source
cd desktop
bunx @tauri-apps/cli@^2 icon src-tauri/icons/icon.svg

# 4. Build installers
cargo tauri build
```

Bundles are written to `src-tauri/target/release/bundle/`:
- macOS: `*.app` + `*.dmg`
- Windows: `*.msi` + NSIS `*.exe`
- Linux: `*.deb`

Debug build (keeps console window on Windows):
```sh
cargo tauri build --debug
```

### CI / automated releases

Pushing a `desktop-v*` tag triggers `.github/workflows/release-desktop.yml`, which builds all three platforms in a matrix and uploads installers to a GitHub Release draft.

Code-signing is optional. Set `APPLE_CERTIFICATE` / `APPLE_ID` / `APPLE_TEAM_ID` secrets for notarized macOS builds, and `WINDOWS_CERTIFICATE` for Authenticode-signed Windows builds. Without these secrets, the workflow produces functional unsigned builds.

---

## Auto-update (Tauri updater plugin)

The app checks for updates on every launch via `tauri-plugin-updater`. Updates are downloaded and installed silently in the background; the user is prompted to restart when ready.

### Enabling auto-update (one-time setup)

Auto-update is **inert by default** — the build succeeds without any signing key, but the update check fails silently (no crash, no blocking). To activate it:

**1. Generate a signing key pair**

```sh
cargo tauri signer generate
```

This prints two values — save them somewhere safe:
- **Public key** — a long base64 string starting with `dW50cnVzdGVkIGNvbW1lbnQ6`
- **Private key** — keep secret, never commit

**2. Put the public key in `tauri.conf.json`**

Open `desktop/src-tauri/tauri.conf.json` and replace the `plugins.updater.pubkey` placeholder with your real public key:

```json
"plugins": {
  "updater": {
    "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6...your-real-key-here..."
  }
}
```

**3. Add secrets to the GitHub repository**

Go to **Settings → Secrets and variables → Actions** and add:

| Secret name | Value |
|-------------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | The private key output from `tauri signer generate` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password you entered (or leave empty if none) |

**4. Push a release tag**

```sh
git tag desktop-v1.0.0
git push origin desktop-v1.0.0
```

The CI workflow will now produce `.sig` signature files and a `latest.json` manifest alongside each installer, which the running app uses to detect and verify new releases.

### How it works at runtime

- On launch, the app spawns an async background task that calls the updater endpoint.
- Endpoint: `https://github.com/ashlrai/ashlr-hub/releases/latest/download/latest.json`
- If no new version is available, or if the signing key is not yet configured, the check errors silently (logged to stderr only — the app continues normally).
- When an update is available and verified, it downloads and installs in the background. An `ashlr-update-installed` event is emitted; the user must restart to apply the update.

### Build safety

The updater plugin is **build-safe without a signing key**:
- Adding `tauri-plugin-updater` to `Cargo.toml` and registering it in `main.rs` compiles cleanly with no secrets.
- The `pubkey` placeholder in `tauri.conf.json` is a plain string — Tauri's JSON Schema for `plugins.*` uses `additionalProperties: true`, so no schema validation fails.
- Signature verification only happens at runtime, not at `cargo tauri build` time.
- When `TAURI_SIGNING_PRIVATE_KEY` is absent from CI, `tauri-action` simply skips producing `.sig` files and `latest.json` — the build still succeeds and produces a fully functional (unsigned) installer.

---

## Architecture

```
desktop/
├── src-tauri/
│   ├── src/main.rs          # Rust entry — sidecar lifecycle + tray
│   ├── Cargo.toml           # tauri v2, tauri-plugin-shell, tray-icon feature
│   ├── tauri.conf.json      # app metadata, bundle targets, CSP, externalBin
│   ├── capabilities/
│   │   └── main.json        # Tauri v2 permission grants
│   ├── binaries/            # Triple-suffixed sidecar binary (git-ignored)
│   └── icons/               # App + tray icons (icon.svg source included)
├── scripts/
│   └── prepare-sidecar.mjs  # Copies dist-bin/ashlr → binaries/<triple>
└── package.json             # npm wrapper for cargo tauri commands
```

### Sidecar lifecycle

1. On launch, checks for `~/.ashlr/.desktop-initialized`. If absent, runs `ashlr setup --yes` (first-run path).
2. Spawns `ashlr serve` as the bundled sidecar.
3. Polls `127.0.0.1:7777` via TCP every 250 ms (up to 30 s) until the server is ready.
4. Shows the main window once the port is open.
5. On **Quit**, kills the sidecar before `app.exit(0)`.
6. The window close button hides the window (does not quit) — the daemon continues running.

---

## Troubleshooting

**Window never appears / stuck on spinner**
The server may not have started. Check terminal output for `[ashlr-desktop]` lines.
Confirm manually: `ashlr serve` → visit `http://127.0.0.1:7777`.

**"sidecar not configured" panic**
`binaries/ashlr-<triple>` is missing. Run `node desktop/scripts/prepare-sidecar.mjs` from the repo root.

**`cargo tauri dev` fails with icon errors**
Run `bunx @tauri-apps/cli@^2 icon src-tauri/icons/icon.svg` from the `desktop/` directory to generate the required PNG/icns/ico files.

**macOS: app quarantined after a local build**
Expected without notarization. For local testing: `xattr -dr com.apple.quarantine Ashlr.app`.
