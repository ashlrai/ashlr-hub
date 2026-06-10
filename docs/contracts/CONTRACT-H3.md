# CONTRACT-H3 — HARDEN & PROVE: CONCURRENCY & BUDGET STRESS

Milestone H3 of Ashlr v2.1 "Harden & Prove". Builds on **H1** (commit `3c91de0`,
the keystone — `test/helpers/h1-fixture.ts`) and **H2** (commit `595ecf2` —
`test/helpers/h2-faults.ts`). It **REUSES BOTH testkits** and adds one small
stress helper (`test/helpers/h3-stress.ts`).

**Primary goal is PROOF.** H3 is a STRESS-TEST milestone. It drives MANY
concurrent tasks/items through the REAL bounding / selection / accounting code
and asserts the in-process caps hold under load: the daily USD budget cap, the
per-tick item cap, the concurrency cap (`parallel <= 8`), the per-task budget
reservation (`sum(authorized) <= pool`), the exact daily reset (no double-count,
no lost spend), and id uniqueness under same-millisecond bursts.

The work is driven with `runSwarm` / `runGoal` **MOCKED** (per the M12 / M24 / H2
convention) so the BOUNDING / SELECTION / ACCOUNTING code runs **for real** while
the simulated work is instant and deterministic — no live model, no real
subprocess, no network.

The **ONLY** production change permitted in H3 is the `makeId()` monotonic
counter fix in `swarm/runner.ts` (justified in THE SINGLE PRODUCTION CHANGE
below). It adds **NO new outward capability**, weakens **NO guard**, and changes
**NO happy-path behavior** (ids stay sortable, charset-valid, filename-safe). H3
does **NOT** build any inter-process lock; the multi-process limit is DOCUMENTED,
not fixed (see THE MULTI-PROCESS LIMITATION).

---

## ABSOLUTE SAFETY RULES (paramount — inherited verbatim from H1/H2)

- **ISOLATED HOME.** Every test relocates `process.env.HOME` to a FRESH
  `os.tmpdir()` dir via the H1 fixture (`makeFixture`/`withTmpHome`), so every
  `~/.ashlr` read/write (swarms, sandboxes, inbox, daemon.json, enrollment, KILL)
  resolves to an ISOLATED home — **NEVER the real one**. The fixture asserts
  `homedir() === tmpHome` and refuses to run otherwise.
- **REAL PORTFOLIO UNTOUCHED.** The real `~/.ashlr/enrollment.json = { repos: [] }`
  is never enrolled or read. Only DISPOSABLE git repos under `os.tmpdir()`
  (`makeRepo`) are ever enrolled/sandboxed, and each test cleans up after itself.
- **NO OUTWARD ACTION.** No test calls `applyProposal`, pushes, opens a PR, or
  deploys. The daemon path under test is PROPOSAL-ONLY; the stress harness adds
  nothing outward.
- **DETERMINISTIC.** No live-LLM dependency, no network, **no real subprocess**.
  Concurrency is driven with mocked instant work and `Promise.all` fan-out, so a
  run is reproducible regardless of machine speed (see below).

---

## DETERMINISTIC-CONCURRENCY STRESS TECHNIQUE (the core idea — read first)

We do **NOT** spawn real agents and do **NOT** depend on a model or wall-clock
scheduling luck. We drive load through the REAL cap logic and make the work
instant + observable:

1. **Mock the work, keep the controls real.** `runSwarm` (for `tick`-level
   stress) and `runGoal` (for `runSwarm`-internal `sliceBudget` / `MAX_PARALLEL`
   stress) are mocked exactly as M24 / M12 already mock them. The mock records its
   call, optionally yields a microtask (`await Promise.resolve()` / a tiny timer)
   to force interleaving, returns a stub with a KNOWN `usage.estCostUsd` (so the
   accounting code sees a precise per-call spend), and — when modelling
   `propose:true` — creates a PENDING proposal via the REAL `createProposal`
   store. The REAL code under test is therefore: `bounded()` (loop.ts:82-105),
   the budget gate + in-tick short-circuit (loop.ts:176-193, 297-300, 330-332),
   `perTickItems` top-K select (loop.ts:257-260), `tickSpent` accounting
   (loop.ts:297, 371, 418), `resetDayIfNeeded` (state.ts:157-165), the
   `parallel` clamp (loop.ts:64-66), and `buildBudget`/`sliceBudget`/`MAX_PARALLEL`
   (runner.ts:179, 206-265, 1085-1088).

