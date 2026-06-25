/**
 * conductor.ts — M102 (goal-aware conductor).
 *
 * The goal-aware loop coordinator. Replaces the backlog-first daemon with a
 * goals-first dispatcher:
 *   1. Check kill-switch immediately.
 *   2. Load active goals, sorted most-recently-updated first.
 *   3. For each active goal (bounded by maxGoalsPerCycle), advance its next
 *      actionable milestone via advanceGoalCycle.
 *   4. If no active goals exist, fall back to runDaemon (backlog mode).
 *   5. Return a per-cycle summary.
 *
 * SAFETY GUARANTEES (inherited from advanceGoalCycle + advanceGoal):
 *  - All swarm execution uses sandbox:true + requireSandbox:true + propose:true.
 *  - assertMayMutate is called before any swarm starts (enrollment + kill-switch).
 *  - NO auto-approve, NO apply, NO push, NO PR.
 *  - Imports no outward-mutation primitive (no apply, no approve, no push, no PR).
 *  - Kill-switch is checked before each goal advance so a running conductor loop
 *    can be stopped between milestones without waiting for a swarm to finish.
 */

import type { AshlrConfig, AdvanceOptions } from '../types.js';

// ---------------------------------------------------------------------------
// ConductorCycleSummary
// ---------------------------------------------------------------------------

/**
 * Summary of one conductor cycle — what happened across all goals this tick.
 * Pure accounting; no mutation state is encoded here.
 */
export interface ConductorCycleSummary {
  /** Number of goals for which at least one milestone advance was attempted. */
  goalsAdvanced: number;
  /** Total milestone advances attempted across all goals this cycle. */
  milestonesAdvanced: number;
  /** Total proposals filed (swarms that produced a PENDING inbox proposal). */
  proposalsFiled: number;
  /** Goals that completed ('done') as a result of this cycle. */
  goalsDone: number;
  /** True when no active goals existed and the daemon handled this cycle. */
  daemonFallback: boolean;
  /** True when the kill-switch was on; all work was skipped. */
  killSwitchTripped: boolean;
  /**
   * Per-goal activity for rich UI display: [{goalId, objective, fractionDone,
   * milestoneTitle, proposalFiled}]. Only populated for goals where work was
   * actually attempted (not dry-run skips with no milestone).
   */
  goalActivity: GoalActivity[];
}

/** One goal's contribution to a conductor cycle. */
export interface GoalActivity {
  goalId: string;
  objective: string;
  /** Fraction done AFTER this advance (0–1). */
  fractionDone: number;
  /** Title of the milestone that was advanced (or would be in dry-run). */
  milestoneTitle: string;
  /** True when a proposal was filed for this milestone this cycle. */
  proposalFiled: boolean;
  /** True when this advance completed the whole goal. */
  goalCompleted: boolean;
}

// ---------------------------------------------------------------------------
// runConductor
// ---------------------------------------------------------------------------

/**
 * Run one conductor cycle:
 *  - Goals-first: advance up to `maxGoalsPerCycle` active goals.
 *  - Backlog-fallback: when no active goals exist, delegate to `runDaemon`.
 *
 * Both `once` and `dryRun` are threaded through to `runDaemon` when it is
 * used as fallback, so the caller's posture is fully preserved.
 *
 * The kill-switch is checked BEFORE each goal advance so a running `--watch`
 * loop can be interrupted between milestones.
 *
 * Never throws — errors per goal are caught and logged; the cycle continues
 * with remaining goals.
 */
