# CONTRACT-H8 — HARDEN & PROVE: WATCHABLE DEMO + RELIABILITY DOCS + ACTIVATION RUNBOOK

Milestone **H8** of Ashlr v2.1 "Harden & Prove" — the **FINAL** milestone. Builds on **H1**
(`test/helpers/h1-fixture.ts`) and **H2** (`test/helpers/h2-faults.ts`) and **REUSES BOTH
testkits** — no new fixture/fault helper is required. New tests live under `test/h8.*.test.ts`.

H8 makes the system **watchable + documented** so Mason can activate with confidence. It adds
**NO new outward capability**. The ONLY new runtime surface is `ashlr demo` — a watchable,
reproducible run of the FULL autonomous chain on a **DISPOSABLE** repo inside an **ISOLATED**
context, **proposal-only**, with **guaranteed auto-cleanup**. The other four deliverables are
documentation (RELIABILITY.md + README finalization) and a comment-only maintainability sweep.
**No guard is weakened, no new runtime dep is added (node builtins + existing modules only).**

New production files:
- `src/cli/demo.ts` — `ashlr demo` (watchable, narrated, DISPOSABLE-repo-only run of the full
  chain; ISOLATED tmp area; proposal-only; guaranteed auto-cleanup; `--no-cleanup` keeps the tmp
  dir for inspection — still tmp).
- `src/cli/demo-sandbox.ts` — a small SHARED module factoring the disposable-repo + isolated-tmp
  setup/teardown logic so `demo.ts` reuses the SAME isolation discipline the H1 testkit encodes
  (relocate `process.env.HOME` to a fresh `os.tmpdir()` dir; never the real `~/.ashlr`).
  *(BUILD may instead reuse `makeDisposableRepo`/`makeFixture` directly from the H1 fixture if it
  factors them out of `test/` into a shippable module; this contract pins the SEAM, not the file
  layout. Whatever the layout, the isolation + auto-cleanup logic is shared, not duplicated.)*

Modified production files:
- `src/cli/index.ts` — wire `demo` dispatcher arm + `loadDemoCmd` loader + `cmdHelp` entry, plus
  the v2.1 command-surface refresh in `cmdHelp` (`verify-safety`/`sandbox gc`/`audit`/`preflight`/
  `onboard`/`demo`). **NOTE: dispatcher wiring + help refresh is owned by the BUILD/INTEGRATION
  step, NOT this scaffold.**

New / finalized docs:
- `docs/RELIABILITY.md` (NEW) — failure modes + recovery, built from the H8 prep outline + the
  proven H1–H6 facts; honest about limits (single-process; no hard swarm wall-clock deadline yet;
  budget overshoot bound).
- `README.md` (MODIFIED) — finalize `~/.ashlr/ACTIVATION-RUNBOOK.md` into the canonical activation
  section (preflight → enroll one → dry-run → daemon → inbox approve → rollback) with the
  evidence table; refresh the documented command surface to the v2.1 commands.

Comment-only maintainability sweep (behavior-preserving — see BUILD ITEM 5):
- `src/core/swarm/planner.ts`, `src/core/swarm/runner.ts`, `src/core/goals/planner.ts`,
  `src/core/goals/store.ts`, `src/core/knowledge/index.ts`, `src/core/knowledge/graph.ts`,
  `src/cli/knowledge.ts`, `src/cli/ask.ts` — update stale bare `CONTRACT-*.md` comment refs to
  `docs/contracts/CONTRACT-*.md` (they moved in commit 140a69e). **Comment text only.**

---

## THE H8 META-GUARANTEE

