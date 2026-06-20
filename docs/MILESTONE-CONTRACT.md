# MILESTONE-CONTRACT — the Goal Loop runner

> **Recovery note (2026-06-20).** A crash lost the conversation that authored this
> feature. The code on disk survived: `src/core/goal-loop/types.ts` (full type
> contract) and `src/core/goal-loop/parse.ts` (markdown parsers). This document is
> **reconstructed from those surviving docstrings + the existing engine/swarm
> conventions** so the plan is durable on disk this time. Sections marked
> **⟢ RECOVERED ASSUMPTION** carried decisions that lived only in the lost
> conversation — confirm or correct them before they harden into code.

---

## Purpose

The **Goal Loop** is an autonomous runner that executes a roadmap of milestones
**one at a time**, with a **FRESH AGENT PROCESS PER MILESTONE** (a deliberate
context reset between milestones), pausing cleanly at any step that needs a human,
and **resumable cold** from a persisted `state.json`.

The shape that makes this work: a **tiny, durable outer driver** loops over the
roadmap and owns all persistence; each milestone is handed to a **heavy, disposable
agent context** that does the work and returns only a small structured
`MilestoneResult`. The agent's context is thrown away after each milestone — the
driver never accumulates it — so a 40-milestone roadmap costs the driver almost
nothing in context and never degrades from a bloated window.

This is the inverse of one long agent run: instead of one context that grows until
it rots, it is N short contexts, each scoped to exactly one milestone file, stitched
together by a durable few-KB state file.

---

## Inputs — the milestone-file contract (already parsed by `parse.ts`)

### Roadmap index file
Milestones in **dependency order**, one markdown link per line. Two accepted forms:

```markdown
- [M0](M0-bootstrap.md)        ← preferred (markdown link)
- M1: M1-schema.md             ← fallback (`id: file.md`)
```

Order is verbatim = execution order. The runner executes sequentially; later
milestones may depend on earlier outputs. **No parallelism.** Parsed by
`parseRoadmap(dir, roadmapFile?)` → `RoadmapIndex`. Default index filenames tried
when none is given: `roadmap.md`, `ROADMAP.md`, `README.md`.

### Milestone file
Per-milestone markdown with **atomic steps** and an **acceptance gate**:

```markdown
# M0 — Bootstrap

- [ ] M0.1 create the package skeleton
      Done when: `npm run build` exits 0
- [x] M0.2 add the lint config
      Done when: `npm run lint` exits 0

## Acceptance checklist (gate)
- [ ] build, lint, and test all pass
- [ ] no new runtime dependency added
```

- **Steps** are checkbox lines whose label starts with a stable id (`M0.1`).
  Each carries an optional verifiable `Done when:` check, a `checked` flag, and the
  source `lineIndex` so the runner can tick it back in place byte-faithfully.
- **Gate** items are the bullets/checkboxes under the first heading matching
  `acceptance`/`gate`. Step-id checkboxes inside the gate section are gate items,
  **not** steps.

Parsed by `parseMilestone(path, id?)` → `MilestoneDoc`. `tickSteps(doc, completedIds)`
returns a new `lines[]` with the named boxes flipped `[ ]`→`[x]` (only that
transition; never unticks; rest of the file byte-preserved) plus a `changed` flag so
the driver can skip a no-op write.

---

## The structured result — the ONLY thing that crosses back

A per-milestone agent returns exactly one `MilestoneResult` (JSON):

```ts
interface MilestoneResult {
  milestone: string;          // must match the dispatched milestone id
  status: 'done' | 'needs_human' | 'blocked' | 'in_progress';
  gate_passed: boolean;       // only meaningful with status 'done'
  steps_completed: string[];  // ids verified this run, e.g. ["M0.1","M0.2"]
  blocked_on: string | null;  // precise: what a human must do / what failed
  summary: string;            // short human-readable recap
}
```

Status semantics (verbatim from `types.ts:96-101`):
- **`done`** — every step verified and the acceptance gate passed.
- **`needs_human`** — a human-only step was reached (manual web action, cloud
  GPU/notebook, sign-off, external upload/creds). The agent did **not** attempt it;
  `blocked_on` says exactly what the human must do.
- **`blocked`** — an automatable step failed twice (retry exhausted).
- **`in_progress`** — partial progress (e.g. a dry-run prediction, or a bounded stop).

---

## Persisted state — `state.json` (lives next to the roadmap)

