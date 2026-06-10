# CONTRACT-M24 — THE DAEMON (`ashlr daemon`)

The autonomous operator that makes the org continuous. It pulls the highest-value
backlog items for ENROLLED repos and dispatches SANDBOXED swarms whose output
becomes PENDING PROPOSALS in the Approval Inbox. It is the most powerful piece —
and SAFE BY CONSTRUCTION: it can ONLY propose; it has NO path to apply / push /
PR / deploy / mutate.

Build against this contract. Each agent edits ONLY its own file(s). Do NOT change
existing behavior; preserve all 2357 tests; reuse existing modules; add no new
runtime deps; do NOT `git commit` ashlr-hub.

---

## NON-NEGOTIABLE GUARDRAILS (the daemon is the most dangerous component)

1. **PROPOSAL-ONLY.** The daemon's ONLY output is PENDING proposals in the M23
   inbox (`core/inbox/store.ts` `createProposal`). It NEVER applies/approves a
   proposal, NEVER pushes, NEVER opens a PR, NEVER deploys, NEVER mutates a user
   repo working tree. Proposals are applied ONLY later by an explicit human
   `inbox approve`. **Grep-provable:** daemon code (`core/daemon/*.ts`,
   `cli/daemon.ts`) MUST NOT import or call `applyProposal` (from
   `core/inbox/apply`), `git push`, `gh pr create` / `createPr`, or any
   ship/deploy path. The ONLY inbox call it may make is `createProposal`
   (indirectly, via `runSwarm({ propose: true })`) and READ-ONLY `pendingCount`.

2. **ENROLLMENT-ONLY.** Operates ONLY on `listEnrolled()` repos
   (`core/sandbox/policy.ts`). DEFAULT EMPTY => the daemon does NOTHING (no repo
   touched). NEVER scans/operates on the whole 69-repo portfolio. Verify with a
   TMP enrolled repo ONLY.

3. **SANDBOXED.** All swarm work runs via `runSwarm({ sandbox: true })` (M21
   worktrees under `~/.ashlr/sandboxes/`) — NEVER the user's working tree.

4. **BOUNDED.** HARD daily budget cap (`DaemonConfig.dailyBudgetUsd`, default
   modest) + per-tick item cap (`perTickItems`) + concurrency cap (`parallel`).
   The budget resets per calendar day. When today's spend reaches the cap the
   daemon idles/stops. NO unbounded loop. KILL SWITCH (`~/.ashlr/KILL`, M21
   `isKilled`) halts every tick immediately; `daemon stop` sets it.

5. **RE-ENTRANCY.** Set `ASHLR_IN_DAEMON=1` on child processes. `runDaemon`
   REFUSES to start if `ASHLR_IN_DAEMON` or `ASHLR_IN_SWARM` is set (no
   daemon-inside-daemon / daemon-inside-swarm fork bomb). Respect the existing
   `ASHLR_IN_SWARM` swarm recursion guard.

6. **BUILD/VERIFY ONLY.** Verify with a TMP enrolled repo, `--once`, a tiny
   budget, proposal-only + `--dry-run` ONLY. Do NOT enroll the real portfolio.
   Do NOT run the daemon as a long-lived live process. Activating the daemon on
   real repos is Mason's explicit gate.

---

## TYPES (already added to `src/core/types.ts` — DO NOT re-edit)

```ts
export interface DaemonConfig {
  dailyBudgetUsd: number;  // HARD daily spend ceiling (USD); resets per day
  perTickItems: number;    // max backlog items processed per tick
  parallel: number;        // bounded concurrency of sandboxed swarms per tick
  intervalMs: number;      // interval between ticks in loop mode (ms)
}

export interface DaemonTick {
  ts: string;              // ISO timestamp
  itemsConsidered: number; // items considered after budget/cap selection
  proposalsCreated: number;// PENDING proposals created this tick
  spentUsd: number;        // estimated USD spent this tick
  reason: string;          // 'ok' | 'kill-switch' | 'budget-exhausted'
                           //  | 'no-enrolled-repos' | 'no-backlog' | 'dry-run'
}

export interface DaemonState {
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  lastTickAt: string | null;
  todayDate: string | null;     // YYYY-MM-DD the spend counters apply to
  todaySpentUsd: number;        // reset when todayDate rolls over
  itemsProcessed: number;       // cumulative across all ticks
  ticks: DaemonTick[];          // bounded history (most-recent last)
}
```

`AshlrConfig` is extended with optional `daemon?: Partial<DaemonConfig>` (caps
only — grants no authority). `DashboardSnapshot` gains optional
`daemon?: { running: boolean; todaySpentUsd: number; pendingProposals: number }`.

---

## FILES & EXACT SIGNATURES

### `src/core/daemon/state.ts` — persistence (own this file only)

```ts
export function daemonStatePath(): string;
// ~/.ashlr/daemon.json (respect ASHLR_HOME if the codebase already does).

export function loadDaemonState(): DaemonState;
// Read+parse daemonStatePath(). NEVER throws — return a fresh zeroed state on
// missing/corrupt file: { running:false, pid:null, startedAt:null,
// lastTickAt:null, todayDate:null, todaySpentUsd:0, itemsProcessed:0, ticks:[] }.

export function saveDaemonState(s: DaemonState): void;
// Atomically write JSON to daemonStatePath() (mkdir -p the dir). Metadata only.

export function resetDayIfNeeded(s: DaemonState): DaemonState;
// If s.todayDate !== today's YYYY-MM-DD, return a copy with todayDate=today and
// todaySpentUsd=0 (daily budget reset). itemsProcessed + ticks are preserved.
// Pure-ish: returns the (possibly new) state; caller persists.
```

