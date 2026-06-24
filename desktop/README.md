# Ashlr Desktop

A Tauri v2 desktop application that wraps the Ashlr Mission Control web UI in a
native window, manages the daemon lifecycle, and adds a system tray icon.

Targets: macOS (.dmg), Windows (.msi), Linux (.AppImage / .deb).
Approximate installed size: ~10–15 MB (Rust runtime + Bun SEA sidecar).

---

## Prerequisites

| Tool | Min version | Install |
|------|-------------|---------|
| Rust + Cargo | 1.77 | `curl https://sh.rustup.rs -sSf \| sh` |
| Tauri CLI | 2.x | `cargo install tauri-cli --version "^2"` |
| Bun _(for sidecar build)_ | 1.x | `curl -fsSL https://bun.sh/install \| bash` |
| Node.js _(optional, for npm scripts)_ | 18+ | https://nodejs.org |

Platform-specific system deps (WebKit, etc.) — follow the
[Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/).

---

## Development

```bash
# 1. Build the Bun SEA sidecar (only needed once, or after CLI changes)
cd ..                              # repo root
bun build --compile --outfile binaries/ashlr-raw src/cli/index.ts
cd desktop

# 2. Copy the sidecar binary into src-tauri/binaries/ with the correct triple suffix
node scripts/prepare-sidecar.mjs

# 3. Start Tauri in dev mode
#    This opens a native window that loads http://127.0.0.1:7777 once ready.
#    `ashlr serve` is spawned as a sidecar automatically.
cargo tauri dev
# or: npm run dev  (if @tauri-apps/cli npm package is installed)
```

> During dev, `tauri.conf.json` sets `devUrl` to `http://127.0.0.1:7777`.
> The Rust code waits for the port to accept connections before showing the window.

---

## Production Build

```bash
# 1–2. Same sidecar prep as above (bun build + prepare-sidecar.mjs)

# 3. Add real icons (see src-tauri/icons/PLACEHOLDER.md)

# 4. Build
cargo tauri build
# Bundles are output to: src-tauri/target/release/bundle/
#   macOS:   *.app + *.dmg
#   Windows: *.msi
#   Linux:   *.AppImage + *.deb
```

Debug build (skips optimizations, keeps console window on Windows):
```bash
cargo tauri build --debug
```

---

## Architecture

```
desktop/
├── src-tauri/
│   ├── src/main.rs          # Rust entry point — sidecar lifecycle + tray
│   ├── Cargo.toml           # tauri v2, tauri-plugin-shell, tray-icon feature
│   ├── build.rs             # Tauri code-gen hook
│   ├── tauri.conf.json      # App metadata, bundle targets, CSP, externalBin
│   ├── capabilities/
│   │   └── main.json        # Tauri v2 permission grants for the main window
│   ├── binaries/            # Triple-suffixed sidecar binary lives here (git-ignored)
│   └── icons/               # App + tray icons (must be added before build)
├── scripts/
│   └── prepare-sidecar.mjs  # Copies compiled ashlr binary → binaries/<triple>
└── package.json             # Optional npm wrapper around cargo tauri commands
```

### Sidecar Lifecycle

1. `main()` sets up Tauri then calls `setup()`.
2. `setup()` calls `app.shell().sidecar("ashlr").args(["serve"]).spawn()`.
   Tauri resolves `binaries/ashlr-<host-triple>` automatically.
3. A background thread calls `wait_for_server()` which polls `127.0.0.1:7777`
   via TCP every 250 ms for up to 30 s.
4. Once the port accepts a connection, the main `WebviewWindow` is shown.
5. The `CommandChild` handle is stored in managed state.
6. On **Quit** (tray menu) the child is `.kill()`-ed before `app.exit(0)`.
7. The X/close button on the window calls `api.prevent_close()` + `win.hide()`
   so the app keeps running in the tray — the only way to fully quit is via
   the tray menu.

### Tray Menu

| Item | Action |
|------|--------|
| Open Dashboard | Show + focus the main window |
| Start Daemon | Runs `ashlr daemon start` via sidecar |
| Stop Daemon | Runs `ashlr daemon stop` via sidecar |
| Kill Switch: OFF/ON | Touches / removes `~/.ashlr/KILL`; label updates live |
| Quit Ashlr | Kills sidecar, exits app |

