# CONTRACT — M13: SURFACES I (watchable hub)

This milestone makes the hub **watchable in real time**: an interactive,
auto-refreshing terminal dashboard (`ashlr tui` / `ashlr dash`) plus a
real-time Raycast extension. Build **against this contract**. Each agent edits
**ONLY its own file(s)**. ZERO new runtime deps for the CLI/TUI (Node builtins
+ `src/cli/ui.ts` helpers only). Raycast may use its existing `@raycast/api`.

The TUI is **reads-only** and must **always restore the terminal** (show cursor,
leave alt-screen, disable raw mode) on quit / signal / throw. The single
exception to reads-only is dispatching a run/swarm from Raycast, which is
bounded + local-first exactly like `ashlr run`.

---

## Shared types (already in `src/core/types.ts` — DO NOT redefine)

```ts
export interface DashboardSnapshot {
  generatedAt: string;
  repos: { total: number; dirty: number; stale: number };
  tools: { installed: number; total: number };
  activity: { sessions: number; tokens: number; estCostUsd: number; commits: number };
  runs: { id: string; goal: string; status: string; tokens: number }[];
  swarms: {
    id: string;
    goal: string;
    status: string;
    tasksDone: number;
    tasksTotal: number;
    phase?: string;
  }[];
  mcp: { name: string; ok: boolean; tools: number }[];
  genome: { entries: number; projects: number };
}

export type TuiTab = 'overview' | 'runs' | 'swarms' | 'pulse' | 'mcp';
```

`AshlrConfig` is the existing config type from `src/core/types.ts`.

---

## EXACT signatures

### `src/core/dashboard.ts`

```ts
import type { AshlrConfig, DashboardSnapshot } from './types.js';

export async function buildSnapshot(cfg: AshlrConfig): Promise<DashboardSnapshot>;
```

- Aggregates the existing data sources — **REUSE, do not reinvent**:
  - `core/index-engine.ts` `loadIndex()` + `core/git.ts` → `repos`
    (`total` = repos in index; `dirty` = repos with a dirty working tree;
    `stale` = inactive/stale repos).
  - `core/tools-registry.ts` `getToolsRegistry()` → `tools`
    (`installed` = `installedCount`; `total` = `tools.length`).
  - `core/observability/rollup.ts` `buildRollup()` → `activity`
    (`sessions`/`tokens` (in+out)/`estCostUsd`/`commits` from `totals`).
  - `core/run/orchestrator.ts` `listRuns()` / `loadRun()` → `runs`
    (most-recent first; `tokens` = run cumulative in+out usage).
  - `core/swarm/store.ts` `listSwarms()` / `loadSwarm()` → `swarms`
    (`tasksDone`/`tasksTotal` task burndown; `phase` = current/active phase).
  - `core/mcp-registry.ts` `discoverMcpServers()` (+ existing health probe)
    → `mcp` (`ok` + `tools` count per server).
  - `core/genome/store.ts` `genomeHealth()` → `genome`
    (`entries` = total entries; `projects` = distinct projects).
- **Bounded**: cap the number of runs/swarms/mcp entries read and bound any
  per-source work so a single frame never blocks the refresh loop.
- **NEVER throws**: any unavailable/failing source degrades to zeroed/empty
  fields; the function always resolves a well-formed `DashboardSnapshot`.
- `generatedAt` is set to the ISO timestamp at build time.

### `src/tui/render.ts`

```ts
import type { DashboardSnapshot, TuiTab } from '../core/types.js';

export function renderFrame(
  snap: DashboardSnapshot,
  state: { tab: TuiTab; selected: number; cols: number; rows: number },
): string;
```

- **PURE** — no I/O, no timers, no global state. Same inputs → same output.
  Fully testable in isolation.
- Returns the **complete ANSI frame string** for the given `state.tab`,
  sized to `state.cols` × `state.rows` (clip/pad to fit; never overflow).
- Renders a tab bar (overview / runs / swarms / pulse / mcp), the active tab's
  body, and a key-hint footer. `state.selected` highlights the current row in
  list-style tabs (runs, swarms, mcp).
