# CONTRACT-H5 — HARDEN & PROVE: SANDBOX LIFECYCLE & LEAK HARDENING

Milestone H5 of Ashlr v2.1 "Harden & Prove". Builds on **H1** (`test/helpers/h1-fixture.ts`)
and **H2** (`test/helpers/h2-faults.ts`) and **REUSES BOTH testkits** — no new fault/fixture
helper is required. New tests live under `test/h5.*.test.ts`.

**H5 closes four CONFIRMED gaps** surfaced by the read-only prep scout
(`~/.ashlr/docs/HARDEN-PREP-NOTES.md`, H5 + H2/H4 follow-up sections). Every change is
**MINIMAL, LOCAL-ONLY, DEFENSE-IN-DEPTH**: each one STRENGTHENS an existing guarantee and
NONE weakens a guard or adds any outward capability. No new runtime dependency. Node builtins
only.

### THE H5 META-GUARANTEE

> **Sandboxes are bounded and self-healing: crash-leftover worktrees are reclaimed, dead
> daemons never misreport as live, `allowAnyRepo` can never bypass enrollment outside an
> explicit test, and sandbox accumulation is capped — all without weakening proposal-only,
> sandbox-required, enrollment, kill-switch, or containment.**

---

## ABSOLUTE SAFETY RULES (paramount — inherited verbatim from H1/H2/H3/H4)

- **ISOLATED HOME.** Every test relocates `process.env.HOME` to a FRESH `os.tmpdir()` dir via
  the H1 fixture (`makeFixture`/`withTmpHome`), so every `~/.ashlr` read/write resolves to an
  ISOLATED home — **NEVER the real one**. The real portfolio (`{repos:[]}`) is NEVER touched.
- **DISPOSABLE REPOS.** All git ops run on disposable repos created by `fx.makeRepo()`.
- **DETERMINISTIC.** No live model; no network. Every `it()` has a real `expect()` plus
  `expect.hasAssertions()` (the H2/H3/H4 reviews caught false-green stubs — do NOT repeat).
- **NO GUARD WEAKENED.** Every production change is local-only, defense-in-depth, and adds NO
  outward capability. The H4 safety regression suite (`test/h4.*`) + `ashlr verify-safety`
  MUST still pass.

---

## THE FOUR PRODUCTION CHANGES

Each entry gives the exact file:line, the change, why it STRENGTHENS (never weakens) a guard,
and the conservative threshold.

### CHANGE 1 — WIRE THE ORPHAN SWEEP (crash-leftover reclaim)

**Files:**
- `src/core/sandbox/worktree.ts:493` — `sweepOrphanSandboxes({ staleMs })` already exists
  (added in H2) but is **NEVER CALLED**. No source change needed to the function itself; it
  inherits all of `removeSandbox`'s containment guards verbatim.
- `src/core/daemon/loop.ts` — `runDaemon()` (line 462), in the "Mark daemon as running" block
  right after `saveDaemonState(state)` (~line 493) and BEFORE the first `tick`: call
  `sweepOrphanSandboxes({ staleMs: ORPHAN_STALE_MS })`. Wrapped in try/catch (never throws out
  of `runDaemon`). Audited via the existing `audit()` surface (`daemon:start` already audits;
  add a `sandbox:sweep`-style summary or reuse `daemon:start`).
- `src/cli/sandbox.ts` — add a `sandbox gc` subcommand to `cmdSandbox` (the existing
  `list | diff | cleanup` switch, lines 186-262): `gc` calls `sweepOrphanSandboxes({ staleMs })`
  (lazy-imported alongside the existing `loadWorktree()` trio) and prints the swept ids. This is
  the explicit human repair surface.
- (Optional, integration-phase decision) a `doctor --fix` hook in `src/core/doctor-fix.ts` that
  calls the same sweep. Documented here; the CLI `sandbox gc` is the primary surface.

**Liveness — POSITIVE `ownerPid` marker (primary) + `ORPHAN_STALE_MS` age fallback (secondary):**
There is NO hard wall-clock cap on a swarm (the runner bounds a swarm by step count `<= 200` and the
token budget only — there is no elapsed-time deadline), so `createdAt`-age ALONE is NOT a sound
liveness proxy: a slow local-model swarm can realistically run for hours. The FIX (closing the
HIGH review finding) is a positive liveness marker:

- `createSandbox` stamps `ownerPid: process.pid` into `sandbox.json` (`Sandbox.ownerPid`, optional
  for back-compat). `sweepOrphanSandboxes` (and the disk-cap pre-sweep) SKIP any sandbox whose
  `ownerPid` is still alive — `process.kill(ownerPid, 0)` succeeds — **regardless of age**. So a
  live in-flight worktree (same- OR cross-process, any age) is NEVER force-removed out from under a
  running swarm. `process.kill(pid, 0)` never sends a real signal (error-check only) and never
  throws out of the guard.
- The `ORPHAN_STALE_MS` age guard is the FALLBACK for a sandbox with NO usable `ownerPid` (older
  metadata, or a crash fixture that models a GONE owner). It is set FAR above any plausible
  200-step run — **`ORPHAN_STALE_MS = 6 * 60 * 60_000` (6 hours)** — as belt-and-suspenders for the
  only residual gap: the rare pid-reuse case where a crashed swarm's pid was recycled by an
  unrelated live process (then age must ALSO have elapsed before reclaim). The cost of a too-LARGE
  value (a stale orphan lingering a few hours) is far cheaper than a too-SMALL one (force-removing a
  live worktree), so we err large. `ORPHAN_STALE_MS` stays `>= 30 min` (the contract floor).

RATIONALE: a LIVE in-flight worktree is SKIPPED by its still-alive `ownerPid` (age-independent), and
any sandbox with no live owner is reclaimed only once it is also older than the 6-hour fallback —
so a concurrently-running swarm's sandbox is NEVER force-removed; only genuine crash leftovers are
reclaimed at startup. The `Sandbox.ownerPid` field + `ownerAlive()` helper live in `worktree.ts`.

**DRY-RUN = ZERO SIDE EFFECTS:** the daemon-start sweep performs real destructive on-disk git ops
(`git worktree remove --force` / `git branch -D`), so on a `daemon start --dry-run` it is SKIPPED
(audited as a `dry-run: orphan sweep skipped (...)` preview); the real reclaim runs only on a
non-dry start. This honors the strict dry-run-mutates-nothing expectation the rest of `loop.ts`
upholds. (The H5 wiring test was updated to use a non-dry start for the reclaim assertion and adds
an explicit dry-run-does-not-sweep case.)

**Why it STRENGTHENS:** today the sweep primitive exists but is dead code, so crash-leftover
worktrees accumulate forever under `~/.ashlr/sandboxes/`. Wiring it on daemon start (with the
stale guard) closes that leak. It removes ONLY `ashlr/sandbox/*` worktrees + scratch refs via
`removeSandbox`'s full guard set (re-derived safe path under `sandboxesDir()`, re-derived branch
in the `ashlr/sandbox/<id>` namespace; a metadata mismatch falls through to LOCAL dir cleanup
only). It can NEVER touch a user's working tree, index, HEAD, or any user branch, pushes nothing,
opens no PR, applies no proposal. The `staleMs` guard guarantees a live sandbox is never reclaimed.

### CHANGE 2 — RECONCILE STALE DAEMON STATE (observability-only liveness)

**File:** `src/core/daemon/state.ts` — add `reconcileDaemonState(s: DaemonState): DaemonState`,
a READ-ONLY liveness check: if `s.running === true` AND `s.pid` is a number that is NOT alive
(`process.kill(pid, 0)` throws `ESRCH`), return a copy with `running:false, pid:null`. Otherwise
return `s` unchanged. Pure-ish (like `resetDayIfNeeded`): the caller persists.

**Call sites:**
- `loadDaemonState()` (state.ts:71) — wrap the returned state through `reconcileDaemonState`
  so every load self-heals. (Lowest-friction single chokepoint; covers status + start + tick.)
- Alternatively/additionally the daemon `status` CLI path and `runDaemon` start. Integration
  decides; the `loadDaemonState` chokepoint is the recommended primary.

**Edge cases (must all be handled):**
- `pid === null` or `running === false` → return unchanged (nothing to reconcile).
- `process.kill(pid, 0)` succeeding → alive → unchanged.
- `process.kill` throwing `EPERM` (alive but not ours) → process EXISTS → treat as alive →
  unchanged (do NOT flip; only `ESRCH` means dead).
