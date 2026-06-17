# CONTRACT-M55 — The `/goal` + `/loop` conductor

**Pillar:** Ashlr v5 Open Fleet — one polished front door to the whole fleet, in
the terminal and inside Claude Code.

**Mason's hard rule:** the conductor is proposal-first. `goal`/`loop` produce
PENDING proposals; the kill-switch and daily budget halt them; the conductor
imports NO outward-mutation primitive (the daemon-no-primitive invariant holds).
Flag-off byte-identical: these are new entrypoints over existing seams; no
existing behavior changes.

---

## 1. `ashlr goal "<objective>"` (`src/cli/goal.ts`, new)

- A single polished goal runner over the existing goal seam: create/load a Goal
  (`goals/store`), decompose to milestones (`goals/planner`), advance the next
  milestone via the sandboxed swarm / sandboxed external engine
  (`goals/advance.advanceGoal` → PENDING proposal). Rich live output (phase,
  routed backend + tier, est cost, proposal id). Flags: `--project <repo>`,
  `--budget-usd`, `--allow-cloud`, `--once` (advance one milestone, default) /
  `--all` (advance until blocked, bounded). Reuses M50/M51/M53 routing.

## 2. `ashlr loop` (`src/cli/loop.ts`, new)

- The continuous portfolio conductor — a thin, friendly wrapper over the existing
  `runDaemon`/`tick` (M24/M48) with the M49 control-plane view rendered inline
  (per-backend throughput, queue depth, quota, merges-to-main today, pending
  count). Flags: `--once`, `--dry-run`, `--interval-ms`, `--budget-usd`,
  `--per-tick-items`. Respects kill-switch + daily budget exactly as the daemon
  does. `loop status` mirrors `fleet status`. It does NOT introduce a new dispatch
  path — it calls the same `tick`.

## 3. Registration (`src/cli/index.ts`)

- Lazy-dispatch `goal` and `loop` alongside `run`/`daemon`/`fleet`/`goals`,
  matching the existing lazy-import + graceful-fallback pattern.

## 4. Claude Code slash commands (`.claude/commands/{goal,loop}.md`, new)

- `goal.md` — invokes `ashlr goal "$ARGUMENTS"` and streams progress; documents
  that output is PENDING proposals to review via the inbox.
- `loop.md` — invokes `ashlr loop --once` (safe default) and shows the fleet
  status; documents kill-switch (`~/.ashlr/KILL`) + budget. Frontmatter matches
  the Claude Code command format (name/description/argument-hint).

## HARD RULES + verification (`test/m55.*`)

1. **Proposal-first + no primitive** — `cli/goal.ts` and `cli/loop.ts` import no
   apply/createPr/push/deploy/merge primitive (source grep-guard, the
   preflight/daemon precedent). → `m55.conductor` + source scan.
2. **`goal` produces a PENDING proposal** — a hermetic goal run (stubbed/builtin,
   sandbox) yields a PENDING inbox proposal, never a live-tree write. →
   `m55.conductor`.
3. **`loop` respects kill + budget** — kill-switch present ⇒ no dispatch; daily
   budget exhausted ⇒ no dispatch (reuse daemon test seams). → `m55.conductor`.
4. **Slash-command files valid** — `.claude/commands/{goal,loop}.md` exist with
   well-formed frontmatter and reference the real CLI commands. → `m55.commands`.
5. **Flag-off byte-identical** — adding the commands changes no existing path. →
   regression + CLI dispatch test.

## Deliverables checklist

- [ ] `src/cli/goal.ts`, `src/cli/loop.ts`; registration in `src/cli/index.ts`.
- [ ] `.claude/commands/goal.md`, `.claude/commands/loop.md`.
- [ ] Tests: `m55.conductor`, `m55.commands`.
- [ ] Docs: README + `docs/SPEC-V5-OPEN-FLEET.md` §7 row ticks; `ashlr docs --agent`
      cheat-sheet mentions `goal`/`loop`.

## Non-goals

A new dispatch/merge path (reuses tick/advanceGoal) · a GUI · removing approval.
