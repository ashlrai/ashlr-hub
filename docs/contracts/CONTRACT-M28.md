# CONTRACT-M28 — Goal Planning & Scheduling (`ashlr goals`)

Ashlr v2 **pillar F**. High-level **OBJECTIVES** the org decomposes into ordered
**MILESTONES** → each milestone maps to a versioned spec (`authorSpec`) →
advancing a milestone runs a **SANDBOXED, PROPOSAL-ONLY** swarm (the exact
M21/M24 pattern), producing a **PENDING inbox proposal**. Milestones are
**TRACKED** over time and the plan is **STEERABLE** (the human edits/reorders/
pauses/skips milestones).

> **Framing.** M28 is the **PLANNING + TRACKING + SCHEDULING** layer on top of
> the already-safe execution path. It introduces **NO new outward authority**.
> Execution ALWAYS flows through `runSwarm` with `sandbox + requireSandbox +
> propose`, so a goal can **NEVER** mutate a real working tree, push, open a PR,
> or deploy — it only produces PENDING inbox proposals a human approves later.
> Planning/tracking is local + read-mostly.

New code lives under `src/core/goals/*`; CLI in `src/cli/goals.ts`; shared types
appended (single-sourced) to `src/core/types.ts`. No new runtime deps.

---

## Module boundaries — `src/core/goals/*`

### `store.ts` — Goal record persistence (pure FS under `~/.ashlr/goals/`)
Mirrors the learn/quality/inbox stores: one file per goal at
`~/.ashlr/goals/<id>.json`, atomic write-then-rename, never throws on reads,
id charset-validated against path traversal. **Never** runs a swarm, authors a
spec, touches a user repo, or emits an outward action.

- `goalsDir(): string` — `~/.ashlr/goals` (re-resolved from `homedir()`).
- **CRUD:** `createGoal(objective, { project? }): Goal`, `loadGoal(id): Goal | null`,
  `listGoals(): Goal[]` (most-recent first, bounded `MAX_LIST=200`),
  `saveGoal(goal): void` (atomic), `deleteGoal(id): void`.