2. **Observe concurrency, don't race it.** Each mocked unit records its
   start/finish and an in-flight counter is sampled; the test asserts the OBSERVED
   peak in-flight count is `<= limit` — a hard cap holds even when MANY units are
   enqueued at once. We never assert exact scheduling order, only the BOUND, so
   the test is deterministic.

3. **Drive volume.** Suites enqueue tens-to-hundreds of units (concurrent tasks,
   backlog items, or id mints) so the cap logic is exercised under genuine load,
   not a 1-or-2 toy case.

Because every accounting/selection/bounding line is the REAL one and only the
work is synthetic, the guarantees proven are the production guarantees.

---

## THE REUSABLE TESTKIT + NEW STRESS HELPERS

### Reused from `test/helpers/h1-fixture.ts` (H1 — unchanged)

`withTmpHome` / `makeFixture`, `makeDisposableRepo` / fixture `makeRepo`,
`seedBacklog`, `makeCfg`, `shasumTree`, `makeAddFileDiff`, `todoSeedFiles`,
`todoScannerAvailable`. Same HOME-isolation timing rule (the core stores resolve
`homedir()` at call time; do NOT use `loadConfig()`/`CONFIG_DIR`).

### Reused from `test/helpers/h2-faults.ts` (H2 — unchanged)

`seedMidTickSpend` / `reloadDaemonState` / `daemonStateExists` (drive the daily
reset + spend-accounting probes against the REAL daemon state), `today()`,
`crashMidSwarm` / `reloadSwarm` (a persisted run to mint/inspect ids against),
`seedPendingProposal` (proposal-id collision surface).

### New in `test/helpers/h3-stress.ts` (H3 — TEST-ONLY, no prod change)

Small, strictly-typed concurrency primitives — node builtins only, no new runtime
dep. They orchestrate the harness; they NEVER touch state directly (state goes
through the real stores under the isolated HOME):

- `spawnConcurrent(n, fn)` — invoke `fn(i)` for `i in [0, n)` and `Promise.all`
  the results, returning `PromiseSettledResult<T>[]` in input order so a failing
  unit never masks the others. The fan-out that floods the REAL `bounded()` /
  `sliceBudget` paths with many simultaneous units.
- `makeConcurrencyProbe()` — returns `{ enter, leave, peak, current }`: `enter()`
  increments an in-flight counter and records the running max; `leave()`
  decrements; `peak()` reports the OBSERVED maximum simultaneous units. The
  primitive behind CONCURRENCY-CAP-HOLDS — a mocked unit calls `enter()` on start
  and `leave()` on finish, and the suite asserts `peak() <= limit`.
- `makeSpendingSwarmStub({ costUsd, probe?, repo?, propose? })` — a `runSwarm`
  mock factory that (optionally) registers with a concurrency probe, yields a
  microtask to force interleaving, returns a `SwarmRun`-shaped stub whose
  `usage.estCostUsd === costUsd` (the precise per-dispatch spend the REAL
  accounting reads), and — when `propose` — creates a PENDING proposal via the
  REAL `createProposal`. Mirrors M24's `makeSwarmRunStub` with a KNOWN cost.
- `makeCountingGoalStub({ probe?, usagePerTask? })` — a `runGoal` mock factory
  (M12 shape) that registers with a concurrency probe and returns a `RunState`
  stub with a known `RunUsage`, so `runSwarm`'s internal BUILD-phase concurrency
  (`MAX_PARALLEL`) and `sliceBudget` reservation run for real under load.
