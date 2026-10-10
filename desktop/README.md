# Phantom Desktop

A Tauri v2 desktop app that wraps **Phantom** (the operator console at
`/verse/`, see `../docs/VERSE.md`) in a native macOS window. Opening it starts
the console; resident autonomy requires its separate local setup and grant.

Find the current qualified release at [GitHub releases](https://github.com/ashlrai/phantom/releases/latest).
Its macOS download is the signed arm64 `Phantom_<version>_aarch64.app.tar.gz`
archive, paired with [`latest.json`](https://github.com/ashlrai/phantom/releases/latest/download/latest.json),
rather than a DMG. These are update artifacts; downloading or unpacking them
alone does not perform the qualified installation described below.

### Consumer first install (source implementation)

The source includes `phm desktop install` for an empty Apple silicon Mac
installation. It is not included in the published release above, and acceptance
on a clean Mac remains unverified. After this command is published and accepted,
use the canonical CLI's matching release:

```sh
phm authority stop --json
phm desktop install           # downloads and verifies a fresh private stage
phm desktop install --apply   # fresh inspection, then explicit installation
```

Inspection preserves downloaded data under `~/.ashlr/updates/consumer-staging`;
it does not install, stop work or create command links. Apply requires absent
`Phantom.app`/`Ashlr.app`, managed current pointer and both managed command links.
It verifies the original signed app and paired npm archive, keeps Stop engaged,
and never builds, re-signs, creates a signing key or resumes the fleet.

Installation acceptance and shell setup are separate results. The exact managed
CLI must report the matching version. An unrelated global npm command, missing
command or unknown login-shell target reports `shell-setup-required`; the
installer does not rewrite global aliases, PATH or shell profiles. Native updates
use the managed current CLI; Fleet's login-shell discovery can resolve another
installation. A same-version authenticated feed means no update, while a newer
feed still needs the existing update admission and grant.

Existing app/current/link collisions use the update or recovery flow instead.
Failed launch can roll back to absence; a live or uncertain replacement is
preserved for normal Quit and recovery. `/Applications` permission, isolated
system Python and macOS Gatekeeper acceptance remain fresh-Mac prerequisites.
The app is locally signed, not Developer ID notarized; this command never bypasses
Gatekeeper or changes system security settings.

### Historical DMG: 3.27.0

The published canonical 3.27.0 release includes `Phantom.app`, with
`Phantom_3.27.0_aarch64.dmg` downloads and the stable `Ashlr Local` signing
identity. The guarded installer migrates a single verified legacy installation;
3.25.0 retains its historical `Ashlr.app` filename. Updated custody prompt
wording requires its separately qualified helper release; installing the app
does not replace the helper. Automatic updating is not activated by this filename change.

For the historical 3.27.0 release, the versioned
[v3.27.0 macOS arm64 DMG](https://github.com/ashlrai/phantom/releases/download/v3.27.0/Phantom_3.27.0_aarch64.dmg)
is the verified published canonical download. Check the release artifacts
and installed startup separately before granting resident authority.
The app inside the DMG is locally signed, not Apple Developer ID notarized;
the DMG is unsigned and not notarized. macOS may require **Open Anyway** on first launch. The desktop CI workflow remains disabled during the
Linux quarantine; its retained draft-only policy is separate from this local
macOS release. The Linux CLI and web dashboard remain supported.
The historical 3.25.3 installed size was ~141 MiB, including the bundled Bun `ashlr`
sidecar (~100 MiB), Rust executable and web assets.

The 3.25.2 archives were published and verified, but its macOS updater client reproduced a startup abort; installation rolled back to 3.25.1. Version 3.25.3 fixes that constructor and adds the compatibility bridge. Verify the selected release artifacts and installed health separately. Publication does not update an existing app or activate its fleet.

---

<a id="canonical-source-candidate"></a>

## Canonical release

Prepare candidate metadata from the repository root with
`node scripts/sync-candidate-version.mjs X.Y.Z`, then run
`node scripts/sync-candidate-version.mjs --check X.Y.Z` to detect drift without
editing files. The helper synchronizes the package, root lock, desktop package,
Tauri version and main-window cache key, and this app's Cargo version and lock
entry, plus the explicit source-candidate lines here, in the root README and in
the quickstart. It preserves dependency
versions and historical release records. This
local preparation does not publish a release or update installed applications.
For routine drift detection, `node scripts/sync-candidate-version.mjs --check`
uses the root package version as the expected value; writing still requires an
explicit version.

This source tree targets version 3.29.7; check canonical release availability and exact matching assets before installation.

Canonical releases use `ashlrai/phantom` and `@ashlr/phantom`.
Its fixed discovery endpoint is
`https://github.com/ashlrai/phantom/releases/latest/download/latest.json`.
The commissioned public key, `ai.ashlr.desktop` bundle identifier, signer,
sidecar and saved-data identities stay unchanged. The signed legacy and
canonical profiles remain distinct; transport redirects do not choose a profile.
The historical [v3.27.0 macOS arm64 DMG](https://github.com/ashlrai/phantom/releases/download/v3.27.0/Phantom_3.27.0_aarch64.dmg)
has its own qualified original app and public-download evidence. Installed
startup, automatic adoption and resident authority remain separate gates.

## Install

Use the [current qualified release](https://github.com/ashlrai/phantom/releases/latest)
and the [signed idle update flow](#signed-idle-updates) in an eligible installed
app. Maintainers can use `scripts/install-desktop-artifacts.mjs` with the exact
qualified checkout, signed hosted bundle and private original finalizer output.
Inspection is the default; `--apply` requires prior Stop, drained leases and
normal Quit. The installer verifies original bytes without rebuilding, signing
or resuming authority. See its `--help` and the
[qualification procedure](../docs/RELEASING.md#qualified-ci-build-handoff).
This is a maintainer path, not a drag-to-Applications installer.

The historical [3.27.0 macOS arm64 DMG](https://github.com/ashlrai/phantom/releases/download/v3.27.0/Phantom_3.27.0_aarch64.dmg)
remains available. The table's DMG row describes that historical release.
For the current browser workbench on macOS, Linux and Windows, install
the promoted package with `npm install -g @ashlr/phantom`, confirm its version
with `phm --version`, and run `phm verse`. Match desktop artifacts to that version.
Other desktop formats remain subject to the draft artifact policy below.

| Platform | Availability |
|----------|-----------------------|
| macOS arm64 current | Signed arm64 app archive and paired update manifest; qualified installation required |
| macOS arm64 | Published canonical v3.27.0 `.dmg` |
| Windows | `.msi` / `.exe` draft only |
| Linux | Not produced while quarantined |

### Installing the build you make yourself

That policy is about *publishing*. Building Phantom for your own Mac and keeping
it in the Dock is supported and is what the rest of this document describes:

1. [Build it](#the-exact-steps-on-this-mac), including the current CLI sidecar
   and `cargo tauri build`.
2. Use the supported authority Stop/drain, then close Phantom normally. The installer requires a valid existing `Ashlr Local` signer and a verified signed source bundle for a first install; it does not create a signer or stop work. From the clean repository root:
   ```sh
   ashlr authority stop --json
   # Quit the native app normally after the drain succeeds.
   npm run ship:local -- --native
   ```
   Do not manually copy either app over an existing installation. Both names present, unknown leases/processes, unrelated aliases or changed source bytes hold the transaction for explicit recovery.
3. Check that the installed app and bundled server report this release.
   Gatekeeper may ask you to right-click → Open on first launch; see
   [First open on a local build](#first-open-on-an-unsigned-build-gatekeeper).
4. With Phantom running, right-click its Dock icon → **Options → Keep in Dock**.

To update later, repeat steps 1–3 from the new clean release checkout.
`ship:local` stages and verifies the complete bundle, retains a full compressed rollback archive, and coordinates `Phantom.app` with the current CLI release and missing `phm`/`ashlr` links. It uses the existing stable `Ashlr Local` signer. A live replacement is never killed or moved on a failed launch: recovery remains held until it is safely closed. Stop remains engaged and the resident is not restarted by installation.
Nothing in `~/.ashlr` is removed; config, seats and window state survive.

The original 3.25.1 source-based install retained `rollback-held` after two
health-check false negatives, despite independent installed-byte and process
checks passing. The 3.25.2 release fixes those predicates; see the
[recorded limitation and recovery boundary](../docs/RELEASING-LOCALLY.md#3251-source-install-observation-october-7-2026).

### Signed idle updates

The paired release manifest binds one macOS arm64 app archive to its original qualified npm archive. An existing 3.25.1 app has an inert updater and requires a qualified manual installation of 3.25.3 before it can use this flow. The compatibility bridge reads the closed legacy and canonical Phantom profiles; it does not rename the repository or package itself. Feed publication alone does not enable automatic updates or approve changed authority.

In the updated desktop, the top bar shows native update status. Expand it to
turn **Automatic updates** on or off, see verified download progress, or refresh
status. Preparing a download is separate from installing it. Installation requires
local work to be idle, the fleet stopped, and a normal **Quit**. Closing a window
only hides the app and does not install an update. Unknown activity holds the
update; the updater never stops work or clears Stop on your behalf.

Automatic installation requires a current, active grant with the same authority
surface. Changed authority, missing or expired grants hold installation for the
existing manual approval workflow. Settings and accounts stay in their existing
locations. Installation does not restart the resident fleet. On the next launch,
Phantom independently checks installed app and CLI bytes before reporting an
update as installed; a saved success receipt alone is insufficient.

The desktop bridge exposes only `updates.getState()` and `updates.refresh()`
(status observation), plus the boolean `automaticUpdates` preference. Native
reports `ashlr:update-state` through its fixed callback. Page code cannot supply
a download URL, signing key, stage path or installation command.

Maintainers prepare paired releases with `scripts/finalize-desktop-update.mjs`.
It requires fresh source, hosted qualification and independent Audit evidence,
the pinned publisher toolchain, the existing Apple signing identity, and the
private local release-signing key. The key is never packaged. This command
prepares verified artifacts; publishing them remains a separate release step.

---

## What it does

- Bundles the `ashlr` CLI binary as a sidecar — no separate Node.js or npm install needed.
- Opens a small **launch window** immediately, so the app is never an invisible
  process while the server boots. It shows what is happening, and if the server
  never comes up it says exactly why (see [Launch states](#launch-states)).
- Starts `ashlr verse --port 7777 --no-open --json`, reads the tokens it prints,
  and then shows the **Phantom** window at `http://127.0.0.1:7777/verse/`
  with those tokens already handed to the page (see [Token handoff](#token-handoff)).
- Presents a real macOS menu bar, an overlay title bar with the traffic lights
  inset into the console's own header strip, and remembers where the window was.
- Closing the Verse window hides it to the menu-bar (tray) item. **Quit** — from
  ⌘Q, the Phantom menu, or the tray — kills the sidecar and exits. No resident
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
| `open-settings` | **Phantom → Settings…** (⌘,) |
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
import { useDesktopState, setDesktopPreference } from '../app/desktop-state.js';

const desktop = useDesktopState(); // null in a browser
// desktop.hotkey        { enabled, registered, accelerator: '⌃⌥Space', error }
// desktop.notifications { enabled, delivery: 'native' | 'script' }
setDesktopPreference('globalHotkey', true); // false in a browser
```

- The page asks by emitting `shell-prefs` (`{ globalHotkey?: bool,
  notifications?: bool, automaticAwake?: bool }`) over the event permission it already has. Rust parses
  it strictly — an object, known keys, booleans only — persists it to
  `~/.ashlr/desktop/prefs.json` (0600), applies it and answers with a new state.
- **Render from the answer, not from what you asked for.** A hotkey another app
  already holds comes back `enabled: true, registered: false` with an
  operator-language `error`.
- `delivery: 'script'` means an unsigned build: banners arrive through
  `osascript` and show as Script Editor. Say so beside the toggle.
- The init script carries the state from window creation; on load the page
  also emits `shell-state-request` and gets the live one, so a reload after a
  change is never stale.

### Automatic awake during local work

The workbench top bar shows the desktop's power source, the configured system
idle-sleep timer and separately whether its **idle-sleep request is active**.
Automatic is enabled by default and can be switched to System settings. The
screen can sleep; Phantom does not change the system power plan, lock settings or
lid behavior. Manual sleep, thermal limits and battery restrictions still apply.

The native app reads authenticated chat activity and owner-verified resident
Fleet dispatch observations. Subscription CLI orchestration executes locally
even when inference happens elsewhere; provider-only sessions do not keep this
host awake. Each source has an independent liveness lease: completion clears
its evidence immediately, failed observations hide current counts without
renewing the prior evidence, and unrefreshed evidence expires after 15 seconds.
This is an observation timeout, not a task budget. Requests renew for long work.
Native polling continues every five seconds while Automatic is enabled, even
when the window is hidden. Resident metadata is cached every five seconds;
there can be an observation delay before a request starts. Page refresh events
prompt a native check but never supply authoritative activity counts.

macOS uses a process-owned IOPM idle-sleep assertion; Windows uses a SystemRequired
PowerRequest. Failed requests are visible. System settings readback has its own
check timestamp. A browser cannot report the host's power state. Standalone CLI
workers are not observed by this control; resident observations require verified
PID, process start and daemon instance identity. Windows adapter behavior needs
Windows runtime acceptance. Quitting the desktop releases its request; an
independent resident service owns its existing power wrapper separately. This
control does not promise local browser or screen tools can run asleep or locked.

### 7. Browser pane (shell contract v1)

A real browser inside Verse's layout, for pages an `<iframe>` cannot show (any
site that sends `X-Frame-Options` / `frame-ancestors`, and every non-loopback
URL). Implemented in `src-tauri/src/browser_pane.rs` + `browser_tap.js`.

**Feature test.** `window.__ASHLR_DESKTOP__.browser` exists only on a shell that
implements it:

```ts
const browser = window.__ASHLR_DESKTOP__?.browser;
// { version: 1,
//   capabilities: { screenshot: boolean /* macOS only */, picker: true, console: true, text: true,
//                   act: boolean /* macOS only: snapshot, resolve, act, network, evaluate */ },
//   send(msg): boolean /* true when handed to native */ }
```

An older shell has no `browser` key: the web UI falls back to an `<iframe>` for
loopback URLs and "open externally" for everything else.

**Page → native.** `send(msg)` accepts a plain object ≤ 16 KB of JSON and emits
it as the `shell-browser` event (the event permission the page already has — no
new capability, no new command). Native parses it strictly: an unknown `op` or
an unknown field drops the whole message.

| `op` | Fields | Effect |
|---|---|---|
| `open` | `tab`, `url`, `bounds` | Create tab window `browser-<tab>` at `url` if it does not exist (an existing one is **not** navigated), hide every other tab, place and show this one without taking focus. |
| `navigate` | `tab`, `url` | Navigate the tab. |
| `back` / `forward` / `reload` | `tab` | History back / forward, reload. |
| `bounds` | `tab`, `bounds` | Store and apply the rectangle; show that tab, hide the others. |
| `hide` | — | Hide every tab (pane hidden or unmounted, page hidden). |
| `close` | `tab` | Close and forget the tab (answers `closed`). |
| `zoom` | `tab`, `factor` | Page zoom, clamped to [0.25, 5]. |
| `query` | `tab`, `req`, `what` | `what` ∈ `text` \| `console` \| `info` \| `pick-start` \| `pick-poll` \| `pick-cancel` \| `resume`, or one of the argument forms below. Answers `result` (5 s timeout → `error: "timeout"`; an act gets 5 s + 20 ms per typed character). |
| `screenshot` | `tab`, `req`, `clip?` | macOS: `{ mime: 'image/png' \| 'image/jpeg', base64, width, height, scale, origin: {x, y}, css: {width, height} }` — at most 1280×800 **pixels**; `scale` = CSS px per image px, `origin` = the image's top-left in CSS px (a `clip` in CSS px captures one rectangle of the viewport; the page beyond the viewport cannot be captured). JPEG q0.8 when the PNG exceeds 4 MB. Elsewhere `error: "unsupported"`. |
| `external` | `url` | Open in the system browser (same URL rule; at most one per second). |

**Query argument forms** (every struct rejects unknown fields; refs match
`^e[1-9][0-9]{0,6}$`, signatures `^[a-z0-9]{1,16}$`):

| `what` | Does |
|---|---|
| `{ snapshot: { max_nodes?, root_ref? } }` | Accessibility-style outline of what is visible (role, name, state, ref per element); password / payment / secret values read `[redacted]`; hidden and `aria-hidden` content left out. |
| `{ network: { limit? } }` | Every fetch / XHR since load: method, URL, status, ms, sizes. No bodies, no headers. |
| `{ resolve: { ref } \| { x, y } \| { focused: true } }` | What an element is: role, name, signature, form / link / download / sensitive flags, rect. |
| `{ act: { kind, … } }` | `click` (`ref` or `x,y`; `button`, `double`, `modifiers`, `expect`), `type` (`ref`, `text` ≤ 2000, `submit`, `clear`), `select` (`ref`, `values`), `hover`, `key` (closed table: one printable character or Enter / Tab / Escape / Backspace / Delete / arrows / Home / End / PageUp / PageDown / Space, with Shift / Alt / Control; Meta only with `a` / `z`), `scroll` (`ref` and/or `direction`, `amount`). |
| `{ evaluate: { expression } }` | Loopback pages only (checked natively and again in the page). The one form whose text runs as code — see below. |

An act runs as: the tap's `prepare` (finds the point, re-checks `expect`,
refuses what must never be done) → **real AppKit mouse / key events** sent into
the tab's own window with `NSWindow sendEvent:` (trusted input: `isTrusted`
is true; no Accessibility permission, no `CGEventPost`, never another window)
→ the tap's `after`. `select`, `scroll` and a right click are done by the tap
(a native popup or context menu would block the app). The typed text travels
only as key events, never through a script.

`tab` matches `^[a-z0-9]{1,16}$`, `req` `^[A-Za-z0-9_-]{1,40}$`. `bounds` is
`{ x, y, width, height }` in CSS px relative to the Verse viewport (x, y ≥ 0;
width, height in [1, 10000]; the tab is also kept inside the window). At most 8
tab windows exist — opening a ninth closes the least recently used (it answers
`closed`).

**Native → page.** One window event:

```ts
window.addEventListener('ashlr:browser', (e) => {
  const d = (e as CustomEvent).detail;
  // { kind: 'nav', tab, url, loading }         page load started / finished
  // { kind: 'title', tab, title }              ≤ 300 chars
  // { kind: 'blocked', tab, url, reason }      a navigation the URL rule refused
  // { kind: 'closed', tab }                    closed, evicted, ⌘W, or unknown tab
  // { kind: 'operator', tab }                  genuine operator input in the tab (≤ 1 per 500 ms);
  //                                            synthesized agent input never produces it
  // { kind: 'result', req, ok: true, data } | { kind: 'result', req, ok: false, error }
});
```

Native delivers it by evaluating `window.__ASHLR_BROWSER_EVENT__(<json>)`, which
the shell script defines non-writable and non-configurable. Every value in
`detail` — titles, URLs, page text, console lines, picked HTML — comes from an
arbitrary website: render it as text, never as HTML.

The tabs are hidden natively when Verse is closed to the tray and whenever the
Verse page (re)loads; after either, the page should send `bounds` again once
the pane is visible (e.g. on `visibilitychange`).

**Security posture.**

- Each tab is a separate window that **no capability matches** (capabilities
  name `main` and `launch` exactly; a test fails if a pattern could match
  `browser-*`), so a website gets zero IPC.
- Native evaluates only fixed scripts in a tab: the constant `browser_tap.js`
  and a tap call chosen from a closed enum, whose arguments are JSON built by
  `serde_json` from validated values. Nothing the Verse page or the website
  sends ever becomes code; answers travel as JSON. The single exception is
  `evaluate`: loopback pages only, checked natively and against
  `location.origin` in the page, and off unless the operator switched scripts
  on for the chat.
- URL rule: `http`/`https` only, no `user:pass@`, never the Verse origin itself
  (any loopback spelling on port 7777). Applied to requests and to every
  navigation the website makes; `target=_blank` / `window.open` open in the
  same tab; downloads are refused.
- Tabs use their own website data store, never Verse's (macOS 14+: a fixed
  store identifier, so pane logins persist; older macOS: a throwaway store;
  elsewhere `<app local data>/browser`).
- Native acts only when the page asks with an `act` query, and only as real
  input into the tab's own window. It never types into a password, payment,
  SSN or secret field (the tap refuses in `prepare`, before any event), never
  picks a file, and never sends ⌘V (the operator's clipboard). The tap reads a
  field's content in one place, and never for a sensitive field. After an
  agent click that made the tab key, key status goes straight back to the Verse
  window, so the operator's typing never lands in the page. The element picker
  swallows only the operator's own picking click.

**Shipping.** This is a change to the Rust binary, not the web bundle: it only
reaches an installed app through `npm run ship:local -- --native`. A web-only
ship leaves the old shell in place, and the web UI must keep working through
the fallback above.

### 8. Dictation (shell contract v1 `voice`)

Verse dictates into its own inputs — the chat composer, the Leader composer,
⌘K and the terminal — with **local** speech recognition. Capture and
transcription run in the app process (`src/voice/`): the launchd sidecar has
no UI and cannot hold a microphone grant, and the WKWebView has no Web Speech
API. Text only ever goes into Verse; nothing is typed into other apps, so no
Accessibility permission is involved.

| Piece | Where |
|---|---|
| Page → native | `window.__ASHLR_DESKTOP__.voice = { version: 1, send }` emits `shell-voice` (the event permission the page already has — no new capability, no command). Ops: `status`, `start {session, mode, cwd?}`, `context {session, mode, cwd?}`, `stop`, `cancel`, `fix {action}` — parsed strictly (`voice/protocol.rs`: closed op set, per-op key allow-list, bounded strings, absolute `cwd`). |
| Native → page | the locked `window.__ASHLR_VOICE_EVENT__(<json>)` → `ashlr:voice` window event: `voice://state` (mic permission, engine + model download, hotkey, lexicon, live session), `voice://level` (~20 Hz), `voice://partial` (~every 400 ms), `voice://final`, `voice://error`. |
| Capture | `cpal` default input → mono → 16 kHz (`voice/capture.rs`). |
| Engine | NVIDIA **Parakeet TDT 0.6B v3** (int8 ONNX) via `transcribe-rs`, CPU. ~670 MB, downloaded **once, on first use** into `~/Library/Application Support/ai.ashlr.desktop/models/`, pinned to one Hugging Face revision and SHA-256-checked per file (`voice/model.rs`). Fallback: `whisper-cli` + a ggml model already on disk, biased with the lexicon's `whisper-prompt`. |
| Streaming | the growing buffer is re-decoded ~every 400 ms for partials; long dictation commits its prefix at a real pause so each decode stays small; energy VAD skips silence and trims the final pass (`voice/stream.rs`). |
| Lexicon | `lexicon serve` (127.0.0.1:41733, token from `~/.config/lexicon/serve.json`, read per request, never logged) normalizes finals with the chat's repo as `cwd`; its term map is cached to disk and applied locally when the server is down (the pill shows a quiet **raw** badge). The terminal is `verbatim`: no lexicon, no cleanup. |
| Hotkeys | **⌃⌥V**: hold ≥250 ms = push-to-talk (listening starts on key-down), tap = latch until pressed again. **⌃⌥⇧V**: the words become the ⌘K query. **Esc** cancels — registered globally only while a dictation is live. Not fn (Wispr Flow's). |

Permissions: `Info.plist` carries `NSMicrophoneUsageDescription` and
`Entitlements.plist` `com.apple.security.device.audio-input`. macOS kills a
process that opens the mic without the usage string, so native checks for it
first and reports `no-usage-description` instead. The microphone grant is
keyed to the code signature — see "stable local signing" in
docs/RELEASING-LOCALLY.md.

Web side: `src/web-ui/routes/verse/voice/` — `VoiceInput` (the mic button,
lazy-loaded by each surface), `VoiceHud` (the one floating pill: waveform,
"Listening · local Parakeet", dimmed partials, errors with a one-click fix),
`voice-store` (routing: a hotkey dictation goes to the focused, else
last-focused, input). In a plain browser the same UI runs on the Web Speech
API.

### 9. Fleet operations (shell contract v1 `fleet`, 3.15)

The Fleet tab starts, restarts and stops the resident daemon and installs the
custody helper **without Terminal**. Implemented in `src-tauri/src/fleet_ops.rs`.

**Feature test.** `window.__ASHLR_DESKTOP__.fleet` = `{ version: 1, ops, send }`.
An older shell has no `fleet` key; the Fleet tab then shows the Terminal command.

**Page → native.** `send({ id, op, checkout? })` emits `shell-fleet` over the
event permission the page already has (no new capability, no new command).
`id` matches `^[A-Za-z0-9_-]{1,64}$`; native drops anything else unparsed.

| `op` | Effect |
|---|---|
| `resident-start` | Reads `ashlr authority resident status --json`, shows a **native** confirm dialog (grant, release, plist, budget, the exact command), then runs `ashlr authority resident start` with a one-time gesture token |
| `resident-restart` | The same dialog, then `resident stop` + `resident start` |
| `resident-stop` | A native confirm, then `ashlr authority resident stop` (lowering: no gesture token) |
| `custody-install` | `checkout` (a Phantom checkout the server found among the enrolled repos; `~/` allowed). Native re-validates it (absolute, `scripts/install-custody.sh` a regular file, `tools/custody/Package.swift`, an exact supported `ashlrai/phantom` or legacy `ashlrai/ashlr-hub` remote), shows the command and the script's sha256 in a native dialog, then asks **macOS** for an administrator (`osascript … with administrator privileges`, every value passed as argv through `quoted form of`) |

**Native → page.** `window.__ASHLR_FLEET_EVENT__(detail)` (non-writable) →
the `ashlr:fleet` window event: `{ id, op, phase, message, command?, exitCode?, output? }`
with `phase` ∈ `confirming | running | done | failed | cancelled`.

**Why this is Mason and not an agent.** `resident start` in a terminal refuses
anything without a TTY. Here the proof is a native modal dialog: page script
can ask for it but cannot answer it, and a seat's tools (CLI processes, MCP
servers) cannot reach this event bus at all. Only after the click does native
write `~/.ashlr/authority/native-gestures/<32 hex>.json` (0600, create-new,
no-follow; a directory every confined fleet agent is denied) and pass its name
in `ASHLR_NATIVE_GESTURE`. The CLI (`authority/resident.ts consumeNativeGesture`)
accepts it in place of the TTY only when it is fresh (≤ 120 s), private, owned
by this user and names `resident-start`, and deletes it before trusting it.
The child runs the operator's own `ashlr` (resolved by a login shell, never the
bundled sidecar and never a page-supplied path) in a scrubbed environment, so
the agent-marker and login-HOME checks still apply. Nothing here signs, raises
or widens anything: the CLI still re-verifies the Touch-ID grant, the clean
build, Stop and the switch, and mints its own single-use capability.

### 10. Computer use (shell contract v1)

Desktop control for Verse's agents: screenshots, the accessibility tree, and
clicks / typing / keys / scroll / drag in apps the operator granted to a chat.
The shared contract (ops, tiers, bundle lists, error codes) is
`src/core/verse/computer-types.ts`; the native half is
`src-tauri/src/computer.rs`. macOS only.

**Feature test.**

```ts
const computer = window.__ASHLR_DESKTOP__?.computer;
// { version: 1, capabilities: { supported: boolean /* macOS */ }, send(msg): boolean }
```

**Page → native.** `send(msg)` takes a plain object ≤ 16 KB of JSON and emits
`shell-computer` over the event permission the page already has (no new
capability, no new command). Parsed strictly: an unknown `op` or field, a bad
`req` (`^[A-Za-z0-9_-]{1,40}$`), a bad bundle id, a non-finite number or an
out-of-range value drops the message (answered `invalid` when its `req` is
readable).

| `op` | Fields | Answer `data` |
|---|---|---|
| `permissions` | `req` | `{ supported, macos, screen, accessibility, postEvents }` |
| `request-permission` | `req`, `kind`: `screen` \| `accessibility` \| `post-events` | same (after the system prompt) |
| `open-settings` | `kind`: `screen` \| `accessibility` | none (opens the Privacy pane from a closed enum) |
| `list-apps` | `req` | `{ apps: [{ bundleId, name, pid, active, hidden, path }] }` (Dock apps) |
| `screenshot` | `req`, `grants`, `app?`, `display?`, `scale?` (0.25–1) | `{ mime, base64, width, height, frame, display, apps: [{ bundleId, name }] }` |
| `zoom` | `req`, `grants`, `frame`, `region: [x0,y0,x1,y1]` | `{ mime, base64, width, height }` |
| `ax-tree` | `req`, `grants`, `app`, `maxDepth` (1–12), `frame?` | `{ app, nodes: [{ ref, depth, role, subrole?, title?, description?, value?, enabled, focused, secure, frame? }], truncated }` |
| `probe` | `req`, `grants`, `frame?`, `target`: point \| ref \| focus | `{ app \| null, role, subrole, label, secure, windowTitle }` |
| `ax-press` | `req`, `grants`, `app`, `ref` | `{ app, role, label }` |
| `click` | `req`, `grants`, `frame`, `x`, `y`, `button`, `count` (1–3), `modifiers` | `{ app, role, label }` |
| `type` | `req`, `grants`, `text` (≤ 2000 chars) | `{ app, chars }` |
| `key` | `req`, `grants`, `keys` (e.g. `cmd+shift+t`, `Return`, `F5`) | `{ app }` |
| `scroll` | `req`, `grants`, `frame`, `x`, `y`, `dx`, `dy` (lines, ±50; +dy = down) | `{ app, role, label }` |
| `drag` | `req`, `grants`, `frame`, `from`, `to` | `{ app, role, label }` |
| `resume` / `kill` / `arm` | — | a `state` event |

`app` in answers is `{ bundleId, name, pid }`. Captures fit ≈1280×800 (times
`scale`), never upscaled; `frame` maps screenshot pixels to global points
(`origin + px * scale`). Refs (`e1`…) are valid until the next `ax-tree` for
that app (`stale-ref` after).

**Native → page.** `window.__ASHLR_COMPUTER_EVENT__(<json>)` (non-writable,
non-configurable) dispatches `ashlr:computer`:

```ts
// { kind: 'result', req, ok: true, data } | { kind: 'result', req, ok: false, code, error }
// { kind: 'state', state: 'idle' | 'active' | 'paused' | 'killed', app?, reason? }
```

Screen text in `data` (labels, values, titles) comes from other apps: render it
as text and frame it as untrusted for the agent.

**What native enforces** (whatever the page sends):

- Grants are clamped to each app's ceiling — browsers `read`, terminals / IDEs
  `click`, the rest `full` — and never widened. The hard denylist (password
  managers, Keychain / Passwords, authentication prompts, the custody helper,
  Phantom itself, anything without a bundle id) is never captured or driven.
- The target is resolved natively: the app under the point for mouse ops, the
  frontmost app for `type` / `key`.
- Secure text fields: never read, never typed into (nor while any app holds
  secure input); only Tab, Shift+Tab and Escape are sent there.
- System Settings' Privacy & Security / Passwords / Users & Groups / Login
  Items panes are refused per action (an unreadable title counts as denied).
- Takeover: hardware input more than 350 ms after the last synthetic event
  pauses control (`operator-took-over`) until `resume`. Esc — registered as a
  global shortcut only while the HUD shows — or `kill` stops it until `arm`.
  Hiding, closing or reloading the Verse window pauses active control; acting
  needs the Verse window visible. Ten idle seconds end the active state.
- While an agent acts, an orange screen-edge border and a pill ("Agent
  controlling <App> — Esc to stop") float above everything, ignore the mouse,
  never take focus, and are excluded from sharing. Screenshots include only
  granted apps' windows, so the HUD and Verse never appear in them.

**Permissions.** Screen Recording (captures) and Accessibility (tree, input)
are the operator's to grant in System Settings; `open-settings` deep-links
there. Screenshots use ScreenCaptureKit's `SCScreenshotManager` (macOS 14+,
loaded at run time); older macOS answers `unsupported`.

**Shipping.** Rust binary change: `npm run ship:local -- --native`.

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
| Starting | Brand mark, "Starting Phantom", an indeterminate hairline. |
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
| **Phantom** | About Phantom · Settings… ⌘, · Services · Hide ⌘H / Hide Others / Show All · Quit Phantom ⌘Q |
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
| ⌘Q, the Phantom menu, the tray's Quit | `RunEvent::Exit` → `reap_sidecar`, which kills the sidecar **and its worker children** (the Bun binary runs its projection/background workers as separate processes that hold file locks in `~/.ashlr`). |
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
| Stop running chats… | A native confirm ("Stop every running chat?"), then cancels each running turn with the mutation token. Disabled when nothing runs, or when the window adopted a server Phantom did not start (no mutation token). Queued follow-ups are held, not sent. |
| Show Phantom | Show + focus the window |
| Quit Phantom | Kills the sidecar, exits |

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
  `tauri-plugin-notification` (Phantom's icon). Anything else — ad-hoc (every
  local `cargo tauri build`), unsigned, `cargo run` — uses `osascript` with the
  text as argv, because macOS can silently drop plugin banners from an app it
  cannot identify. Those banners show as Script Editor, and clicking one opens
  Script Editor rather than Phantom; the tray and the Dock badge are the reliable
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
- `shell.open` is not granted to any page. The one Rust-side use is the
  browser pane's `external` op, which opens only `http`/`https` URLs that pass
  the pane's URL rule, at most one per second.
- Computer use (§8) adds no capability or command: the page emits
  `shell-computer`, and native re-checks every grant against the tier
  ceilings, the hard denylist, secure fields, System Settings' privacy panes,
  takeover and the kill switch before it captures or posts an event.
- Browser pane tabs (§7) are separate `browser-<tab>` windows that no
  capability matches — websites in them get no IPC — with their own website
  data store, fixed read-only scripts, and the URL rule on every navigation.
- **No website ever gets the microphone or camera.** wry's WKUIDelegate
  grants every WebKit media-capture request; every browser tab gets a
  delegate proxy that answers Deny (and forwards everything else to wry's),
  installed when the tab is built — a tab whose guard cannot be installed is
  destroyed (`src/media_guard.rs`). The tap also replaces `getUserMedia` /
  `getDisplayMedia` before the page runs. Dictation captures in Rust for the
  Verse window only.
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
| Node.js | 22.15+ | https://nodejs.org |
| Xcode command line tools | — | `xcode-select --install` |

### The exact steps on this Mac

```sh
# 0. From the repo root.
cd /absolute/path/to/phantom  # a clean checkout of ashlrai/phantom

# 1. Build the web UI and compile the CLI into a single Bun executable.
#    `npm run build:binary` runs `npm run build` first.
npm ci
npm run build:binary                        # → dist-bin/ashlr + dist-bin/public/

# 2. Stage the sidecar and the web assets for the host triple.
node desktop/scripts/prepare-sidecar.mjs    # → desktop/src-tauri/binaries/ashlr-aarch64-apple-darwin
                                            #   desktop/src-tauri/resources/public/

# 3. (Once, or after editing the Phantom icon source icons/icon.svg.)
cd desktop && npm run icons                 # = cargo tauri icon src-tauri/icons/icon.svg

# 4. Release build — the .app and the .dmg.
#    beforeBundleCommand runs the bundle policy assertion, then dmg-preflight.
cd desktop && cargo tauri build
```

The native app icon is generated from the tracked Phantom ghost SVG on the existing rounded-square canvas. The five bundle icon outputs are generated locally, not checked in; the monochrome `tray.png` remains a separate tracked template icon. See [icon generation and provenance](src-tauri/icons/PLACEHOLDER.md). This artwork change preserves the stable `ai.ashlr.desktop` bundle identifier and signing identity.

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

- `macos/Phantom.app` — the installable app
- `dmg/Phantom_<version>_aarch64.dmg` — the disk image; `<version>` matches the root package version

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

**No.** An earlier `cargo tauri build` on this Mac completed `Bundling Ashlr.app` →
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
`Phantom.app` inside is identical either way. Prefer this over
`cargo tauri build --bundles app`, which skips the DMG entirely.

**The .app is the artifact that matters.** Even when the DMG step fails, the
bundler has already written
`target/release/bundle/macos/Phantom.app` — it is complete and installable, and
the failure is only about the disk image wrapped around it.

### First open on an unsigned build (Gatekeeper)

The raw `cargo tauri build` artifact may be unsigned. The supported local
install through `ship:local --native` signs `/Applications/Phantom.app` with
"Ashlr Local", a stable identity trusted for code signing on this Mac. It is
**not** an Apple Developer ID signature or notarization. Gatekeeper can still
block its first open with *"Ashlr" cannot be opened because the developer
cannot be verified*; a quarantined DMG may show a different warning.

Do this once, after the guarded installer installs `Phantom.app` in `/Applications`:

- **Right-click (or Control-click) `Phantom.app` → Open**, then click **Open** in
  the dialog. macOS remembers the exemption; ordinary double-clicks work after
  that.
- If macOS shows no **Open** button at all (Sequoia and later often do not),
  open **System Settings → Privacy & Security**, scroll to the message about
  Ashlr being blocked, and click **Open Anyway**.
- Or strip the quarantine attribute directly:
  ```sh
  xattr -dr com.apple.quarantine /Applications/Phantom.app
  ```

This can occur with a local signature and is not a bug in the app. A public
installer without that prompt would require Apple Developer ID signing and
notarization, which this release does not provide.

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

## Release feed and update trust

The source updater uses the reviewed [signed idle update flow](#signed-idle-updates).
The fixed GitHub `releases/latest/download/latest.json` endpoint is discovery;
its paired manifest and payloads must pass the commissioned publisher signature.
The legacy immediate `download_and_install` path is removed. The disabled
`release-desktop.yml` workflow stays disabled; adding secrets or pushing a
`desktop-v*` tag does not commission this release path.

The published 3.25.1 desktop still has its earlier inert updater. Public keys are
installed through the normal qualified app release, never accepted from a feed
or staged archive. This phase does not change Developer ID/notarization or the
Windows and Linux desktop publication policy.

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
   the Phantom menu, the tray, a signal, or the next launch after a crash — reaps
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
probing the port, so just launch Phantom again. To clear it by hand:
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
