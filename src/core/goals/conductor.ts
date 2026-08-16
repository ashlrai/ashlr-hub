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
  /** True when live conductor authority is intentionally unavailable. */
  activationRefused?: boolean;
  /** Structured fail-closed reason for a dormant/invalid one-shot request. */
  activationRefusalReason?: string;
  /** Metadata-only identifier of the durably consumed one-shot permit. */
  activationPermitId?: string;
  /**
   * Per-goal activity for rich UI display: [{goalId, objective, fractionDone,
   * milestoneTitle, proposalFiled}]. Only populated for goals where work was
   * actually attempted (not dry-run skips with no milestone).
   */
  goalActivity: GoalActivity[];
}

function emptyConductorSummary(): ConductorCycleSummary {
  return {
    goalsAdvanced: 0,
    milestonesAdvanced: 0,
    proposalsFiled: 0,
    goalsDone: 0,
    daemonFallback: false,
    killSwitchTripped: false,
    goalActivity: [],
  };
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
  const summary = emptyConductorSummary();

  if (!opts.dryRun) {
    const { liveConductorActivationAuthorized } = await import('../daemon/activation-permit.js');
    if (!liveConductorActivationAuthorized()) {
      summary.activationRefused = true;
      return summary;
    }
  }

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

/**
 * Execute one explicitly targeted, signed goal milestone.
 *
 * This does not enable the general conductor. It has no resident/watch shape,
 * no cloud option, no retry, and no daemon fallback. Production remains dormant
 * while either its immutable trust roots or final durable quota authority are
 * unavailable.
 */
export async function runAuthorizedConductorOnce(
  cfg: AshlrConfig,
  request: { goalId: string },
): Promise<ConductorCycleSummary> {
  const summary = emptyConductorSummary();
  const refuse = (reason: string): ConductorCycleSummary => {
    summary.activationRefused = true;
    summary.activationRefusalReason = reason;
    return summary;
  };
  if (!request.goalId) return refuse('goal-conductor-explicit-goal-required');

  const { killSwitchOn, listEnrolled } = await import('../sandbox/policy.js');
  if (killSwitchOn()) {
    summary.killSwitchTripped = true;
    return summary;
  }
  const {
    goalSnapshotDigest,
    listGoalsDetailed,
    loadGoal,
  } = await import('./store.js');
  const { nextActionableMilestone, advanceGoalCycle, progressOf } = await import('./advance.js');
  const source = listGoalsDetailed({ status: 'active' });
  if (source.sourceState === 'degraded' || !source.complete) {
    return refuse('goal-conductor-goal-source-degraded');
  }
  const goal = source.goals.find((entry) => entry.id === request.goalId);
  if (!goal) return refuse('goal-conductor-target-not-active');
  if (!goal.project) return refuse('goal-conductor-target-project-missing');
  const enrolled = listEnrolled();
  if (!enrolled.includes(goal.project)) return refuse('goal-conductor-target-project-not-enrolled');
  const milestone = nextActionableMilestone(goal);
  if (!milestone) return refuse('goal-conductor-target-has-no-actionable-milestone');
  const target = {
    goalId: goal.id,
    milestoneId: milestone.id,
    goalDigest: goalSnapshotDigest(goal),
    projectPath: goal.project,
  };

  const activationModule = await import('../daemon/activation-permit.js');
  const activation = activationModule.consumeGoalConductorActivationPermit(cfg, target);
  if (!activation.authorized || !activation.capability) return refuse(activation.reason);
  summary.activationPermitId = activation.permitId;

  // Reopen after durable receipt creation. Any steering between preflight and
  // consumption burns the permit and makes zero provider contacts.
  const current = loadGoal(goal.id);
  if (!current || goalSnapshotDigest(current) !== target.goalDigest) {
    return refuse('goal-conductor-target-drifted-after-consumption');
  }
  const currentMilestone = nextActionableMilestone(current);
  if (!currentMilestone || currentMilestone.id !== target.milestoneId) {
    return refuse('goal-conductor-milestone-drifted-after-consumption');
  }

  if (!activationModule.isGoalConductorActivationCapability(activation.capability, target)) {
    return refuse('goal-conductor-capability-invalid-or-consumed');
  }

  // This is intentionally the final pre-provider boundary, after the one-shot
  // capability's action-time runtime revalidation. It is a hard refusal until
  // actual durable reservations can be carried to every provider contact made
  // by advanceGoal/runSwarm.
  const { reserveGoalConductorProviderQuota } = await import('./conductor-quota.js');
  const quota = reserveGoalConductorProviderQuota();
  if (!quota.launchAuthorized) return refuse(quota.reason);

  try {
    const result = await advanceGoalCycle(goal.id, activation.configSnapshot ?? cfg, {
      maxRetries: 0,
      allowCloud: false,
      allowAnyRepo: false,
      budget: {
        maxTokens: activationModule.GOAL_CONDUCTOR_ONCE_MAX_TOKENS,
        maxSteps: activationModule.GOAL_CONDUCTOR_ONCE_MAX_STEPS,
        allowCloud: false,
      },
      expectedGoalDigest: target.goalDigest,
      expectedMilestoneId: target.milestoneId,
    });
    summary.goalsAdvanced = 1;
    summary.milestonesAdvanced = 1;
    summary.proposalsFiled = result.proposalsFiled;
    summary.goalsDone = result.goalDone ? 1 : 0;
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
    return summary;
  } catch (error) {
    return refuse(`goal-conductor-advance-failed:${error instanceof Error ? error.message : String(error)}`);
  }
}