> **`ashlr demo` runs the FULL autonomous chain — enroll → backlog scan → daemon tick →
> PENDING proposal → inbox review → rollback/cleanup — entirely on a THROWAWAY git repo created
> under `os.tmpdir()`, inside an ISOLATED context (its OWN tmp `~/.ashlr`; `process.env.HOME`
> relocated exactly as the H1 fixture does). It NEVER enrolls or touches the real portfolio or
> the real `~/.ashlr/enrollment.json` ({repos:[]}); it NEVER applies a proposal; it NEVER
> pushes/PRs/deploys; it NEVER runs against a real repo; and it ALWAYS auto-cleans the tmp repo +
> tmp state on success AND on error/interrupt (try/finally). When a local model is up it MAY run
> a real sandboxed PROPOSAL-ONLY swarm; otherwise it runs the daemon tick dry-run or a
> deterministic stub — and the demo works end-to-end with NO local model. `--no-cleanup` keeps
> the tmp dir (still under `os.tmpdir()`) for inspection. `docs/RELIABILITY.md` + the README
> activation runbook DOCUMENT the proven guarantees and honest limits; the maintainability sweep
> edits COMMENTS only. No guard is weakened, no new outward capability is added.**

---

## ABSOLUTE SAFETY RULES (paramount — inherited verbatim from H1/H2/H3/H4/H5/H6/H7)

- **ISOLATED HOME.** The demo (and every test) relocates `process.env.HOME` to a FRESH
  `os.tmpdir()` dir — the SAME discipline `makeFixture` (H1 fixture) encodes — so every
  `~/.ashlr` read/write (`enrollment.json`, `KILL`, `daemon.json`, `sandboxes/`, `audit/`)
  resolves to an ISOLATED home, **NEVER the real one**. The real portfolio (`{repos:[]}`) is
  NEVER touched. The demo SNAPSHOTS + RESTORES `process.env.HOME` (and the re-entrancy env) on
  exit, exactly as the fixture does.
- **DISPOSABLE REPOS.** The demo enrolls + works ONLY a throwaway git repo created under
  `os.tmpdir()` (seeded with a `// TODO:` so the backlog scan finds work). It NEVER enrolls a
  real repo.
- **GUARANTEED AUTO-CLEANUP.** The tmp repo + tmp `~/.ashlr` are removed in a `try/finally` on
  success, on error, AND on interrupt (SIGINT/SIGTERM handler). `--no-cleanup` keeps the tmp dir
  (still tmp) for inspection and prints its path. Cleanup is idempotent and never throws.
- **DETERMINISTIC, NO LIVE MODEL REQUIRED.** The demo works end-to-end with NO local model: the
  daemon tick runs dry-run / a deterministic stub proposal so a PENDING proposal always appears.
  A real sandboxed swarm is attempted ONLY when a local model is reachable, and even then it is
  **propose-only** (`propose:true` never apply). No network beyond the existing LOCAL
  `probeEndpoint`. Tests force the no-model path so they are deterministic.
- **REAL ASSERTIONS.** Every `it()` has a real `expect()` plus `expect.hasAssertions()` (the
  H2–H7 reviews caught false-green stubs — do **NOT** repeat). Skeletons carry `it.todo` markers
  that **BUILD MUST replace with real assertions** — a vacuous/pending stub is a contract breach.
- **NO GUARD WEAKENED.** The demo adds NO outward capability; it imports NO apply/push/PR/deploy
  primitive (it points the human at `ashlr inbox` exactly as the daemon does). The docs are docs.
  The sweep is comment-only. The H4 safety regression suite (`test/h4.*`) + `ashlr verify-safety`
  MUST still pass unchanged after H8.

---

## REUSED EXISTING FUNCTIONS (H8 reinvents NOTHING)

