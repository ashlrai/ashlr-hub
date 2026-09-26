/**
 * The ONE definition of an "open" (active) goal, shared by the Leader's
 * evidence, the Leader's `active-goals` metric, and the digest / dashboard
 * "goals in flight" list.
 *
 * WHY THIS FILE EXISTS (3.14 Leader reliability). The Leader counted open
 * goals from `listGoalsDetailed()` and replaced the WHOLE goals section with
 * `null` whenever the read was incomplete — while the digest counted from
 * `listGoals()`, which silently drops unreadable files. Three goal files had
 * a 1970 `updatedAt` (earlier than `createdAt`, which the store's record
 * guard rejects), so every read was "degraded": the digest reported 18–21
 * active goals while the Leader's model saw `GOALS AND FOCUS: null` and wrote
 * "the fleet has zero active goals". Now both sides count the same readable
 * goals with the same status rule, and an incomplete read is reported as a
 * LOWER BOUND with the unreadable-file count — never as nothing.
 *
 * Pure (no I/O): callers pass the result of a goal-store read.
 */
import type { Goal, GoalStatus } from '../types.js';

/**
 * Statuses that occupy focus capacity. `planning` counts: a goal with no
 * milestones yet is still open work the fleet has committed to.
 */
export const OPEN_GOAL_STATUSES: readonly GoalStatus[] = Object.freeze(['active', 'planning'] as GoalStatus[]);

export function isOpenGoal(goal: Pick<Goal, 'status'>): boolean {
  return goal.status === 'active' || goal.status === 'planning';
}

export interface GoalReadLike {
  goals: readonly Goal[];
  /** False when any goal file could not be read (or the listing was truncated). */
  complete: boolean;
  /** Goal files that could not be read; undefined = not reported by the source. */
  unreadable?: number;
}

export interface OpenGoalsSummary {
  /** Open goals among the READABLE ones — a lower bound when `complete` is false. */
  open: number;
  active: number;
  planning: number;
  paused: number;
  /** Readable goals of every status. */
  total: number;
  complete: boolean;
  /** Goal files the store could not read (0 when complete; null = unknown). */
  unreadable: number | null;
  /** The open goals themselves, in the source's order. */
  openGoals: Goal[];
}

export function summarizeOpenGoals(read: GoalReadLike): OpenGoalsSummary {
  const openGoals = read.goals.filter(isOpenGoal);
  let active = 0;
  let planning = 0;
  let paused = 0;
  for (const g of read.goals) {
    if (g.status === 'active') active += 1;
    else if (g.status === 'planning') planning += 1;
    else if (g.status === 'paused') paused += 1;
  }
  return {
    open: openGoals.length,
    active,
    planning,
    paused,
    total: read.goals.length,
    complete: read.complete,
    unreadable: read.complete ? 0 : (typeof read.unreadable === 'number' ? read.unreadable : null),
    openGoals,
  };
}
