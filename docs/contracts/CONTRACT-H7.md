# CONTRACT-H7 — HARDEN & PROVE: GUIDED ONBOARDING, PREFLIGHT & ONE-COMMAND ROLLBACK

Milestone **H7** of Ashlr v2.1 "Harden & Prove". Builds on **H1** (`test/helpers/h1-fixture.ts`)
and **H2** (`test/helpers/h2-faults.ts`) and **REUSES BOTH testkits** — no new fixture/fault
helper is required. New tests live under `test/h7.*.test.ts`.

H7 is an **ORCHESTRATION + UX layer over functions that ALREADY EXIST**. It adds **NO new
outward capability**. Its entire job is to make the FIRST activation **safe + legible** so a
first real repo can be enrolled with confidence. Every new surface either (a) READS state and
prints it, or (b) CHAINS the already-existing human gates (`enroll` + `inbox`-approve) plus a
READ-ONLY dry-run, plus an inward-only cleanup. **No guard is weakened, no new runtime dep is
added (node builtins + existing modules only).**

New production files:
- `src/cli/preflight.ts` — `ashlr preflight` (READ-ONLY readiness check; `--json`).
- `src/cli/onboard.ts` — `ashlr onboard` (guided first-activation walkthrough + `--rollback`).
- `src/core/readiness.ts` — a small SHARED, read-only readiness module consumed by BOTH
  `preflight.ts` AND the five new `doctor.ts` probes (single source of truth).

Modified production files:
- `src/core/doctor.ts` — ADD 5 read-only probes (enrollment, daemon-state, kill-switch,
  `~/.ashlr` writeable, sandbox health), each consistent with the existing `DoctorCheck` shape.
- `src/cli/index.ts` — wire `preflight` + `onboard` dispatcher arms + loaders + `cmdHelp`
  entries. **NOTE: dispatcher wiring is owned by the BUILD/INTEGRATION step, NOT the scaffold.**

---

## THE H7 META-GUARANTEE

> **`ashlr preflight` and the five new `ashlr doctor` probes READ-ONLY-report first-activation
> readiness (model reachable, enrollment count, kill-switch state, daemon not stuck, `~/.ashlr`
> writeable, sandbox health) and MUTATE NOTHING and make NO outward call. `ashlr onboard` chains
> ONLY the pre-existing human gates — `enroll` (the explicit enrollment gate) + a `daemon
> --dry-run --once` (read-only, creates NO proposal) + a human-readable PLAN + a pointer to
> `ashlr inbox` (review only) — and NEVER applies a proposal, NEVER pushes/PRs/deploys, and
> NEVER runs a live (non-dry) daemon. `ashlr onboard --rollback` is INWARD CLEANUP ONLY
> (`unenroll` + `sweepOrphanSandboxes`/`removeSandbox` + optional `setKill(true)`), all audited
> via the H6 `audit()` already wired into `policy.ts`. No guard is weakened.**

---

## ABSOLUTE SAFETY RULES (paramount — inherited verbatim from H1/H2/H3/H4/H5/H6)

- **ISOLATED HOME.** Every test relocates `process.env.HOME` to a FRESH `os.tmpdir()` dir via
  the H1 fixture (`makeFixture`), so every `~/.ashlr` read/write (`enrollment.json`, `KILL`,
  `daemon.json`, `sandboxes/`, `audit/`) resolves to an ISOLATED home — **NEVER the real one**.
  The real portfolio (`{repos:[]}`) is NEVER touched.
- **DISPOSABLE REPOS.** All git/enroll ops run on disposable repos created by `fx.makeRepo()`.
- **DETERMINISTIC, NO LIVE MODEL.** `probeEndpoint` is mocked or tolerated-down — preflight is
  written so the model being UNREACHABLE is a *warning*, never a crash, and a down probe never
  blocks readiness output. No network. No live daemon. No live swarm.