- `pid === process.pid` (self) → alive → unchanged.
- Any unexpected throw → conservatively treat as alive (do not flip) — observability must
  never destroy real running state.

**Why it STRENGTHENS:** today a daemon process killed `-9` leaves `running:true, pid:<dead>` in
`daemon.json` forever, so `daemon status` misreports a dead daemon as live. This is purely an
OBSERVABILITY correction — it changes NO spend accounting (`todaySpentUsd` is already idempotent
and untouched), NO guard (kill-switch / enrollment / sandbox unaffected), and adds NO capability.
It only makes `status` truthful. (H2 follow-up.)

### CHANGE 3 — ENV-GATE `allowAnyRepo` (defense-in-depth enrollment guard)

**Files (mirror `advance.ts:155-157` EXACTLY):**
- `src/core/sandbox/policy.ts:180` — `assertMayMutate`. The enrollment branch is currently
  `if (!opts?.allowAnyRepo && !isEnrolled(repo))`. Change the effective `allowAnyRepo` to
  `opts?.allowAnyRepo === true && process.env.ASHLR_TEST_ALLOW_ANY_REPO === '1'`. The kill-switch
  check (lines 174-177) STAYS FIRST and UNCONDITIONAL — it always wins.
- `src/core/sandbox/worktree.ts:163-167` — `createSandbox` passes `opts` straight to
  `assertMayMutate`. Because the gate now lives in `assertMayMutate`, `createSandbox` needs NO
  separate env check — but for defense-in-depth and to keep the two call paths symmetric, the
  contract permits computing an env-gated `effectiveOpts` once and passing it down. Simplest
  correct form: gate in `assertMayMutate` only (single source of truth), since `createSandbox`
  has no other use of `allowAnyRepo`. Integration MUST verify `createSandbox` honors the gate
  transitively.

**Exact gate expression (verbatim mirror of `advance.ts:156`):**
```ts
const allowAnyRepo =
  opts?.allowAnyRepo === true && process.env.ASHLR_TEST_ALLOW_ANY_REPO === '1';
```

**Why it STRENGTHENS:** today `assertMayMutate`/`createSandbox` honor `opts.allowAnyRepo`
WITHOUT the `ASHLR_TEST_ALLOW_ANY_REPO==='1'` env guard that `advance.ts` already uses, so a
stray `allowAnyRepo:true` in any production path could bypass enrollment. After this change the
test hatch is effective ONLY when the env var is set — closing that latent weakening.
**Production behavior is UNCHANGED:** the only production caller is `runner.ts:1163`
(`_createSandbox(project)` — passes NO opts), and `advance.ts:157` already env-gates before
calling `assertMayMutate`. Verified: `grep ASHLR_TEST_ALLOW_ANY_REPO src/` shows only advance.ts
(+ types.ts doc). The kill switch ALWAYS wins (unchanged), and `verify-safety` CHECK 2
(`kill-switch-precedence`) still passes because `killSwitchOn()` still appears before
`isEnrolled()` in the body.

**CRITICAL — TEST MIGRATION (see "TEST-MIGRATION PLAN" below):** this STRENGTHENS the guard but
breaks every test that passes `allowAnyRepo:true` against the REAL (unmocked) policy/worktree
without setting the env. Those call-sites MUST set `process.env.ASHLR_TEST_ALLOW_ANY_REPO='1'`
(and restore after) and the full suite MUST stay green.

### CHANGE 4 — SANDBOX DISK/COUNT CAP (bounded-resource guard)

**File:** `src/core/sandbox/worktree.ts` — `createSandbox` (after the policy gate + repo checks,
before/around `git worktree add` at lines 219-227). Add a new module constant
`MAX_SANDBOXES` and a bounded check:
1. Count current sandboxes via the existing `listSandboxes()`.
2. If `count >= MAX_SANDBOXES`: FIRST `sweepOrphanSandboxes({ staleMs: ORPHAN_STALE_MS })` (reclaim
   stale orphans — never a live/non-stale one).
3. Re-count; if STILL `>= MAX_SANDBOXES`: REFUSE to create — `audit({ action:'sandbox:create',
   result:'refused', summary:'sandbox cap reached' })` and throw a clean error
   (`sandbox cap reached (MAX_SANDBOXES=...)`). Never removes a non-stale/in-use sandbox.

