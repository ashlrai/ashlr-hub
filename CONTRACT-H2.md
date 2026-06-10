# CONTRACT-H2 — HARDEN & PROVE: CRASH RECOVERY & RESUMABILITY

Milestone H2 of Ashlr v2.1 "Harden & Prove". Builds on **H1** (commit `3c91de0`,
the keystone) and **REUSES its testkit** (`test/helpers/h1-fixture.ts`).

**Primary goal is PROOF.** H2 is mostly TESTS that fault-inject against the REAL
recovery paths. We inject faults — a daemon killed mid-tick, a swarm killed
mid-run, a sandbox orphaned before cleanup, a kill switch toggled across persist
points — then invoke the REAL recovery/resume/restart code and assert the system
recovers cleanly: **NO double-spend, NO orphaned sandboxes, NO stuck proposals,
correct RESUME from persisted state, and a clean ABORT on a kill-switch race.**

Any production change is **MINIMAL and LOCAL-ONLY** (reconcile persisted state /
sweep orphan sandboxes / mark a crashed `running` swarm resumable). It MUST add
**NO new outward capability**, weaken **NO guard**, and change **NO happy-path
behavior**. We prefer proving the existing paths; every production line is
justified in the GAPS section below.

---

## ABSOLUTE SAFETY RULES (paramount — inherited verbatim from H1)

- **ISOLATED HOME.** Every test relocates `process.env.HOME` to a FRESH
  `os.tmpdir()` dir via the H1 fixture (`makeFixture`/`withTmpHome`), so every
  `~/.ashlr` read/write (swarms, sandboxes, inbox, daemon.json, enrollment, KILL)
  resolves to an ISOLATED home — **NEVER the real one**. The fixture asserts
  `homedir() === tmpHome` and refuses to run otherwise.
- **REAL PORTFOLIO UNTOUCHED.** The real `~/.ashlr/enrollment.json = { repos: [] }`
  is never enrolled or read. Only DISPOSABLE git repos under `os.tmpdir()`
  (`makeRepo`) are ever enrolled/sandboxed, and each test cleans up after itself.
- **NO OUTWARD ACTION.** No test calls `applyProposal`, pushes, opens a PR, or
  deploys. The daemon path under test is PROPOSAL-ONLY; recovery adds nothing.
- **DETERMINISTIC.** No live-LLM dependency, no network, **no real crashing
  subprocess**. See below.

---

## FAULT-INJECTION TECHNIQUE (the core idea — read first)

We do **NOT** spawn a real crashing subprocess and do **NOT** depend on a model.
A "crash" is simulated by writing, **through the REAL stores**, the exact on-disk
intermediate state a process killed at a chosen instant would leave, and then
invoking the genuine production recovery entry point:

| Crash simulated | How H2 constructs the intermediate state | Real recovery path invoked |
|---|---|---|
| Swarm killed mid-phase | `crashMidSwarm()` → `saveSwarm()` a `SwarmRun` at status `running` with some tasks `done`, rest `pending`, plan populated | `runSwarm(..., { resumeId })` (runner.ts ~1224) |
| Daemon killed mid-tick | `seedMidTickSpend()` → `saveDaemonState()` with `todaySpentUsd=X`, `todayDate=today`, `running=true` | `tick()` / `loadDaemonState()` / `resetDayIfNeeded()` |
| Sandbox orphaned pre-cleanup | `makeOrphanSandbox()` → REAL `createSandbox()` then DROP the handle (worktree persists on disk) | `listSandboxes()` → `removeSandbox()` |
| Proposal mid-write | atomic tmp+rename in `inbox/store.ts`; seed via REAL `createProposal()` + a stray `*.tmp` sidecar | `listProposals()` / `loadProposal()` |
| Kill toggled across persist points | `setKill(true/false)` between checkpoints | `killSwitchOn()` / `assertMayMutate()` gate before work |

Because every byte is written through the SAME stores the production code reads
back, the recovery path exercised is the **real** one — only the "kill" itself is
synthetic.

---

## THE REUSABLE TESTKIT + NEW FAULT HELPERS

### Reused from `test/helpers/h1-fixture.ts` (H1 — unchanged)

