/**
 * Types for the Goal Loop milestone runner (hub feature).
 *
 * The Goal Loop is an autonomous runner that executes a roadmap of milestones
 * one at a time, with a FRESH AGENT PROCESS PER MILESTONE, pausing cleanly at
 * any step that needs a human. It is resumable cold from a persisted state.json.
 *
 * These types describe three things:
 *  1. The milestone-file CONTRACT the runner consumes (RoadmapIndex, MilestoneDoc,
 *     MilestoneStep) — parsed from external markdown by src/core/goal-loop/parse.ts.
 *  2. The persisted STATE (GoalLoopState, MilestoneStateEntry) — written next to
 *     the roadmap by src/core/goal-loop/state.ts.
 *  3. The strict structured RESULT a per-milestone agent returns (MilestoneResult)
 *     and the injectable executor seam (RunMilestoneFn) — wired in runner.ts.
 *
 * See docs/MILESTONE-CONTRACT.md for the authored contract.
 */

// ---------------------------------------------------------------------------
// Milestone-file contract (parsed input)
// ---------------------------------------------------------------------------

/**
 * One entry in the roadmap index file — a single milestone, in dependency order.
 * `id` is the milestone id (e.g. "M0", "M2"); `file` is the resolved absolute
 * path to that milestone's markdown file.
 */
export interface RoadmapEntry {
  /** Milestone id as it appears in the index (e.g. "M0", "M2"). */
  id: string;
  /** Human label for the milestone (link text or heading). */
  title: string;
  /** Absolute path to the milestone markdown file. */
  file: string;
}

/**
 * The parsed roadmap index: milestones in dependency order. The runner executes
 * them sequentially (later milestones depend on earlier outputs; no parallelism).
 */
export interface RoadmapIndex {
  /** Absolute path to the roadmap index file that was parsed. */
  path: string;
  /** Absolute path to the roadmap directory (where state.json lives). */
  dir: string;
  /** Milestones in dependency order. */
  milestones: RoadmapEntry[];
}

/**
 * One atomic step within a milestone file. Steps are `- [ ]` / `- [x]` checkbox
 * lines with a stable id (e.g. "M0.1", "M2.4") and a verifiable `Done when:`
 * check. `lineIndex` records the 0-based line of the checkbox in the source file
 * so the runner can tick it in place without re-parsing.
 */
export interface MilestoneStep {
  /** Stable step id (e.g. "M0.1"). */
  id: string;
  /** Step description text (the checkbox label, minus the id prefix). */
  text: string;
  /** The `Done when:` verifiable check for this step, if present. */
  doneWhen: string | null;
  /** Whether the checkbox is currently ticked (`- [x]`). */
  checked: boolean;
  /** 0-based index of the checkbox line in the source markdown. */
  lineIndex: number;
}

/**
 * A fully parsed milestone markdown file: ordered steps plus the acceptance
 * gate. `raw` is the verbatim file content (lines) so the runner can re-tick
 * checkboxes and write the file back byte-faithfully apart from the ticks.
 */
export interface MilestoneDoc {
  /** Milestone id (e.g. "M0"). */
  id: string;
  /** Milestone title (first heading). */
  title: string;
  /** Absolute path to the milestone markdown file. */
  path: string;
  /** Atomic steps in document order. */
  steps: MilestoneStep[];
  /** Acceptance-checklist (gate) items — the checks the runner verifies before advancing. */
  gate: string[];
  /** Verbatim source lines (used to write checkbox ticks back in place). */
  lines: string[];
}

// ---------------------------------------------------------------------------
// Structured per-milestone result (agent output contract)
// ---------------------------------------------------------------------------