- `collectIds(n, mint)` — call `mint()` `n` times AS FAST AS POSSIBLE (tight loop,
  same millisecond where possible) and return the array of produced ids. The
  primitive behind IDS-COLLISION-SAFE — assert `new Set(ids).size === n`.
- `mintProposalIds(n)` / `mintSwarmIds(n)` — `collectIds` specialised to the REAL
  id-minting paths: proposal ids via repeated REAL `createProposal` (reads back
  the persisted id), swarm ids via the REAL `runSwarm` path (or the exported
  `makeId` once the H3 fix makes a thin exported seam — see THE SINGLE PRODUCTION
  CHANGE). Both run under the isolated HOME.

All strictly typed, node builtins + project stores only, no new runtime dep.

---

## THE SUITES (`test/h3.*.test.ts`) — the 5 BUILD tasks + what each asserts

> NOTE: in the scaffold phase these started as SKELETONS (describe/it that
> typecheck + lint clean). The BUILD phase fills EVERY `it()` with real
> assertions (no vacuous TODO stubs remain — the exact false-green the H2 review
> caught). The shipped false-green DEFENCE is `expect.hasAssertions()` in each
> suite's `beforeEach` (`h3.budget-cap.test.ts`, `h3.daily-reset.test.ts`,
> `h3.id-collision.test.ts`, `h3.concurrency-cap.test.ts`, `h3.atomic-writes.test.ts`),
> so any `it()` that runs zero assertions FAILS loudly instead of passing
> vacuously — the documented invariant "an unfilled test is RED, not green" is
> enforced everywhere. In particular the two concurrency-cap tick-flood tests
> hard-REQUIRE the TODO scanner (`expect(todoScannerAvailable()).toBe(true)`)
> rather than skipping, so a CI image without `grep`/`rg` fails loudly instead of
> greening a never-exercised cap.

### BUILD 1 — `test/h3.budget-cap.test.ts` (BUDGET-CAP-HOLDS)
Drives the REAL `tick()` budget gate + in-tick short-circuit with `runSwarm`
MOCKED to a KNOWN per-dispatch cost:
- a tick whose remaining budget is exhausted MID-batch STOPS dispatching further
  items (in-tick short-circuit `tickSpent >= remainingBudget`, loop.ts:330-332) —
  later items return `dispatched:false`, `runSwarm` is NOT called for them;