export async function runConductor(
  cfg: AshlrConfig,
  opts: {
    once: boolean;
    dryRun: boolean;
    maxGoalsPerCycle?: number;
  } & Pick<AdvanceOptions, 'budget' | 'allowCloud' | 'allowAnyRepo'>,
): Promise<ConductorCycleSummary> {
  const summary: ConductorCycleSummary = {
    goalsAdvanced: 0,
    milestonesAdvanced: 0,
    proposalsFiled: 0,
    goalsDone: 0,
    daemonFallback: false,
    killSwitchTripped: false,
    goalActivity: [],
  };

  // All dependencies loaded lazily so vi.mock() intercepts them in tests.
  const { killSwitchOn, listEnrolled } = await import('../sandbox/policy.js');
  const { listGoals } = await import('./store.js');
  const { nextActionableMilestone, advanceGoalCycle, progressOf } = await import('./advance.js');

  // ── Kill-switch check ──────────────────────────────────────────────────────
  if (killSwitchOn()) {
    summary.killSwitchTripped = true;
    return summary;
  }

  // ── Load active goals (most-recently-updated first, bounded) ───────────────
  const maxGoals = Math.max(1, Math.min(opts.maxGoalsPerCycle ?? 3, 10));
  const activeGoals = listGoals({ status: 'active' })
    .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0))
    .slice(0, maxGoals);

  // ── No active goals → backlog daemon fallback ──────────────────────────────
  if (activeGoals.length === 0) {
    summary.daemonFallback = true;
    const { runDaemon } = await import('../daemon/loop.js');
    await runDaemon(cfg, { once: opts.once, dryRun: opts.dryRun });
    return summary;
  }

  // ── Goals-first dispatch ───────────────────────────────────────────────────
  for (const goal of activeGoals) {
    // Per-goal kill-switch check so a running watch loop can be stopped cleanly.
    if (killSwitchOn()) {
      summary.killSwitchTripped = true;
      break;
    }

    // Skip goals whose project is null/missing OR whose project path is not
    // in the enrolled list. These goals can NEVER advance (no real repo to
    // mutate) and failing on every cycle wastes fleet capacity.
    // allowAnyRepo bypasses the enrollment check (matches assertMayMutate).
    if (!opts.allowAnyRepo) {
      if (!goal.project) {
        process.stderr.write(
          `[conductor] goal ${goal.id} skipped — no project set (needs-attention)
`,
        );
        continue;
      }
      const enrolledPaths = listEnrolled();
      if (enrolledPaths.length > 0 && !enrolledPaths.includes(goal.project)) {
        process.stderr.write(
          `[conductor] goal ${goal.id} skipped — project "${goal.project}" is not enrolled (needs-attention)
`,
        );
        continue;
      }
    }

    // Find the next actionable milestone (sequencing guard: skips gated goals).
    const milestone = nextActionableMilestone(goal);
    if (!milestone) {
      // No work to do on this goal right now (all pending milestones gated or none).
      continue;
    }

    if (opts.dryRun) {
      // Dry-run: record intent without running a swarm.
      const progress = progressOf(goal);
      summary.milestonesAdvanced += 1;
      summary.goalActivity.push({
        goalId: goal.id,
        objective: goal.objective,
        fractionDone: progress.fractionDone,
        milestoneTitle: milestone.title,
        proposalFiled: false,
        goalCompleted: false,
      });
      continue;
    }

    // Advance the milestone (with bounded retry on 'blocked').
    try {
      const result = await advanceGoalCycle(goal.id, cfg, {
        budget: opts.budget,
        allowCloud: opts.allowCloud,
        allowAnyRepo: opts.allowAnyRepo,
      });

      summary.goalsAdvanced += 1;
      summary.milestonesAdvanced += 1;
      summary.proposalsFiled += result.proposalsFiled;
      if (result.goalDone) summary.goalsDone += 1;

      // Re-load the goal for a fresh fractionDone after the advance.
      const { loadGoal } = await import('./store.js');
      const refreshed = loadGoal(goal.id);
      const progress = refreshed ? progressOf(refreshed) : { fractionDone: 0 };

      summary.goalActivity.push({
        goalId: goal.id,
        objective: goal.objective,
        fractionDone: progress.fractionDone,
        milestoneTitle: milestone.title,
        proposalFiled: result.proposalsFiled > 0,
        goalCompleted: result.goalDone,
      });
    } catch (err) {
      // Log the error but continue with remaining goals so one stuck goal
      // doesn't block the whole conductor cycle.
      process.stderr.write(
        `[conductor] goal ${goal.id} advance failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  return summary;
}
