# Ashlr Desktop

A source-only Tauri v2 desktop app that wraps **Ashlr Verse** (the operator
console at `/verse/`, see `../docs/VERSE.md`) in a native macOS window. It is
not a public or commissioned desktop product, and it does not activate the
dormant daemon.

Public desktop releases and installers: none. The desktop release workflow is
externally disabled during the Linux quarantine, and any future workflow output
is draft-only. The Linux CLI and web dashboard remain supported.
Installed size: ~110 MB (Rust WebView runtime + the bundled Bun `ashlr` sidecar
~90 MB + web assets).

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

To build one for yourself, see [Build an installable app](#build-an-installable-app).

---

## What it does

- Bundles the `ashlr` CLI binary as a sidecar — no separate Node.js or npm install needed.
- Opens a small **launch window** immediately, so the app is never an invisible
  process while the server boots. It shows what is happening, and if the server
  never comes up it says exactly why (see [Launch states](#launch-states)).
- Starts `ashlr verse --port 7777 --no-open --json`, reads the tokens it prints,
  and then shows the **Ashlr Verse** window at `http://127.0.0.1:7777/verse/`
  with those tokens already handed to the page (see [Token handoff](#token-handoff)).
- Presents a real macOS menu bar, an overlay title bar with the traffic lights
  inset into the console's own header strip, and remembers where the window was.
- Closing the Verse window hides it to the menu-bar (tray) item. **Quit** — from
  ⌘Q, the Ashlr menu, or the tray — kills the sidecar and exits. No resident
  daemon is started.
- On first launch the app invokes `ashlr setup --yes`, but the current CLI
  refuses before config, discovery, enrollment, or service effects. The banner
  is not evidence of completed setup.

---

## Desktop shell contract

This is the **entire** native→web surface, and the only thing the web UI (owner
C) has to adopt. It is implemented in `src-tauri/src/shell_contract.rs` +
`shell_contract.js`, injected into the Verse page before any page script runs,
and gated to the sidecar origin. Everything here is inert in a browser, so the
web UI needs no conditional build — only CSS fallbacks.

### 1. Shell markers

`<html>` gets:

| Attribute | Value in the desktop app | Value in a browser |
|---|---|---|
| `data-app-shell` | `"desktop"` | absent |
| `data-app-platform` | `"macos"` | absent |

and these CSS custom properties are set on `:root`:

| Variable | Value | Meaning |
|---|---|---|
| `--app-titlebar-height` | `48px` | Height of the strip at the very top of the window that the OS title bar overlays. Deliberately equal to the 48px header strip in `docs/VERSE-DESIGN-V2.md` §4, so the header strip *is* the title bar. |
| `--app-traffic-light-inset` | `92px` | Width at the top-**left** that must stay clear of interactive controls, because the macOS traffic lights float there. Wider than the 56px rail on purpose — the three buttons plus their inset overrun it. |

**What owner C needs to do.** Always read these with a `0px` fallback so the
browser layout is unchanged:

```css
/* Rail: push the brand mark below the traffic lights. */
.rail { padding-top: var(--app-titlebar-height, 0px); }

/* Header strip: nothing interactive in the top-left corner. */
.headerStrip { padding-left: var(--app-traffic-light-inset, 0px); }
```

Under `[data-app-shell="desktop"]` the rail's first 48px and the top-left 92px
must contain no button, link, or input.

### 2. Drag regions

Mark the strip that should move the window:

```html
<header class="headerStrip" data-app-region="drag"> … </header>
```

- `data-app-region="drag"` — this element **and its subtree** drag the window.
  Double-clicking it zooms the window, matching macOS.
- `data-app-region="no-drag"` — opt a subtree back out (a toolbar inside the
  strip, say). Buttons, links, inputs, `[contenteditable]` and anything with a
  `role` of button/link/menuitem/tab/checkbox/radio/switch/option are **already**
  excluded automatically — you rarely need this.

The shell mirrors these onto Tauri's own `data-tauri-drag-region` (including for
elements React renders later, via a `MutationObserver`), so the web UI never
references Tauri. In a browser the attribute does nothing.

Recommended: put `data-app-region="drag"` on the rail's top 48px **and** the
main header strip, so the whole top edge of the window drags.

> Caveat inherited from `TitleBarStyle::Overlay`: a drag region cannot move the
> window while the window is unfocused (tauri-apps/tauri#4316). First click
> focuses, second click drags.

### 3. Menu commands (native → page)

The menu bar dispatches a window event. No Tauri API, no IPC:

```ts
window.addEventListener('ashlr:desktop-command', (e) => {
  switch ((e as CustomEvent<{ command: string }>).detail.command) {
    case 'open-settings': setActiveSection('settings'); break;
    case 'toggle-theme':  toggleTheme(); break;
  }
});
```

| Command | Sent by |
|---|---|
| `open-settings` | **Ashlr → Settings…** (⌘,) |
| `toggle-theme` | **View → Toggle Light / Dark** (⇧⌘L) |

`open-settings` is the ⌘, wiring the contract asks for. If the web UI does not
listen, the menu item is simply inert — nothing breaks.

### 4. Theme reporting (page → native, optional but wanted)

```ts
window.__ASHLR_DESKTOP__?.reportTheme(resolvedTheme); // 'light' | 'dark'
```

Call it once the theme resolves and on every change. The native window stores it
next to the window geometry and paints the window background with the matching
canvas colour (`#0b0b0d` dark / `#fafafa` light) **before the webview has
painted** on the next launch. Without this call the app falls back to the macOS
appearance, which is wrong whenever the user has forced a theme inside Verse —
and that is exactly when a white flash is most jarring. Repeat calls with the
same value are dropped.

`window.__ASHLR_DESKTOP__` also exposes `shell`, `platform`, `version`,
`titlebarHeight`, `trafficLightInset`. Its absence is how the UI detects a
browser.

### 5. Keyboard split

Native claims ⌘, ⌘R ⌘+ ⌘− ⌘0 ⇧⌘L and the standard Edit/Window set. **⌘1–⌘5, ⌘K
and ⌘N are deliberately left unbound natively** so they reach the page, which
owns them per `docs/VERSE-CONTRACT-V2.md`. A native accelerator would swallow
them before the webview ever saw the keystroke — `app_menu.rs` has a test that
fails if one is ever added.

---

## Window behaviour

- **Overlay title bar, hidden title.** `titleBarStyle: "Overlay"` +
  `hiddenTitle: true`; the traffic lights are inset to (18, 18) so they sit
  vertically centred in the 48px strip.
- **Size and position are remembered** in `~/.ashlr/desktop/window-state.json`
  (geometry and last theme only — nothing else). Restored geometry is clamped to
  the monitors that exist at launch: a window saved on a display that is now
  unplugged re-centres instead of opening off-screen.
- **Minimum size 900 × 620**, matching the 900px floor the design language
  requires the layout to work at.
- **No white flash**: the window background is painted with the theme canvas
  before the page loads.

### Launch states

| State | What you see |
|---|---|
| Starting | Brand mark, "Starting Ashlr Verse", an indeterminate hairline. |
| Port in use | "Port is already in use", the `lsof -ti tcp:7777` command to find the holder, and three buttons: **Use the server that is already running** (opens the console against it — you paste its read token once), **Try again**, **Quit**. |
| Sidecar failed to spawn | The spawn error, and the `prepare-sidecar.mjs` fix. |
| Sidecar exited early | The exit code plus the last few output lines. |
| Timed out (30 s) | Says the server never reported listening, and how to reproduce in a terminal. |

Diagnostics shown there are redacted by `launch_state::redact_diagnostic`: any
line containing `token`, `secret`, `password`, `api_key`, `authorization`,
`bearer` or `credential`, and **any JSON object or array at all** (the startup
record is a JSON object), is dropped rather than displayed.

### Menu bar

| Menu | Items |
|---|---|
| **Ashlr** | About Ashlr · Settings… ⌘, · Services · Hide ⌘H / Hide Others / Show All · Quit Ashlr ⌘Q |
| **Edit** | Undo ⌘Z · Redo ⇧⌘Z · Cut ⌘X · Copy ⌘C · Paste ⌘V · Select All ⌘A |
| **View** | Reload ⌘R · Toggle Light / Dark ⇧⌘L · Zoom In ⌘= / Zoom Out ⌘− / Actual Size ⌘0 · Toggle Full Screen |
| **Window** | Minimize ⌘M · Zoom · Close ⌘W |

The Edit menu is not decoration: without it WKWebView has nothing to claim ⌘C /
⌘V / ⌘Z, and copy, paste and undo silently do nothing in the composer.

Zoom is clamped to 0.5×–2.0× in 0.1 steps and snaps back to exactly 1.0.

### Tray (menu-bar) item

| Item | Action |
|------|--------|
| Show Ashlr Verse | Show + focus the window |
| Quit Ashlr | Kills the sidecar, exits |

Left-clicking the tray icon toggles the window.

Daemon start/stop and the kill switch are deliberately **not** here. The kill
switch writes the global `~/.ashlr/KILL`, which is an emergency stop that also
refuses the agent's own write tools — far too much blast radius for a menu item
you can hit by accident. Both live in the console's Autonomy section behind a
confirm step.

---

## Token handoff

`ashlr serve` protects reads with a per-process read token and mutations with a
separate mutation token, both printed once at startup. The desktop app never
asks you to paste them:

1. The sidecar runs `ashlr verse --port 7777 --no-open --json` (= serve with
   dispatch enabled) and prints one JSON line
   `{"url","port","allowDispatch","readToken","token",...}` on stdout once it is
   listening.
2. `main.rs` parses that line (`parse_startup_line`), keeps `readToken` and
   `token` in memory, and drops the line — it is not forwarded to the
   `sidecar-stdout` event bus, never written to stderr, and never reaches the
   launch window.
3. The Verse window is declared in `tauri.conf.json` with `"create": false` and
   built with `WebviewWindowBuilder::from_config(..).initialization_script(..)`.
   The script (`shell_contract.rs`) runs before any page script and sets
   `window.__ASHLR_TOKENS__ = Object.freeze({ readToken, token })`, guarded by
   `window.location.origin === "http://127.0.0.1:7777"`. Values are JSON-encoded
   into a config object, never interpolated. `SessionGate` reads the global to
   establish the read session; the mutation dialog uses `token`.
4. Fallbacks: if the bundled CLI exits before printing the record (no `verse`
   command yet) the app retries once with
   `ashlr serve --port 7777 --allow-dispatch --json`. If the server is listening
   but never printed a record, the window opens token-less and the SessionGate
   prompts as usual. If nothing is listening at all, the launch window shows the
   timeout state rather than a spinner.

---

## Security posture

- The Verse window only ever loads `http://127.0.0.1:7777` — no remote origins.
- Tokens reach the page only through the origin-gated initialization script
  above; they are never logged, persisted, or emitted as events.
- CSP restricts `default-src`, `connect-src`, `script-src`, `style-src`,
  `img-src`, and `font-src` to `self` and `http://127.0.0.1:7777`.
- `shell.open` is disabled — the app cannot open arbitrary URLs in the browser.
- **IPC granted to the remote page is exactly three commands**, in
  `capabilities/verse-remote.json`: `core:window:allow-start-dragging`,
  `core:window:allow-internal-toggle-maximize`, `core:event:allow-emit`. That is
  what makes the drag region and `reportTheme` work. Every `shell:*` permission,
  the updater, the filesystem, and app show/hide are **excluded**, so an XSS in
  the console cannot become command execution. Do not widen this list; put new
  native behaviour behind a window event evaluated from Rust instead
  (`shell_contract::command_script`).
- The launch window is a local bundled page and has its own capability
  (`capabilities/launch.json`) limited to the event channel its buttons use.

---

## Build an installable app

> **Linux desktop quarantine:** every fresh Tauri dev, debug, release, and
> direct Cargo source build targeting Linux fails in `src-tauri/build.rs` before
> `tauri_build::build()`. Tauri v2 currently resolves GTK3 and vulnerable
> `glib 0.18.5` (`GHSA-wrw7-89jp-8q8g` / `RUSTSEC-2024-0429`). This does not
> block the root `ashlr` CLI, Bun sidecar, or web dashboard on Linux.
> Default Tauri configuration also disables Linux bundling and runs a
> fail-closed pre-bundle policy (`scripts/assert-desktop-bundle-policy.mjs`,
> wired as `beforeBundleCommand`), covering the official workflow and ordinary
> `cargo tauri build`, `--debug`, and direct `--bundles` paths. A hostile
> `--config` override combined with an already-built/staged executable is
> outside source-build enforcement; never treat artifacts from a custom config
> or a non-fresh build tree as admitted release output.

### Prerequisites

| Tool | Version used | Install |
|------|--------------|---------|
| Rust + Cargo | 1.95 (min 1.85) | `curl https://sh.rustup.rs -sSf \| sh` |
| Tauri CLI | 2.10.1 (2.x) | `cargo install tauri-cli --version "^2"` |
| Bun | 1.x | `curl -fsSL https://bun.sh/install \| bash` |
| Node.js | 18+ | https://nodejs.org |
| Xcode command line tools | — | `xcode-select --install` |

### The exact steps on this Mac

```sh
# 0. From the repo root.
cd /Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub

# 1. Build the web UI and compile the CLI into a single Bun executable.
#    `npm run build:binary` runs `npm run build` first.
npm ci
npm run build:binary                        # → dist-bin/ashlr + dist-bin/public/

# 2. Stage the sidecar and the web assets for the host triple.
node desktop/scripts/prepare-sidecar.mjs    # → desktop/src-tauri/binaries/ashlr-aarch64-apple-darwin
                                            #   desktop/src-tauri/resources/public/

# 3. (Once, or after editing icons/icon.svg.)
cd desktop && npm run icons                 # = cargo tauri icon src-tauri/icons/icon.svg

# 4. Release build — the .app and the .dmg.
cd desktop && cargo tauri build
```

Output under `desktop/src-tauri/target/release/bundle/`:

- `macos/Ashlr.app` — the installable app
- `dmg/Ashlr_0.1.0_aarch64.dmg` — the disk image

A debug bundle (unoptimized, faster to build, under `target/debug/bundle/`):

```sh
cd desktop && cargo tauri build --debug
```

> `npm run build` at the **repo root** cannot pass on this machine: its
> dependency-inventory step rejects the global npm's symlinks. That is
> environmental and unrelated to the desktop app. `npm run build:binary`
> depends on it, so if it trips, run the web build (`npm run build:web`) and the
> Bun compile step directly.

### Is the DMG step broken?

**No — not on this machine, as of this build.** `cargo tauri build` completes
`Bundling Ashlr.app` → `Bundling Ashlr_0.1.0_aarch64.dmg` → `Running
bundle_dmg.sh` → `Finished 2 bundles` with exit code 0, on a cold release
target, in about a minute. Nothing in this repo's configuration was changed to
achieve that.

If `bundle_dmg.sh` *does* fail for you, it is almost always environmental, and
the cause is one of these — check them in order:

1. **A previous `Ashlr` volume is still mounted.** `bundle_dmg.sh` fails to
   attach a second image with the same volume name.
   `hdiutil detach /Volumes/Ashlr` (or check `mount | grep Ashlr`), then rebuild.
2. **No window-server session.** The script drives Finder over AppleScript to
   lay out the disk-image window. Over plain SSH, in a locked screen session, or
   in CI without a GUI login, the AppleScript step errors with
   `execution error: Finder got an error`. Build from a logged-in graphical
   session, or produce only the app bundle: `cargo tauri build --bundles app`.
3. **Terminal lacks Automation (Apple Events) permission for Finder.** System
   Settings → Privacy & Security → Automation → your terminal → enable Finder.
   The failure looks like `Not authorized to send Apple events to Finder`.
4. **A stale `bundle/dmg/` directory** from an interrupted run. Remove
   `desktop/src-tauri/target/release/bundle/dmg/` and rebuild.

None of these is fixable in our configuration, which is why nothing was changed
for them. The bundle-policy assertion is untouched.

### First open on an unsigned build (Gatekeeper)

Locally built apps are **unsigned and un-notarized**. macOS will refuse the
first open with *"Ashlr" cannot be opened because the developer cannot be
verified* — or, if you opened it from the DMG you just built, *"Ashlr" is
damaged and can't be opened*, which is the same quarantine flag with a worse
message.

Do this once, after copying `Ashlr.app` to `/Applications`:

- **Right-click (or Control-click) `Ashlr.app` → Open**, then click **Open** in
  the dialog. macOS remembers the exemption; ordinary double-clicks work after
  that.
- If macOS shows no **Open** button at all (Sequoia and later often do not),
  open **System Settings → Privacy & Security**, scroll to the message about
  Ashlr being blocked, and click **Open Anyway**.
- Or strip the quarantine attribute directly:
  ```sh
  xattr -dr com.apple.quarantine /Applications/Ashlr.app
  ```

This is expected for any unsigned build and is not a bug in the app. It goes
away only with an Apple Developer ID signature plus notarization, which is out
of scope here (see [Auto-update](#auto-update-tauri-updater-plugin) for where
signing secrets would go).

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
policy must be retired in the same reviewed change.

After the quarantine exit review and external re-enablement, code-signing may be
configured with `APPLE_CERTIFICATE` / `APPLE_ID` / `APPLE_TEAM_ID` for notarized
macOS drafts and `WINDOWS_CERTIFICATE` for Authenticode-signed Windows drafts.
Unsigned workflow output must remain a private draft and is never a current
download claim.

---

## Auto-update (Tauri updater plugin)

The app checks for updates on every launch via `tauri-plugin-updater`. It is
**inert by default** — the build succeeds without any signing key and the check
fails silently (no crash, no blocking).

To activate it:

1. `cargo tauri signer generate` — save both keys.
2. Replace the `plugins.updater.pubkey` placeholder in
   `desktop/src-tauri/tauri.conf.json` with the public key (a long base64 string
   starting `dW50cnVzdGVkIGNvbW1lbnQ6`).
3. Add repository secrets `TAURI_SIGNING_PRIVATE_KEY` and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. After quarantine clearance, push a `desktop-v*` tag. Do **not** do this while
   workflow 301689703 is disabled.

At runtime the check hits
`https://github.com/ashlrai/ashlr-hub/releases/latest/download/latest.json`; an
available, signature-verified update downloads in the background and emits
`ashlr-update-installed`. The user restarts to apply it. Signature verification
happens at runtime, not at build time, so the placeholder key never breaks a
build.

---

## Architecture

```
desktop/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs                # sidecar lifecycle, launch window, Verse window, tray, exit
│   │   ├── shell_contract.rs      # the native→web contract (+ shell_contract.js)
│   │   ├── shell_contract.js      # injected: tokens, CSS vars, drag regions, command bus
│   │   ├── app_menu.rs            # macOS menu bar, zoom, menu routing
│   │   ├── launch_state.rs        # launch phases, failure copy, diagnostic redaction
│   │   ├── window_state.rs        # geometry + theme persistence, monitor clamping
│   │   ├── lib.rs                 # native-only foundations, not wired into the UI
│   │   └── native_launchd_broker.rs
│   ├── Cargo.toml                 # tauri v2, tauri-plugin-shell, tauri-plugin-updater
│   ├── tauri.conf.json            # windows (main + launch), CSP, bundle targets, externalBin
│   ├── capabilities/
│   │   ├── main.json              # local grants for the main window
│   │   ├── launch.json            # local grants for the launch window
│   │   └── verse-remote.json      # the three commands the remote Verse page may call
│   ├── binaries/                  # triple-suffixed sidecar binary (git-ignored)
│   └── icons/                     # app + tray icons (icon.svg source; `npm run icons`)
├── dist-placeholder/index.html    # the launch window's page (also Tauri's frontendDist)
├── scripts/
│   ├── prepare-sidecar.mjs        # dist-bin/ashlr → binaries/<triple>, dist-bin/public → resources/
│   └── assert-desktop-bundle-policy.mjs   # beforeBundleCommand: refuses Linux bundling
└── package.json                   # npm wrapper for cargo tauri commands
```

### Lifecycle

1. Restore `~/.ashlr/desktop/window-state.json`; build the menu bar; open the
   launch window with a theme-matched background.
2. If `~/.ashlr/.desktop-initialized` is absent, invoke `ashlr setup --yes`
   (the current CLI refuses before config or service work).
3. Probe `127.0.0.1:7777`. Already open → the port-in-use launch state.
4. Spawn `ashlr verse --port 7777 --no-open --json` (falling back once to
   `ashlr serve --port 7777 --allow-dispatch --json`).
5. On the JSON startup record: build the Verse window with the restored
   geometry, the inset traffic lights and the shell-contract script, then close
   the launch window. No record within 30 s → the timeout launch state.
6. Window moves and resizes are written back (throttled), and on every exit.
7. The window's close button hides it to the tray. **Every** exit path — ⌘Q,
   the Ashlr menu, the tray, a signal — reaps the sidecar in
   `RunEvent::ExitRequested | RunEvent::Exit`, so no orphan `ashlr verse` is
   left behind.

### Tests

```sh
cd desktop/src-tauri && cargo test
```

Covers the startup-record parser and the guarantee that the token line is never
forwarded, the shell contract's origin gate and JSON encoding, drag-region
mapping, launch-state copy and redaction, window-state clamping across monitor
changes, zoom stepping, and the assertion that the native menu never claims a
shortcut the web UI owns.

---

## Troubleshooting

**The launch window says the port is in use**
Something else holds 7777. `lsof -ti tcp:7777` names it. If it is your own
`ashlr verse`, press **Use the server that is already running** and paste its
read token once.

**Window never appears**
Look for `[ashlr-desktop]` lines on stderr. Reproduce the server on its own:
`ashlr verse --no-open` → visit `http://127.0.0.1:7777/verse/`.

**"sidecar not configured" panic**
`binaries/ashlr-<triple>` is missing. Run `node desktop/scripts/prepare-sidecar.mjs`
from the repo root.

**`cargo tauri dev` fails with icon errors**
Run `npm run icons` from `desktop/`.

**`cargo check` / build fails with `resource path binaries/ashlr-<triple> doesn't exist`**
Tauri's build script requires the sidecar to be staged even for a type-check.
Run `node desktop/scripts/prepare-sidecar.mjs` from the repo root.

**Window opens on the SessionGate asking for a token**
The sidecar did not print its startup record, or you adopted a server this app
did not start. The fallback order is `ashlr verse` → `ashlr serve --allow-dispatch`.

**Copy/paste does nothing in the composer**
That was the symptom of a missing Edit menu. If it recurs, the menu bar failed
to build — check stderr at startup.

**The window opens on the wrong screen or at the wrong size**
Delete `~/.ashlr/desktop/window-state.json` and relaunch.

**macOS: app quarantined after a local build**
Expected without notarization — see
[First open on an unsigned build](#first-open-on-an-unsigned-build-gatekeeper).
