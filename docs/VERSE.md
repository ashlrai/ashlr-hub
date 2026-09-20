# Ashlr Verse

Verse is the operator console for the whole Ashlr hub. One window: chat with an
agent that can edit your repos, run the autonomous fleet and keep it on a leash,
approve or reject what it produced while you were away, and see what every
account and local model is costing you.

It is served by the normal `ashlr serve` server at `/verse/`, opened by
`ashlr verse`, and wrapped by the macOS desktop app in `desktop/`.

- Build contracts: `docs/VERSE-CONTRACT-V1.md` (sessions) and
  `docs/VERSE-CONTRACT-V2.md` (redesign + control plane).
- Design language: `docs/VERSE-DESIGN-V2.md`.
- Shared types: `src/core/verse/types.ts` (V1, frozen) and
  `src/core/verse/control-types.ts` (V2).

This page is the user guide.

---

## Start it

```sh
ashlr verse                      # start the server with dispatch enabled, open http://127.0.0.1:7777/verse/
ashlr verse --port 7777          # pick the port (the desktop app always uses 7777)
ashlr verse --no-open            # do not open a browser tab
ashlr verse --no-open --json     # print one machine-readable JSON line instead of the banner
```

`ashlr verse` is `ashlr serve --allow-dispatch` plus the Verse entry point. It
prints the same two tokens `ashlr serve` prints:

| Token | Used for | Where it goes |
|-------|----------|---------------|
| Read token | reading seats, projects, sessions, usage, and the SSE event stream | pasted once into the SessionGate; exchanged for a short-lived HttpOnly cookie |
| Mutation token | creating sessions, sending turns, changing caps or scope, approving proposals | asked for by the mutation dialog the first time you dispatch |

With `--json` the line is `{"url","consoleUrl","port","allowDispatch","readToken","token",...}`.
The desktop app reads that line from the sidecar's stdout and hands the tokens
straight to the window, so there is no paste step there. Neither token is ever
written to disk, logged, or sent anywhere other than `127.0.0.1`.

The server binds to `127.0.0.1` only. Do not expose it to other hosts.

---

## The five sections

A 56px icon rail down the left switches between them. ⌘1–⌘5 do the same.

| # | Section | What it is for |
|---|---------|----------------|
| 1 | **Chat** | Talk to a seat about a project. Sessions, transcript, composer. |
| 2 | **Autonomy** | Run the fleet without you. Start/stop the loop, set caps, set scope, read the audit trail, emergency stop. |
| 3 | **Approvals** | The inbox of proposals the fleet produced. Diff, evidence, approve or reject. |
| 4 | **Usage** | What each account and local model has spent, against plan windows and configured limits. |
| 5 | **Settings** | Appearance, connection, shortcuts, about. |

A dot on the Approvals rail icon means something is waiting for you.

### Chat

Sessions are listed in the sidebar grouped by project, newest first, each with a
2px engine marker, its title and a relative time. A running session shows a
small pulsing dot.

The transcript is a single 720px reading column. There are no chat bubbles: your
turn is indented behind a 2px rule in secondary text, the assistant's is plain
primary text at full measure. Markdown gets real typographic hierarchy, and code
blocks have a language label and a copy button on hover.

Tool calls collapse to one line each — glyph, tool name in mono, truncated
argument, right-aligned duration — and a run of them collapses further into a
single summary row like `6 tools · Read ×4, Edit ×2 · 12s`. Expand any of them
for the full input and output. Failures tint the left rule; nothing else
changes colour.

The composer grows to 40% of the viewport, gains the accent on focus, and docks
at the bottom of the same 720px measure. Under the header strip there is a 2px
context line rather than a labelled progress bar; the numbers (`18k / 66k`) sit
next to it in Space Grotesk.

**How a turn actually runs.** Each turn spawns one vendor CLI process
(`claude -p`, `codex exec`, `grok -p`) in the project directory with
`--permission-mode acceptEdits` (or Codex's `workspace-write` sandbox), streams
its output as normalized events, and exits. Nothing holds stdin open between
turns; the vendor conversation is resumed by id on the next turn, so memory
across turns is the vendor's own. **Stop** cancels the running turn (SIGINT to
the process group, SIGKILL after 10 s). Turns also time out on their own.

