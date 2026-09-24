/**
 * Fleet task source — V3.10 Track B unit U5 (SPEC-310B §3 "Task source").
 *
 * The fleet's OWN queue of explicit asks, merged into the scanned backlog on
 * every standing tick:
 *   - `leader`  — the Leader's `work.dispatch` (U8; a veto cancels it while it
 *                 is still queued or parked);
 *   - `repair` / `revert` — the post-merge watch's repair task after a red
 *                 merge (U4);
 *   - `insight` — an A7 `verification-gap` insight becomes "add tests";
 *   - `manual` / `backlog` — Mason, or a backlog item promoted by hand.
 * Score = value × P(ship) ÷ cost (`scoreTask`), and every task carries the
 * size budget it was sliced to — min(the repo's effective merge caps) — which
 * the producer is told in its brief. Nothing bigger is ever asked for.
 *
 * STORE: `~/.ashlr/fleet/tasks.json` (0600, dir 0700), one JSON document,
 * read-modify-written under a local store lock so the Verse server (Leader
 * API) and the daemon (post-merge watch, dispatch outcomes) never interleave.
 * Bounded: at most MAX_OPEN_TASKS unfinished tasks; finished ones are pruned
 * after 7 days.
 *
 * Untrusted text: titles and details can come from a model (the Leader) or a
 * reasoning insight. Both are scrubbed, stripped of control characters and
 * length-capped before they are stored, and they reach a producer only as the
 * DATA of its brief — never as an instruction to the daemon.
 *
 * FROZEN (SPEC-310BC-COORD §1): `enqueueTask`, `cancelTask` signatures.
 */
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { WorkItem, WorkSource } from '../types.js';
import { currentStandingPolicy } from '../authority/effective-config.js';
import { STANDING_GRANT_CEILINGS, STANDING_GRANT_PATTERNS } from '../authority/types.js';
import type { RoutingDifficulty } from '../routing/types.js';
import type { ReasoningInsight } from '../reasoning/types.js';
import { scrubSecrets } from '../util/scrub.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import {
  FLEET_ACTORS,
  type CancelTaskRequest,
  type CancelTaskResult,
  type EnqueueTaskResult,
  type FleetActor,
  type FleetTask,
  type FleetTaskInput,
  type FleetTaskSource,
  type FleetTaskStatus,
} from './fleet-types.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';

// ---------------------------------------------------------------------------
// Limits and vocabulary
// ---------------------------------------------------------------------------

export const TASK_QUEUE_LIMITS = Object.freeze({
  /** Unfinished tasks (queued / parked / dispatched). A bound, not a budget. */
  maxOpenTasks: 500,
  maxTitleChars: 200,
  maxDetailChars: 4_000,
  maxRefChars: 200,
  /** A task that failed this many dispatches is marked failed, not retried forever. */
  maxAttempts: 3,
  /** Finished tasks are kept this long for the Fleet surface, then pruned. */
  finishedRetentionMs: 7 * 24 * 60 * 60_000,
  lockWaitMs: 2_000,
  maxFileBytes: 2 * 1024 * 1024,
});

const TASK_SOURCES: readonly FleetTaskSource[] = ['leader', 'backlog', 'repair', 'insight', 'revert', 'manual'];
const DIFFICULTIES: readonly RoutingDifficulty[] = ['low', 'medium', 'high'];
const OPEN_STATUSES: ReadonlySet<FleetTaskStatus> = new Set<FleetTaskStatus>(['queued', 'parked', 'dispatched']);
const ALL_STATUSES: readonly FleetTaskStatus[] = ['queued', 'parked', 'dispatched', 'done', 'failed', 'cancelled'];

/** WorkItem id prefix for a fleet task (so a dispatch outcome maps back to its task). */
export const FLEET_TASK_ITEM_PREFIX = 'fleet-task:';
export const FLEET_TASK_TAG = 'fleet-task';

export function taskQueuePath(): string {
  return join(homedir(), '.ashlr', 'fleet', 'tasks.json');
}

function lockPath(file: string): string {
  return `${file}.lock`;
}

