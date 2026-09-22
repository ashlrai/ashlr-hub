# Ashlr Verse V2 — build contract

Goal: take Verse from "works" to "Mason runs his whole engineering day in it". Two halves:
a **redesign** to the language in `docs/VERSE-DESIGN-V2.md`, and a **control plane** for the hub's
existing autonomous fleet so the human can step out of the loop while keeping spend and scope on a leash.

Read `docs/VERSE-DESIGN-V2.md` and `docs/VERSE-CONTRACT-V1.md` first. `src/core/verse/types.ts` V1 shapes
stay frozen; V2 adds `src/core/verse/control-types.ts`.

## Shell contract (every builder codes against this)

`VerseApp.tsx` renders a 56px icon rail with five sections and lazy-mounts exactly these modules, each
exporting a named component taking NO props:

| Rail item | Module | Export | Owner |
|---|---|---|---|
| Chat | `routes/verse/sections/ChatSection.tsx` | `ChatSection` | C |
| Autonomy | `routes/verse/sections/AutonomySection.tsx` | `AutonomySection` | D |
| Approvals | `routes/verse/sections/ApprovalsSection.tsx` | `ApprovalsSection` | D |
| Usage | `routes/verse/sections/UsageSection.tsx` | `UsageSection` | E |
| Settings | `routes/verse/sections/SettingsSection.tsx` | `SettingsSection` | A |

Section state lives in `verse-ui-store.ts` (owner C): active section, sidebar width/collapsed,
resources open. Persist to `localStorage` under `ashlr.verse.ui.v2`. Approvals rail item shows a dot
when `pendingCount > 0`. ⌘1–⌘5 switch sections; ⌘K quick switcher; ⌘N new chat; ⌘, Settings.

## Backend — new routes (owner B), all in `src/core/verse/control-api.ts`, mounted from `api.ts`

GETs use the read session. **Every POST requires `ctx.allowDispatch` (404 when off) AND
`passesMutationGate`** — same as existing mutating routes. Bodies validated key-by-key, unknown keys
rejected. Errors `{error, code}`.

- `GET  /api/verse/control` → `VerseControlSnapshot` — the one aggregate the Autonomy view reads:
  daemon observation, fleet status essentials, configured caps (below), enrollment list, kill-switch
  state, **daemon pause state as its own `pause` field** (never merged into `killSwitch` — the two
  sentinels have different blast radii and this view exists to tell them apart), pending approval
  count, today's spend, per-engine quota usage.
- `GET  /api/verse/caps` → `VerseCaps` — the **configured** limits, which no route exposes today:
  `{dailyBudgetUsd, perTickItems, parallel, intervalMs, mode, maxConcurrent, concurrency{local,cloud,total},
    subscriptionMaxPercent, foundryLimits: {engine, window, max}[]}`.
- `POST /api/verse/caps` — partial update, same shape. Validate hard: budget 0–1000 USD, perTickItems
  1–50, parallel 1–16, intervalMs 30_000–86_400_000, maxConcurrent 1–32, **concurrency 1–32 each**,
  subscriptionMaxPercent 1–100, foundry limit max ≥ 0. Persist with `saveConfig`. Takes effect live
  (the daemon re-reads config each tick) — say so in the response: `{ok, applied, live: true}`.
  (**Amended from 0–32**: a zero tier is not a stop, it is a hang — `resolveCfg` only adopts a tier
  `> 0` and `TieredPool` floors every cap at `Math.max(1, …)`, so a stored 0 silently became 2/6/8,
  and teaching `tieredBounded` to accept 0 would make that tier never resolve. 1 is the only value
  true in the doc, the server and the UI at once; to stop dispatch, pause the daemon or set
  `dailyBudgetUsd: 0`.)