- **REAL ASSERTIONS.** Every `it()` has a real `expect()` plus `expect.hasAssertions()` (the
  H2–H6 reviews caught false-green stubs — do **NOT** repeat). Skeletons carry `it.todo` markers
  that **BUILD MUST replace with real assertions** — a vacuous/pending stub is a contract breach.
- **NO GUARD WEAKENED.** Every production change is read-only or inward-cleanup-only and adds NO
  outward capability. The H4 safety regression suite (`test/h4.*`) + `ashlr verify-safety` MUST
  still pass unchanged after H7 (H7 touches none of the proposal-only / sandbox-required /
  enrollment / kill-switch / containment guards).

---

## REUSED EXISTING FUNCTIONS (H7 reinvents NOTHING)

| Capability                      | Existing function · file:line                                   | H7 use            |
|---------------------------------|-----------------------------------------------------------------|-------------------|
| Local model reachable           | `probeEndpoint(id,url)` · `src/core/providers.ts:118` (2s, never throws) | preflight + readiness |
| Enrollment list / count         | `listEnrolled()` · `src/core/sandbox/policy.ts:190`             | preflight + probe + onboard |
| Enroll one repo (the gate)      | `enroll(repo)` · `src/core/sandbox/policy.ts:144` (audited H6)  | onboard           |
| Unenroll (rollback)             | `unenroll(repo)` · `src/core/sandbox/policy.ts:167` (audited H6)| rollback          |
| Kill-switch state               | `killSwitchOn()` · `src/core/sandbox/policy.ts:90`             | preflight + probe |
| Kill-switch set (opt. rollback) | `setKill(on)` · `src/core/sandbox/policy.ts:98` (audited H6)    | rollback (opt-in) |
| Daemon state (+ self-heal)      | `loadDaemonState()` · `src/core/daemon/state.ts:71` (calls `reconcileDaemonState` H5) | preflight + probe |
| Daemon-state path               | `daemonStatePath()` · `src/core/daemon/state.ts:42`            | readiness         |
| Dry-run tick / plan             | `tick(cfg,{dryRun:true})` · `src/core/daemon/loop.ts:127`; `runDaemon({once,dryRun})` · `loop.ts:462` | onboard plan |
| Sandbox health / orphans        | `listSandboxes()` · `src/core/sandbox/worktree.ts:551`; `ownerAlive` semantics | preflight + probe |
| Orphan sweep (rollback)         | `sweepOrphanSandboxes({staleMs})` · `worktree.ts:633`; `removeSandbox(sb)` · `worktree.ts:474` | rollback |
| Sandboxes dir / `~/.ashlr`      | `sandboxesDir()` · `worktree.ts:137`; `enrollmentPath()`/`killSwitchPath()` · `policy.ts:37/42` | readiness writeable check |
| Proposals (review pointer only) | `listProposals()` · `src/core/inbox/store.ts:162`; `cmdInbox` · `src/cli/inbox.ts:611` | onboard pointer |
| Phantom / git presence          | `getPhantomStatus()` · `src/core/phantom.ts`; `git --version` (doctor `checkGit`) | preflight |
| Config load / `CONFIG_DIR`      | `loadConfig()` · `src/core/config.ts`                          | preflight + onboard |
| TTY / colors                    | `isTty()`, `makeColors()`, `pad()` · `src/cli/ui.ts`           | preflight + onboard output |
| Doctor probe shape              | `check(id,label,status,detail,fix?)` + `DoctorCheck` · `doctor.ts:21` | 5 new probes |
| H6 audit (rollback trail)       | `audit()` inside `policy.ts` enroll/unenroll/setKill (CONTRACT-H6 §A) | rollback is auto-audited |

---

## BUILD ITEM 1 — `ashlr preflight` (READ-ONLY readiness)

**File:** `src/cli/preflight.ts` (NEW). **Dispatcher:** `case 'preflight'` + `loadPreflightCmd`
loader in `src/cli/index.ts` (wired by BUILD/INTEGRATION, mirroring `loadVerifySafetyCmd` at
`index.ts:390`).