**Threshold — `MAX_SANDBOXES`:** conservative default **16**. The daemon caps concurrency at 8
(`loop.ts:65`, runner `MAX_PARALLEL=8`), so 16 leaves 2x headroom for concurrent daemon swarms +
a manual `ashlr swarm` + transient overlap, while still bounding unbounded accumulation. A
total-bytes budget is documented as a FUTURE option but NOT required for H5 (count cap is the
minimal sufficient guard).

**Why it STRENGTHENS:** there is NO cap on sandbox count/disk today, so a pathological
crash/restart loop could fill the disk with worktrees. The cap bounds it, and because step 2
sweeps stale orphans FIRST (with the same `staleMs` liveness guard), a healthy install with a
transient burst self-heals rather than refusing. The refusal is a clean, audited error — it
removes nothing in-use and adds no outward capability. Local-only resource guard.

---

## TEST-MIGRATION PLAN (CHANGE 3 — `allowAnyRepo` env-gate)

The env-gate breaks any test that calls the REAL `createSandbox(repo, {allowAnyRepo:true})` or
`assertMayMutate(repo, {allowAnyRepo:true})` (unmocked) without `ASHLR_TEST_ALLOW_ANY_REPO=1`.
Two complementary migration moves; integration applies them and keeps the FULL suite green:

**A. CENTRAL (recommended primary):** set `process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1'` inside
the H1 fixture `makeFixture()` (snapshot prior value; restore in `cleanup()`), and inside the
H2 helper `makeOrphanSandbox`/`crashMidSwarm` paths in `test/helpers/h2-faults.ts`. This covers
EVERY fixture-using test in one place (the vast majority). This is a TEST-ONLY env toggle in an
isolated HOME — it does NOT relax any production guard.

**B. PER-CALL-SITE (for tests that hit policy/worktree WITHOUT the fixture, e.g. `fakeTmpRepo()`
in `m21.policy.test.ts`):** wrap with `process.env.ASHLR_TEST_ALLOW_ANY_REPO='1'` in a
`beforeEach`/`afterEach` (or per-`it`) with restore.

**Impacted test files (every `allowAnyRepo:true` against real policy/worktree):**
- `test/m21.worktree.test.ts` — ~38 `createSandbox(repo,{allowAnyRepo:true})` sites (lines
  188, 200, 222, 239, 255, 270, 291, 312, 327, 342, 357, 373, 388, 403, 428, 457, 486, 502,
  521, 554, 581, 607, 629, 644, 660, 674, 688, 701, 714, 736, 759, 796, 861, 877, …). Uses its
  own harness — migrate via A if it uses the fixture, else B.
- `test/m21.policy.test.ts` — `assertMayMutate(fakeTmpRepo(),{allowAnyRepo:true})` (lines 184,
  191, 198, 201). Uses `fakeTmpRepo()` (NOT a fixture repo) → needs B. NOTE: the two
  `allowAnyRepo:false` cases (194-203) are UNAFFECTED. The "passes when allowAnyRepo true + kill
  off" case (182-184) now ALSO requires the env var.
- `test/h1.safety.test.ts` — `createSandbox(repo.dir,{allowAnyRepo:true})` (line 208). Fixture
  user → A covers it.
- `test/h4.sandbox-enrollment-kill.test.ts` — lines 292, 541, 547, 555, 570. **H4 SUITE —
  pinned.** See "H4 TESTS IMPACTED" below; migrate via A and confirm the negative kill-switch
  cases still throw (they must — kill precedes the gate).
- `test/h4.sandbox-containment.test.ts` — ~10 sites (134, 164, 184, 227, 259, 293, 329, 366,
  417). **H4 SUITE.** Migrate via A; containment semantics unchanged.
- `test/helpers/h2-faults.ts` — `makeOrphanSandbox` (line 266) calls
  `createSandbox(repoDir,{allowAnyRepo:true})`. Migrate via A (set env in the helper or rely on
  the fixture-level set), so H2 orphan tests stay green.
- `test/h2.orphan-sandbox.test.ts`, `test/h2.swarm-resume.test.ts`, `test/h2.kill-race-abort.test.ts`,
  `test/h3.atomic-writes.test.ts` — consume `makeOrphanSandbox`/`crashMidSwarm`; covered
  transitively by A.