### Security Posture

- The webview's `url` and `devUrl` are both `http://127.0.0.1:7777` — no
  remote origin is ever loaded.
- The CSP in `tauri.conf.json` restricts `default-src`, `connect-src`,
  `script-src`, `style-src`, `img-src`, and `font-src` to `self` and
  `http://127.0.0.1:7777` only.
- `shell.open` is `false` in `tauri.conf.json` — the app cannot open arbitrary
  URLs in the user's browser.
- `externalBin` is limited to the single `binaries/ashlr` sidecar.
- Tauri's IPC bridge is not exposed to the webview (no `invoke` calls from the
  frontend) — the web UI communicates solely over the existing ashlr HTTP/WS
  API on localhost.

---

## Open Items (required for a shippable build)

### 1. Bundled Runtime — CRITICAL

**Problem:** The existing `bin/ashlr` is a Node.js shebang script.  Shipping
it as the sidecar would require Node.js to be installed on the end-user's
machine, defeating the purpose of the desktop app.

**Decision needed:** Bun SEA (preferred) or Node.js SEA.

#### Option A — Bun `--compile` (recommended)
```bash
bun build --compile --outfile binaries/ashlr-raw src/cli/index.ts
```
Produces a single ~10 MB native binary per platform.  Bun embeds its own
JS/TS runtime.  No Node required at runtime.

Requires:
- Confirming `src/cli/index.ts` is the correct entry point for the CLI.
- Cross-compilation: run on each target OS in CI (or use Bun's upcoming
  cross-compile flag once stable).

#### Option B — Node.js SEA (Node 21+)
See `sea-config.json` approach in https://nodejs.org/api/single-executable-applications.html.
Heavier (~30 MB) and more steps.

**TODO:** Wire chosen approach into GitHub Actions (`.github/workflows/release.yml`).

### 2. App Icons

All files in `src-tauri/icons/` are placeholders.  See
`src-tauri/icons/PLACEHOLDER.md` for exact size/format requirements.

Quick start: design a source SVG, then:
```bash
cargo tauri icon path/to/icon.svg
```

The tray icon (`tray-icon.png`, 22×22 px, monochrome) must be added manually
after running `cargo tauri icon`.

### 3. Code Signing & Notarization

| Platform | Requirement |
|----------|-------------|
| macOS | Apple Developer ID Application certificate + `xcrun notarytool` notarization.  Without this, Gatekeeper blocks the .dmg on end-user machines. |
| Windows | EV code-signing certificate + timestamp server.  Without this, SmartScreen shows a warning on first run. |
| Linux | Optional; .AppImage and .deb work unsigned. |

Set `signingIdentity` in `tauri.conf.json` (macOS) and
`certificateThumbprint` (Windows) once you have certs.

### 4. Auto-Update

Tauri ships `tauri-plugin-updater`.  Wire it to the GitHub Releases feed from
`.github/workflows/release.yml` so the app can self-update.

### 5. CI Pipeline

Add a matrix build job to `.github/workflows/release.yml` that:
1. Builds the Bun SEA for each target (macOS x64+arm64, Windows x64, Linux x64).
2. Runs `prepare-sidecar.mjs` with the correct `--target` triple.
3. Runs `cargo tauri build`.
4. Uploads `.dmg` / `.msi` / `.AppImage` as release assets.

---

## Troubleshooting

**Window never appears / stuck on spinner**
- The server may not have started.  Check the terminal for `[ashlr-desktop]`
  sidecar stdout/stderr lines.
- Confirm `ashlr serve` works manually: `ashlr serve` → visit `http://127.0.0.1:7777`.

**"sidecar not configured" panic**
- The `binaries/ashlr-<triple>` file is missing.  Run `prepare-sidecar.mjs`.

**`cargo tauri dev` fails with icon errors**
- Add placeholder PNGs to `src-tauri/icons/` (see PLACEHOLDER.md) or run
  `cargo tauri icon` with a source SVG.

**macOS: app quarantined after build**
- Expected without notarization.  For dev testing: `xattr -dr com.apple.quarantine Ashlr.app`.