- across a tick at **parallel:1**, `state.todaySpentUsd` ends `<= dailyBudgetUsd`
  even when selected items × per-dispatch cost would otherwise overshoot; at
  **parallel>1** the check-then-act gate admits a whole batch, so realized spend
  is bounded by `dailyBudgetUsd + (parallel-1)×cost` and CAN exceed the cap — a
  dedicated bounded-overshoot test proves this honest bound (see invariant #1);
- a tick entered already at/over budget refuses entirely (reason
  `budget-exhausted`, 0 proposals, `runSwarm` never called — loop.ts:176-193);
- the per-item USD slice + token conversion (loop.ts:300-309) never authorizes a
  negative/zero-or-absurd budget; `selectCount` shrinks as remaining budget
  shrinks (loop.ts:257-260).

### BUILD 2 — `test/h3.concurrency-cap.test.ts` (CONCURRENCY-CAP-HOLDS)
Drives the REAL `bounded()` (loop.ts) AND the REAL `runSwarm` internal
`MAX_PARALLEL` clamp (runner.ts) under flood, via `makeConcurrencyProbe`:
- `bounded(tasks, limit)` with MANY tasks never runs more than `limit`
  simultaneously — observed `peak() <= limit` for limits 1..N;
- the daemon `parallel` cap is clamped to `<= 8` (loop.ts:64-66): a cfg requesting
  `parallel: 100` results in an OBSERVED peak `<= 8` over a flooded tick;
- `runSwarm`'s BUILD phase honors `MAX_PARALLEL = 8` (runner.ts:179, 1085-1088)
  with `runGoal` MOCKED + probed: observed peak `<= 8` regardless of plan size;
- the per-task budget RESERVATION (`sliceBudget`, runner.ts:206-265) keeps
  `sum(authorized) <= pool`: a dedicated test drives the REAL BUILD phase under a
  CONSTRAINED total budget (so the pool binds) with a non-trivial per-task usage
  (so `used` advances between batches), captures the `budget.maxTokens` authorized
  to each `runGoal` call, and asserts the sum across every concurrent batch stays
  `<= total` and each slice `<= 25%` of total (the old 8×25%=200% overshoot is
  impossible);
- `bounded` preserves input-order results and never throws on a unit rejection
  (a rejected unit is a `rejected` settled result, siblings still settle).

### BUILD 3 — `test/h3.daily-reset.test.ts` (DAILY-RESET-EXACT)
Drives the REAL `resetDayIfNeeded` + `tick` accounting at the day boundary, using
`seedMidTickSpend` (H2) to construct prior-day spend:
- a SAME-day reload PRESERVES `todaySpentUsd` (no zeroing, no double-count) — the
  reset is a no-op when `todayDate === today` (state.ts:159);
- a prior-day `todayDate` reload ZEROES `todaySpentUsd` exactly once and stamps
  today (state.ts:160-164), preserving `itemsProcessed` + `ticks` history;
- the reset always PRECEDES `todaySpentUsd += tickSpent` (loop.ts:416-418), so a
  day-rollover tick can neither double-count nor LOSE the new tick's spend;
- a tick that resets re-checks the day AFTER its async work (loop.ts:417) so a
  long tick crossing midnight still accounts spend against the correct day.

### BUILD 4 — `test/h3.id-collision.test.ts` (IDS-COLLISION-SAFE)
Drives the REAL id-minting paths under same-millisecond bursts, via `collectIds`:
- minting `N` (e.g. 5_000) proposal ids in a tight loop yields `N` UNIQUE ids —
  the inbox `generateId` `_seq` counter (store.ts:60-72) guarantees uniqueness
  even within one millisecond; ASSERT the existing counter, do NOT change it;
- minting `N` swarm ids in a tight loop yields ids ordered by a strictly-increasing
  per-millisecond `<seq>` COUNTER — this is the GAP: the pre-fix `makeId` had ONLY
  ~24-bit random and no counter. The RED-before/GREEN-after DETECTOR is the
  `<seq>`-counter ORDERING, **not** raw set-uniqueness: a tight JS loop spreads
  the N mints across many millisecond buckets, so a same-ms 24-bit birthday
  collision essentially never occurs and a bare `Set.size === N` check would pass
  even on the broken minter. A seq-less PRE-fix id, by contrast, fails the
  4-segment shape guard and the strict per-bucket `seq` increase — deterministically
  red. The suite asserts that ordering and is GREEN after the `makeId` `_seq`
  counter is added (THE SINGLE PRODUCTION CHANGE);
- minted ids are charset-safe (`/^[\w.-]+$/`, the `swarmPath`/`proposalPath`
  guard) and, WITHIN each `<ts>` millisecond bucket, ordered by the monotonic
  `<seq>` counter so list views keep a stable most-recent-first tiebreak. The
  proof is asserted per-bucket (never a global string sort over the whole burst)
  so it isolates the counter from a non-monotonic wall clock (NTP / leap-second /
  VM clock step-back can't flake it).

### BUILD 5 — `test/h3.atomic-writes.test.ts` (ATOMIC-WRITES-UNDER-CONTENTION)
Drives the REAL atomic stores under concurrent writers, via `spawnConcurrent`:
- many concurrent `saveDaemonState` / `createProposal` / `saveSwarm` writers each
  use tmp+rename (state.ts:136-139, store.ts:85-88, swarm/store.ts:104-118), so a
  concurrent READER never observes a partial/torn file — every read parses to a
  COMPLETE record (or the prior complete record), never a syntax error;
- N concurrent `createProposal` calls persist N distinct, well-formed proposal
  files (no lost write, no clobbered id) — `listProposals().length === N`;
- N concurrent `saveSwarm` of distinct ids leave N readable records
  (`listSwarms().length === N`), with the documented POSIX-atomic rename path
  exercised (the Windows direct-write fallback, swarm/store.ts:112-117, is NOTED
  as a platform caveat — see below — and NOT changed);
- no `*.tmp` sidecar is ever surfaced by a list view (the `.tmp` filter holds).

---

## H3 INVARIANTS (verbatim) + HOW EACH IS PROVEN

1. **BUDGET-CAP-HOLDS** — Under load, a single tick's realized spend is bounded by
   the remaining daily USD budget **plus a bounded overshoot**, and a tick at/over
   budget does no work. The HONEST in-process guarantee is
   `state.todaySpentUsd <= dailyBudgetUsd + (parallel-1) × cost`, where `cost` is
   the per-dispatch swarm cost: the in-tick gate (`tickSpent >= remainingBudget`,
   loop.ts:330-332) is a check-then-act — `tickSpent` is incremented only AFTER
   each `runSwarm` resolves (loop.ts:371), so a whole concurrent batch of up to
   `parallel` dispatches can pass the gate while `tickSpent` is still 0 and then
   each adds its cost. At **parallel:1** (sequential) this collapses to a HARD
   `todaySpentUsd <= dailyBudgetUsd`. A hard cap at parallel>1 would require
   reserving budget BEFORE dispatch — a production change beyond the permitted
   `makeId` edit, so it is OUT of H3 scope; H3 PROVES the bounded-overshoot bound
   instead of asserting a false hard cap. *Proven:* `runSwarm` MOCKED to a KNOWN
   per-dispatch cost; the parallel:1 tests assert the in-tick short-circuit stops
   dispatch and `todaySpentUsd <= dailyBudgetUsd`; a dedicated BOUNDED-OVERSHOOT
   test (parallel:3, dailyBudgetUsd 0.125, cost 0.05) asserts realized spend CAN
   exceed `dailyBudgetUsd` yet stays `<= dailyBudgetUsd + (parallel-1)×cost`; a
   tick entered at/over budget returns `budget-exhausted` with `runSwarm` never
   called (loop.ts:176-193). The per-task reservation (`sliceBudget`,
   runner.ts:206-265) is proven by the BUILD-2 reservation test, which drives the
   REAL `runSwarm` BUILD phase under a CONSTRAINED total budget and asserts the sum
   of authorized per-task budgets in each concurrent batch stays `<= total` (the
   `sum(authorized) <= pool` bound the old 8×25%=200% overshoot violated).

2. **CONCURRENCY-CAP-HOLDS** — No more than `limit` units run simultaneously, and
   the daemon/swarm parallelism is clamped to `<= 8`. *Proven:* `makeConcurrencyProbe`
   samples in-flight count inside MOCKED units flooded through the REAL `bounded()`
   (loop.ts:82-105) and the REAL `runSwarm` BUILD phase (`MAX_PARALLEL`, runner.ts:179);
   assert observed `peak() <= limit` and `peak() <= 8` for a cfg requesting more.

3. **DAILY-RESET-EXACT** — The daily spend reset zeroes exactly once at the day
   boundary and never double-counts or loses spend. *Proven:* `resetDayIfNeeded`
   (state.ts:157-165) is a no-op same-day (preserve) and zeroes once on rollover;
   the reset always precedes `todaySpentUsd += tickSpent` (loop.ts:416-418); seed
   prior-day spend via `seedMidTickSpend` and assert preserve vs. zero behavior +
   intact `itemsProcessed`/`ticks`.

4. **IDS-COLLISION-SAFE** — Ids minted in a same-millisecond burst are unique.
   *Proven:* `collectIds(N, mint)` ⇒ `new Set(ids).size === N` for proposal ids
   (existing `_seq` counter, store.ts:60-72 — asserted, unchanged) AND swarm ids
   (after the `makeId` `_seq` fix — THE SINGLE PRODUCTION CHANGE); ids stay
   charset-safe and lexicographically (timestamp, seq) ordered.

5. **ATOMIC-WRITES-UNDER-CONTENTION** — Concurrent writers never expose a partial
   file and never lose a distinct record. *Proven:* tmp+rename in the daemon-state,
   inbox-proposal, and swarm stores; `spawnConcurrent` floods N writers and a
   concurrent reader always parses a COMPLETE record; N distinct records all
   persist + list; no `*.tmp` is ever surfaced.

6. **ISOLATED** — Everything runs under a FRESH tmp HOME; the real `~/.ashlr`
   (portfolio `{repos:[]}`, daemon.json, inbox, sandboxes, swarms) is NEVER
   touched. *Proven:* the H1 fixture's `homedir() === tmpHome` guard + per-test
   cleanup; all stores resolve `homedir()` at call time.

7. **DETERMINISTIC** — No live model, no network, no real subprocess; concurrency
   is asserted by BOUND, never by scheduling order. *Proven:* `runSwarm`/`runGoal`
   MOCKED to instant, known-cost stubs; the concurrency probe asserts a peak
   `<= limit` (a property true under every interleaving), never an exact order;
   id bursts run in a tight loop with no timing dependency.

---

## THE SINGLE PRODUCTION CHANGE — `makeId()` monotonic counter

**File:** `src/core/swarm/runner.ts`, `makeId()` (currently lines 194-198).

**Today:**
```ts
function makeId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `swarm-${ts}-${rand}`;
}
```
The id is `swarm-<ts>-<rand>` with `rand` only ~24 bits of `Math.random`. Two
swarms created in the SAME millisecond rely solely on that random suffix to
differ — a real (if small) same-ms collision risk, which would make two distinct
swarms share a persistence path (`~/.ashlr/swarms/<id>.json`) and clobber each
other.

**Fix (the ONLY production line H3 adds):** mirror the inbox `generateId`
counter (`inbox/store.ts:60-72`, which ALREADY has it) — add a module-level
`_seq` counter and put it BEFORE the random segment:
```ts
let _seq = 0;
function makeId(): string {
  const ts = Date.now().toString(36);
  const seq = (_seq++).toString(36).padStart(6, '0');
  const rand = Math.random().toString(36).slice(2, 8);
  return `swarm-${ts}-${seq}-${rand}`;
}
```

**Why this is safe and justified:**
- **Pure id-uniqueness hardening.** It guarantees uniqueness within a process for
  any number of same-ms mints; no two swarms can share a path.
- **NO behavior change.** The id stays charset-valid (`/^[\w.-]+$/`, the
  `swarmPath` guard in swarm/store.ts:73-78), filename-safe, and now sorts by
  `(timestamp, monotonic counter)` — strictly BETTER list ordering, matching the
  inbox convention.
- **NO new dep, NO new outward capability, NO weakened guard.** It is a local
  string-format change inside one helper.
- **Pattern parity.** It makes swarm ids match the already-shipped, already-safe
  inbox id format `prefix-<ts>-<seq>-<rand>`.

The inbox `generateId` counter is **ASSERTED** (BUILD 4) and **NOT changed** — it
already does the right thing. Integration applies this `makeId` edit; the scaffold
does NOT touch production.

---

## THE MULTI-PROCESS LIMITATION (DOCUMENTED, NOT FIXED)

H3 stress-tests the **in-process** guarantees and DOCUMENTS — but does NOT fix —
the multi-process limits. These are not defects within the current design; they
are the boundary of it.

- **Per-process id counters.** Both `inbox/store.ts` `_seq` and the new
  `swarm/runner.ts` `_seq` are MODULE-LEVEL and reset per process. Two CONCURRENT
  daemon PROCESSES minting ids in the same millisecond could, in principle,
  collide (each starts its counter at 0). The `<ts>` + ~24-bit `<rand>` segments
  make this astronomically unlikely, but it is not a hard guarantee across
  processes.

- **Multi-daemon budget race.** The daemon budget gate (loop.ts:174-395) has NO
  inter-process lock. Two daemons running against the SAME `~/.ashlr/daemon.json`
  could each read `todaySpentUsd`, both pass the gate, and overshoot the daily cap
  (a classic check-then-act race across processes). Within ONE process the in-tick
  `tickSpent` short-circuit and the between-tick gate hold (and THAT is what H3
  proves).

**Why we do NOT build locking here.** The CURRENT design is explicitly
**single-machine, single-process**: `runDaemon` REFUSES to start nested
(`ASHLR_IN_DAEMON`/`ASHLR_IN_SWARM` re-entrancy guard, loop.ts:469-472), and the
product ships ONE local daemon. Multi-machine / multi-daemon coordination is the
**GATED M30 `DaemonCoordinator` cloud seam** (see `CONTRACT-M30.md`) — a separate,
deferred milestone that owns inter-process/-machine locking. Building a lock in
H3 would be premature, would add surface ahead of the gated seam, and is out of
scope. H3's job is to PROVE the in-process caps and clearly mark this boundary.

The id half of this limitation is mirrored as a code comment at `makeId`
(`swarm/runner.ts`): the comment explicitly notes that `_seq` resets per process
and that cross-process id allocation is the GATED M30 `DaemonCoordinator` seam,
pointing back to this section. The multi-daemon BUDGET race is documented HERE in
this contract only — the budget gate in `loop.ts` is deliberately NOT edited,
because the single permitted production change in H3 is the `makeId` counter
(adding a comment to `loop.ts` would be a second production-file change, out of
scope). A future reader meets the boundary at `makeId` where the one permitted
edit lives, and the budget-gate boundary in this contract's MULTI-PROCESS
LIMITATION section.

---

## PLATFORM CAVEAT (NOTED, NOT CHANGED) — `saveSwarm` rename fallback

`saveSwarm` (swarm/store.ts:98-122) writes tmp+rename (POSIX-atomic). On a rename
failure (e.g. Windows cross-device, or a race) it falls back to a DIRECT
`writeFileSync` over the target (swarm/store.ts:112-117), which is NOT atomic and
is racy on Windows. The POSIX path — the only path H3 runs on (CI is
macOS/Linux) — is atomic. BUILD 5 exercises and asserts the POSIX atomic path;
the Windows fallback is **NOTED as a documented platform caveat and NOT changed**
(changing it is out of H3 scope and would not affect the proven POSIX guarantee).

---

## DELIVERABLES

- `CONTRACT-H3.md` (this file).
- `test/helpers/h3-stress.ts` — deterministic-concurrency stress helpers (extends
  the H1 + H2 testkits).
- `test/h3.budget-cap.test.ts` — BUILD 1 (BUDGET-CAP-HOLDS).
- `test/h3.concurrency-cap.test.ts` — BUILD 2 (CONCURRENCY-CAP-HOLDS).
- `test/h3.daily-reset.test.ts` — BUILD 3 (DAILY-RESET-EXACT).
- `test/h3.id-collision.test.ts` — BUILD 4 (IDS-COLLISION-SAFE).
- `test/h3.atomic-writes.test.ts` — BUILD 5 (ATOMIC-WRITES-UNDER-CONTENTION).
- **One production edit (integration, not scaffold):** the `makeId()` `_seq`
  counter in `src/core/swarm/runner.ts` — the ONLY production change in H3.

Conventions: ESM, `.js` import specifiers, strict TS, vitest, eslint. Tests under
`test/` named `h3.*.test.ts`; helpers under `test/helpers/`. No new runtime deps.
Do NOT touch the real `~/.ashlr`.