**Behavior.** Prints `ready=true|false` plus a `blockers[]` / `warnings[]` list. Computes its
report by calling the SHARED `buildReadiness()` from `src/core/readiness.ts` (BUILD ITEM 2's
module), which composes the existing read-only primitives:

- **local model reachable** — `probeEndpoint('lmstudio', cfg.models.lmstudio)` /
  `probeEndpoint('ollama', cfg.models.ollama)` (never throws; down ⇒ **warning**, not a blocker).
- **enrollment state** — `listEnrolled().length` (empty is **fine**, surfaced as an INFO note,
  never a blocker — a fresh install is legitimately empty).
- **kill-switch state** — `killSwitchOn()` (on ⇒ surfaced; on its own is a **warning**, because
  a preflight with kill ON correctly reports "nothing will run").
- **daemon not stuck** — `loadDaemonState()` (the H5 `reconcileDaemonState` self-heals a
  dead-pid `running:true`; a still-`running:true`-with-live-pid is reported truthfully, not a
  blocker; a self-healed stale flag is reported as resolved).
- **`~/.ashlr` writeable** — a probe-write+unlink of a temp sentinel under `CONFIG_DIR`
  (`readiness.ts` owns it). Non-writeable ⇒ **blocker** (nothing can persist).
- **sandbox health** — `listSandboxes().length` + orphan count via `ownerAlive`-style age
  (read-only; high orphan count ⇒ **warning** with a `ashlr sandbox gc` hint, never a blocker).