```ts
interface GoalLoopState {
  version: 1;
  roadmap: string;                                  // abs path to the index
  active: string | null;                            // milestone last worked on
  milestones: Record<string, MilestoneStateEntry>;  // keyed by milestone id
  updatedAt: string;                                // ISO
}
interface MilestoneStateEntry {
  milestone: string;
  status: MilestoneStatus;
  gate_passed: boolean;
  steps_done: string[];      // UNION across runs (never shrinks)
  blocked_on: string | null;
  summary: string;
  updatedAt: string;
}
```

Holds **only tiny per-milestone summaries + bookkeeping** — never the agents' heavy
context. **Resume rule:** an entry with `{ status: 'done', gate_passed: true }` is
treated as complete and skipped; everything else is (re-)dispatched, and
`steps_done` is fed to the agent so it skips already-verified steps (the same
skip-done-don't-redo discipline `runSwarm({ resumeId })` uses at `runner.ts:1313`).

---

## Modules to build

### `state.ts` — persistence (no ambiguity; fully determined by the types)
- `loadState(dir, roadmapPath): GoalLoopState` — read `state.json` from the roadmap
  dir; if absent, return a fresh `{ version:1, roadmap, active:null, milestones:{} }`.
  Tolerant of a malformed/partial file (return fresh, never throw).
- `saveState(dir, state): void` — **atomic tmp+rename** (the same write discipline as
  `src/core/inbox/store.ts`), so a crash mid-write leaves the OLD complete file, never
  a partial one.
- `mergeResult(state, result): GoalLoopState` — fold a `MilestoneResult` into the
  entry for its milestone: union `steps_done`, set `status`/`gate_passed`/`blocked_on`/
  `summary`, stamp `updatedAt`. **Merge, never clobber.**
- `statePath(dir): string` — `<dir>/state.json`.

### `result.ts` — parse the agent's structured output (never throws)
- `parseMilestoneResult(raw: string, expectMilestone: string): MilestoneResult` —
  extract the JSON object from the agent's stdout (the `claude --output-format json`
  envelope wraps it in `{ result: "<text>", ... }`, so look inside `result` and also
  accept a bare object), validate the shape, and coerce. On any malformed / missing /
  mismatched-milestone output, return a safe **`blocked`** result with
  `blocked_on` describing the parse failure — the driver turns that into a clean stop,
  never a crash. Mirrors the tolerant, never-throw posture of `parse.ts`.

### `runner.ts` — the driver + the default executor
The driver (pure of any LLM; testable with a fake executor):
1. `parseRoadmap` → ordered milestones; `loadState`.
2. For each milestone **in order**: if state says complete, skip. Otherwise
   `parseMilestone`, set `state.active`, dispatch via the injected `RunMilestoneFn`.
3. On the result: `tickSteps` for `steps_completed` and write the milestone file back
   iff `changed`; `mergeResult` + `saveState`.
4. **Stop the loop** (do not advance) on `needs_human` or `blocked` — print
   `blocked_on` so the human knows exactly what to do; the run is resumable.
   `in_progress` also stops (bounded). Only `done && gate_passed` advances.
5. Return a summary of what ran / where it stopped.

The **default `RunMilestoneFn`** (the real executor): spawn a fresh agent scoped to
**exactly one milestone file** — the context reset. Reuse the existing engine seam,
**do not reinvent spawning**: build the command with
`buildEngineCommand('claude', <prompt>, cfg, { cwd })` → exactly
`claude -p "<prompt>" --model <M> --output-format json` (`engines.ts:104-110`), run
it with `spawnEngine` (which already applies the env-bridge allowlist, optional
phantom wrap, a 5-min wall-clock cap, captures stdout, and **never throws**), then
`parseMilestoneResult(out.output, doc.id)`. The prompt embeds the single milestone
file + the milestone's `steps_done` from state + the strict "return ONLY this JSON
shape" instruction. **Implementations MUST NOT throw** — a failed spawn/parse becomes
a `blocked` result (or `null`) that the driver turns into a clean stop
(`types.ts:178-181`).

> **⟢ RECOVERED ASSUMPTION (executor).** That the per-milestone engine is the
> `claude` adapter via `buildEngineCommand`/`spawnEngine` is inferred from the
> `claude -p` reference in `types.ts:171` + the existing seam. Alternative: route
> through the hub's configured `EngineId` (so `aw`/`builtin` also work). **Confirm:
> hard-wire `claude`, or honor `cfg`'s engine selection?**