`withTmpHome` / `makeFixture`, `makeDisposableRepo` / fixture `makeRepo`,
`seedBacklog`, `makeCfg`, `shasumTree`, `makeAddFileDiff`, `todoSeedFiles`,
`todoScannerAvailable`. Same HOME-isolation timing rule as H1 (the core stores
resolve `homedir()` at call time; do NOT use `loadConfig()`/`CONFIG_DIR`).

### New in `test/helpers/h2-faults.ts` (H2 — TEST-ONLY, no prod change)

Each helper writes ONLY through the real stores under the isolated tmp HOME:

- `crashMidSwarm({ id, goal, project, taskIds, doneTaskIds?, phase?, status? })`
  → persists (via `saveSwarm`) a crash-intermediate `SwarmRun` (default status
  `running`); plan populated so resume does NOT re-plan (model-free). Returns the
  `SwarmRun`. `reloadSwarm(id)` re-reads it.
- `seedMidTickSpend({ spentUsd, running?, withTickRecord? })` → seeds
  `daemon.json` (via `saveDaemonState`) with today's debited spend and (default)
  `running=true` + a stale pid. Returns the `DaemonState`. `reloadDaemonState()`
  re-reads it; `daemonStateExists()` checks presence.
- `makeOrphanSandbox(repoDir)` → REAL `createSandbox(repoDir, { allowAnyRepo:true })`
  then returns the `Sandbox` while dropping the live handle → an on-disk orphan.
  `listOrphanSandboxes()` (= `listSandboxes()`), `sandboxHomeExists(id)`,
  `ensureSandboxesDir()` support assertions.
- `seedPendingProposal(repoDir, title?)` → REAL `createProposal()` of a PENDING
  patch proposal. Returns the `Proposal`.
- `today()` helper (YYYY-MM-DD, matches daemon state).

All strictly typed, node builtins + project stores only, no new runtime dep.

---

## THE SUITES (`test/h2.*.test.ts`) — the 5 BUILD tasks + what each asserts

### BUILD 1 — `test/h2.swarm-resume.test.ts` (CLEAN-RESUME)
Drives the REAL `runSwarm({ resumeId })`:
- a run persisted at `running` with partial tasks is loadable + resumable;
- resume **SKIPS** already-`done` tasks and does **NOT re-plan** (deterministic,
  model-free) — `executeTask` returns `'continue'` for `done`, and the planner is
  skipped when `plan.tasks` is already populated;
- resume drives a partial run to a **TERMINAL** status (never stuck at `running`);
- resuming an absent id fails safely (status `failed`, "not found", no mutation).

### BUILD 2 — `test/h2.daemon-no-double-spend.test.ts` (NO-DOUBLE-SPEND)
Drives the REAL `tick()` / `loadDaemonState()` / `resetDayIfNeeded()`:
- a same-day restart **PRESERVES** the already-debited `todaySpentUsd` (never
  zeroes it, never doubles it);
- a restart over an already-debited budget refuses work (reason
  `budget-exhausted`, `runSwarm` NOT called, spend unchanged);
- NEW realized spend **ADDS to** — never re-adds — the persisted spend
  (`todaySpentUsd === prior + S`, with `runSwarm` MOCKED to a known `S`);
- a stale `running=true` from a crash is reconciled (GAP — see below).

### BUILD 3 — `test/h2.orphan-sandbox.test.ts` (NO-ORPHAN-SANDBOX)
Drives the REAL `listSandboxes()` / `removeSandbox()`:
- an orphaned worktree (dropped handle) is **SURFACED** by `listSandboxes`;
- the sweep removes worktree + scratch branch with **NO source mutation**
  (`shasumTree` byte-identical, `git status` clean, branch set unchanged);
- the sweep is **idempotent** (re-sweep never throws);
- a restart-time sweeper removes ALL unowned sandboxes (GAP — see below).

### BUILD 4 — `test/h2.proposal-survives.test.ts` (NO-STUCK-PROPOSAL)
Drives the REAL `listProposals()` / `loadProposal()` / `pendingCount()`:
- a PENDING proposal seeded before a crash is loadable + still **PENDING** after
  a restart (byte round-trip; status never auto-advances);
- a leftover `*.tmp` sidecar is never surfaced (no limbo);
- a restart does NOT auto-advance a pending proposal (`pendingCount` stable);
- a malformed inbox file is skipped, not surfaced as a stuck proposal.

