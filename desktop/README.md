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

### Installing the build you make yourself

That policy is about *publishing*. Building Ashlr for your own Mac and keeping
it in the Dock is supported and is what the rest of this document describes:

1. [Build it](#the-exact-steps-on-this-mac) — `cargo tauri build`.
2. Copy it into place, replacing any previous copy:
   ```sh
   REPO=/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub
   rm -rf /Applications/Ashlr.app
   cp -R "$REPO/desktop/src-tauri/target/release/bundle/macos/Ashlr.app" /Applications/
   ```
3. Open it **once** with right-click → Open, because the build is unsigned —
   see [First open on an unsigned build](#first-open-on-an-unsigned-build-gatekeeper).
4. With Ashlr running, right-click its Dock icon → **Options → Keep in Dock**.

To update later, quit Ashlr, repeat steps 1–2, and launch again. The
right-click-Open exemption is remembered per app path, so a rebuild copied over
`/Applications/Ashlr.app` normally opens straight away; if a macOS update
resets that, do step 3 again. Nothing in `~/.ashlr` is touched by installing or
replacing the bundle — your config, seats and window state all survive.

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
- While the window is out of sight it keeps you informed (see
  [While Verse is hidden](#while-verse-is-hidden)): a native banner when a chat
  finishes or fails, or when something new needs you; `● N` in the menu bar
  while chats run; a Dock badge counting Needs-you items; and an opt-in
  ⌃⌥Space that brings the window forward from any app.
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
| `open-needs-you` | Tray **Needs you…**; a clicked "Needs you" or seat-health banner |
| `new-chat` | Tray **New chat** |
| `focus-composer` | The global hotkey ⌃⌥Space |
| `open-session:<id>` | A running chat in the tray; a clicked "Finished" / "Failed" banner. `<id>` matches `^[A-Za-z0-9._-]{1,128}$` — Rust checks it before building the command. |

The names are the command catalog's `DESKTOP_COMMAND_NAMES`
(`src/web-ui/routes/verse/shell/command-catalog.ts`); `parseDesktopCommand`
turns each into a catalog command, and `app/desktop-shell.ts` →
`subscribeShellCommands` delivers them parsed. If the web UI does not listen,
the item is simply inert — nothing breaks.

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
fails if one is ever added, and the web catalog's key test parses `app_menu.rs`
for the same reason. The one system-wide key, ⌃⌥Space, is registered by the app
(`hotkey.rs`), never by the page; a vitest checks it equals the catalog's
`app.summon`.

### 6. Desktop state (Settings ▸ Desktop)

```ts
import { useDesktopState, setDesktopPreference } from '../app/desktop-shell.js';

const desktop = useDesktopState(); // null in a browser
// desktop.hotkey        { enabled, registered, accelerator: '⌃⌥Space', error }
// desktop.notifications { enabled, delivery: 'native' | 'script' }
setDesktopPreference('globalHotkey', true); // false in a browser
```

- The page asks by emitting `shell-prefs` (`{ globalHotkey?: bool,
  notifications?: bool }`) over the event permission it already has. Rust parses
  it strictly — an object, those two keys, booleans only — persists it to
  `~/.ashlr/desktop/prefs.json` (0600), applies it and answers with a new state.
- **Render from the answer, not from what you asked for.** A hotkey another app
  already holds comes back `enabled: true, registered: false` with an
  operator-language `error`.
- `delivery: 'script'` means an unsigned build: banners arrive through
  `osascript` and show as Script Editor. Say so beside the toggle.
- The init script carries the state from window creation; on load the page
  also emits `shell-state-request` and gets the live one, so a reload after a
  change is never stale.

---

## Window behaviour

- **Overlay title bar, hidden title.** `titleBarStyle: "Overlay"` +
  `hiddenTitle: true`; the traffic lights are inset to (18, 18) so they sit
  vertically centred in the 48px strip.
- **Size and position are remembered** in `~/.ashlr/desktop/window-state.json`
  (geometry and last theme only — nothing else). Restored geometry is clamped to
  the monitors that exist at launch: a window saved on a display that is now
  unplugged re-centres instead of opening off-screen. The monitor list is read
  from the `AppHandle`, not from the launch window — that window is on its way
  out when the geometry is restored, and is already gone on the crash-recovery
  path, which made the saved position silently vanish.
  `app.windows[0].center` in `tauri.conf.json` is deliberately **`false`**: a
  config-level `center: true` is applied *after* the builder's `.position()` and
  quietly discards the restored position. Centring is done in `main.rs`, only
  when there is nothing to restore. Turning that config flag back on re-breaks
  position restore with no error anywhere.
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

There is no state in which the window spins forever: every path ends in either
the Verse window or one of the four failure states above, within 30 seconds.

The failure window is sized to its content — the port-conflict state carries no
sidecar output and gets a short window, the states that do carry diagnostics get
a taller one.

**A lease held by `ashlr resource-console`.** The account collector takes a
lease in `~/.ashlr` while it refreshes seat quotas. If `ashlr resource-console`
already holds it, `ashlr verse` does *not* fail — the lease is declared
read-only-safe, so the server still starts and the console shows the seats it
can read. If the collector instead refuses to start, the sidecar exits and you
get **Sidecar exited early** with its own last lines, which name the lease. The
app does not invent a lease-specific screen for a case the CLI degrades through.

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

### The sidecar never outlives the window

Closing the Verse window hides it to the tray. **Quitting** stops the sidecar.
Three exit paths have to leave a clean machine behind, and only the first of
them gets a turn in Tauri's event loop — `src-tauri/src/sidecar_guard.rs` covers
the other two:

| How the app ends | What reaps the sidecar |
|---|---|
| ⌘Q, the Ashlr menu, the tray's Quit | `RunEvent::Exit` → `reap_sidecar`, which kills the sidecar **and its worker children** (the Bun binary runs its projection/background workers as separate processes that hold file locks in `~/.ashlr`). |
| A signal — `pkill`, `kill`, Ctrl-C on a foreground run | An async-signal-safe handler kills the recorded pid, then `_exit`s. |
| SIGKILL or a crash — nothing of ours runs | The **next launch** repairs it. Before the port is probed, the ownership record written at spawn time is read back; if the app that wrote it is gone while its sidecar is still alive, that sidecar is orphaned and is killed. |

Without the third row, one crash left `ashlr verse` holding 127.0.0.1:7777
forever and every relaunch landed on the port-conflict screen — honest, but a
broken app.

The record is `~/.ashlr/.desktop-sidecar.json`: two pids, a port, and the
sidecar's own path. **No token can be in it** — a test asserts the shape has
exactly those four fields. Nothing is killed unless *all four* of these hold:
the record names the port we are about to bind, the desktop pid that wrote it is
dead, the recorded sidecar pid is alive, and that pid's argv still starts with
our own sidecar binary path. The last one is what makes pid recycling harmless:
a recycled pid belongs to some other program, whose argv is not our sidecar.

To check for yourself after quitting:

```sh
pgrep -fl "Contents/MacOS/ashlr verse"   # expect: no output
lsof -ti tcp:7777                        # expect: no output
```

### Tray (menu-bar) item

| Item | Action |
|------|--------|
| Running › ‹chat› | One row per running chat (up to 8, then "N more running"): shows the window and opens that chat |
| Needs you (N)… | Shows the window and opens the Needs-you drawer |
| New chat | Shows the window and starts a chat |
| Stop running chats… | A native confirm ("Stop every running chat?"), then cancels each running turn with the mutation token. Disabled when nothing runs, or when the window adopted a server Ashlr did not start (no mutation token). Queued follow-ups are held, not sent. |
| Show Ashlr Verse | Show + focus the window |
| Quit Ashlr | Kills the sidecar, exits |

The menu-bar title reads `● N` while N chats run and is empty otherwise.
Left-clicking the tray icon toggles the window; clicking the Dock icon while
the window is closed brings it back.

The shell adopts the tray icon `tauri.conf.json` declares (`app.trayIcon`,
id `main`) instead of building a second one — it used to build its own, which
put two icons in the menu bar.

Daemon start/stop and the kill switch are deliberately **not** here. The kill
switch writes the global `~/.ashlr/KILL`, which is an emergency stop that also
refuses the agent's own write tools — far too much blast radius for a menu item
you can hit by accident. Both live in the console behind a confirm step. The
tray may stop **chats**; it never stops, starts or steers the fleet (a
`tray.rs` test pins that no row names the fleet, the daemon, the kill switch or
autonomy).

### While Verse is hidden

`activity_watch.rs` polls `GET /api/verse/activity?since=<cursor>` with the read
token, through the same tiny loopback client as the health poll: every **5 s**,
or every **30 s** while the window is hidden and nothing is running (and while
the sidecar predates the route). One poll updates the tray, the Dock badge and
— only while the window is **not in front** (hidden, minimized, or another app
focused) and notifications are on — raises banners:

| Banner | When |
|---|---|
| Finished: ‹chat title› — "Done in 2m 14s" | A turn ended cleanly |
| Failed: ‹chat title› | A turn ended with an error |
| Finished: N chats, M failed | More than two turns ended in one poll |
| Needs you: N new — "2 approvals · 1 fleet decision" | New Needs-you items |
| Seat health (signed out, expiring, out of usage) | From the 30 s health poll |

- **Every word is a Rust template** (`notify.rs`). The only server text that can
  appear is a chat title, stripped of control and bidi-override characters and
  capped at 60 characters. Needs-you items are described by category counts,
  never by their own text.
- The first poll is a baseline: nothing that finished or was waiting before the
  app started raises a banner. A cancelled turn (yours, or the tray's Stop) is
  not news. A failure announced as "Failed" is not announced again when its
  Needs-you item lands. At most 6 banners a minute.
- **Clicks.** The notification plugin cannot report a click, so a banner arms
  its target; if the window gains focus within 60 s, the page gets
  `open-session:<id>` or `open-needs-you`. Focus regained for another reason
  inside that minute also navigates — the accepted trade. Any tray action or
  the hotkey clears the armed target first.
- **Signing.** A Developer ID–signed bundle delivers through
  `tauri-plugin-notification` (Ashlr's icon). Anything else — ad-hoc (every
  local `cargo tauri build`), unsigned, `cargo run` — uses `osascript` with the
  text as argv, because macOS can silently drop plugin banners from an app it
  cannot identify. Those banners show as Script Editor, and clicking one opens
  Script Editor rather than Ashlr; the tray and the Dock badge are the reliable
  signal on such builds. `codesign -dv` decides once per launch, off the main
  thread.
- The "local server keeps stopping" alert is the one banner that ignores focus:
  it is about the window itself.

The Dock badge is the Needs-you count (cleared at zero). The global hotkey
⌃⌥Space is **off by default** (it takes that chord from every other app);
Settings ▸ Desktop turns it on, and it shows the window and focuses the
composer from anywhere.

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
  what makes the drag region, `reportTheme` and `setPreference` work. The
  notification and global-shortcut plugins are driven from Rust only; neither is
  granted to any window, so page code cannot raise a banner, choose its text, or
  register a key.
- The **mutation token** is held in Rust for one purpose: the tray's "Stop
  running chats…" cancel POSTs, after a native confirm. Like the read token it
  lives only in memory and in a request header, and is dropped whenever its
  sidecar stops. Every `shell:*` permission,
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
> first in `beforeBundleCommand`; the macOS DMG preflight is chained after it
> with `&&`, so a refusal stops the bundle), covering the official workflow and
> ordinary `cargo tauri build`, `--debug`, and direct `--bundles` paths.
> A hostile `--config` override combined with an already-built/staged
> executable is outside source-build enforcement; never treat artifacts from a
> custom config or a non-fresh build tree as admitted release output.

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
#    beforeBundleCommand runs the bundle policy assertion, then dmg-preflight.
cd desktop && cargo tauri build
```

Timing on this Mac: about 6 minutes cold (the release profile is `lto = true`,
`codegen-units = 1`, `panic = "abort"`), about 90 seconds when only the bundling
needs to be redone. Nothing in step 4 needs the network.

> **Step 4 alone re-bundles stale web assets.** `cargo tauri build` ships
> whatever is sitting in `src-tauri/binaries/` and `src-tauri/resources/public/`.
> Those only change when steps 1–2 are re-run. After any change to `src/web-ui`
> or `src/core`, run steps 1–2 again or the new build will contain the old
> console. Check what you are about to ship with:
> ```sh
> ls -l desktop/src-tauri/resources/public/app.js   # is this newer than your edit?
> ```

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

**No.** `cargo tauri build` on this Mac completes `Bundling Ashlr.app` →
`Bundling Ashlr_0.1.0_aarch64.dmg` → `Running bundle_dmg.sh` → `Finished 2
bundles`, exit code 0, in about 90 seconds once the Rust crate is compiled.

It *had* failed, and the cause was leftover state rather than our configuration:

> Tauri bundles the DMG with a vendored fork of create-dmg (`bundle_dmg.sh`). It
> writes an interstitial read-write image next to the .app named
> `rw.<pid>.Ashlr_<version>_<arch>.dmg`, attaches it with
> `hdiutil attach -mountrandom /Volumes` (which mounts it as `/Volumes/dmg.XXXXXX`,
> **not** `/Volumes/Ashlr`), lays the window out, detaches, and compresses.
> Interrupt the build anywhere between the attach and the detach — a Ctrl-C, a
> killed parent, a timed-out agent step — and the volume stays mounted and the
> partial image stays on disk. The next build then fails without naming the real
> cause: `hdiutil attach` collides with the attached image, or `find_mount_dir`
> resolves the wrong device and the script exits 1 with *"unable to proceed with
> final disk image creation"*.

This repo was in exactly that state: `/Volumes/dmg.gQvqCb` was still attached
from an interrupted debug build, next to a 173 MB
`rw.34706.Ashlr_0.1.0_aarch64.dmg`. Detaching and deleting them made the release
DMG build on the first attempt.

So it is now cleaned up automatically. `scripts/dmg-preflight.mjs` runs as part
of `beforeBundleCommand`, detaches any attached image whose `image-path` is
inside **this repo's** `desktop/src-tauri/target` tree, and deletes partial
`rw.<pid>.*.dmg` files there. It touches nothing outside that tree, so a disk
image you have open from anywhere else is never detached. It is idempotent and
safe to run by hand:

```sh
cd desktop && node scripts/dmg-preflight.mjs
```

The bundle-policy assertion is **unchanged** and still runs first —
`beforeBundleCommand` is now
`node scripts/assert-desktop-bundle-policy.mjs && node scripts/dmg-preflight.mjs`,
so a refused Linux bundle still short-circuits before the preflight.

#### If it still fails: the Finder AppleScript

The one cause the preflight cannot fix is environmental. `bundle_dmg.sh` drives
**Finder over AppleScript** to position the icons in the disk-image window. That
needs an Aqua login session *and* Automation permission for whatever is running
the build. Over plain SSH, on a locked-out screen session, or in CI with no GUI
login, it fails with `execution error: Not authorized to send Apple events to
Finder. (-1743)` (or `Finder got an error`) and the bundler exits **64**.

Check whether your shell has the permission at all:

```sh
osascript -e 'tell application "Finder" to get name of startup disk'
```

If that errors, either grant it (System Settings → Privacy & Security →
Automation → your terminal → Finder) or skip the cosmetic step. There is no
Tauri config option for it; the switch is create-dmg's `--skip-jenkins`, which
the bundler passes **only when `CI` is set**:

```sh
cd desktop && CI=1 cargo tauri build
```

That produces a DMG with default icon positions and no custom window layout. The
`Ashlr.app` inside is identical either way. Prefer this over
`cargo tauri build --bundles app`, which skips the DMG entirely.

**The .app is the artifact that matters.** Even when the DMG step fails, the
bundler has already written
`target/release/bundle/macos/Ashlr.app` — it is complete and installable, and
the failure is only about the disk image wrapped around it.

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
│   │   ├── shell_contract.js      # injected: tokens, CSS vars, drag regions, command bus, desktop state
│   │   ├── app_menu.rs            # macOS menu bar, zoom, menu routing
│   │   ├── activity_watch.rs      # running chats / turn endings / Needs you → banners, tray, badge
│   │   ├── notify.rs              # banner templates, title sanitizer, focus gate, click targets, delivery
│   │   ├── tray.rs                # the tray menu as data, id routing, Stop copy
│   │   ├── hotkey.rs              # ⌃⌥Space (opt-in)
│   │   ├── desktop_prefs.rs       # Settings ▸ Desktop prefs + the state the page sees
│   │   ├── health_watch.rs        # seat health poll + the tiny loopback HTTP client
│   │   ├── launch_state.rs        # launch phases, failure copy, diagnostic redaction
│   │   ├── window_state.rs        # geometry + theme persistence, monitor clamping
│   │   ├── lib.rs                 # native-only foundations, not wired into the UI
│   │   └── native_launchd_broker.rs
│   ├── Cargo.toml                 # tauri v2 + shell, updater, dialog, notification, global-shortcut plugins
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
3. Reclaim a sidecar orphaned by a previous crash, if the ownership record
   names one (see [The sidecar never outlives the window](#the-sidecar-never-outlives-the-window)).
4. Probe `127.0.0.1:7777`. Already open → the port-in-use launch state.
5. Spawn `ashlr verse --port 7777 --no-open --json` (falling back once to
   `ashlr serve --port 7777 --allow-dispatch --json`), and write the ownership
   record.
6. On the JSON startup record: build the Verse window with the restored
   geometry, the inset traffic lights and the shell-contract script, then close
   the launch window. No record within 30 s → the timeout launch state.
7. Window moves and resizes are written back (throttled), and on every exit.
8. The window's close button hides it to the tray. **Every** exit path — ⌘Q,
   the Ashlr menu, the tray, a signal, or the next launch after a crash — reaps
   the sidecar and its worker children, so no orphan `ashlr verse` is left
   behind.

### Tests

```sh
cd desktop/src-tauri && cargo test
```

146 tests in the app plus 27 in the `lib` crate, and two `#[ignore]`d live checks
(`cargo test -- --ignored live_`) that poll a real, HOME-isolated sidecar for
seat health and activity and send the tray's cancel POST to a session that does
not exist (404 = the mutation gate passed; a wrong token is 401). They cover the notification
templates, the title sanitizer, the "only while unfocused" gate, the 60 s
click window and the `open-session:<id>` shape; the activity fold (baseline,
coalescing, de-duplication, cursor handling, poll rate); the tray's rows, id
routing and "never the fleet" rule; the hotkey chord; strict preference
parsing and 0600 persistence; the startup-record parser and the guarantee that the token
line is never forwarded, the shell contract's origin gate and JSON encoding,
drag-region mapping, launch-state copy and redaction, launch-window sizing,
window-state clamping across monitor changes, zoom stepping, the assertion that
the native menu never claims a shortcut the web UI owns, and the orphan-reclaim
decision — including that a live sibling app's sidecar is never killed, that a
recycled pid can never be mistaken for ours, and that the ownership record has
no field a token could hide in.

Nothing here spawns a server or reads `~/.ashlr`: every test is a pure decision
function, a JSON round-trip, a file round-trip under the OS temp dir, or a
one-shot loopback socket on an ephemeral port.

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

**An `ashlr verse` is still running after I quit**
It should not be — see
[The sidecar never outlives the window](#the-sidecar-never-outlives-the-window).
If one survives (say the app was SIGKILLed), the next launch kills it before
probing the port, so just launch Ashlr again. To clear it by hand:
`pkill -f "Contents/MacOS/ashlr verse"`.

**`cargo tauri build` fails at `bundle_dmg.sh`**
The `.app` is already built and installable; only the disk image failed. See
[Is the DMG step broken?](#is-the-dmg-step-broken). Run
`node scripts/dmg-preflight.mjs` and build again, or `CI=1 cargo tauri build` to
skip the Finder layout step.

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

## The open `glib` advisory, and why it stays open

Dependabot reports a moderate advisory against `glib` 0.18.5 in
`src-tauri/Cargo.lock` (unsoundness in the `Iterator` and `DoubleEndedIterator`
impls for `glib::VariantStrIter`), fixed upstream in 0.20.0. It is left open
deliberately, for two reasons that are worth writing down rather than
rediscovering every time the alert resurfaces.

**It is not reachable on macOS.** `glib` arrives through
`gtk` → `libappindicator` → `tray-icon` → `tauri`, all of which are Linux-only.
`cargo tree -i glib` on a Mac prints *nothing to print*; the crate has to be
asked for with `--target all` before it appears at all. The bundle in
`/Applications` never compiles it.

**We cannot move it.** The `gtk-rs` 0.18 line pins `glib` to 0.18, so
`cargo update -p glib` locks 0 packages and changes nothing. Reaching 0.20 means
`gtk` 0.19+, which is `tauri`'s dependency to raise, not ours. The alert lifts
when Tauri ships a release on the newer gtk-rs line.

If a Linux desktop build is ever produced from this directory, re-check this
first — the reasoning above stops holding the moment the Linux target is real.