/**
 * Lifecycle status a milestone executor reports back.
 *  - `done`        — every step verified and the acceptance gate passed.
 *  - `needs_human` — a human-only step was reached (manual web action, cloud GPU/
 *                    notebook, sign-off, external upload/creds). The agent did NOT
 *                    attempt it; `blocked_on` says exactly what the human must do.
 *  - `blocked`     — an automatable step failed twice (retry exhausted).
 *  - `in_progress` — partial progress (e.g. dry-run prediction, or a bounded stop).
 */
export type MilestoneStatus = 'done' | 'needs_human' | 'blocked' | 'in_progress';

/**
 * The STRICT structured result a per-milestone agent process returns. This is the
 * only thing that crosses back from the (heavy, disposable) agent context into the
 * (tiny, durable) outer driver. Parsed by src/core/goal-loop/result.ts.
 */
export interface MilestoneResult {
  /** The milestone id this result is for (must match the dispatched milestone). */
  milestone: string;
  /** Lifecycle status. */
  status: MilestoneStatus;
  /** Whether the acceptance-checklist (gate) passed. Only meaningful with `done`. */
  gate_passed: boolean;
  /** Ids of steps completed (verified `Done when:`) this run, e.g. ["M0.1","M0.2"]. */
  steps_completed: string[];
  /** When not `done`: a precise description of what blocks progress (human action, failure). */
  blocked_on: string | null;
  /** Short human-readable summary of what happened this milestone. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

/** Per-milestone slice of the persisted state. Merged, never clobbered, per run. */
export interface MilestoneStateEntry {
  /** Milestone id. */
  milestone: string;
  /** Last reported status. */
  status: MilestoneStatus;
  /** Whether the acceptance gate passed (resume treats {done, gate_passed:true} as complete). */
  gate_passed: boolean;
  /** Ids of steps completed so far (union across runs). */
  steps_done: string[];
  /** What this milestone is blocked on, if anything. */
  blocked_on: string | null;
  /** Short summary from the last run. */
  summary: string;
  /** ISO timestamp of the last update to this entry. */
  updatedAt: string;
}

/**
 * The persisted Goal Loop state (state.json), written next to the roadmap. Holds
 * only tiny per-milestone summaries + bookkeeping — never the agents' heavy context.
 */
export interface GoalLoopState {
  /** Schema version for forward-compatibility. */
  version: 1;
  /** Absolute path to the roadmap index this state tracks. */
  roadmap: string;
  /** The milestone the loop was last working on (or about to). */
  active: string | null;
  /** Per-milestone entries, keyed by milestone id. */
  milestones: Record<string, MilestoneStateEntry>;
  /** ISO timestamp of the last state write. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Executor seam (dependency injection for testability)
// ---------------------------------------------------------------------------

/**
 * The injectable per-milestone executor. The DEFAULT implementation spawns a
 * fresh `claude -p` process scoped to exactly one milestone file (the context
 * reset), awaits its structured JSON, and parses it into a MilestoneResult.
 *
 * Tests inject a fake so NO real agent runs and NO heavy work happens. The same
 * seam keeps the engine swappable internally.
 *
 * Implementations MUST NOT throw — a failed spawn/parse resolves to a `blocked`
 * (or `null`) result that the driver turns into a clean stop.
 */
export type RunMilestoneFn = (
  doc: MilestoneDoc,
  ctx: RunMilestoneContext,
) => Promise<MilestoneResult | null>;

/** Context handed to a per-milestone executor. */
export interface RunMilestoneContext {
  /** Absolute path to the roadmap directory. */
  dir: string;
  /** Absolute path to the state.json the agent may read (read-only for the agent). */
  statePath: string;
  /** When true, the agent PREDICTS automatable-vs-human per step and touches nothing. */
  dryRun: boolean;
  /** Loaded hub config (for engine spawn / env bridge). */
  cfg: import('../types.js').AshlrConfig;
  /** M86: engine override (--engine); else ASHLR_ENGINE, else 'claude'. */
  engine?: import('../types.js').EngineId;
  /** M86: permit cloud (api-model) engines — the local-first opt-in. */
  allowCloud?: boolean;
}