Sessions persist in `~/.ashlr/verse/sessions/` (`<id>.json` plus an append-only
`<id>.events.jsonl`) and reappear after a restart.

**Context meter.** `contextTokens / contextWindow` — the prompt size of the most
recent assistant call (input + cache-read + cache-creation tokens) against the
seat's best-known window. Amber at ≥ 70 %, red at ≥ 90 %, `n/a` when the window
is unknown. It moves after every turn's `usage` event, so you can see a long
chat filling up and start a fresh session before the model starts truncating.

**Dictation.** The microphone uses the browser's Web Speech API when the runtime
provides it. WKWebView — which is what the desktop app is — does not, so there
the button explains itself and you use system dictation (Wispr Flow,
Superwhisper, macOS dictation) into the composer, which is an ordinary textarea.

---

## Seats

A seat is one place a turn can run: an **engine** plus the **account** (or local
model) it is pinned to. Sessions are seat-bound — changing the seat on an
existing chat starts a new session.

### Your subscriptions

Seats come from `~/.ashlr/account-connections/connections.json` (the same file
`ashlr` uses for native-profile launchers). Each account becomes one seat with
`engine = provider`:

| Engine | Models offered | Context window | Identity colour |
|--------|----------------|----------------|-----------------|
| `claude` | `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001` | 200k | `#c96442` |
| `codex` | `gpt-5.5`, `gpt-5.5-mini` | 272k | `#10a37f` |
| `grok` | `grok-4`, `grok-4-fast` | 256k | `#6b7280` |
| `local` | every Ollama coding tag | from the model | `#7c5cff` |

These are your **subscriptions**, not API keys — the work runs through the
vendor CLI signed in as that account, so it draws on the plan you already pay
for. The account's launcher command (which pins `CLAUDE_CONFIG_DIR` /
`CODEX_HOME` / `GROK_HOME`) stays on the server and is never returned by the
API, never logged, and never shown in the UI.

The engine colour is used for the 2px seat marker, the seat pill tint and the
usage bar — never for text.

Health comes from `observations.json` when present, plus Claude's rolling-window
usage from `src/core/fabric/claude-usage.ts`. Otherwise a seat reads `unknown` —
which is shown as `unknown`, not as zero. Seats whose health is `unavailable`
are listed but disabled with the reason. Health is advisory: it never blocks a
turn.

### Local Ollama models

If Ollama is reachable (`cfg.models.ollama`, default `http://127.0.0.1:11434`),
every tag that looks like a coding model (`coder`, `code`, `qwen`, `deepseek`,
`devstral`, `llama`) becomes a `local:<tag>` seat under the **Local** group. The
context window is read from `/api/show` when the model reports it, else from a
`:ctxNNk` suffix in the tag, else assumed to be 65,536 tokens.

Local seats run the plain `claude` binary with `ANTHROPIC_BASE_URL` pointed at
Ollama's Anthropic-compatible endpoint — same transcript, tool cards and resume
behaviour as a Claude seat, no cloud account involved, no marginal cost. The
Usage section frames that as `localSavingsUsd`: money you did not spend because
the work ran locally. When Ollama is down the Local group is empty and the
Resources panel says so.

---

## Autonomy — running without you

The Autonomy section is the cockpit for the hub's existing daemon. The loop
picks work off your goals and backlog, dispatches it to seats, and files the
results as proposals in Approvals. You read the results later instead of
watching it happen.

### Status and controls

The header tells you whether the daemon is running, the current direction mode,
when the last tick ran and how it went, when the next one is due, and today's
spend against the daily cap as a single line meter.

- **Start** / **Stop** the loop — the ordinary controls. Stop is just "stop the
  daemon"; it does not disable anything else.
- **Run one tick** — do exactly one pass, now, and show what it did. The honest
  way to find out what the loop would do before letting it run unattended.
- **Emergency stop** — see below. Separated, confirm-guarded, and labelled for
  what it is.

### How spend is bounded

Every limit is editable in the Budget & limits panel and takes effect live (the
daemon re-reads its config each tick), with an inline "applied live"
confirmation on commit:

| Limit | Range | What it does |
|---|---|---|
| Daily USD budget | 0–1000 | Hard ceiling on spend per day. **0 means stopped** — the panel says so rather than letting you set it silently. |
| Items per tick | 1–50 | How much work one pass may pick up. |
| Parallelism | 1–16 | How many dispatches run at once. |
| Tick interval | 30 s – 24 h | How often the loop wakes. |
| Max concurrent | 1–32 | Ceiling across everything. |
| Concurrency: local / cloud / total | 0–32 each | Splits the ceiling between free local work and paid cloud work. |
| Subscription max percent | 1–100 | How much of a subscription's window the fleet may consume before it backs off. |
| Per-engine dispatch limits | max ≥ 0 per engine/window | Rate limits per engine, checked against the dispatch ledger. |

Each control shows its current value **and the live usage against it**, so a
limit is never an abstract number. Usage also breaks down local vs cloud for the
period, so you can see how much of the day ran for free.

### How scope is bounded

The loop can only touch repositories in the enrollment registry. The Scope panel
lists them and lets you add and remove them by absolute path.

- Non-absolute paths, non-directories, and anything under `~/.codex/artifacts`
  are rejected.
- **An empty registry means the daemon does nothing.** The empty state says that
  plainly rather than looking like a loading failure.

Enrollment is the single biggest lever you have. A repo that is not enrolled
cannot be written to by the fleet, whatever the caps say.

### What it did while you were away

The Activity view is the audit trail: recent ticks, dispatches, and every
recorded action with its result and time, newest first, filterable by action and
result. The Safety view runs the `verify-safety` report as five pass/fail checks
with a re-run button.

Goals and the backlog are shown read-only in V2.

### The emergency stop — what it actually does

**It is not a pause.** Pressing it writes the global sentinel file
`~/.ashlr/KILL`, and that file is read fail-closed across the whole hub: the
kill switch counts as *on* unless it is proven absent.

While it is armed:

- the autonomous loop refuses to dispatch;
- outward mutations are fenced — an operation already inside the fence may
  finish, but nothing new gets in after the sentinel is observed;
- **the agent's own `mcp-native` write tools are refused too.** That includes the
  agent you are chatting with in the Chat section. This is the part people are
  surprised by, so the confirm step spells it out.

Clear it from the same control. Clearing also takes the fence, so it cannot race
with a mutation that is mid-flight.

If you only want the loop to stop, use **Stop**, not the emergency stop.

---

## Approvals

Everything the fleet produced that needs a human is here, pending first. Each row
shows its risk class, repo, title, engine and age. Opening one gives you the
summary, a real syntax-aware diff, the verify result, the decision evidence and
the provenance.

**Approve is destructive.** A `pr` proposal pushes a branch and opens a pull
request. Approving therefore requires an explicit confirm step that names the
repo and the kind of proposal, and shows what will happen before you click.

---

## Usage

One card per seat: engine marker, plan, window meters with reset times, and
tokens used. Plus the local-vs-cloud split for the period, `localSavingsUsd`
framed as money not spent, and dispatch-ledger usage against each configured
per-engine limit.

Where a number does not exist, it says so. Claude has no local utilization
signal and Grok's probe is not on `/api/usage`; both render as **unknown**
rather than as a fabricated zero. If a per-day spend series cannot be derived
from the data on hand, you get the aggregate and a note that the series is
unavailable — not an invented curve.

---

## Theming and appearance

Settings → Appearance. Everything applies instantly — there is no save button —
and persists in `localStorage` under `ashlr.verse.appearance.v1`. "Reset to
defaults" undoes the lot.

| Control | Options |
|---|---|
| Theme | System / Light / Dark |
| Accent | Eight presets plus a hue slider |
| Density | Comfortable / Compact |
| Display font | Space Grotesk / UI sans / Mono |
| Radius | Sharp / Default / Soft |
| Reduce motion | Forces all durations to 1 ms (`prefers-reduced-motion` is respected by default anyway) |

The interface is monochrome by design: colour carries meaning (a status, an
engine identity, a destructive action) and nothing else. Fonts are self-hosted —
there is no network font access — so appearance works offline.

In the desktop app the theme also drives the **native window background**, so a
dark-mode launch never flashes white before the page paints.