### CLI surface
> **⟢ RECOVERED ASSUMPTION (command name).** The CLI name lived only in the lost
> conversation. `ashlr goals` is already taken by M28 (goal *planning* &
> scheduling); this feature *executes* a roadmap. **Proposed:**
> ```
> ashlr roadmap run    [--dir <d>] [--roadmap <file>] [--dry-run] [--json]
> ashlr roadmap status [--dir <d>] [--json]
> ashlr roadmap resume [--dir <d>]          # alias for run; resumes from state.json
> ```
> `--dry-run` maps to `RunMilestoneContext.dryRun` (agent PREDICTS automatable-vs-human
> per step and touches nothing). `--json` emits a machine-readable run summary.
> **Confirm the noun (`roadmap` vs `loop` vs `chain`) and the flags.**

---

## INVARIANTS (and how each is proven)

1. **CONTEXT-RESET** — each milestone runs in a fresh agent process; the driver never
   accumulates agent context. *Proven:* the only value crossing back is a
   `MilestoneResult` (a few hundred bytes); a fake `RunMilestoneFn` asserts the driver
   passes exactly one `MilestoneDoc` per dispatch and stores only the summary.
2. **DURABLE-RESUME** — killing the process between any two milestones loses no
   completed work. *Proven:* `state.json` is written atomically after every milestone;
   a test crashes between milestones N and N+1, re-runs the driver, and asserts
   completed milestones are skipped and the loop continues at N+1.
3. **SKIP-DONE** — a resumed milestone does not redo verified steps. *Proven:*
   `steps_done` from state is handed to the agent and union-merged on return; never
   shrinks.
4. **CLEAN-PAUSE** — `needs_human` / `blocked` stops the loop without advancing and
   without falsely marking anything `done`; `blocked_on` is surfaced. *Proven:* a fake
   executor returns each non-`done` status; the driver halts at that milestone, state
   records the reason, later milestones stay untouched.
5. **BYTE-FAITHFUL TICKS** — ticking step checkboxes changes only `[ ]`→`[x]` on the
   recorded lines; the rest of the milestone file is byte-preserved. *Proven:*
   `tickSteps` round-trip test (already specified by `parse.ts`); driver writes back
   only when `changed`.
6. **NEVER-THROWS** — neither the parsers, the result parser, nor the executor throw
   on malformed input; every failure becomes a clean `blocked`/fresh-state outcome.
   *Proven:* malformed roadmap/milestone/result fixtures yield empty/partial/blocked
   structures, asserted explicitly.
7. **DETERMINISTIC TESTS** — no test spawns a real agent or depends on a model.
   *Proven:* every suite injects a fake `RunMilestoneFn`; the default (spawning)
   executor is unit-tested only at the argv-builder level (as `engines.ts` already is),
   never spawned.

---

## SAFETY POSTURE (inherited from the hub)

- The runner **edits the milestone files and `state.json` only** (tick boxes + persist
  summaries). Any change the *agent* makes to the target repo is the agent's own
  doing inside its scoped process — the driver performs **no `git push` / PR / deploy**
  and no outward action.
- `--dry-run` touches nothing: the agent predicts automatable-vs-human per step and
  reports, matching the existing dry-run posture.
- Non-interactive / CI: same as the hub — detect/predict only unless explicitly run.

---

## DELIVERABLES

| Path | Role | Status |
|------|------|--------|
| `docs/MILESTONE-CONTRACT.md` | this contract | ✅ (recovered) |
| `src/core/goal-loop/types.ts` | type contract | ✅ done |
| `src/core/goal-loop/parse.ts` | roadmap + milestone parsers, `tickSteps` | ✅ done |
| `src/core/goal-loop/state.ts` | persist/load/merge `GoalLoopState` | ⬜ to build |
| `src/core/goal-loop/result.ts` | parse `MilestoneResult` (never throws) | ⬜ to build |
| `src/core/goal-loop/runner.ts` | driver + default `claude -p` executor | ⬜ to build |
| CLI wiring (`ashlr roadmap …`) | run / status / resume | ⬜ to build (name TBC) |
| `test/goal-loop.*.test.ts` | suites w/ injected fake executor | ⬜ to build |

Conventions: ESM, `.js` import specifiers, strict TS, vitest, eslint. No new runtime
dependency (parsers are hand-rolled; spawning reuses `engines.ts`).
