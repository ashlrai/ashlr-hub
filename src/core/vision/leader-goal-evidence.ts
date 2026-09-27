/**
 * The Leader's GOALS AND FOCUS evidence block (3.14 Leader reliability).
 *
 * Built from the shared open-goal definition (goals/open-goals.ts) so the
 * Leader and the digest can never disagree about how many goals are open.
 * An incomplete goal-store read is reported as a lower bound, with the number
 * of files that could not be read — never as `null`, which a model reads as
 * "zero goals" (the 2026-09-24/25 memos did exactly that while 21 were open).
 * `null` is kept only for a source that could not be read at all.
 */
import type { Goal } from '../types.js';
import { summarizeOpenGoals, type GoalReadLike } from '../goals/open-goals.js';
import { LEADER_LIMITS } from './leader-types.js';
import { cleanModelText } from './leader-memo.js';

export interface LeaderGoalItem {
  id: string;
  objective: string;
  status: string;
  repo: string | null;
  milestonesDone: number;
  milestones: number;
  updatedOn: string;
}

export interface LeaderGoalEvidence {
  /** Open (active + planning) goals — a lower bound when `complete` is false. */
  open: number;
  total: number;
  focusLimit: number;
  /** False when some goal files could not be read: `open` / `total` are then lower bounds. */
  complete: boolean;
  /** Goal files that could not be read (null = the source did not say). */
  unreadableGoalFiles: number | null;
  /** Plain-language caveat for the model; null when the read was complete. */
  note: string | null;
  items: LeaderGoalItem[];
}

const MAX_ITEMS = 40;

function day(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
}

/** PURE: the Leader's goals block from one goal-store read. */
export function buildLeaderGoalEvidence(read: GoalReadLike): LeaderGoalEvidence {
  const summary = summarizeOpenGoals(read);
  const shown: Goal[] = [...summary.openGoals, ...read.goals.filter((g) => g.status === 'paused')].slice(0, MAX_ITEMS);
  const note = summary.complete
    ? null
    : `The goal store could not read ${summary.unreadable ?? 'some'} goal file(s): at least ${summary.open} goals are open (a lower bound, not the full count).`;
  return {
    open: summary.open,
    total: summary.total,
    focusLimit: LEADER_LIMITS.maxActiveGoals,
    complete: summary.complete,
    unreadableGoalFiles: summary.unreadable,
    note,
    items: shown.map((g) => ({
      id: g.id,
      objective: cleanModelText(g.objective, 200) ?? '',
      status: g.status,
      repo: g.project ? g.project.split(/[\\/]/).pop() ?? null : null,
      milestonesDone: g.milestones.filter((m) => m.status === 'done').length,
      milestones: g.milestones.length,
      updatedOn: day(g.updatedAt),
    })),
  };
}
