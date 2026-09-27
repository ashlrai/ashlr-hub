/**
 * Cloud task evidence timeline — the HTTP contract (3.13).
 *
 *   GET /api/verse/cloud/tasks/<id>/timeline  → CloudTimelineResponse
 *   GET /api/verse/devin/tasks/<id>/timeline  → CloudTimelineResponse (3.15, a Devin task)
 *
 * One ordered chain per cloud task, from the objective to what it cost:
 *
 *   objective → launch → worker (model / account) → report (a CLAIM) → PR
 *     → diff → checks → merge gates → merge → release → health → cost
 *
 * Every step says where it came from (`source`) and how much it can be
 * trusted (`verified`):
 *   true       a record Verse (or GitHub, through the tracker) wrote itself —
 *              the task store, the fleet merge record, the hash-chained
 *              authority ledger, the post-merge watch, local git.
 *   false      someone's say-so. The session's own report is ALWAYS this,
 *              and so is the cost, which is an estimate fixed at launch.
 *   'unknown'  nothing was recorded, or the record could not be read.
 *
 * Steps are always present and always in this order, so the chain reads the
 * same for every task; a stage the task has not reached says so
 * (`reached: false`) instead of disappearing.
 *
 * NODE-FREE on purpose: the web UI imports these types and the path helper.
 */
import { CLOUD_TASK_ID_PATTERN } from './types.js';
import { DEVIN_TASK_ID_PATTERN } from '../devin/types.js';

export const CLOUD_TIMELINE_SCHEMA_VERSION = 1 as const;

/** `/api/verse/cloud/tasks/<id>/timeline` — the id is checked against CLOUD_TASK_ID_PATTERN by the route. */
export const CLOUD_TIMELINE_PATH_RE = /^\/api\/verse\/cloud\/tasks\/([^/]+)\/timeline$/;

export function cloudTimelinePath(taskId: string): string {
  return `/api/verse/cloud/tasks/${encodeURIComponent(taskId)}/timeline`;
}

/**
 * 3.15: `/api/verse/devin/tasks/<id>/timeline` — checked against
 * DEVIN_TASK_ID_PATTERN by the route. Served by the same 'cloud-timeline'
 * module (timeline-api.ts), which is mounted before 'devin'.
 */
export const DEVIN_TIMELINE_PATH_RE = /^\/api\/verse\/devin\/tasks\/([^/]+)\/timeline$/;

export function devinTimelinePath(taskId: string): string {
  return `/api/verse/devin/tasks/${encodeURIComponent(taskId)}/timeline`;
}

/**
 * The evidence path for a task id Verse issued — cloud (`ct_…`) or Devin
 * (`dv_…`) — or null for anything else, so a caller can never splice an id
 * Verse did not issue into a request path.
 */
export function evidenceTimelinePath(taskId: string): string | null {
  if (CLOUD_TASK_ID_PATTERN.test(taskId)) return cloudTimelinePath(taskId);
  if (DEVIN_TASK_ID_PATTERN.test(taskId)) return devinTimelinePath(taskId);
  return null;
}

export type TimelineStepKind =
  | 'objective'
  | 'launch'
  | 'worker'
  | 'report'
  | 'pr'
  | 'diff'
  | 'checks'
  | 'gates'
  | 'merge'
  | 'release'
  | 'health'
  | 'cost';

/** The fixed order every timeline uses. */
export const TIMELINE_STEP_ORDER: readonly TimelineStepKind[] = [
  'objective', 'launch', 'worker', 'report', 'pr', 'diff', 'checks', 'gates', 'merge', 'release', 'health', 'cost',
];

export type TimelineVerified = true | false | 'unknown';

export interface TimelineLink {
  /** https only: claude.ai, github.com, and app.devin.ai (a Devin session, 3.15). */
  href: string;
  label: string;
}

export interface TimelineStep {
  kind: TimelineStepKind;
  /** ISO time the evidence was recorded; null when no time was recorded (never guessed). */
  at: string | null;
  /** One short line ("PR #512 merged"). */
  title: string;
  /** Plain sentences; scrubbed. May be empty. */
  detail: string;
  /** Where the evidence came from, in operator words ("authority ledger", "session report"). */
  source: string;
  verified: TimelineVerified;
  /** False while the task has not reached this stage (it may never). */
  reached: boolean;
  link?: TimelineLink;
}

export interface CloudTimelineResponse {
  v: typeof CLOUD_TIMELINE_SCHEMA_VERSION;
  generatedAt: string;
  taskId: string;
  repo: string;
  title: string;
  state: string;
  steps: TimelineStep[];
}