**NOT impacted (mocked policy):** `test/m28.advance.test.ts` mocks `assertMayMutate` entirely
(`mockAssertMayMutate`) and `advance.ts` is UNCHANGED — those `advanceGoal({allowAnyRepo:true})`
calls do not reach the real gate, so they stay green with no migration. (Confirm during
integration.)

**NOT impacted (static source read):** `test/h4.verify-safety.test.ts:246` only READS the
policy source TEXT for the `kill-switch-precedence` check; it asserts `killSwitchOn()` precedes
`isEnrolled()`. The env-gate change keeps that ordering, so CHECK 2 stays green. No migration.

---

## H5 INVARIANTS (the guarantees this milestone installs + how each is proven)

1. **RECLAIM-ALWAYS / LIVE-NEVER-RECLAIMED** — crash-leftover worktrees (no live owner) are
   reclaimed at daemon start; a LIVE sandbox (owner pid alive) is NEVER reclaimed regardless of
   age, and a no-live-owner sandbox younger than `ORPHAN_STALE_MS` is NEVER reclaimed.
   *Proof:* `test/h5.orphan-sweep-wire.test.ts` — seed a stale orphan (back-dated > staleMs, dead
   owner) + a fresh one; run the sweep wiring; assert the stale one swept, the fresh one survives;
   a LIVE sandbox aged 4x past staleMs with an ALIVE owner pid is NOT swept (the HIGH-finding fix),
   and the same sandbox IS reclaimed once its owner is gone; `runDaemon({once})` on an isolated
   HOME reclaims a back-dated orphan, while `runDaemon({once,dryRun:true})` sweeps NOTHING.

2. **CONTAINMENT-HOLDS** — the wired sweep + cap inherit `removeSandbox`'s containment guards
   verbatim; no git op ever runs against an arbitrary branch/path.
   *Proof:* `test/h5.orphan-sweep-wire.test.ts` — a tampered-metadata orphan (branch/path
   mismatch) falls through to LOCAL dir cleanup only (audited `refused`), source repo's branches
   + working tree byte-identical. Re-uses the H4 containment assertions.

3. **ENV-GATE-ENFORCED** — `allowAnyRepo:true` is effective ONLY when
   `ASHLR_TEST_ALLOW_ANY_REPO==='1'`; otherwise an unenrolled repo is REFUSED.
   *Proof:* `test/h5.allowanyrepo-envgate.test.ts` — with the env var UNSET,
   `assertMayMutate(repo,{allowAnyRepo:true})` THROWS (enrollment) and
   `createSandbox(repo,{allowAnyRepo:true})` THROWS + audits `refused`; with the env var SET,
   both succeed on a disposable repo. Mirrors the `advance.ts` precedent.

4. **DISK-CAP-BOUNDED** — sandbox count never exceeds `MAX_SANDBOXES`; on overflow the sweep
   runs first, then a clean audited refusal — never removing a non-stale sandbox.
   *Proof:* `test/h5.disk-cap.test.ts` — create up to `MAX_SANDBOXES` fresh sandboxes; the next
   `createSandbox` first sweeps (no stale → no removal) then THROWS `sandbox cap reached` +
   audits `refused`; back-date one to stale, retry → sweep reclaims it, creation now succeeds;
   assert no live sandbox was removed.

5. **NO-PROD-BEHAVIOR-REGRESSION** — production callers are unchanged by the env-gate.
   *Proof:* `test/h5.allowanyrepo-envgate.test.ts` — assert (static read) `runner.ts` calls
   `_createSandbox(project)` with NO opts and `advance.ts` already env-gates; assert
   `grep ASHLR_TEST_ALLOW_ANY_REPO src/` set equals `{advance.ts, types.ts(doc)}` (+ the new
   policy.ts/worktree.ts gate after the change). Full existing suite green after migration.

6. **NO-GUARD-WEAKENED** — kill-switch precedence, sandbox-required, proposal-only, enrollment,
   and containment are all intact.
   *Proof:* `test/h4.*` + `ashlr verify-safety` still pass (CHECK 2 `kill-switch-precedence`
   especially). `test/h5.daemon-state-reconcile.test.ts` asserts reconcile flips ONLY a dead
   pid, touches NO spend, NO kill switch, NO enrollment; an `EPERM`/alive/`self` pid is left
   `running:true`.

