/**
 * goal-focus.ts - tiny read-only policy for keeping the fleet on closure.
 *
 * Goal creation is enqueue-only metadata. The expensive part is widening the
 * autonomous work queue from those goals, so this helper only decides whether
 * scanners/producers should defer NEW goal/invent expansion while enough
 * concrete active goal work is already available.
 */

import { resolve } from 'node:path';
import type { AshlrConfig, Goal, Milestone } from '../types.js';

export const DEFAULT_GOAL_FOCUS_ACTIVE_THRESHOLD = 4;

export interface GoalFocusSnapshot {
  enabled: boolean;
  activeThreshold: number;
  activeGoalCount: number;
  actionableActiveGoalCount: number;
  planningGoalCount: number;
  focusedGoalIds: string[];
  shouldDeferNewGoalWork: boolean;
  reason: 'disabled' | 'below-threshold' | 'active-goal-work-in-flight';
}

function foundryRecord(
  cfg?: Pick<AshlrConfig, 'foundry'> | null,
): Record<string, unknown> | undefined {
  return cfg?.foundry as Record<string, unknown> | undefined;
}

export function goalFocusModeEnabled(cfg?: Pick<AshlrConfig, 'foundry'> | null): boolean {
  return foundryRecord(cfg)?.['goalFocusMode'] !== false;
}

export function goalFocusActiveThreshold(cfg?: Pick<AshlrConfig, 'foundry'> | null): number {
  const raw = foundryRecord(cfg)?.['goalFocusActiveThreshold'];
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_GOAL_FOCUS_ACTIVE_THRESHOLD;
}

export function isActionableGoalMilestone(milestone: Milestone): boolean {
  return milestone.status === 'pending' || milestone.status === 'in-progress';
}

function goalMatchesScope(
  goal: Goal,
  opts?: { repo?: string | null; repos?: readonly string[] | null },
): boolean {
  if (!goal.project) return false;
  try {
    const project = resolve(goal.project);
    if (opts?.repo) return project === resolve(opts.repo);
    if (opts?.repos) {
      const repoSet = new Set(opts.repos.map((repo) => resolve(repo)));
      return repoSet.has(project);
    }
    return true;
  } catch {
    return false;
  }
}

export function nextActionableGoalMilestone(goal: Goal): Milestone | null {
  return goal.milestones.find(isActionableGoalMilestone) ?? null;
}

export function goalFocusSnapshot(
  goals: readonly Goal[],
  cfg?: Pick<AshlrConfig, 'foundry'> | null,
  opts?: { repo?: string | null; repos?: readonly string[] | null },
): GoalFocusSnapshot {
  const enabled = goalFocusModeEnabled(cfg);
  const activeThreshold = goalFocusActiveThreshold(cfg);
  const scoped = goals.filter((goal) => goalMatchesScope(goal, opts));
  const active = scoped.filter((goal) => goal.status === 'active');
  const planning = scoped.filter((goal) => goal.status === 'planning');
  const actionableActive = active.filter((goal) => nextActionableGoalMilestone(goal) !== null);
  const shouldDeferNewGoalWork = enabled && actionableActive.length >= activeThreshold;

  return {
    enabled,
    activeThreshold,
    activeGoalCount: active.length,
    actionableActiveGoalCount: actionableActive.length,
    planningGoalCount: planning.length,
    focusedGoalIds: actionableActive.map((goal) => goal.id).slice(0, activeThreshold),
    shouldDeferNewGoalWork,
    reason: !enabled
      ? 'disabled'
      : shouldDeferNewGoalWork
        ? 'active-goal-work-in-flight'
        : 'below-threshold',
  };
}

export function compareGoalFocusCandidates(
  left: { goal: Goal; milestone: Milestone },
  right: { goal: Goal; milestone: Milestone },
): number {
  const leftInProgress = left.milestone.status === 'in-progress' ? 1 : 0;
  const rightInProgress = right.milestone.status === 'in-progress' ? 1 : 0;
  if (leftInProgress !== rightInProgress) return rightInProgress - leftInProgress;

  const leftUpdated = Date.parse(left.milestone.updatedAt || left.goal.updatedAt || '');
  const rightUpdated = Date.parse(right.milestone.updatedAt || right.goal.updatedAt || '');
  const safeLeftUpdated = Number.isFinite(leftUpdated) ? leftUpdated : 0;
  const safeRightUpdated = Number.isFinite(rightUpdated) ? rightUpdated : 0;
  if (safeLeftUpdated !== safeRightUpdated) return safeRightUpdated - safeLeftUpdated;

  return left.goal.id.localeCompare(right.goal.id) || left.milestone.id.localeCompare(right.milestone.id);
}