- `GET  /api/verse/scope` → `{repos: {path, name, exists}[], degradedReason?}` from the enrollment registry.
- `POST /api/verse/scope` `{action: 'enroll'|'unenroll', path}` → calls `enroll`/`unenroll` from
  `core/sandbox/policy.ts`. Reject non-absolute paths, non-directories, and anything under
  `~/.codex/artifacts`. This is the single biggest scope lever and has no UI path today.
- `GET  /api/verse/audit?limit=&action=&result=` → `readAudit()` entries, capped at 500, newest first.
- `POST /api/verse/daemon` `{action: 'start'|'stop'|'once'|'pause'|'resume'}` — run the autonomous loop.
  `start` spawns the daemon detached exactly the way `ashlr daemon start` does (reuse `src/cli/daemon.ts`
  helpers; do NOT reimplement the tick); `once` runs a single tick; `stop` calls `stopDaemon()`.
  Return the resulting `ServiceStatusResult`/`DaemonState` projection.
  `pause`/`resume` (V2.1) are the NARROW halt: they write `~/.ashlr/daemon.paused`
  (`src/core/daemon/pause.ts`), which only `daemon/loop.ts` reads — `assertMayMutate`, `mcp-native`
  and `mcp-native-engineer` must never consult it, so a paused daemon leaves the agent's own write
  tools working. `tick()`'s `stopRequested()` honours it and the continuous loop PARKS on it (keeping
  its singleton lock) rather than exiting. An unreadable or malformed sentinel reads as PAUSED, never
  as running — same fail-closed discipline as `readKillSwitch()`'s `unknown`. `pause`/`resume` skip
  the start refusal ladder (a pause that needed enrolled scope or a live loop would be untrustworthy);
  `start`/`once` refuse while paused rather than spawning a loop that would immediately park.
  CLI parity: `ashlr daemon pause` / `ashlr daemon resume`.
- `GET  /api/verse/safety` → the `verify-safety` JSON report (reuse the `--json` path in
  `src/cli/verify-safety.ts`; extract a callable function rather than shelling out).

**Two footguns the UI must respect — encode them in the API layer, not just the UI:**
1. `POST /api/fleet/pause` writes the GLOBAL `~/.ashlr/KILL`, which also refuses the agent's own
   `mcp-native` write tools — it is an emergency stop, not a pause. Expose it in
   `VerseControlSnapshot` as `killSwitch` and label the action `emergencyStop`. Never call it "pause".
   Provide `POST /api/verse/daemon {action:'stop'}` as the ordinary stop.
   **V2.1 amendment.** `stopDaemon()` is itself `setKill(true)`, so that "ordinary stop" had the SAME
   blast radius as the emergency one — two controls, one effect, and the safer-looking of the two was
   useless. The fix is a third control with a genuinely different scope: `{action:'pause'|'resume'}`
   on a sentinel of its own. The cockpit now shows three stops — Pause (primary, unconfirmed,
   reversible), Stop loop (confirmed, states that it engages the kill switch), Emergency stop
   (separated, confirmed, stated at full blast radius) — and the word "pause" finally belongs to the
   control that earns it. The kill switch is still never called a pause.
2. `subscriptionMaxPercent` is read today through an untyped cast in five places with inconsistent
   clamping. Before exposing it: give it a typed home on `AshlrConfig['foundry']` in `src/core/types.ts`,
   clamp 1–100 in ONE helper, and make the existing readers use that helper. Do not change behavior
   otherwise.

## Sections

### Chat (owner C) — redesign of the existing surface
Rebuild against the design language: rail + sidebar + 720px transcript column + docked composer.
Messages without bubbles, tool runs collapsing to summary rows, real Markdown hierarchy, code blocks
with copy, 2px context line under the header, streaming caret, Space Grotesk numerals. Keep ALL
existing behavior: seats, models, resume, Stop, dictation, ⌘N, token gate, SSE resume, follow-ups.
Every existing Verse test must still pass or be updated deliberately, never deleted to go green.