### BUILD 5 — `test/h2.kill-race-abort.test.ts` (KILL-RACE-CLEAN-ABORT)
Drives the REAL kill gate (`killSwitchOn` / `assertMayMutate`) + `tick` + resume:
- kill ON ⇒ `createSandbox` **REFUSES** even with `allowAnyRepo` (which bypasses
  ENROLLMENT only, **never** the kill switch) — no worktree, so no orphan;
- kill toggled on before a tick ⇒ clean abort (reason `kill-switch`, 0 proposals,
  `runSwarm` NOT dispatched, persisted spend unchanged);
- kill toggled on after a crash ⇒ resume aborts (mandatory sandbox refused ⇒ ZERO
  tasks, working tree untouched, run not falsely `done`);
- clearing the kill switch restores normal operation (no sticky/latent abort).

---

## H2 INVARIANTS (verbatim) + HOW EACH IS PROVEN

1. **NO-DOUBLE-SPEND** — A restart after a mid-tick crash never counts the
   already-debited spend twice. *Proven:* seed `daemon.json` with `todaySpentUsd=X`
   (today), drive the REAL `tick`/`loadDaemonState` restart, assert the counter is
   `X` (same-day preserve) or `X + S` (only NEW realized spend `S`), never `2X`;
   the budget gate still fires off the preserved `X`.

2. **NO-ORPHAN-SANDBOX** — A crash-leftover worktree is surfaced and swept with no
   source-repo mutation. *Proven:* `makeOrphanSandbox` (REAL `createSandbox`, then
   dropped handle) ⇒ `listSandboxes()` surfaces it ⇒ `removeSandbox()` (or the
   recovery sweeper) deletes the worktree + scratch branch; the disposable source
   repo's `shasumTree`/`git status`/branch set are byte-identical before/after.

3. **NO-STUCK-PROPOSAL** — A crash cannot strand a proposal in a non-terminal
   limbo; PENDING ones survive a restart intact and stay safely PENDING. *Proven:*
   atomic tmp+rename means a reader sees OLD or COMPLETE-new — never partial; a
   seeded PENDING proposal round-trips byte-equal and `pendingCount()` is unchanged
   across a restart; `*.tmp` sidecars and malformed files are skipped, not surfaced.

4. **CLEAN-RESUME** — A swarm crashed at `running` with partial tasks resumes from
   persisted state, skipping done work and reaching a terminal status. *Proven:*
   `crashMidSwarm` ⇒ `runSwarm({ resumeId })` skips `done` tasks, does not re-plan,
   and ends terminal (`done`/`failed`/`aborted`/`needs-approval`) — never stuck.

5. **KILL-RACE-CLEAN-ABORT** — Toggling the kill switch across persist points
   yields a clean abort with no partial outward effect and no corrupted state.
   *Proven:* kill ON ⇒ `createSandbox`/`tick` refuse before any work (no worktree,
   reason `kill-switch`, `runSwarm` not dispatched); a kill-during-resume aborts to
   ZERO tasks; the disposable tree stays byte-identical; clearing the kill restores
   normal operation.

6. **ISOLATED** — Everything runs under a FRESH tmp HOME; the real `~/.ashlr`
   (portfolio `{repos:[]}`, daemon.json, inbox, sandboxes) is NEVER touched.
   *Proven:* the H1 fixture's `homedir() === tmpHome` guard + per-test cleanup;
   all stores resolve `homedir()` at call time.

7. **DETERMINISTIC** — No live model, no network, no real crashing subprocess.
   *Proven:* crashes are synthetic persisted-state constructions; `runSwarm` is
   MOCKED on any daemon path that would otherwise execute a task; resume tests
   either use all-`done` tasks (pure recovery) or the builtin engine in isolation.

---

## RECOVERY GAPS TO PROBE (and whether a MINIMAL LOCAL-ONLY fix is warranted)

The probe order is: (a) write the test against the REAL path; (b) if it already
recovers, the test is pure proof and **no** production line is added; (c) only if
a genuine gap is found do we add the minimal local-only reconcile/sweep below.
Integration (not this scaffold) owns any actual production edit.