| Capability                       | Existing function · file:line                                       | H8 use            |
|----------------------------------|---------------------------------------------------------------------|-------------------|
| Isolated HOME + disposable repo  | `makeFixture()` / `makeDisposableRepo()` · `test/helpers/h1-fixture.ts:461/261` | demo isolation + tmp repo |
| TODO-seed files (find work)      | `todoSeedFiles(n)` / `seedBacklog()` · `test/helpers/h1-fixture.ts:187/391` | demo backlog has work |
| Enroll one repo (the gate)       | `enroll(repo)` · `src/core/sandbox/policy.ts:144` (audited H6)       | demo enroll(tmp)  |
| Unenroll (cleanup)               | `unenroll(repo)` · `src/core/sandbox/policy.ts:167` (audited H6)     | demo cleanup      |
| Enrollment list                  | `listEnrolled()` · `src/core/sandbox/policy.ts:190`                  | demo narrate      |
| Backlog scan                     | `buildBacklog({repos})` · `src/core/portfolio/backlog.ts`           | demo backlog step |
| Daemon tick (dry-run / live)     | `tick(cfg,{dryRun})` · `src/core/daemon/loop.ts:127`                | demo tick step    |
| Local model reachable            | `probeEndpoint(id,url)` · `src/core/providers.ts:118` (2s, never throws) | demo model gate |
| Pending proposals                | `listProposals({status})` · `src/core/inbox/store.ts:162`           | demo show PENDING |
| Stub proposal (no-model path)    | `createProposal(p)` · `src/core/inbox/store.ts:128` (PENDING only)  | demo stub proposal |
| Inbox review (pointer + render)  | `cmdInbox(args)` · `src/cli/inbox.ts:611`                           | demo inbox review |
| Sandbox sweep (cleanup)          | `sweepRepoSandboxes(repo)` · `src/core/sandbox/worktree.ts:702`     | demo cleanup      |
| TTY / colors                     | `isTty()`, `makeColors()` · `src/cli/ui.ts`                        | demo narration    |
| Config (in-memory cfg)           | `makeCfg()` · `test/helpers/h1-fixture.ts:431` (conservative caps)  | demo cfg          |
| Lazy command loader / `Cmd`      | `lazyCmd(...)` + `type Cmd` · `src/cli/index.ts:70/59`              | demo dispatcher   |
| Static-scan helpers (tests)      | `readSource`/`stripComments`/`containsToken` · `test/helpers/h4-static.ts:35/66/77` | demo no-new-outward |

---

## BUILD ITEM 1 — `ashlr demo` (watchable, DISPOSABLE-repo-only, auto-cleaning)

**File:** `src/cli/demo.ts` (NEW) + `src/cli/demo-sandbox.ts` (NEW, shared isolation module).
**Dispatcher:** `case 'demo'` + `loadDemoCmd` loader in `src/cli/index.ts` (wired by
BUILD/INTEGRATION, mirroring `loadVerifySafetyCmd` at `index.ts:390` / `loadOnboardCmd` at
`index.ts:406`).

**Behavior — narrate each step of the FULL chain on a throwaway repo:**
1. **Isolate.** Relocate `process.env.HOME` to a FRESH `os.tmpdir()` dir (snapshot the prior
   HOME + re-entrancy env for restore) so every `~/.ashlr` read/write is isolated — the SAME
   discipline `makeFixture` encodes. ASSERT `homedir()` resolves to the tmp HOME before
   proceeding (fail loudly, restore, abort — never risk the real `~/.ashlr`).
2. **Seed.** Create a DISPOSABLE git repo under `os.tmpdir()` with a file carrying a `// TODO:`
   marker (`todoSeedFiles`) so the backlog scan finds real work.