### Autonomy (owner D) — the human-out-of-the-loop cockpit
- **Status header**: daemon running/stopped, current direction mode, last tick time and outcome,
  next tick countdown, today's spend against the daily cap as a single line meter.
- **Primary controls**: Pause / Resume (primary, unconfirmed — it is reversible and touches nothing
  but dispatch), Start / Stop the loop, Run one tick, and a clearly separated, confirm-guarded
  **Emergency stop** (the global kill switch) with a one-line explanation of what it also disables.
  Stop loop is confirm-guarded too, and its confirm says that it engages the global kill switch and
  points at Pause for the narrow halt.
- **Budget & limits panel**: editable caps from `GET/POST /api/verse/caps` — daily USD budget, items
  per tick, parallelism, tick interval, per-engine dispatch limits, subscription max percent. Each
  control shows the current value, the live usage against it, and saves on commit (blur/Enter) with an
  inline "applied live" confirmation. Guard rails: a budget of 0 means "stopped", say so.
- **Scope panel**: enrolled repositories, add (folder path) / remove, with the empty-list state stating
  plainly that an empty registry means the daemon will do nothing.
- **Activity**: recent ticks, dispatches, and the audit trail (`/api/verse/audit`) as a dense table with
  action/result/time and a filter. This is the "what did it do while I was away" view.
- **Safety**: the `verify-safety` report as five pass/fail checks with a re-run button.
- Goals and backlog read from the existing `GET /api/goals` and `GET /api/backlog` (read-only in V2;
  do not build goal mutation routes).

### Approvals (owner D)
List from `GET /api/inbox` with status filter and pending-first ordering. Row: risk class, repo, title,
engine, age. Detail: summary, a real syntax-aware diff view (reuse `routes/inbox/diff-parser.ts`,
`highlight.ts`, `DiffViewer.tsx` — do not rewrite them), verify result, decision evidence, provenance.
Approve and Reject via the existing `POST /api/inbox/:id/{approve,reject}`. Approve is destructive
(a `pr` proposal pushes a branch and opens a PR) — require an explicit confirm step naming the repo and
the kind, and show what will happen before the click.

### Usage (owner E)
- Per-account cards for every seat: engine identity marker, plan, window meters with reset times,
  tokens used, and an honest "no local signal" state for Claude rather than a fake number.
- Local vs cloud split for the period, and `localSavingsUsd` from `ControlUsage` framed as money not
  spent by running locally.
- Dispatch-ledger usage against each configured `foundry.limits` entry.
- A compact time series of spend per day from the data already available; if a series is not
  obtainable, show the aggregate and say the series is unavailable rather than inventing one.
- Reads `/api/usage`, `/api/control`, `/api/verse/control`. Claude has no local utilization signal and
  Grok's probe is not on `/api/usage` — render both honestly as unknown; do not fabricate.

### Settings (owner A)
Appearance (theme, accent hue, density, display font, radius, reduce motion) with live preview and
reset; connection (server URL, tokens, disconnect); keyboard shortcut reference; About with version.

## Ground rules
- No new runtime dependencies without saying so in the report. No network fonts. No CSS framework.
- Every new surface has loading, empty, error, and unauthorized states.
- Nothing may print or return a launcher command, token, or env value.
- Backend tests flat in `test/verse-*.test.ts`; anything spawning a process or binding a port goes in
  `test/config/realio-lane-membership.mjs`. Tests must never touch the real `~/.ashlr` — use
  `test/helpers/h1-fixture.ts` or explicit root paths.
- Web tests beside components, run by `npm run test:web`.
- Gates: `npm run typecheck`, `npm run typecheck:web`, `npm run lint`, `npm run lint:realio-lane`,
  `npx vitest run test/verse-*.test.ts`, `npm run test:web`, `npm run build:web`.
  (`npm run build` cannot pass on this machine — its dependency-inventory step rejects the global npm's
  symlinks. Run the build steps individually instead; that is a known environmental failure.)