---

## Keyboard shortcuts

In the console (browser or desktop):

| Keys | Action |
|---|---|
| ⌘1 – ⌘5 | Switch section (Chat, Autonomy, Approvals, Usage, Settings) |
| ⌘K | Quick switcher (sessions and seats) |
| ⌘N | New chat |
| Enter | Send |
| Shift+Enter | Newline |
| Esc | Stop dictation |

Desktop app only, from the macOS menu bar:

| Keys | Action |
|---|---|
| ⌘, | Settings |
| ⌘R | Reload |
| ⇧⌘L | Toggle light / dark |
| ⌘= / ⌘− / ⌘0 | Zoom in / out / actual size |
| ⌘Z / ⇧⌘Z / ⌘X / ⌘C / ⌘V / ⌘A | Undo / Redo / Cut / Copy / Paste / Select All |
| ⌘M / ⌘W / ⌘H / ⌘Q | Minimize / Close window / Hide / Quit |

⌘1–⌘5, ⌘K and ⌘N are deliberately **not** bound in the native menu so they reach
the page.

---

## Desktop app (macOS)

The Tauri app in `desktop/` is a native window around Verse plus a menu-bar
item. It is a source-only draft — there is no public installer (see
`DESKTOP.md`). Full detail, including the native↔web shell contract, is in
[`desktop/README.md`](../desktop/README.md).

What it does on launch:

1. Opens a small **launch window** immediately, so the app is never an invisible
   process while the server boots.
2. Checks whether anything already holds `127.0.0.1:7777`. If so it says exactly
   that and offers to adopt the running server, retry, or quit — it does not
   spin forever, and it does not silently attach to someone else's server.
3. Spawns the bundled `ashlr` sidecar as
   `ashlr verse --port 7777 --no-open --json`, reads the single JSON startup
   line, takes `readToken` and `token`, and drops the line. It is never
   forwarded to the event bus, to stderr, or to the launch window.
4. Creates the **Ashlr Verse** window at `http://127.0.0.1:7777/verse/` with
   `window.__ASHLR_TOKENS__` already set, so the SessionGate never asks for a
   paste. The window has an overlay title bar with the traffic lights inset into
   the console's own 48px header strip, remembers its size and position in
   `~/.ashlr/desktop/window-state.json`, and paints its background in the
   current theme before the page loads.
5. If the bundled CLI does not know `verse` yet, it falls back once to
   `ashlr serve --port 7777 --allow-dispatch --json`.

Closing the window hides it to the menu bar. **Quit** — ⌘Q, the Ashlr menu, or
the menu-bar item — kills the sidecar and exits.

The sidecar is reaped on every exit path, so no orphan server is left behind:
a normal quit kills it and its worker children, a signal (`pkill`, Ctrl-C)
triggers a handler that does the same, and if the app is SIGKILLed or crashes,
the **next launch** kills the sidecar it left behind before probing the port.
After quitting, `pgrep -fl "Contents/MacOS/ashlr verse"` should print nothing.

The menu-bar item has **Show** and **Quit** only. Daemon controls and the
emergency stop live in the Autonomy section, behind a confirm step, on purpose.

### Install it on this Mac

There is no public installer (that policy is unchanged), but building Ashlr for
your own Mac and keeping it in the Dock is supported:

```sh
REPO=/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub

# 1. Build (see "Build it" below for the prerequisites and the full steps).
cd "$REPO/desktop" && cargo tauri build

# 2. Install, replacing any previous copy.
rm -rf /Applications/Ashlr.app
cp -R "$REPO/desktop/src-tauri/target/release/bundle/macos/Ashlr.app" /Applications/
```

Then, **once**: the build is unsigned, so macOS refuses an ordinary
double-click. Right-click (or Control-click) `Ashlr.app` → **Open** → **Open**.
If no Open button appears, use System Settings → Privacy & Security →
**Open Anyway**, or `xattr -dr com.apple.quarantine /Applications/Ashlr.app`.
With Ashlr running, right-click its Dock icon → **Options → Keep in Dock**.