3. **Enroll(tmp).** `enroll(tmpRepo)` — narrate "enrolled 1 disposable repo (NOT your portfolio)".
4. **Backlog scan.** `buildBacklog({repos:[tmpRepo]})` — narrate the discovered TODO item(s).
5. **Daemon tick.** Determine the path: if a local model is reachable
   (`probeEndpoint`), OPTIONALLY run a real sandboxed PROPOSAL-ONLY swarm (`tick(cfg,{dryRun:
   false})` — proposal-only is the daemon's existing guarantee, never apply); else run
   `tick(cfg,{dryRun:true})` and synthesize a deterministic stub PENDING proposal via
   `createProposal` so a proposal always appears. Narrate which path ran + why.
6. **Show PENDING.** `listProposals({status:'pending'})` — render the proposal title + that it is
   PENDING and NOT applied.
7. **Inbox review.** Invoke `cmdInbox` (list/show) against the ISOLATED inbox — narrate "this is
   the human gate; in real use YOU approve here; the demo NEVER approves".
8. **Rollback / cleanup.** Narrate `unenroll` + `sweepRepoSandboxes` (the rollback) then the tmp
   teardown.
9. **Auto-clean (FINALLY).** In a `try/finally` that also installs a SIGINT/SIGTERM handler:
   `unenroll` the tmp repo, sweep its sandboxes, `rm -rf` the tmp repo + tmp HOME, restore
   `process.env.HOME` + re-entrancy env. `--no-cleanup` keeps the tmp dir (still tmp) + prints
   its path. Cleanup is idempotent + never throws.

**Flags.** `--no-cleanup` (keep the tmp dir for inspection — still tmp). `--json` MAY emit a
structured trace of the steps (optional; BUILD's call).

**DEMO SAFETY JUSTIFICATION.** The demo's only mutating calls — `enroll`/`unenroll`/`setKill`/
`createProposal`/`tick`/sandbox ops — ALL resolve their state via `os.homedir()` AT CALL TIME, so
with `process.env.HOME` relocated to the tmp dir they write ONLY into the isolated tmp `~/.ashlr`.
`enroll` targets ONLY the disposable tmp repo (never a real path). `tick` is the daemon's
existing PROPOSAL-ONLY path — it imports NO apply/push/PR/deploy primitive (H4/H1 grep-guarded) —
so even the real-swarm branch can only create a PENDING proposal. The demo NEVER calls
`applyProposal`/`setStatus('approved')`/`approveProposal`/`createPr`/`git push`/deploy. Cleanup is
guaranteed by `try/finally` + a signal handler. **Reuses:** `makeFixture`-style isolation,
`makeDisposableRepo`, `todoSeedFiles`, `enroll`, `unenroll`, `buildBacklog`, `tick`,
`probeEndpoint`, `listProposals`, `createProposal`, `cmdInbox`, `sweepRepoSandboxes`.

---

## BUILD ITEM 2 — `docs/RELIABILITY.md` (failure modes + recovery)

**File:** `docs/RELIABILITY.md` (NEW). Built from the H8 prep "reliability facts" outline
(`~/.ashlr/docs/HARDEN-PREP-NOTES.md` § "H8 prep — reliability facts") + the proven H1–H6 facts.
Each claim cites its milestone/test/commit. Sections:

- **What can't happen (proven guarantees).** Proposal-only (H1/H4); sandboxed (H1); enrollment-
  gated + kill-switch-always-wins (H4/H5); local-first / no cloud egress (H4); containment (H4).
- **Failure modes + recovery.** Crash mid-tick → restart preserves `todaySpentUsd`, resumes a
  crashed swarm via `resumeId`, PENDING proposals survive byte-equal, kill-race aborts clean (H2);
  orphan/leftover sandbox → `sweepOrphanSandboxes` at daemon-start (H5) + manual `ashlr sandbox gc`;
  stuck daemon flag → H5 `reconcileDaemonState` self-heals a dead-pid `running:true`; halt now →
  `ashlr daemon stop` / `ashlr enroll kill on` / `touch ~/.ashlr/KILL`.
- **Honest limits.** Single-machine / single-process (multi-daemon = gated M30 cloud seam, NOT
  built); budget overshoot bound under `parallel>1` (≤(parallel-1)×per-item before in-tick
  short-circuit; default parallel=2 ⇒ ~1 extra; daily reset exact); NO hard swarm wall-clock
  deadline yet (ORPHAN_STALE_MS is a conservative 6h so a live worktree is never reclaimed —
  documented tracked follow-up); Windows `saveSwarm` rename-fallback caveat.
- **Self-check + audit.** `ashlr verify-safety` (H4, 5 structural guards); `ashlr audit` (H6);
  `ashlr preflight` (H7); `ashlr demo` (H8, watch the whole chain safely).

**JUSTIFICATION.** Docs are docs — no runtime change, no guard touched. Every stated guarantee is
backed by an existing passing test/commit (the doc is a CONSOLIDATION, not a new claim).

---

## BUILD ITEM 3 — README activation runbook (finalize)

**File:** `README.md` (MODIFIED). Finalize `~/.ashlr/ACTIVATION-RUNBOOK.md` into the canonical
README activation section: preflight → enroll ONE → dry-run → daemon → inbox approve → rollback,
WITH the evidence table (each guarantee → the milestone/test that proves it) and the
stop/rollback + hard-limits sections. Mark clearly that **activation is the human gate** (nothing
autonomous runs until the human enrolls). Link `docs/RELIABILITY.md` + reference `ashlr demo` as
the "see it before you trust it" step.

**JUSTIFICATION.** Documentation only.

---

## BUILD ITEM 4 — README v2.1 command surface (refresh)

**File:** `README.md` (MODIFIED) + `cmdHelp` in `src/cli/index.ts` (already lists most; ensure
`demo` is added). Add the v2.1 commands to the documented surface so the full list is current:
`ashlr verify-safety` (H4), `ashlr sandbox gc` (H5), `ashlr audit` (H6), `ashlr preflight` /
`ashlr onboard` (H7), `ashlr demo` (H8).

**JUSTIFICATION.** Documentation + a `cmdHelp` text entry only (no behavior change). The
dispatcher arm for `demo` is the one new runtime surface, justified in BUILD ITEM 1.

---

## BUILD ITEM 5 — maintainability sweep (comment-only, behavior-preserving)

Update the stale bare `CONTRACT-*.md` comment refs (moved to `docs/contracts/` in commit 140a69e)
to `docs/contracts/CONTRACT-*.md`. **Comment text ONLY — no code, no behavior change.** Files +
known ref sites (from the H8 prep "Maintainability backlog"):

| File | Site(s) |
|------|---------|
| `src/core/swarm/planner.ts`   | `:308` |
| `src/core/swarm/runner.ts`    | `:210` |
| `src/core/goals/planner.ts`   | `:5`   |
| `src/core/goals/store.ts`     | `:7`   |
| `src/core/knowledge/index.ts` | `:525` |
| `src/core/knowledge/graph.ts` | `:4`, `:380`, `:515` |
| `src/cli/knowledge.ts`        | `:21`  |
| `src/cli/ask.ts`              | `:202` |

BUILD greps each file for bare `CONTRACT-*.md` refs (line numbers are indicative — BUILD locates
the actual sites) and rewrites them to the `docs/contracts/` path in ONE sweep.

**JUSTIFICATION.** Comments only; behavior-preserving; proven by the CLEANUP-COMMENT-ONLY test
(git-diff scan asserts every changed line in these files is inside a comment).

---

## H8 INVARIANTS (and how each is PROVEN)

| Invariant | Statement | Proven by |
|-----------|-----------|-----------|
| **DEMO-DISPOSABLE-ONLY** | `ashlr demo` enrolls/works ONLY a throwaway repo under `os.tmpdir()` inside an isolated tmp `~/.ashlr`; it NEVER touches the real portfolio or real `~/.ashlr/enrollment.json`. | `h8.demo.test.ts` — snapshot the REAL `enrollment.json` byte-state before/after a demo run (in a test that ITSELF isolates HOME), assert byte-identical + `{repos:[]}`; assert the only enrolled path during the run is under `os.tmpdir()`. |
| **DEMO-AUTO-CLEANS** | The tmp repo + tmp `~/.ashlr` are removed on success, on error, AND on interrupt (try/finally + signal handler); `--no-cleanup` keeps them (still tmp). | `h8.demo.test.ts` — run demo; assert the tmp dir no longer exists afterwards (default) and DOES exist with `--no-cleanup`; force the chain to THROW mid-run and assert cleanup still ran (tmp gone, HOME restored). |
| **DEMO-NEVER-APPLIES** | The demo creates only a PENDING proposal; it NEVER approves/applies, NEVER pushes/PRs/deploys, NEVER runs against a real repo. | `h8.demo.test.ts` (behavioral) — assert `listProposals({status:'applied'})` is empty after the demo and the tmp repo working-tree hash is unchanged; `h8.no-new-outward.test.ts` (`[STATIC]`) — `demo.ts`/`demo-sandbox.ts` import no apply/push/PR/deploy primitive + contain no `applyProposal(`/`setStatus('approved'`/`createPr(`/`git push`/`deploy(` token. |
| **DOCS-ACCURATE** | `docs/RELIABILITY.md` + the README runbook state only guarantees that an existing passing test/commit backs, and cite the real commands. | `h8.docs.test.ts` — assert `docs/RELIABILITY.md` + README exist and contain the cited commands (`verify-safety`, `sandbox gc`, `audit`, `preflight`, `daemon stop`, `demo`) and the honest-limits markers (single-process, budget overshoot bound, no wall-clock deadline). |
| **CLEANUP-COMMENT-ONLY** | The maintainability sweep changes COMMENTS only — no code, no behavior. | `h8.cleanup-comment-only.test.ts` — for each swept file, assert it contains `docs/contracts/CONTRACT-` and NO remaining bare `CONTRACT-*.md` ref outside that path; (BUILD also runs a git-diff scan asserting every changed line is a comment). |
| **NO-GUARD-WEAKENED** | The H4 safety suite + `ashlr verify-safety` still pass unchanged; H8 touches no proposal-only / sandbox-required / enrollment / kill-switch / containment guard. | `h8.no-new-outward.test.ts` (`[STATIC]` scan of `demo.ts`/`demo-sandbox.ts`) + the existing `test/h4.*` suite + `ashlr verify-safety` remaining GREEN (CI gate). |

---

## TEST FILES (under `test/`, named `h8.*.test.ts`)

| File | Covers | Key invariant(s) |
|------|--------|------------------|
| `test/h8.demo.test.ts`                | `ashlr demo` runs the full chain on a DISPOSABLE repo (no-model stub path); a PENDING proposal appears; nothing applied; tmp tree unchanged; auto-cleans on success + on a forced mid-run throw; `--no-cleanup` keeps the tmp dir | DEMO-DISPOSABLE-ONLY, DEMO-AUTO-CLEANS, DEMO-NEVER-APPLIES |
| `test/h8.no-new-outward.test.ts`      | `[STATIC]` scan: `demo.ts` + `demo-sandbox.ts` import no apply/push/PR/deploy primitive + contain no outward CALL token; behavioral: the real-swarm branch is propose-only (`tick` never approves) | DEMO-NEVER-APPLIES, NO-GUARD-WEAKENED |
| `test/h8.docs.test.ts`                | `docs/RELIABILITY.md` + README exist + cite the real commands + carry the honest-limits markers | DOCS-ACCURATE |
| `test/h8.cleanup-comment-only.test.ts`| each swept file references `docs/contracts/CONTRACT-` and retains NO bare `CONTRACT-*.md` ref | CLEANUP-COMMENT-ONLY |

All REUSE `test/helpers/h1-fixture.ts` (`makeFixture` for the isolated HOME + `makeDisposableRepo`/
`todoSeedFiles`/`seedBacklog`/`makeCfg`) and, where a fault is needed, `test/helpers/h2-faults.ts`.
`probeEndpoint` is mocked DOWN via `vi.mock`/`vi.spyOn` so the demo runs the deterministic
no-model stub path. `[STATIC]` scans reuse `readSource`/`stripComments`/`containsToken` from
`test/helpers/h4-static.ts`.

---

## CLI COMMANDS INTRODUCED

```
ashlr demo [--no-cleanup] [--json]   # watchable, reproducible full-chain run on a DISPOSABLE
                                     # repo in an ISOLATED tmp context; proposal-only; auto-cleans.
                                     # --no-cleanup keeps the tmp dir (still tmp) for inspection.
```

**Dispatcher wiring (`src/cli/index.ts`) + docs finalization + the comment sweep are owned by the
BUILD/INTEGRATION step, not this scaffold.** The scaffold ships the files + stubs + test
skeletons so the tree typechecks and lints clean; BUILD fills the `demo.ts` body, finalizes
`RELIABILITY.md` + the README, performs the comment-only sweep, replaces every `it.todo` with a
real `expect()` + `expect.hasAssertions()`, and adds the `case 'demo'` arm + `loadDemoCmd` loader
+ `cmdHelp` entry.