1. **GAP — does a restart double-count spend?**
   `tick()` reloads state and ADDS only `tickSpent` (this tick's realized spend);
   `resetDayIfNeeded` zeroes only on a real date change. So a same-day restart
   should PRESERVE the debited spend and add only new spend. *Expectation:* PASS
   with no prod change. *If it fails* (e.g. a path re-adds a persisted tick's
   spend), the fix is a LOCAL idempotency guard in `daemon/state` or `loop`
   accounting — pure bookkeeping, no outward capability.

2. **GAP — is a stale `running=true` reconciled on restart?**
   A crash leaves `running=true` with a stale pid and the clean-exit `running=false`
   write never ran. `runDaemon` re-asserts `running=true` on start and the
   re-entrancy guard keys off the `ASHLR_IN_DAEMON` env var (cleared on a new
   process), so a fresh process is NOT blocked. But `daemon status` may MISREPORT a
   dead daemon as live. *Likely MINIMAL LOCAL-ONLY fix:* a `reconcileDaemonState()`
   that flips `running=false`/`pid=null` when the recorded pid is absent/not alive
   (a read-only `process.kill(pid, 0)` liveness probe) at load/status time. This is
   **local-only**: it only corrects a STALE STATUS FLAG, adds NO outward capability,
   weakens NO guard (the kill switch and re-entrancy guard are untouched), and does
   NOT change happy-path behavior (a genuinely-running daemon keeps `running=true`).

3. **GAP — does anything SWEEP orphan sandboxes on restart?**
   `removeSandbox` exists and is safe/idempotent, and `listSandboxes` surfaces
   orphans, but there is **no caller that sweeps unowned sandboxes on startup** —
   a crash mid-swarm can leave a worktree that accumulates forever. *Likely MINIMAL
   LOCAL-ONLY fix:* a `sweepOrphanSandboxes()` that iterates `listSandboxes()` and
   `removeSandbox()`es each id not owned by a `running`/`needs-approval` swarm
   (cross-referenced via `listSwarms()` `sandboxId`). It composes the two EXISTING
   safe primitives, runs only under the isolated/enrolled-or-tmp surface they
   already guard, adds **NO outward capability** (cleanup is inward-only), and is
   off the happy path (a clean run already removes its own sandbox).

4. **GAP — is a crashed `running` swarm resumable or stuck?**
   `runSwarm({ resumeId })` loads a `running` record, skips `done` tasks, and
   continues — so a crashed run IS resumable by design. *Expectation:* PASS with no
   prod change. The only adjacent concern is OBSERVABILITY: a never-resumed crashed
   run sits at `running` forever in `ashlr swarms`. *Optional MINIMAL LOCAL-ONLY
   fix (only if a test shows it matters):* a `markResumable()` reconcile that
   re-labels a stale `running` swarm (whose owning process is gone) without
   executing anything — a status-only correction, no outward capability, no
   happy-path change. Default stance: prove resumability; do NOT add this unless a
   suite demonstrates a concrete stuck-state harm.

5. **GAP — can a kill-switch race leave a half-applied effect?**
   The kill gate is checked BEFORE work in both `createSandbox` (via
   `assertMayMutate`) and `tick`, and the swarm's `requireSandbox` aborts to ZERO
   tasks when the sandbox can't be created. *Expectation:* PASS with no prod change
   — the race is already a clean abort. No fix anticipated.

**Anticipated production changes:** at most the three reconcile/sweep helpers in
gaps #2, #3, #4 — each LOCAL-ONLY, each composed from existing safe primitives,
each adding no outward capability and no happy-path change, each added ONLY if a
H2 test demonstrates the gap. Gaps #1 and #5 are expected to be pure proof.

---

## DELIVERABLES

- `CONTRACT-H2.md` (this file).
- `test/helpers/h2-faults.ts` — fault-injection helpers (extends the H1 testkit).
- `test/h2.swarm-resume.test.ts` — BUILD 1 (CLEAN-RESUME).
- `test/h2.daemon-no-double-spend.test.ts` — BUILD 2 (NO-DOUBLE-SPEND).
- `test/h2.orphan-sandbox.test.ts` — BUILD 3 (NO-ORPHAN-SANDBOX).
- `test/h2.proposal-survives.test.ts` — BUILD 4 (NO-STUCK-PROPOSAL).
- `test/h2.kill-race-abort.test.ts` — BUILD 5 (KILL-RACE-CLEAN-ABORT).

Conventions: ESM, `.js` import specifiers, strict TS, vitest, eslint. Tests under
`test/` named `h2.*.test.ts`; helpers under `test/helpers/`. No new runtime deps.
Do NOT touch the real `~/.ashlr`.
