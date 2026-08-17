import type { Goal } from '../types.js';
import type { GoalConductorActivationTarget } from '../daemon/activation-permit.js';
import type { ListGoalsDetailedResult } from './store.js';

export interface GoalConductorTargetResolution {
  ok: boolean;
  reason: string;
  target?: GoalConductorActivationTarget;
  goal?: Goal;
  milestone?: Goal['milestones'][number];
}

/**
 * Resolve the exact live goal/milestone tuple shared by permit request and
 * consumption. The complete goal directory is the authority: a partial scan
 * can never be used to select a production target.
 */
export interface GoalConductorTargetDependencies {
  listGoalsDetailed: (filter: { status: 'active' }) => ListGoalsDetailedResult;
  listEnrolled: () => string[];
  nextActionableMilestone: (goal: Goal) => Goal['milestones'][number] | null;
  goalSnapshotDigest: (goal: Goal) => string;
}

export function resolveGoalConductorTarget(
  goalId: string,
  dependencies: GoalConductorTargetDependencies,
): GoalConductorTargetResolution {
  if (!goalId || goalId.length > 256) {
    return { ok: false, reason: 'goal-conductor-explicit-goal-required' };
  }
  const source = dependencies.listGoalsDetailed({ status: 'active' });
  if (source.sourceState === 'degraded' || !source.complete) {
    return { ok: false, reason: 'goal-conductor-goal-source-degraded' };
  }
  const goal = source.goals.find((entry) => entry.id === goalId);
  if (!goal) return { ok: false, reason: 'goal-conductor-target-not-active' };
  if (!goal.project) return { ok: false, reason: 'goal-conductor-target-project-missing' };
  const enrolled = dependencies.listEnrolled();
  if (!enrolled.includes(goal.project)) {
    return { ok: false, reason: 'goal-conductor-target-project-not-enrolled' };
  }
  const milestone = dependencies.nextActionableMilestone(goal);
  if (!milestone) {
    return { ok: false, reason: 'goal-conductor-target-has-no-actionable-milestone' };
  }
  return {
    ok: true,
    reason: 'goal-conductor-target-resolved',
    goal,
    milestone,
    target: {
      goalId: goal.id,
      milestoneId: milestone.id,
      goalDigest: dependencies.goalSnapshotDigest(goal),
      projectPath: goal.project,
    },
  };
}
