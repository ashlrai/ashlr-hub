# Ashlr Desktop

A source-only Tauri v2 desktop draft that wraps the Ashlr Mission Control web UI
in a native window and defines a system tray integration. It is not a public or
commissioned desktop product, and it does not activate the dormant daemon.

Public desktop releases and installers: none. The desktop release workflow is
externally disabled during the Linux quarantine, and any future workflow output
is draft-only. The Linux CLI and web dashboard remain supported.
Installed size: ~10–15 MB (Rust WebView runtime + bundled ashlr binary).

---

## Install

There is no public desktop installer today. Use the supported
[npm/CLI quickstart](../docs/QUICKSTART.md). The formats below describe only
future draft artifacts after the quarantine exit review; they are not downloads
or an installation channel.

| Platform | Draft artifact policy |
|----------|-----------------------|
| macOS | `.dmg` draft only |
| Windows | `.msi` / `.exe` draft only |
| Linux | Not produced while quarantined |

### First-launch security prompts (unsigned builds)

If a future reviewed desktop draft is promoted without platform signing, users
will see a one-time OS warning:

**macOS — Gatekeeper:** Right-click (or Control-click) `Ashlr.app` and choose **Open**, then click Open again in the dialog. You only need to do this once.

**Windows — SmartScreen:** Click **More info → Run anyway**.

---

## What the draft source does

- Bundles the `ashlr` CLI binary as a sidecar — no separate Node.js or npm install needed.
- On first launch, the draft invokes `ashlr setup --yes`, but the current CLI
  refuses before config, discovery, enrollment, or service effects. The banner
  is not evidence of completed setup.
- Starts `ashlr serve` and waits for the server to be ready, then shows the Mission Control window at `http://127.0.0.1:7777`.
- Closing the draft window hides it to the tray while the local `ashlr serve`
  sidecar remains open. No resident daemon is started; use the tray menu to quit
  the draft process.

### Tray menu

| Item | Action |
|------|--------|
| Open Dashboard | Show + focus the main window |
| Start Daemon | Invokes `ashlr daemon start`, which currently refuses before effects because compiled daemon trust roots are empty |
| Stop Daemon | Runs `ashlr daemon stop` |
| Kill Switch: OFF/ON | Touches / removes `~/.ashlr/KILL`; label updates live |
| Quit Ashlr | Kills the sidecar, exits the app |

### Re-running the draft setup attempt

For source-development testing only, removing the draft marker causes another
setup attempt on relaunch. The current setup command still refuses before
effects:

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

> **Linux desktop quarantine:** every fresh Tauri dev, debug, release, and
> direct Cargo source build targeting Linux fails in `src-tauri/build.rs` before
> `tauri_build::build()`. Tauri v2 currently resolves GTK3 and vulnerable
> `glib 0.18.5` (`GHSA-wrw7-89jp-8q8g` / `RUSTSEC-2024-0429`). This does not
> block the root `ashlr` CLI, Bun sidecar, or web dashboard on Linux.
> Default Tauri configuration also disables Linux bundling and runs a
> fail-closed pre-bundle policy, covering the official workflow and ordinary
> `cargo tauri build`, `--debug`, and direct `--bundles` paths. A hostile
> `--config` override combined with an already-built/staged executable is
> outside source-build enforcement; never treat artifacts from a custom config
> or a non-fresh build tree as admitted release output.

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

Debug build (keeps console window on Windows):
```sh
cargo tauri build --debug
```

### CI / automated releases

Repository workflow 301689703 must remain externally `disabled_manually` while
the quarantine is active. Its retained source definition accepts only
`desktop-v*` tag pushes, builds only macOS and Windows, records Linux as not
published, and sets `releaseDraft: true`; workflow output is draft-only and is
not a public installer. Ruleset 20660876 protects `refs/tags/desktop-v*` with a
Mason-only bypass. Tag protection is necessary but not sufficient because a
tag can select a historical commit whose workflow predates this quarantine.

Linux desktop release can be re-enabled only after either migration to Tauri v3
with GTK4, or adoption of another supported dependency chain that resolves
`glib >=0.20`. That change must also pass full native build, install, launch,
sidecar, signing/updater, and release acceptance on macOS, Windows, and Linux,
with an independent security review. Removing the workflow row alone is not an
override: the Rust build guard, default Linux bundle policy, and pre-bundle
policy must be retired in the same reviewed change. Release acceptance applies
only to the official workflow, default Tauri configuration, and fresh builds;
a hostile `--config` with a staged executable is outside source-build
enforcement.

After the quarantine exit review and external re-enablement, code-signing may be
configured with `APPLE_CERTIFICATE` / `APPLE_ID` / `APPLE_TEAM_ID` for notarized
macOS drafts and `WINDOWS_CERTIFICATE` for Authenticode-signed Windows drafts.
Unsigned workflow output must remain a private draft and is never a current
download claim.

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

**4. After quarantine clearance, push a release tag**

Do not perform this step while workflow 301689703 is externally disabled for
the quarantine.

```sh
git tag desktop-v1.0.0
git push origin desktop-v1.0.0
```

After the quarantine is cleared and the workflow is explicitly re-enabled, CI
can produce `.sig` signature files and a `latest.json` manifest alongside each
draft installer. Promotion requires separate release acceptance.

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
- When `TAURI_SIGNING_PRIVATE_KEY` is absent from CI, `tauri-action` skips
  `.sig` files and `latest.json`; any resulting unsigned macOS or Windows
  artifacts remain draft-only and are not a supported public installer.

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

### Draft sidecar lifecycle

1. On launch, checks for `~/.ashlr/.desktop-initialized`. If absent, invokes
   `ashlr setup --yes`; the current CLI refuses before config or service work.
2. Spawns `ashlr serve` as the bundled sidecar.
3. Polls `127.0.0.1:7777` via TCP every 250 ms (up to 30 s) until the server is ready.
4. Shows the main window once the port is open.
5. On **Quit**, kills the sidecar before `app.exit(0)`.
6. The window close button hides the window (does not quit); the local web
   sidecar continues until **Quit**, but no resident daemon is activated.

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