- Tab content:
  - **overview**: repos dirty/stale, ecosystem tools installed/total, and a
    one-line activity summary (sessions/tokens/cost/commits).
  - **runs**: recent runs with live status + tokens.
  - **swarms**: active/recent swarms with per-phase + task burndown
    (done/total).
  - **pulse**: 7d cost/tokens/by-project activity.
  - **mcp**: MCP server health (name, ok, tool count).
- Uses ONLY `src/cli/ui.ts` ANSI/`pad`/`stripAnsi`/`color` helpers (+ Node
  builtins). No new deps.

### `src/tui/app.ts`

```ts
import type { AshlrConfig } from '../core/types.js';

export async function runTui(
  cfg: AshlrConfig,
  opts: { once: boolean },
): Promise<number>;
```

- Resolves to the process exit code (0 on clean quit).
- **`opts.once === true`**: build ONE `buildSnapshot(cfg)`, render ONE frame via
  `renderFrame(...)`, write it to stdout, and return — **no raw mode, no
  alt-screen, no timers**. This is the headless/scripting/test path.
- **Non-TTY** (stdout not a TTY): behave like `--once` — print one frame and
  return; never enter raw mode.
- **Interactive TTY** (`opts.once === false` and stdout is a TTY):
  - Enter alt-screen, hide cursor, enable raw-mode key handling via `readline`
    / `process.stdin` (Node builtins only).
  - Auto-refresh every ~2s by re-reading via `buildSnapshot(cfg)` (bounded,
    never blocks the loop); re-render on each refresh, keypress, and resize.
  - Keys: `tab`/`shift-tab` or `1`–`5` switch tabs; `j`/`k` move selection;
    `r` force-refresh; `enter` open/show detail; `q` (and Ctrl-C) quit.
  - Resize-aware: track `process.stdout.{columns,rows}` and re-render on the
    `resize` event.
  - **ALWAYS restore the terminal** (show cursor, leave alt-screen, disable raw
    mode, remove listeners) on quit, on `SIGINT`/`SIGTERM`, and on any thrown
    error — never leave the terminal corrupted.

### `src/cli/tui.ts`

```ts
export async function cmdTui(args: string[]): Promise<number>;
```

- Parses `--once` (boolean) from `args`.
- Loads the config (existing config loader) and dispatches to
  `runTui(cfg, { once })`, returning its exit code.
- Registered as the `tui` command with alias `dash` in the CLI dispatcher
  (`src/cli/index.ts`).

---

## Raycast (real-time) — `src/raycast/`

Use `@raycast/api`'s built-in polling/revalidation (e.g. `usePromise` /
`useExec` with an interval) reading `~/.ashlr/{index,runs,swarms}.json` and
`ashlr ... --json`.

- **Dispatch Run**: a form that runs `ashlr run --json`.
- **Swarms**: list active/recent swarms with live task done/total + per-phase;
  action to show detail / open the project.
- Make the existing **pulse** / **attention** views auto-revalidate (interval).
- Register every new command in `src/raycast/package.json`.

---

## File ownership (each agent edits ONLY its file[s])

| File                        | Owner                                  |
| --------------------------- | -------------------------------------- |
| `src/core/types.ts`         | CONTRACT (this agent) — DONE           |
| `CONTRACT-M13.md`           | CONTRACT (this agent) — DONE           |
| `src/core/dashboard.ts`     | dashboard agent                        |
| `src/tui/render.ts`         | render agent                           |
| `src/tui/app.ts`            | app agent                              |
| `src/cli/tui.ts`            | cli agent (+ register in index.ts)     |
| `src/raycast/*`             | raycast agent                          |

## Guardrails

- ZERO new runtime deps for CLI/TUI (Node builtins + `src/cli/ui.ts` only).
- TUI is reads-only; the only outward action is Raycast dispatching a run/swarm
  (bounded + local-first like `ashlr run`).
- TUI must restore the terminal on quit/signal/throw.
- Preserve all existing behavior and the 1184 passing tests. No git commit.