**To update:** quit Ashlr, repeat steps 1–2, launch again. The Gatekeeper
exemption is remembered per app path, so a rebuild copied over the same location
normally opens straight away. Nothing in `~/.ashlr` is touched by installing or
replacing the bundle — config, seats, autonomy state and window geometry all
survive.

### Build it

Prerequisites: Rust ≥ 1.85 with `cargo install tauri-cli --version "^2"`, Bun
1.x, Node ≥ 18, Xcode command line tools. From the repo root:

```sh
# 1. Compile the CLI into a single Bun executable (runs the web build first)
npm ci
npm run build:binary                     # → dist-bin/ashlr + dist-bin/public/

# 2. Stage it as the Tauri sidecar for the host triple
node desktop/scripts/prepare-sidecar.mjs # → desktop/src-tauri/binaries/ashlr-aarch64-apple-darwin

# 3. Generate the app icons (once, or after changing icons/icon.svg)
cd desktop && npm run icons

# 4. Build
cd desktop && cargo tauri build          # release .app + .dmg
cd desktop && cargo tauri build --debug  # fast, unoptimized
```

Output: `desktop/src-tauri/target/release/bundle/macos/Ashlr.app` and
`.../dmg/Ashlr_<version>_aarch64.dmg`. About 6 minutes cold, ~90 seconds when
only the bundling has to be redone.

**The `.app` is the artifact that matters**; the `.dmg` is only a wrapper for
handing the app to someone else. The DMG step drives Finder over AppleScript to
lay out the disk-image window, and that step is flaky — it needs a logged-in
graphical session with Automation permission, and it leaves a mounted
`/Volumes/dmg.XXXXXX` behind when it fails. `beforeBundleCommand` now clears
that leftover automatically (`desktop/scripts/dmg-preflight.mjs`), and
`CI=1 cargo tauri build` skips the Finder step entirely, producing a plain DMG
around an identical app. A DMG failure never invalidates the `.app` that was
already written. Full diagnosis in `desktop/README.md`.

For a dev loop without bundling, `cd desktop && cargo tauri dev` — it still
launches the staged sidecar, so run steps 1–2 first.

---

## Known limits

**Chat**
- One project per session, one seat per session. Switching either starts a new
  chat. There is no cross-session memory beyond what the vendor CLI keeps.
- Permission mode is fixed at `acceptEdits` / `workspace-write`. Verse does not
  surface per-tool approval prompts; use the CLI directly for stricter modes.
- No virtualized transcript. Very long sessions render every event — start a new
  session when the context meter is red anyway.
- Grok and Codex resume rely on each vendor's `--resume` / `exec resume`
  behaviour; if a vendor CLI changes its JSON shapes the adapter needs updating
  (`src/core/verse/adapters/`).
- Local seats need the `claude` binary on `PATH` and an Anthropic-compatible
  Ollama; models without tool-use support will chat but not edit.
- Dictation depends on the runtime. WKWebView has no `SpeechRecognition`; use
  system dictation in the desktop app.

**Autonomy**
- Caps bound spend per day, not per task. A single expensive dispatch can still
  consume a large share of the day's budget before the meter catches up.
- Spend figures are the hub's own accounting, not the vendor's billing. Treat
  them as close, not authoritative.
- Goals and the backlog are read-only in V2 — create and edit them through the
  CLI.
- The emergency stop is global and fail-closed. If the sentinel cannot be read,
  the hub behaves as though it is armed. That is deliberate, and it means a
  broken `~/.ashlr` looks like a stopped fleet.

**Usage**
- Claude has no local utilization signal and Grok's probe is not on
  `/api/usage`. Both are shown as unknown. Nothing is estimated to fill the gap.

**Desktop**
- macOS only. Linux Tauri builds are quarantined (`GHSA-wrw7-89jp-8q8g` /
  `RUSTSEC-2024-0429`); see `DESKTOP.md`.
- Unsigned and un-notarized — expect the one-time Gatekeeper prompt.
- The port is fixed at 7777. If something else holds it, the app tells you and
  offers to adopt it, but it cannot move to another port.
- Tokens are held in memory only and are not persisted between launches.
- A drag region cannot move the window while the window is unfocused (an
  upstream Tauri limitation of the overlay title bar): first click focuses,
  second click drags.
- Auto-update is inert until a signing key is configured.