### `src/core/daemon/loop.ts` — the operator (own this file only)

```ts
export async function tick(
  cfg: AshlrConfig,
  opts: { dryRun: boolean },
): Promise<DaemonTick>;
```
ONE operator cycle. In order:
  1. If kill switch set (M21 `isKilled` / `~/.ashlr/KILL`) => return a tick with
     `reason:'kill-switch'`, zero counters. No work.
  2. Load+`resetDayIfNeeded` state; if `todaySpentUsd >= dailyBudgetUsd` =>
     return `reason:'budget-exhausted'`, zero counters.
  3. `listEnrolled()`; if empty => return `reason:'no-enrolled-repos'`. NEVER
     touch non-enrolled repos.
  4. Refresh/load backlog (M22 `buildBacklog`/`loadBacklog`) for enrolled repos;
     if no items => `reason:'no-backlog'`.
  5. Take the top-K items (`perTickItems`), bounded by remaining daily budget.
  6. **If `dryRun`:** count what WOULD be worked into `itemsConsidered`, create
     NO swarms and NO proposals; return `reason:'dry-run'`.
  7. Otherwise, for each selected item with bounded concurrency (`parallel`):
     `runSwarm(cfg, { ..., sandbox: true, propose: true })` (M21 worktree + M23
     proposal). Each success => a PENDING inbox proposal. Tally
     `proposalsCreated` + `spentUsd`; stop early if remaining budget is exhausted.
  8. Update + persist state (today's spend, itemsProcessed, append the tick,
     bound `ticks` length). Return the tick.

NEVER calls `applyProposal`, `git push`, `createPr`, or any deploy path.

```ts
export async function runDaemon(
  cfg: AshlrConfig,
  opts: { once: boolean; dryRun: boolean },
): Promise<DaemonState>;
```
  - REFUSE (return state unchanged, do nothing) if `process.env.ASHLR_IN_DAEMON`
    or `process.env.ASHLR_IN_SWARM` is set.
  - Set `ASHLR_IN_DAEMON=1` for itself and any child processes.
  - Mark state running (pid, startedAt), persist.
  - `once:true` => run exactly one `tick`, then stop (clear running), return.
  - else loop: `tick`; persist; if kill switch set OR `todaySpentUsd >=
    dailyBudgetUsd` => stop; else wait `intervalMs` and repeat. NO unbounded
    loop — every iteration re-checks kill + budget.
  - On stop, clear running/pid and persist; return final state.

```ts
export function stopDaemon(): void;
// Set the kill switch (M21, write ~/.ashlr/KILL) AND clear running state
// (running=false, pid=null) via load/save. Idempotent; never throws.
```

### `src/cli/daemon.ts` — CLI surface (own this file only)

```ts
export async function cmdDaemon(args: string[]): Promise<number>;
```
Subcommands (returns process exit code; 0 = ok):
  - `daemon start [--once] [--dry-run] [--budget <usd>] [--interval <ms>]
    [--parallel <n>]` — load cfg, merge flags over `cfg.daemon`/defaults into a
    `DaemonConfig`, call `runDaemon(cfg, { once, dryRun })`. `--dry-run` =>
    plan only (which items WOULD be worked; NO swarm/proposal). REFUSES (nonzero,
    clear message) when `ASHLR_IN_DAEMON`/`ASHLR_IN_SWARM` is set.
  - `daemon stop` — `stopDaemon()`; print confirmation.
  - `daemon status` — print: running?, last tick, today's spend vs cap, items
    processed, pending proposals (`pendingCount` from M23). READ-ONLY.

Wire `cmdDaemon` into the CLI dispatcher (`src/cli/index.ts`) the same way the
M22/M23 commands (`backlog`, `inbox`) are wired. Edit ONLY the dispatch table
entry — match existing style.

### Dashboard / TUI / Web surface (own those files only)

Populate `DashboardSnapshot.daemon` (optional) from `loadDaemonState()` +
`pendingCount()`:
`{ running, todaySpentUsd, pendingProposals }`. READ-ONLY — surfacing daemon
status NEVER applies a proposal or mutates a repo. Render it in the TUI overview
and the web dashboard next to the inbox `pending` count.

---

## VERIFICATION (the loop must do this; build-only)

1. `npm run typecheck && npm run build && npm test` — all 2357 tests still pass.
2. Create a TMP repo, `enroll` ONLY that repo.
3. `ashlr daemon start --once --dry-run --budget 0.05` => plans, creates NO
   proposals (`pendingCount` unchanged).
4. `ashlr daemon start --once --budget 0.05` => at most a tiny number of PENDING
   proposals; verify `inbox` shows them PENDING (never applied).
5. `ASHLR_IN_DAEMON=1 ashlr daemon start --once` => REFUSES.
6. `ASHLR_IN_SWARM=1 ashlr daemon start --once` => REFUSES.
7. `ashlr daemon stop` => kill switch set; next tick is a `kill-switch` no-op.
8. Grep-prove the daemon never references `applyProposal`, `git push`,
   `gh pr create`/`createPr`, or any deploy path.
9. Un-enroll the TMP repo; remove `~/.ashlr/KILL`. Do NOT enroll the real
   portfolio. Do NOT run the daemon as a long-lived process.