interface TaskQueueFileV1 {
  v: 1;
  tasks: FleetTask[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Text hygiene
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

/** Scrub, strip control / bidi characters, collapse to `max` chars. */
export function cleanTaskText(value: string, max: number, singleLine: boolean): string {
  let text = scrubSecrets(value).replace(CONTROL_CHARS, '');
  if (singleLine) text = text.replace(/\s+/g, ' ');
  text = text.trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function cleanRef(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0 || text.length > TASK_QUEUE_LIMITS.maxRefChars) return null;
  // An identifier: printable, no whitespace, no control characters.
  if (!/^[\x21-\x7e]+$/.test(text)) return null;
  return text;
}

// ---------------------------------------------------------------------------
// Size budget ("sliced to fit the caps")
// ---------------------------------------------------------------------------

/**
 * The size a task is sliced to: the repo's effective merge caps under the
 * standing policy, or — with no policy in force — the most conservative
 * compiled caps (local-authored: 4 files / 150 lines). Never larger than the
 * compiled ceilings.
 */
export function sizeBudgetFor(repo: string): { files: number; lines: number } {
  const ceilings = STANDING_GRANT_CEILINGS;
  let policy: ReturnType<typeof currentStandingPolicy> = null;
  try {
    policy = currentStandingPolicy();
  } catch {
    policy = null;
  }
  const repoPolicy = policy?.repos.find((r) => r.nameWithOwner.toLowerCase() === repo.toLowerCase()) ?? null;
  if (!repoPolicy) {
    return { files: ceilings.localAuthored.maxFiles, lines: ceilings.localAuthored.maxLines };
  }
  return {
    files: Math.max(1, Math.min(repoPolicy.maxFiles, ceilings.maxFiles)),
    lines: Math.max(1, Math.min(repoPolicy.maxLines, ceilings.maxLines)),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function isIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function sanitizeTask(raw: unknown): FleetTask | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r['v'] !== 1 || typeof r['id'] !== 'string' || !/^[a-f0-9-]{36}$/.test(r['id'])) return null;
  if (typeof r['repo'] !== 'string' || !STANDING_GRANT_PATTERNS.nameWithOwner.test(r['repo'])) return null;
  if (!TASK_SOURCES.includes(r['source'] as FleetTaskSource)) return null;
  if (!DIFFICULTIES.includes(r['difficulty'] as RoutingDifficulty)) return null;
  if (!ALL_STATUSES.includes(r['status'] as FleetTaskStatus)) return null;
  if (!FLEET_ACTORS.includes(r['requestedBy'] as FleetActor)) return null;
  if (typeof r['title'] !== 'string' || typeof r['detail'] !== 'string') return null;
  const value = r['value'];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const budget = r['sizeBudget'] as Record<string, unknown> | undefined;
  if (!budget || typeof budget['files'] !== 'number' || typeof budget['lines'] !== 'number') return null;
  const attempts = r['attempts'];
  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0) return null;
  if (!isIso(r['createdAt']) || !isIso(r['updatedAt'])) return null;
  const parkedUntil = r['parkedUntil'];
  if (parkedUntil !== null && !isIso(parkedUntil)) return null;
  return {
    v: 1,
    id: r['id'],
    repo: r['repo'],
    source: r['source'] as FleetTaskSource,
    title: cleanTaskText(r['title'], TASK_QUEUE_LIMITS.maxTitleChars, true),
    detail: cleanTaskText(r['detail'], TASK_QUEUE_LIMITS.maxDetailChars, false),
    difficulty: r['difficulty'] as RoutingDifficulty,
    value: Math.max(1, Math.min(5, Math.round(value))),
    requestedBy: r['requestedBy'] as FleetActor,
    goalId: cleanRef(r['goalId']),
    landingId: cleanRef(r['landingId']),
    insightId: cleanRef(r['insightId']),
    dedupeKey: cleanRef(r['dedupeKey']),
    status: r['status'] as FleetTaskStatus,
    sizeBudget: {
      files: Math.max(1, Math.min(STANDING_GRANT_CEILINGS.maxFiles, Math.floor(budget['files']))),
      lines: Math.max(1, Math.min(STANDING_GRANT_CEILINGS.maxLines, Math.floor(budget['lines']))),
    },
    attempts,
    parkedUntil: parkedUntil as string | null,
    createdAt: r['createdAt'],
    updatedAt: r['updatedAt'],
  };
}

export type TaskQueueRead =
  | { ok: true; tasks: FleetTask[] }
  | { ok: false; reason: string };

/**
 * Read the queue. A missing file is the honest empty queue (nothing was ever
 * queued); an unreadable / corrupt one is NOT read as empty — callers that
 * need the queue fail closed on `ok: false`.
 */
export function readTaskQueue(file: string = taskQueuePath()): TaskQueueRead {
  const read = readPrivateFileCapped(file, TASK_QUEUE_LIMITS.maxFileBytes);
  if (!read) {
    // readPrivateFileCapped answers null both for "absent" and "unreadable";
    // only a genuinely absent file is an empty queue.
    return fileAbsent(file) ? { ok: true, tasks: [] } : { ok: false, reason: 'The fleet task queue could not be read.' };
  }
  if (read.truncated) return { ok: false, reason: 'The fleet task queue is larger than it may ever be; refusing to read a partial queue.' };
  try {
    const raw = JSON.parse(read.text) as Record<string, unknown>;
    if (raw['v'] !== 1 || !Array.isArray(raw['tasks'])) {
      return { ok: false, reason: 'The fleet task queue is not a version-1 queue.' };
    }
    const tasks: FleetTask[] = [];
    for (const entry of raw['tasks']) {
      const task = sanitizeTask(entry);
      if (task) tasks.push(task);
    }
    return { ok: true, tasks };
  } catch {
    return { ok: false, reason: 'The fleet task queue is not valid JSON.' };
  }
}

function fileAbsent(file: string): boolean {
  try {
    lstatSync(file);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
  }
}

function prune(tasks: FleetTask[], nowMs: number): FleetTask[] {
  return tasks.filter((t) => OPEN_STATUSES.has(t.status)
    || nowMs - Date.parse(t.updatedAt) < TASK_QUEUE_LIMITS.finishedRetentionMs);
}

function writeQueue(file: string, tasks: FleetTask[], nowMs: number): void {
  const body: TaskQueueFileV1 = { v: 1, tasks, updatedAt: new Date(nowMs).toISOString() };
  ensurePrivateDirectory(dirname(file));
  writePrivateFileAtomic(file, `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * Run `mutate` over the queue under the store lock and persist its result.
 * The lock is what keeps a Leader enqueue (Verse server) and a dispatch
 * update (daemon) from losing each other's write.
 */
function withQueue<T>(
  file: string,
  nowMs: number,
  mutate: (tasks: FleetTask[]) => { tasks: FleetTask[]; result: T; write: boolean },
): { ok: true; result: T } | { ok: false; reason: string } {
  try {
    ensurePrivateDirectory(dirname(file));
  } catch {
    return { ok: false, reason: 'The fleet task queue directory is not a private directory.' };
  }
  const lock = acquireLocalStoreLock(lockPath(file), TASK_QUEUE_LIMITS.lockWaitMs);
  if (!lock) return { ok: false, reason: 'The fleet task queue is busy; try again.' };
  try {
    const read = readTaskQueue(file);
    if (!read.ok) return { ok: false, reason: read.reason };
    const outcome = mutate(prune(read.tasks, nowMs));
    if (outcome.write) writeQueue(file, outcome.tasks, nowMs);
    return { ok: true, result: outcome.result };
  } catch (err) {
    return { ok: false, reason: `The fleet task queue could not be updated (${scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 160)}).` };
  } finally {
    releaseLocalStoreLock(lock);
  }
}

// ---------------------------------------------------------------------------
// Frozen API
// ---------------------------------------------------------------------------

export interface TaskStoreOptions {
  nowMs?: number;
  file?: string;
  /** Override the sliced size (tests); defaults to `sizeBudgetFor(repo)`. */
  sizeBudget?: { files: number; lines: number };
}

function validateInput(input: FleetTaskInput): { ok: true } | { ok: false; reason: string } {
  if (typeof input !== 'object' || input === null) return { ok: false, reason: 'A task must be an object.' };
  if (typeof input.repo !== 'string' || !STANDING_GRANT_PATTERNS.nameWithOwner.test(input.repo)) {
    return { ok: false, reason: 'repo must be a GitHub owner/name.' };
  }
  if (!TASK_SOURCES.includes(input.source)) return { ok: false, reason: `source must be one of: ${TASK_SOURCES.join(', ')}.` };
  if (!DIFFICULTIES.includes(input.difficulty)) return { ok: false, reason: 'difficulty must be low, medium or high.' };
  if (!FLEET_ACTORS.includes(input.requestedBy)) return { ok: false, reason: 'requestedBy is not a fleet actor.' };
  if (typeof input.title !== 'string' || cleanTaskText(input.title, TASK_QUEUE_LIMITS.maxTitleChars, true).length === 0) {
    return { ok: false, reason: 'A task needs a title.' };
  }
  if (typeof input.detail !== 'string') return { ok: false, reason: 'detail must be a string.' };
  if (typeof input.value !== 'number' || !Number.isFinite(input.value) || input.value < 1 || input.value > 5) {
    return { ok: false, reason: 'value must be a number from 1 to 5.' };
  }
  for (const key of ['goalId', 'landingId', 'insightId', 'dedupeKey'] as const) {
    const ref = input[key];
    if (ref !== undefined && ref !== null && cleanRef(ref) === null) {
      return { ok: false, reason: `${key} must be a short identifier without spaces.` };
    }
  }
  return { ok: true };
}

/** Queue a task (idempotent on `dedupeKey`). */
export function enqueueTask(input: FleetTaskInput, opts: TaskStoreOptions = {}): EnqueueTaskResult {
  const valid = validateInput(input);
  if (!valid.ok) return valid;
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const file = opts.file ?? taskQueuePath();
  const dedupeKey = cleanRef(input.dedupeKey);
  type EnqueueOutcome = { task: FleetTask | null; deduped: boolean; full: boolean };
  const outcome = withQueue<EnqueueOutcome>(file, nowMs, (tasks) => {
    if (dedupeKey !== null) {
      const existing = tasks.find((t) => t.dedupeKey === dedupeKey && OPEN_STATUSES.has(t.status));
      if (existing) return { tasks, result: { task: existing, deduped: true, full: false }, write: false };
    }
    const open = tasks.filter((t) => OPEN_STATUSES.has(t.status)).length;
    if (open >= TASK_QUEUE_LIMITS.maxOpenTasks) {
      return { tasks, result: { task: null, deduped: false, full: true }, write: false };
    }
    const budget = opts.sizeBudget ?? sizeBudgetFor(input.repo);
    const task: FleetTask = {
      v: 1,
      id: randomUUID(),
      repo: input.repo,
      source: input.source,
      title: cleanTaskText(input.title, TASK_QUEUE_LIMITS.maxTitleChars, true),
      detail: cleanTaskText(input.detail, TASK_QUEUE_LIMITS.maxDetailChars, false),
      difficulty: input.difficulty,
      value: Math.max(1, Math.min(5, Math.round(input.value))),
      requestedBy: input.requestedBy,
      goalId: cleanRef(input.goalId),
      landingId: cleanRef(input.landingId),
      insightId: cleanRef(input.insightId),
      dedupeKey,
      status: 'queued',
      sizeBudget: {
        files: Math.max(1, Math.min(STANDING_GRANT_CEILINGS.maxFiles, Math.floor(budget.files))),
        lines: Math.max(1, Math.min(STANDING_GRANT_CEILINGS.maxLines, Math.floor(budget.lines))),
      },
      attempts: 0,
      parkedUntil: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    return { tasks: [...tasks, task], result: { task, deduped: false, full: false }, write: true };
  });
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  if (outcome.result.full) {
    return { ok: false, reason: `The fleet already holds ${TASK_QUEUE_LIMITS.maxOpenTasks} unfinished tasks.` };
  }
  return { ok: true, task: outcome.result.task!, deduped: outcome.result.deduped };
}

/** Cancel a queued / parked task (a dispatched task cannot be cancelled: ok false). */
export function cancelTask(req: CancelTaskRequest, opts: TaskStoreOptions = {}): CancelTaskResult {
  if (typeof req !== 'object' || req === null || typeof req.taskId !== 'string' || !/^[a-f0-9-]{36}$/.test(req.taskId)) {
    return { ok: false, reason: 'taskId must be a task id.' };
  }
  if (!FLEET_ACTORS.includes(req.actor)) return { ok: false, reason: 'actor is not a fleet actor.' };
  const nowMs = opts.nowMs ?? Date.now();
  type CancelOutcome =
    | { kind: 'missing' }
    | { kind: 'not-cancellable'; task: FleetTask }
    | { kind: 'cancelled'; task: FleetTask };
  const outcome = withQueue<CancelOutcome>(opts.file ?? taskQueuePath(), nowMs, (tasks) => {
    const index = tasks.findIndex((t) => t.id === req.taskId);
    if (index === -1) return { tasks, result: { kind: 'missing' }, write: false };
    const task = tasks[index]!;
    if (task.status !== 'queued' && task.status !== 'parked') {
      return { tasks, result: { kind: 'not-cancellable', task }, write: false };
    }
    const next: FleetTask = {
      ...task,
      status: 'cancelled',
      parkedUntil: null,
      detail: cleanTaskText(`${task.detail}\n\nCancelled by ${req.actor}: ${String(req.reason ?? '')}`, TASK_QUEUE_LIMITS.maxDetailChars, false),
      updatedAt: new Date(nowMs).toISOString(),
    };
    const copy = [...tasks];
    copy[index] = next;
    return { tasks: copy, result: { kind: 'cancelled', task: next }, write: true };
  });
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  const result = outcome.result;
  if (result.kind === 'missing') return { ok: false, reason: `No task ${req.taskId} exists.` };
  if (result.kind === 'not-cancellable') {
    return { ok: false, reason: `Task ${req.taskId} is ${result.task.status} and can no longer be cancelled.` };
  }
  return { ok: true, task: result.task };
}

// ---------------------------------------------------------------------------
// Daemon-side updates
// ---------------------------------------------------------------------------

export type TaskDispatchUpdate =
  | { kind: 'dispatched' }
  | { kind: 'produced'; proposalId: string | null }
  | { kind: 'no-result'; reason: string }
  | { kind: 'held'; reason: string; parkedUntil: string | null };

/**
 * Record what one dispatch did to a task. `produced` finishes it (the
 * proposal carries on through the gates); `no-result` counts an attempt and
 * re-queues it until TASK_QUEUE_LIMITS.maxAttempts; `held` parks it.
 */
export function recordTaskDispatch(taskId: string, update: TaskDispatchUpdate, opts: TaskStoreOptions = {}): FleetTask | null {
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const outcome = withQueue<FleetTask | null>(opts.file ?? taskQueuePath(), nowMs, (tasks) => {
    const index = tasks.findIndex((t) => t.id === taskId);
    if (index === -1) return { tasks, result: null, write: false };
    const task = tasks[index]!;
    if (task.status === 'cancelled' || task.status === 'done' || task.status === 'failed') {
      return { tasks, result: task, write: false };
    }
    let next: FleetTask;
    switch (update.kind) {
      case 'dispatched':
        next = { ...task, status: 'dispatched', parkedUntil: null, updatedAt: nowIso };
        break;
      case 'produced':
        next = { ...task, status: 'done', attempts: task.attempts + 1, parkedUntil: null, updatedAt: nowIso };
        break;
      case 'no-result': {
        const attempts = task.attempts + 1;
        next = {
          ...task,
          attempts,
          status: attempts >= TASK_QUEUE_LIMITS.maxAttempts ? 'failed' : 'queued',
          parkedUntil: null,
          detail: attempts >= TASK_QUEUE_LIMITS.maxAttempts
            ? cleanTaskText(`${task.detail}\n\nGave up after ${attempts} attempts: ${update.reason}`, TASK_QUEUE_LIMITS.maxDetailChars, false)
            : task.detail,
          updatedAt: nowIso,
        };
        break;
      }
      case 'held':
        next = {
          ...task,
          status: 'parked',
          parkedUntil: update.parkedUntil && isIso(update.parkedUntil) ? update.parkedUntil : null,
          updatedAt: nowIso,
        };
        break;
    }
    const copy = [...tasks];
    copy[index] = next;
    return { tasks: copy, result: next, write: true };
  });
  return outcome.ok ? outcome.result : null;
}

/**
 * Parked tasks whose `parkedUntil` has passed go back to `queued`, and a
 * `dispatched` task the daemon lost track of (a crash mid-run, older than
 * `staleDispatchMs`) is re-queued rather than left dispatched forever.
 * Returns how many tasks changed; never throws.
 */
export function releaseParkedTasks(opts: TaskStoreOptions & { staleDispatchMs?: number } = {}): number {
  const nowMs = opts.nowMs ?? Date.now();
  const staleMs = opts.staleDispatchMs ?? 6 * 60 * 60_000;
  const nowIso = new Date(nowMs).toISOString();
  const outcome = withQueue<number>(opts.file ?? taskQueuePath(), nowMs, (tasks) => {
    let changed = 0;
    const next = tasks.map((t) => {
      if (t.status === 'parked' && t.parkedUntil !== null && Date.parse(t.parkedUntil) <= nowMs) {
        changed += 1;
        return { ...t, status: 'queued' as const, parkedUntil: null, updatedAt: nowIso };
      }
      if (t.status === 'dispatched' && nowMs - Date.parse(t.updatedAt) > staleMs) {
        changed += 1;
        return { ...t, status: 'queued' as const, updatedAt: nowIso };
      }
      return t;
    });
    return { tasks: next, result: changed, write: changed > 0 };
  });
  return outcome.ok ? outcome.result : 0;
}

// ---------------------------------------------------------------------------
// Scoring and projection into the loop's backlog
// ---------------------------------------------------------------------------

/** Prior P(ship) by difficulty when the repo has no history (a starting guess, not a measurement). */
export const SHIP_PRIOR: Readonly<Record<RoutingDifficulty, number>> = Object.freeze({ low: 0.7, medium: 0.5, high: 0.3 });
/** Relative cost units by difficulty (local slots are $0, but time and seats are not). */
export const COST_UNITS: Readonly<Record<RoutingDifficulty, number>> = Object.freeze({ low: 1, medium: 2, high: 4 });
/** Each failed attempt multiplies P(ship) by this. */
export const ATTEMPT_DECAY = 0.7;

/**
 * Score = value × P(ship) ÷ cost (SPEC-310B §3). `repoShipRate` is the
 * repo's smoothed recent success rate when known (null = use the prior).
 * On the same scale as the scanned backlog's `value / effort` (0.2 – 5), so
 * the loop's per-repo ordering can interleave the two honestly.
 */
export function scoreTask(
  task: Pick<FleetTask, 'value' | 'difficulty' | 'attempts'>,
  repoShipRate: number | null = null,
): number {
  const pShip = Math.max(0, Math.min(1, repoShipRate ?? SHIP_PRIOR[task.difficulty])) * ATTEMPT_DECAY ** task.attempts;
  // ×2 puts a typical task (value 3, medium, prior) at 1.5 — the same score a
  // value-3 / effort-2 backlog item gets — so neither source starves the other.
  return Math.round(((task.value * pShip) / COST_UNITS[task.difficulty]) * 2 * 1000) / 1000;
}

const EFFORT_OF: Readonly<Record<RoutingDifficulty, number>> = Object.freeze({ low: 2, medium: 3, high: 4 });

const WORK_SOURCE_OF: Readonly<Record<FleetTaskSource, WorkSource>> = Object.freeze({
  leader: 'goal',
  manual: 'goal',
  backlog: 'goal',
  repair: 'issue',
  revert: 'issue',
  insight: 'test',
});

/** The task id a projected work item carries, or null for a scanned item. */
export function fleetTaskIdOfItem(item: Pick<WorkItem, 'id'>): string | null {
  if (!item.id.startsWith(FLEET_TASK_ITEM_PREFIX)) return null;
  const id = item.id.slice(FLEET_TASK_ITEM_PREFIX.length);
  return /^[a-f0-9-]{36}$/.test(id) ? id : null;
}

/**
 * Project dispatchable tasks (queued, or parked past their time) into the
 * loop's WorkItem shape for the enrolled checkouts they belong to. Tasks for a
 * repo with no enrolled path are left in the queue untouched.
 */
export function fleetTaskWorkItems(
  tasks: readonly FleetTask[],
  pathOfRepo: (nameWithOwner: string) => string | null,
  opts: { nowMs: number; shipRateOf?: (nameWithOwner: string) => number | null },
): WorkItem[] {
  const items: WorkItem[] = [];
  for (const task of tasks) {
    const ready = task.status === 'queued'
      || (task.status === 'parked' && task.parkedUntil !== null && Date.parse(task.parkedUntil) <= opts.nowMs);
    if (!ready) continue;
    const path = pathOfRepo(task.repo);
    if (path === null) continue;
    const budget = `Size budget: at most ${task.sizeBudget.files} file(s) and ${task.sizeBudget.lines} changed line(s). `
      + 'If the change needs more, make the first complete slice that fits and stop.';
    const origin = task.source === 'leader'
      ? 'Requested by the Leader.'
      : task.source === 'repair' || task.source === 'revert'
        ? 'A repair after a fleet merge was reverted.'
        : task.source === 'insight'
          ? 'Filed from a reasoning insight (a verification gap).'
          : 'Queued for the fleet.';
    items.push({
      id: `${FLEET_TASK_ITEM_PREFIX}${task.id}`,
      repo: path,
      source: WORK_SOURCE_OF[task.source],
      title: task.title,
      detail: [task.detail, origin, budget].filter((part) => part.length > 0).join('\n\n'),
      value: task.value,
      effort: EFFORT_OF[task.difficulty],
      score: scoreTask(task, opts.shipRateOf?.(task.repo) ?? null),
      tags: [FLEET_TASK_TAG, `difficulty:${task.difficulty}`, `fleet-source:${task.source}`],
      ts: task.createdAt,
    });
  }
  items.sort((a, b) => b.score - a.score);
  return items;
}

/**
 * Merge projected fleet tasks into a scanned backlog: tasks first where they
 * outscore, by a STABLE sort on score — the backlog's own within-repo order
 * (already score-sorted by buildBacklog) is preserved.
 */
export function mergeFleetTaskItems(backlog: readonly WorkItem[], taskItems: readonly WorkItem[]): WorkItem[] {
  if (taskItems.length === 0) return [...backlog];
  const ids = new Set(backlog.map((i) => i.id));
  const merged = [...taskItems.filter((i) => !ids.has(i.id)), ...backlog];
  return merged
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (b.item.score - a.item.score) || (a.index - b.index))
    .map(({ item }) => item);
}

// ---------------------------------------------------------------------------
// A7 insights → "add tests" tasks
// ---------------------------------------------------------------------------

const INSIGHT_VALUE: Readonly<Record<ReasoningInsight['severity'], number>> = Object.freeze({ high: 4, warn: 3, info: 2 });

/**
 * Turn `verification-gap` insights into "add tests" tasks for repos the grant
 * covers. Idempotent per insight id (dedupeKey). `repoOf` resolves the
 * insight's repo label (a path, a name or owner/name) to nameWithOwner.
 * Returns how many NEW tasks were queued.
 */
export function enqueueInsightTasks(
  insights: readonly ReasoningInsight[],
  repoOf: (label: string) => string | null,
  opts: TaskStoreOptions = {},
): number {
  let added = 0;
  for (const insight of insights) {
    if (insight.kind !== 'verification-gap' || insight.repo === null) continue;
    const repo = repoOf(insight.repo);
    if (repo === null) continue;
    const evidence = insight.evidence.slice(0, 5).map((e) => `- ${e.ref} (${e.at})`).join('\n');
    const result = enqueueTask({
      repo,
      source: 'insight',
      title: `Add tests: ${insight.title}`,
      detail: `Code was changed without a test run proving it (${insight.count} time${insight.count === 1 ? '' : 's'} between `
        + `${insight.firstAt} and ${insight.lastAt}). Add or extend tests that exercise the changed behaviour.`
        + (evidence ? `\n\nEvidence:\n${evidence}` : ''),
      difficulty: insight.severity === 'high' ? 'medium' : 'low',
      value: INSIGHT_VALUE[insight.severity],
      requestedBy: 'daemon',
      insightId: insight.id.slice(0, TASK_QUEUE_LIMITS.maxRefChars),
      dedupeKey: `insight:${insight.id}`.slice(0, TASK_QUEUE_LIMITS.maxRefChars),
    }, opts);
    if (result.ok && !result.deduped) added += 1;
  }
  return added;
}

/** Read-only listing for the Fleet surface. Never throws; an unreadable queue is `ok: false`. */
export function listTasks(filter: { status?: FleetTaskStatus[] } = {}, file: string = taskQueuePath()): TaskQueueRead {
  const read = readTaskQueue(file);
  if (!read.ok) return read;
  const wanted = filter.status ? new Set(filter.status) : null;
  return { ok: true, tasks: wanted ? read.tasks.filter((t) => wanted.has(t.status)) : read.tasks };
}