7. **RECONCILE-OBSERVABILITY** — `loadDaemonState` self-heals a dead-pid `running:true` to
   `running:false`, changing nothing else.
   *Proof:* `test/h5.daemon-state-reconcile.test.ts` — seed `daemon.json` with
   `running:true, pid:<unused-dead-pid>`; `reconcileDaemonState`/`loadDaemonState` returns
   `running:false, pid:null`; seed `pid:process.pid` (alive) → unchanged; spend fields
   byte-identical in all cases.

---

## TEST FILES (new — `test/h5.*.test.ts`)

- `test/h5.orphan-sweep-wire.test.ts` — RECLAIM-ALWAYS + CONTAINMENT-HOLDS (CHANGE 1).
- `test/h5.daemon-state-reconcile.test.ts` — RECONCILE-OBSERVABILITY + NO-GUARD-WEAKENED (CHANGE 2).
- `test/h5.allowanyrepo-envgate.test.ts` — ENV-GATE-ENFORCED + NO-PROD-BEHAVIOR-REGRESSION (CHANGE 3).
- `test/h5.disk-cap.test.ts` — DISK-CAP-BOUNDED (CHANGE 4).

All four REUSE `test/helpers/h1-fixture.ts` (`withTmpHome`, `makeRepo`) and
`test/helpers/h2-faults.ts` (`makeOrphanSandbox`, `listOrphanSandboxes`, `sandboxHomeExists`).
Every `it()` carries `expect.hasAssertions()`.

---

## H4 / OTHER TESTS IMPACTED (by the CHANGE 3 env-gate)

**H4 suite (pinned — migrate deliberately, keep green):**
- `test/h4.sandbox-enrollment-kill.test.ts` (lines 292, 541, 547, 555, 570) — set
  `ASHLR_TEST_ALLOW_ANY_REPO=1` for the positive `createSandbox/assertMayMutate(allowAnyRepo:true)`
  cases; the kill-switch negatives (4.6) STILL throw because kill precedes the gate (UNCHANGED).
- `test/h4.sandbox-containment.test.ts` (lines 134, 164, 184, 227, 259, 293, 329, 366, 417) —
  set the env so genuine sandboxes still build; containment semantics unchanged.
- `test/h4.verify-safety.test.ts` — NOT impacted (static source read; ordering preserved).
- `test/h4.proposal-only.test.ts`, `test/h4.local-first-secret.test.ts` — NOT impacted (no
  `allowAnyRepo`).

**Other (non-H4) impacted:**
- `test/m21.worktree.test.ts` (~38 sites) — migrate (central or per-call-site env set).
- `test/m21.policy.test.ts` (lines 184, 191, 198, 201) — per-call-site env set (`fakeTmpRepo`).
- `test/h1.safety.test.ts` (line 208) — fixture-covered.
- `test/helpers/h2-faults.ts` (line 266 `makeOrphanSandbox`) — set env in helper / fixture.
- `test/h2.orphan-sandbox.test.ts`, `test/h2.swarm-resume.test.ts`, `test/h2.kill-race-abort.test.ts`,
  `test/h3.atomic-writes.test.ts` — covered transitively via the H2 helper / fixture.

**Explicitly NOT impacted:** `test/m28.advance.test.ts` (mocks `assertMayMutate`; `advance.ts`
unchanged).

---

## SCAFFOLD STATUS (this commit)

- Contract authored (this file).
- Production STUBS added (compile + lint clean, NOT finalized — integration applies the real
  edits + test migration):
  - `reconcileDaemonState` in `src/core/daemon/state.ts` (real, minimal, safe to land now —
    additive read-only export; load-chokepoint wiring deferred to integration).
  - `MAX_SANDBOXES` + `ORPHAN_STALE_MS` constants + a marked disk-cap insertion point in
    `worktree.ts` (commented `H5-STUB` markers; the env-gate edit site likewise marked).
  - `sandbox gc` subcommand marked in `src/cli/sandbox.ts` (stub help line + dispatch marker).
- Test SKELETONS added (`test/h5.*.test.ts`) — typecheck + lint clean, each `it()` has a real
  `expect()` + `expect.hasAssertions()`; bodies are scaffolds the integration phase fills in.