- **git present** — `git --version` (reuses doctor's `runCmd` semantics; absent ⇒ **blocker**).
- **phantom present** — `getPhantomStatus()` (optional; absent ⇒ **warning**).

`ready` is `true` iff `blockers.length === 0`. Exit code: `0` when ready, `1` when blocked.

**Flag.** `--json` emits a `ReadinessReport` (`{ ready, blockers, warnings, info, generatedAt }`)
as JSON on stdout (no color). Human mode prints a grouped, colorized list.

**READ-ONLY / NO-NEW-OUTWARD JUSTIFICATION.** Every input is a pure read: `probeEndpoint` only
does an HTTP GET to a *local* model endpoint (the SAME read `ashlr doctor` already performs — no
new egress), `listEnrolled`/`killSwitchOn`/`loadDaemonState`/`listSandboxes`/`getPhantomStatus`
are all read-only. The lone WRITE — the `~/.ashlr` writeable probe — writes then `unlinkSync`s a
private sentinel file under the ISOLATED `CONFIG_DIR`; it touches no repo, no enrollment, no
kill, no daemon state, and creates nothing persistent. **Reuses:** `probeEndpoint`,
`listEnrolled`, `killSwitchOn`, `loadDaemonState`, `listSandboxes`, `getPhantomStatus`.

---

## BUILD ITEM 2 — 5 MISSING `doctor` PROBES + shared readiness module

**File:** `src/core/readiness.ts` (NEW) — exports `buildReadiness(cfg): Promise<ReadinessReport>`
and the small per-facet helpers (`checkAshlrWriteable()`, `readSandboxHealth()`,
`readDaemonHealth()`, `readEnrollmentState()`, `readKillState()`) so BOTH `preflight.ts` AND the
new `doctor.ts` probes share ONE read-only implementation (no drift, no double maintenance).

**File:** `src/core/doctor.ts` (MODIFIED) — ADD 5 probes, each returning a `DoctorCheck` via the
existing `check(id,label,status,detail,fix?)` helper (`doctor.ts:21`), pushed in `runDoctor`
(`doctor.ts:834`) alongside the existing 16. Each is **pass/warn/info-only — never mutates, never
fails-the-process for a merely-empty fresh install:**

| # | id                 | label                  | Reads via                          | pass / warn rule |
|---|--------------------|------------------------|------------------------------------|------------------|
| 1 | `enrollment`       | Enrollment registry    | `readEnrollmentState()` → `listEnrolled()` | pass always; detail = `N repo(s) enrolled` (0 ⇒ pass + "none yet — run `ashlr onboard`") |
| 2 | `daemon-state`     | Daemon state           | `readDaemonHealth()` → `loadDaemonState()` | pass when stopped/healthy; warn if `running` with a live pid is unexpected; the H5 reconcile already self-heals a dead-pid flag |
| 3 | `kill-switch`      | Kill switch            | `readKillState()` → `killSwitchOn()`       | pass when OFF; warn when ON (autonomy paused) |
| 4 | `ashlr-writeable`  | `~/.ashlr` writeable   | `checkAshlrWriteable()` (sentinel write+unlink under `CONFIG_DIR`) | pass when writeable; **fail** when not (nothing can persist) |
| 5 | `sandbox-health`   | Sandbox health         | `readSandboxHealth()` → `listSandboxes()`  | pass when 0/low; warn on high orphan count with `ashlr sandbox gc` fix hint |

**READ-ONLY JUSTIFICATION.** Four of five are pure reads. The fifth (`ashlr-writeable`) writes +
immediately `unlink`s a private sentinel under the ISOLATED `CONFIG_DIR` (no repo, no guard, no
persistent artifact) — the same probe `preflight` uses, shared from `readiness.ts`. NONE of the 5
mutates enrollment, the kill switch, daemon spend accounting, a sandbox, or a repo. **Reuses:**
`listEnrolled`, `loadDaemonState`, `killSwitchOn`, `listSandboxes`, `CONFIG_DIR`.

---

## BUILD ITEM 3 — guided `ashlr onboard` walkthrough

**File:** `src/cli/onboard.ts` (NEW). **Dispatcher:** `case 'onboard'` + `loadOnboardCmd`
(wired by BUILD/INTEGRATION).

**TTY-aware flow (the FIRST safe activation):**
1. **Preflight** — run `buildReadiness(cfg)`. If `!ready` (blockers present), STOP and print the
   blockers; do nothing else. (No enroll, no dry-run.)
2. **Enroll ONE repo** — resolve the candidate repo path, CONFIRM with the user (TTY prompt),
   then `enroll(repo)` (the explicit human gate; H6-audited). Idempotent.
3. **Dry-run plan** — `tick(cfg,{dryRun:true})` (or `runDaemon({once:true,dryRun:true})`), then
   print a HUMAN-READABLE PLAN of what WOULD run (BUILD ITEM 5). Creates NO proposal, spends $0
   (the dry-run branch returns `proposalsCreated:0, spentUsd:0, reason:'dry-run'`).
4. **Point at inbox** — instruct the user to run `ashlr inbox` to review. NEVER auto-approve,
   NEVER auto-apply.
5. **Offer rollback** — print the one-command undo (`ashlr onboard --rollback`).

**Non-interactive (`--yes` OR non-TTY).** Prints the SAME numbered steps as guidance WITHOUT
prompting and WITHOUT enrolling — it describes the activation; the human still runs the explicit
`enroll`/`inbox` steps. (Mirrors `cmdInit`'s `yesMode = args.includes('--yes') || !process.stdin.isTTY`
at `doctor-init.ts:195`.)

**ONBOARD-NEVER-AUTO-APPLIES JUSTIFICATION.** `onboard` imports NO apply/push/PR/deploy
primitive. Its only mutating call is `enroll(repo)` — already the explicit enrollment gate that
H4 proves and that a human must consciously confirm — plus the dry-run (read-only). It points at
`ashlr inbox` (review only) and never calls `applyProposal`/approve. It never calls
`runDaemon` with `dryRun:false`. **Reuses:** `buildReadiness`, `enroll`, `tick`(dryRun),
`listEnrolled`, the dry-run plan renderer, `isTty`.

---

## BUILD ITEM 4 — one-command rollback

**Surface:** `ashlr onboard --rollback <repo>` (primary) — alias `ashlr unenroll <repo> --cleanup`
acceptable if BUILD prefers, both routing to the SAME `rollback()` in `onboard.ts`.

**Steps (INWARD CLEANUP ONLY, in order):**
1. `unenroll(repo)` — remove from the enrollment registry (H6-audited `enroll:remove`).
2. `sweepRepoSandboxes(repo)` — a SCOPED reclaim of that repo's crash-leftover sandboxes
   (only sandboxes whose `sourceRepo === resolve(repo)`). It KEEPS the `ownerAlive` guard, so a
   LIVE in-flight worktree is NEVER force-removed, but DROPS the 6h `ORPHAN_STALE_MS` age guard:
   for an explicit user-requested undo of a just-unenrolled repo, the age heuristic (which exists
   to protect a possibly-live owner whose pid is unreadable, in the background restart sweep) is
   unwarranted — so a FRESH crash-leftover from the very activation being undone is reclaimed too,
   making this a true one-command undo. Each removal still inherits `removeSandbox`'s full
   branch-prefix / path-containment guards verbatim (inward cleanup only).
3. **Optionally** `setKill(true)` when `--kill` is passed — pause ALL autonomy in the same step
   (H6-audited `kill:on`). Off by default; opt-in.

**ROLLBACK-INWARD-ONLY JUSTIFICATION.** Every step REMOVES capability or local state — it
un-enrolls (narrows the gate), sweeps only `ashlr/sandbox/*` worktrees + scratch refs (pushes
nothing, opens no PR, applies no proposal), and optionally flips the kill switch ON (the most
restrictive state). It can NEVER widen access or trigger an outward action. The full trail is
already audited by the H6 `audit()` calls inside `policy.ts`. **Reuses:** `unenroll`,
`sweepOrphanSandboxes`/`removeSandbox`, `setKill`, `listSandboxes`.

---

## BUILD ITEM 5 — human-readable dry-run PLAN

**Problem.** `tick(cfg,{dryRun:true})` writes a tick record + an audit line (`loop.ts:265-285`)
but the `DaemonTick` it returns (`types.ts:1812`) carries only `itemsConsidered`/`reason` — NOT
the per-item titles a human needs. The dry-run does NOT print a plan today.

**Fix.** Add a read-only `renderDryRunPlan(cfg)` (in `onboard.ts`, or a tiny exported helper in
`readiness.ts`) that re-derives the SAME would-run selection the dry-run uses — `listEnrolled()`
→ `buildBacklog({repos})` → top-K selection — and formats a legible summary
(`N item(s) across M repo(s)`, then a bulleted list of item titles), explicitly labelled as a
PLAN that creates NO proposals. It calls `tick(cfg,{dryRun:true})` for the authoritative
`itemsConsidered` count and presents the matching titles. **No mutation, no proposal, $0 spend.**

**JUSTIFICATION.** `buildBacklog` is read-only (scans repos; `loop.ts:218`), and the dry-run
branch of `tick` is the existing read-only path that creates no proposals and spends nothing.
The plan renderer only READS + FORMATS. **Reuses:** `tick`(dryRun), `listEnrolled`, `buildBacklog`.

---

## H7 INVARIANTS (and how each is PROVEN)

| Invariant | Statement | Proven by |
|-----------|-----------|-----------|
| **PREFLIGHT-READ-ONLY** | `ashlr preflight` and `buildReadiness` mutate no enrollment/kill/daemon/sandbox/repo state; the only write is a self-cleaning sentinel under the isolated `CONFIG_DIR`. | `h7.preflight.test.ts` — snapshot `enrollment.json` + `KILL` + `daemon.json` + `sandboxes/` byte-state before/after a preflight run; assert byte-identical (modulo the absence of any leftover sentinel). |
| **NO-NEW-OUTWARD** | No new outward capability anywhere in H7; `preflight.ts`/`onboard.ts`/`readiness.ts` import NO apply/push/PR/deploy primitive. | `h7.no-new-outward.test.ts` — `[STATIC]` source scan of the 3 new files (via `readSource`/`stripComments` from `h4-static.ts`) asserts NO import of apply/push/PR/deploy modules; preflight/onboard perform no network beyond the existing local `probeEndpoint`. |
| **ONBOARD-NEVER-AUTO-APPLIES** | `ashlr onboard` only chains `enroll` (human gate) + dry-run (read-only) + inbox pointer (review only) + rollback (inward); never applies a proposal, never runs a non-dry daemon. | `h7.onboard.test.ts` — run onboard non-interactively on a disposable repo; assert `listProposals({status:'pending'})` is unchanged (no proposal created/approved/applied), the repo working tree hash is unchanged, and no live daemon ran. `[STATIC]` assert `onboard.ts` does not import `applyProposal`/`runDaemon`-non-dry. |
| **ROLLBACK-INWARD-ONLY** | `ashlr onboard --rollback` only narrows state: unenroll + sweep + optional kill-ON. | `h7.rollback.test.ts` — enroll a disposable repo + create a sandbox, run rollback; assert repo unenrolled, its orphan sandboxes swept (a LIVE owner-pid sandbox is NOT removed), optional `--kill` ⇒ `killSwitchOn()===true`; assert the H6 audit trail recorded `enroll:remove` (+ `kill:on` when `--kill`). |
| **NO-GUARD-WEAKENED** | The H4 safety suite + `ashlr verify-safety` still pass unchanged; the 5 new doctor probes + readiness module touch no guard. | `h7.doctor-probes.test.ts` asserts the 5 probes are read-only (state byte-identical before/after `runDoctor`); the existing `test/h4.*` suite + `ashlr verify-safety` remain GREEN (CI gate). |

---

## TEST FILES (under `test/`, named `h7.*.test.ts`)

| File | Covers | Key invariant(s) |
|------|--------|------------------|
| `test/h7.preflight.test.ts`      | `ashlr preflight` ready/blocked, `--json` shape, model-down tolerated, empty-enrollment is OK, `~/.ashlr` non-writeable ⇒ blocker | PREFLIGHT-READ-ONLY |
| `test/h7.doctor-probes.test.ts`  | the 5 new `doctor` probes appear with the right pass/warn/fail status; `runDoctor` mutates nothing | NO-GUARD-WEAKENED, PREFLIGHT-READ-ONLY |
| `test/h7.onboard.test.ts`        | non-interactive onboard prints steps; with confirm enrolls ONE repo + prints the dry-run PLAN; creates NO proposal; never auto-applies | ONBOARD-NEVER-AUTO-APPLIES |
| `test/h7.rollback.test.ts`       | `onboard --rollback` unenrolls + sweeps orphans (live owner preserved) + optional kill; audited | ROLLBACK-INWARD-ONLY |
| `test/h7.no-new-outward.test.ts` | `[STATIC]` scan: the 3 new files import no apply/push/PR/deploy primitive; readiness/preflight have no new egress | NO-NEW-OUTWARD |

All five REUSE `test/helpers/h1-fixture.ts` (`makeFixture` for the isolated HOME + disposable
repos) and, where a fault is needed, `test/helpers/h2-faults.ts`. `probeEndpoint` is mocked via
`vi.mock`/`vi.spyOn` so suites are deterministic with NO live model. `[STATIC]` scans reuse
`readSource`/`stripComments` from `test/helpers/h4-static.ts`.

---

## CLI COMMANDS INTRODUCED

```
ashlr preflight [--json]                  # read-only readiness check
ashlr onboard [--yes]                     # guided first-activation walkthrough
ashlr onboard --rollback <repo> [--kill]  # one-command undo of a first activation
ashlr unenroll <repo> --cleanup           # alias of onboard --rollback (BUILD's option)
ashlr doctor                              # now also runs the 5 new read-only probes
```

**Dispatcher wiring (`src/cli/index.ts`) is owned by the BUILD/INTEGRATION step, not this
scaffold.** The scaffold ships the files + stubs + test skeletons so the tree typechecks and lints
clean; BUILD fills the stubs with real logic, replaces every `it.todo` with a real `expect()` +
`expect.hasAssertions()`, and adds the `case 'preflight'` / `case 'onboard'` arms + loaders +
`cmdHelp` entries.