- **Milestone mutators (the human's STEERING controls — pure local edits):**
  `addMilestone(goalId, { title, detail }): Goal | null`,
  `updateMilestoneStatus(goalId, milestoneId, status, { swarmId?, proposalId? }): Goal | null`,
  `reorderMilestones(goalId, orderedIds): Goal | null`,
  `pauseMilestone(goalId, milestoneId?): Goal | null` (no `milestoneId` ⇒ pause whole goal),
  `resumeMilestone(goalId, milestoneId?): Goal | null`,
  `skipMilestone(goalId, milestoneId): Goal | null`.
  `updateMilestoneStatus` mutates the **M28 Goal record only** — it NEVER calls
  inbox `setStatus` and NEVER approves/applies the linked proposal.

### `planner.ts` — deterministic decomposition + per-milestone spec authoring
- `decomposeGoal(objective, cfg, { allowCloud?, maxMilestones? }): Promise<Milestone[]>`
  — **deterministic by default** (local heuristic split; **NO LLM, ZERO
  network**). Optional LLM refinement routes ONLY through
  `getActiveClient(cfg, { allowCloud })` (local Ollama/LM Studio unless
  `--allow-cloud` + key); falls back to the deterministic split on any model
  error. **BOUNDED** by `min(maxMilestones ?? 8, HARD_MAX=16)`. Does not persist.
- `planMilestoneSpec(goal, milestone, cfg): Promise<SpecArtifact>` — authors/
  links a versioned spec via `spec-store.authorSpec(prompt, cfg, { project })`
  (local-first, idempotent). Caller persists `milestone.specId = artifact.id`.
  NEVER runs a swarm or touches a user working tree.

### `advance.ts` — the sandboxed, proposal-only, single-milestone run (**SAFETY-CRITICAL**)
- `nextActionableMilestone(goal): Milestone | null` — pure **READ seam** the
  user-gated daemon MAY consume: lowest-`order` `'pending'` milestone when the
  goal is not paused/archived/done; else `null`. Mutates nothing.
- `advanceGoal(goalId, cfg, opts?, sink?): Promise<SwarmRun>` — advances exactly
  ONE milestone. Resolves `goal.project` → `assertMayMutate(repo, { allowAnyRepo })`
  (enrollment + kill-switch GATE, **before** any swarm) → sets milestone
  `in-progress` → `runSwarm({ goal, specId }, cfg, { sandbox:true,
  requireSandbox:true, propose:true, budget, allowCloud, project:repo }, sink)`
  → links `swarmId`+`proposalId`, sets milestone `proposed` (or `blocked` on
  failure/escalation). HARD per-advance budget (`DEFAULT_ADVANCE_BUDGET`,
  `allowCloud:false`). **NEVER** ships/pushes/PRs/deploys/approves/applies.
- `progressOf(goal): GoalProgress` — read-only tracking roll-up (per-status
  counts, `proposed`/`done`, `fractionDone`, `nextActionableId`). Mutates nothing.

---

## CLI surface — `src/cli/goals.ts` (`export async function cmdGoals(args): Promise<number>`)

| Command | Behaviour | Class |
|---|---|---|
| `ashlr goals add "<objective>" [--project <enrolled-repo>]` | Create a Goal. `--project` is `resolve()`'d + `isEnrolled()`-checked (HARD-ERROR exit 1 if not). | mutating (local record only) |
| `ashlr goals list [--json]` | List goals. | **read-only** |
| `ashlr goals show <id> [--json]` | Show goal + milestones. | **read-only** |
| `ashlr goals plan <id> [--allow-cloud] [--max <n>]` | Decompose + author specs. Deterministic by default; `--allow-cloud` prints a warning. Bounded by `--max`. No swarm runs. | mutating (local plan/specs) |
| `ashlr goals advance <id>` | Run the NEXT milestone via the sandboxed, proposal-only swarm path. | **sandboxed proposal-only** |
| `ashlr goals status [--json]` | Tracking dashboard via `progressOf`. | **read-only** |
| `ashlr goals pause/resume/skip <id> [milestone]` | Steer the plan. | mutating (local record only) |

`--allow-cloud` is **off by default**. `--json` is supported on read paths.
Exit codes: `0` success, `1` runtime error / not-enrolled, `2` bad usage.
Integration (deferred, owned by the Build/Integrate phase): wire
`loadGoalsCmd = lazyCmd(() => import('./goals.js'), (m) => m.cmdGoals as Cmd, '…')`,
a `case 'goals':` in the `src/cli/index.ts` dispatch switch, and a `cmdHelp` entry.

---

## The 5 HARD SAFETY INVARIANTS — enforcement + verifier proof

**1. SANDBOXED + PROPOSAL-ONLY EXECUTION.** `goals advance` MUST call `runSwarm`
with `{ sandbox:true, requireSandbox:true, propose:true }` + a hard budget. It
NEVER runs a swarm against the real working tree, NEVER ships, pushes, opens
PRs, deploys, or applies a proposal. The ONLY execution sink is a PENDING inbox
proposal.
- *Enforced:* `advance.advanceGoal` is the only `runSwarm` caller in `goals/*`
  and hardcodes those three flags + `DEFAULT_ADVANCE_BUDGET`. No `applyProposal`,
  `setStatus('approved')`, `git push`, `createPr`, or `deploy` is imported or
  called anywhere in `goals/*` or `cli/goals.ts`.
- *Verifier proves:* grep `goals/* cli/goals.ts` for `applyProposal`,
  `setStatus`, `git push`, `createPr`, `deploy` ⇒ **zero matches**; and every
  `runSwarm(` call site sets `requireSandbox:true` **and** `propose:true`
  (**and** `sandbox:true`). A test asserts a mocked `runSwarm` received exactly
  those options.

**2. ENROLLMENT-SCOPED.** A goal/milestone bound to a repo only advances if that
repo `isEnrolled()` (`resolve()` first); a non-enrolled repo HARD-ERRORS before
any swarm starts. `assertMayMutate(repo)` (which also checks the kill switch)
gates the advance path. Default enrollment EMPTY ⇒ nothing executes.
- *Enforced:* `advanceGoal` calls `assertMayMutate(resolve(goal.project), …)`
  **before** `runSwarm`, and HARD-ERRORS when `goal.project` is null. The CLI
  ALSO `resolve()`s + `isEnrolled()`-checks `--project` (on `add`) and the goal's
  project (on `advance`) — filtering at **BOTH** core and CLI (M25 lesson).
- *Verifier proves:* a test with a non-enrolled tmp repo asserts `advanceGoal`
  throws **before** the mocked `runSwarm` is called (mock call count 0); kill
  switch on ⇒ throws regardless. Default-empty enrollment ⇒ advance refuses.

**3. LOCAL-FIRST.** Milestone decomposition is deterministic by default (NO LLM);
optional LLM-assisted planning routes through `getActiveClient(cfg,{allowCloud})`
— local Ollama/LM Studio only unless `--allow-cloud` + key. Planning/tracking
writes ONLY under `~/.ashlr/goals/`. Default path = zero non-localhost
connections (beyond an explicitly-invoked sandboxed swarm).
- *Enforced:* `decomposeGoal` returns the deterministic split unless
  `opts.allowCloud`; the only synthesis path is `getActiveClient`. `store.ts`
  writes ONLY under `goalsDir()`; `planMilestoneSpec` writes only via the spec
  store.
- *Verifier proves:* grep `goals/*` ⇒ no network/provider import except
  `getActiveClient` (gated by `allowCloud`); a test runs `decomposeGoal` with no
  `allowCloud` and asserts no client is constructed and output is deterministic
  across runs; store writes resolve under `~/.ashlr/goals`.

**4. STEERABLE + BOUNDED.** The human controls milestones (add/edit/reorder/
pause/skip). NO auto-advance loop — advancing is an explicit `goals advance`
action (or a single user-gated daemon tick; never an unbounded self-driving loop
inside goals). Hard per-advance budget + a cap on milestones planned.
- *Enforced:* `advanceGoal` advances exactly ONE milestone per call and contains
  no loop over milestones; `DEFAULT_ADVANCE_BUDGET` caps it; `decomposeGoal` caps
  at `HARD_MAX_MILESTONES=16`. The daemon seam is the read-only
  `nextActionableMilestone` (default off) — goals build no new always-on loop.
- *Verifier proves:* grep `goals/*` ⇒ no `setInterval`/`while(true)`/recursive
  self-advance; a test asserts one `advanceGoal` call ⇒ one `runSwarm` call;
  `decomposeGoal` never exceeds the cap.

**5. READ-ONLY TRACKING.** `goals list/show/status` only READ `~/.ashlr/goals` +
swarm/inbox state; they mutate nothing.
- *Enforced:* those CLI branches call only `listGoals`/`loadGoal`/`progressOf`/
  `loadSwarm`/`loadProposal` — no store writes, no `runSwarm`, no inbox writes.
- *Verifier proves:* a test snapshots `~/.ashlr/goals` before/after
  `list`/`show`/`status` and asserts no file changes; grep confirms those
  branches call no mutator.

> **Restated explicitly:** EVERY `runSwarm` call in `goals/*` sets
> `sandbox + requireSandbox + propose`; and `advance` is `assertMayMutate`-gated
> + enrollment-scoped at **BOTH** core and CLI.

---

## Type shapes (single-sourced in `src/core/types.ts`)

```ts
type MilestoneStatus =
  | 'pending' | 'in-progress' | 'proposed'
  | 'paused' | 'skipped' | 'blocked' | 'done';

type GoalStatus = 'planning' | 'active' | 'paused' | 'done' | 'archived';

interface Milestone {
  id: string;
  title: string;
  detail: string;
  order: number;                 // lower = earlier; reorder mutates these
  status: MilestoneStatus;
  specId: string | null;         // linked SpecArtifact (authorSpec); null until `plan`
  swarmId: string | null;        // READ-ONLY tracking handle (loadSwarm)
  proposalId: string | null;     // PENDING inbox proposal — the ONLY sink; never approved
  createdAt: string;
  updatedAt: string;
}

interface Goal {
  id: string;                    // file stem ~/.ashlr/goals/<id>.json
  objective: string;
  project: string | null;        // resolved, ENROLLED abs repo path, or null
  status: GoalStatus;
  milestones: Milestone[];       // sorted by order
  createdAt: string;
  updatedAt: string;
}

interface DecomposeOptions { allowCloud?: boolean; maxMilestones?: number; }
interface AdvanceOptions { budget?: Partial<RunBudget>; allowCloud?: boolean; allowAnyRepo?: boolean; }
interface GoalProgress {
  goalId: string; total: number;
  byStatus: Partial<Record<MilestoneStatus, number>>;
  proposed: number; done: number; fractionDone: number;
  nextActionableId: string | null;
}
```

## Tests (`test/m28.*.test.ts`)
tmpdir + tmp git repos + mocked `listEnrolled`/`runSwarm`/`authorSpec`. NEVER
the real `~/.ashlr`, real portfolio, or a real swarm. Cover: every `runSwarm`
gets `sandbox+requireSandbox+propose`; non-enrolled/kill-switch refuses before
`runSwarm`; deterministic decomposition (no client, stable output); read-only
list/show/status leave `~/.ashlr/goals` untouched; one advance ⇒ one swarm.
