/**
 * Cloud lane persistence (unit C1). Everything lives under `cloudHome()` =
 * `<ashlr home>/cloud` (resolve the ashlr home the same way capacity-history
 * does; never hard-code ~). Tasks: one JSON file per task at
 * `tasks/<id>.json`, written atomically (tmp + rename), mode 0600 in 0700
 * dirs, opened O_NOFOLLOW|O_NONBLOCK like capacity-history. Budget:
 * `budget.json`, defaults from DEFAULT_CLOUD_BUDGET when missing/corrupt.
 *
 * RULES
 *  - Paths re-resolve per call (`ASHLR_HOME` when absolute, else
 *    `homedir()/.ashlr`), so a relocated HOME in tests is always honoured.
 *  - Readers are total: a missing, oversized, corrupt or hand-mangled file is
 *    skipped (tasks) or falls back to defaults field by field (budget). The
 *    server must boot, and the overview must answer, on any file.
 *  - Reads go through readPrivateFileCapped (O_NOFOLLOW | O_NONBLOCK: a
 *    symlink or FIFO planted at a task name is refused instead of followed or
 *    hanging the event loop); writes through writePrivateFileAtomic (O_EXCL
 *    temp, fchmod 0600, fsync, rename) inside ensurePrivateDirectory dirs.
 */
import { randomInt } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import {
  CLOUD_BRANCH_PREFIX,
  CLOUD_BUDGET_SCHEMA_VERSION,
  CLOUD_TASK_ID_PATTERN,
  CLOUD_TASK_SCHEMA_VERSION,
  DEFAULT_CLOUD_BUDGET,
  type CloudBudgetUpdate,
  type CloudBudgetV1,
  type CloudLaunchFailureCode,
  type CloudTaskOrigin,
  type CloudTaskPr,
  type CloudTaskReport,
  type CloudTaskState,
  type CloudTaskV1,
} from './types.js';

export const CLOUD_DIR = 'cloud';
export const CLOUD_TASKS_DIR = 'tasks';
export const CLOUD_BUDGET_FILE = 'budget.json';

/** GitHub `owner/name` — the one repo shape every cloud entry point accepts. */
export const CLOUD_REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

const DEFAULT_LIST_LIMIT = 500;
/** A task file is a few KB (the prompt is capped at 20 000 chars); anything past this was not written by us. */
const MAX_TASK_BYTES = 256 * 1024;
const MAX_BUDGET_BYTES = 16 * 1024;

const TASK_STATES: readonly CloudTaskState[] = ['queued', 'launching', 'running', 'pr-open', 'merged', 'closed', 'failed', 'expired'];
const TASK_ORIGINS: readonly CloudTaskOrigin[] = ['chat', 'operator', 'leader', 'self-improve', 'cli'];
const REQUESTERS: readonly CloudTaskV1['requestedBy'][] = ['mason', 'leader', 'self-improve'];
const FAILURE_CODES: readonly CloudLaunchFailureCode[] = [
  'seat-unavailable', 'auth', 'not-enabled', 'rate-limited', 'no-remote', 'checkout-failed', 'budget', 'timeout', 'unparsed', 'unknown',
];
const REPORT_STATUSES: readonly CloudTaskReport['status'][] = ['done', 'partial', 'blocked', 'no-change'];
const PR_STATES: readonly CloudTaskPr['state'][] = ['open', 'closed', 'merged'];

/**
 * Budget bounds. Generous on purpose — they exist to stop a typo (an extra
 * zero, a negative) from silently disabling or unbounding the lane, not to
 * second-guess the operator's account.
 */
export const CLOUD_BUDGET_LIMITS = Object.freeze({
  maxUsd: 100_000,
  maxCostPerSessionUsd: 1_000,
  maxConcurrent: 20,
  maxSessionsPerDay: 500,
  maxSelfImprovePerDay: 100,
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** `$ASHLR_HOME` when it is absolute, else `~/.ashlr` (resolved per call so a test HOME is honoured). */
export function ashlrHome(): string {
  const configured = process.env['ASHLR_HOME'];
  return typeof configured === 'string' && configured.trim() !== '' && isAbsolute(configured)
    ? configured
    : join(homedir(), '.ashlr');
}

export function cloudHome(): string {
  return join(ashlrHome(), CLOUD_DIR);
}

export function cloudTasksDir(): string {
  return join(cloudHome(), CLOUD_TASKS_DIR);
}

export function cloudBudgetPath(): string {
  return join(cloudHome(), CLOUD_BUDGET_FILE);
}

/** Creates `<ashlr home>`, `cloud/` and any `sub` directories as private (0700, owned, not symlinks). */
export function ensureCloudDirectory(...sub: string[]): string {
  ensurePrivateDirectory(ashlrHome());
  let dir = cloudHome();
  ensurePrivateDirectory(dir);
  for (const part of sub) {
    dir = join(dir, part);
    ensurePrivateDirectory(dir);
  }
  return dir;
}

function readJsonFile(path: string, maxBytes: number): unknown {
  const file = readPrivateFileCapped(path, maxBytes);
  if (!file || file.truncated) return undefined;
  try {
    return JSON.parse(file.text) as unknown;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

function isReport(value: unknown): value is CloudTaskReport {
  return isRecord(value)
    && REPORT_STATUSES.includes(value['status'] as CloudTaskReport['status'])
    && isString(value['summary'])
    && isStringArray(value['testsRun'])
    && isStringArray(value['risks'])
    && (value['filesChanged'] === undefined || (typeof value['filesChanged'] === 'number' && Number.isFinite(value['filesChanged'])));
}

function isPr(value: unknown): value is CloudTaskPr {
  return isRecord(value)
    && typeof value['number'] === 'number' && Number.isInteger(value['number'])
    && isString(value['url'])
    && PR_STATES.includes(value['state'] as CloudTaskPr['state'])
    && typeof value['draft'] === 'boolean'
    && isString(value['title']);
}

/** Structural check of a persisted task. Hand-edited or foreign files fail it and are skipped by readers. */
export function isCloudTask(value: unknown): value is CloudTaskV1 {
  if (!isRecord(value)) return false;
  const id = value['id'];
  return value['v'] === CLOUD_TASK_SCHEMA_VERSION
    && isString(id) && CLOUD_TASK_ID_PATTERN.test(id)
    && isString(value['repo']) && CLOUD_REPO_PATTERN.test(value['repo'])
    && isString(value['baseBranch'])
    && value['branch'] === `${CLOUD_BRANCH_PREFIX}${id}`
    && isString(value['title'])
    && isString(value['prompt'])
    && TASK_ORIGINS.includes(value['origin'] as CloudTaskOrigin)
    && REQUESTERS.includes(value['requestedBy'] as CloudTaskV1['requestedBy'])
    && isString(value['seat'])
    && isNullableString(value['sessionId'])
    && isNullableString(value['sessionUrl'])
    && TASK_STATES.includes(value['state'] as CloudTaskState)
    && isNullableString(value['stateReason'])
    && (value['failure'] === null || FAILURE_CODES.includes(value['failure'] as CloudLaunchFailureCode))
    && isString(value['createdAt']) && Number.isFinite(Date.parse(value['createdAt']))
    && isNullableString(value['launchedAt'])
    && isString(value['updatedAt'])
    && (value['pr'] === null || isPr(value['pr']))
    && (value['report'] === null || isReport(value['report']))
    && typeof value['estimatedCostUsd'] === 'number' && Number.isFinite(value['estimatedCostUsd']) && value['estimatedCostUsd'] >= 0
    && isNullableString(value['backlogItemId'])
    && isNullableString(value['needsYouId']);
}

function taskPath(id: string): string {
  return join(cloudTasksDir(), `${id}.json`);
}

/** Newest first (by createdAt), corrupt files skipped, at most `limit` (default 500). */
export function listCloudTasks(limit: number = DEFAULT_LIST_LIMIT): CloudTaskV1[] {
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_LIST_LIMIT;
  let names: string[];
  try {
    names = readdirSync(cloudTasksDir());
  } catch {
    return [];
  }
  const tasks: CloudTaskV1[] = [];
  for (const name of names) {
    // Skips temp files (`.ct_….json.<pid>.<rand>.tmp`) and anything not ours.
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!CLOUD_TASK_ID_PATTERN.test(id)) continue;
    const task = readCloudTask(id);
    if (task) tasks.push(task);
  }
  tasks.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
  return tasks.slice(0, cap);
}

export function readCloudTask(id: string): CloudTaskV1 | null {
  if (typeof id !== 'string' || !CLOUD_TASK_ID_PATTERN.test(id)) return null;
  const value = readJsonFile(taskPath(id), MAX_TASK_BYTES);
  // A file whose id disagrees with its name was copied or hand-edited: trusting
  // it would let two files claim one task.
  return isCloudTask(value) && value.id === id ? value : null;
}

/**
 * Atomic write; sets updatedAt. Rejects ids not matching CLOUD_TASK_ID_PATTERN.
 * The caller's object gets the same updatedAt (unless frozen), so what it
 * returns to an API caller matches what is on disk.
 */
export function writeCloudTask(task: CloudTaskV1): void {
  if (!task || typeof task.id !== 'string' || !CLOUD_TASK_ID_PATTERN.test(task.id)) {
    throw new Error('cloud lane: refusing to write a task with an invalid id');
  }
  const updatedAt = new Date().toISOString();
  const record: CloudTaskV1 = { ...task, updatedAt };
  if (!isCloudTask(record)) throw new Error('cloud lane: refusing to write a malformed task');
  ensureCloudDirectory(CLOUD_TASKS_DIR);
  writePrivateFileAtomic(taskPath(task.id), `${JSON.stringify(record, null, 2)}\n`);
  if (!Object.isFrozen(task)) task.updatedAt = updatedAt;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

const roundCents = (value: number): number => Math.round(value * 100) / 100;

function clampMoney(value: unknown, fallback: number, max: number = CLOUD_BUDGET_LIMITS.maxUsd): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return roundCents(Math.min(max, Math.max(0, value)));
}

function clampCount(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function defaultBudget(): CloudBudgetV1 {
  return { ...DEFAULT_CLOUD_BUDGET, selfImprove: { ...DEFAULT_CLOUD_BUDGET.selfImprove }, updatedAt: new Date(0).toISOString() };
}

/**
 * Field-by-field merge of `input` over `base`: a wrong-typed field keeps the
 * base value, a number out of range is clamped. Shared by the reader (a
 * hand-mangled file) and updates (an API body), so both obey the same bounds.
 */
function mergeBudget(base: CloudBudgetV1, input: unknown): CloudBudgetV1 {
  const src = isRecord(input) ? input : {};
  const self = isRecord(src['selfImprove']) ? src['selfImprove'] : {};
  const repo = typeof self['repo'] === 'string' && CLOUD_REPO_PATTERN.test(self['repo'].trim())
    ? self['repo'].trim()
    : base.selfImprove.repo;
  return {
    v: CLOUD_BUDGET_SCHEMA_VERSION,
    creditsTotalUsd: clampMoney(src['creditsTotalUsd'], base.creditsTotalUsd),
    creditsSpentAdjustmentUsd: clampMoney(src['creditsSpentAdjustmentUsd'], base.creditsSpentAdjustmentUsd),
    estimatedCostPerSessionUsd: clampMoney(src['estimatedCostPerSessionUsd'], base.estimatedCostPerSessionUsd, CLOUD_BUDGET_LIMITS.maxCostPerSessionUsd),
    // At least one: zero concurrent sessions would silently disable the lane;
    // the daily caps (which may be 0) are the explicit "pause" switch.
    maxConcurrent: clampCount(src['maxConcurrent'], base.maxConcurrent, 1, CLOUD_BUDGET_LIMITS.maxConcurrent),
    maxSessionsPerDay: clampCount(src['maxSessionsPerDay'], base.maxSessionsPerDay, 0, CLOUD_BUDGET_LIMITS.maxSessionsPerDay),
    selfImprove: {
      enabled: typeof self['enabled'] === 'boolean' ? self['enabled'] : base.selfImprove.enabled,
      repo,
      maxPerDay: clampCount(self['maxPerDay'], base.selfImprove.maxPerDay, 0, CLOUD_BUDGET_LIMITS.maxSelfImprovePerDay),
      reserveUsd: clampMoney(self['reserveUsd'], base.selfImprove.reserveUsd),
    },
    updatedAt: typeof src['updatedAt'] === 'string' && Number.isFinite(Date.parse(src['updatedAt'])) ? src['updatedAt'] : base.updatedAt,
  };
}

export function readCloudBudget(): CloudBudgetV1 {
  const value = readJsonFile(cloudBudgetPath(), MAX_BUDGET_BYTES);
  // A file from a future schema is not ours to reinterpret: defaults, untouched on disk.
  if (!isRecord(value) || value['v'] !== CLOUD_BUDGET_SCHEMA_VERSION) return defaultBudget();
  return mergeBudget(defaultBudget(), value);
}

/** Validates + clamps (non-negative, sane maxima), persists, returns the result. */
export function updateCloudBudget(update: CloudBudgetUpdate): CloudBudgetV1 {
  const current = readCloudBudget();
  // `updatedAt` and `v` are never taken from the caller.
  const { updatedAt: _ignored, v: _version, ...fields } = (isRecord(update) ? update : {}) as Record<string, unknown>;
  const next = { ...mergeBudget(current, fields), updatedAt: new Date().toISOString() };
  ensureCloudDirectory();
  writePrivateFileAtomic(cloudBudgetPath(), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** `ct_<yyyymmdd>T<hhmm>_<6 base36>` from a UTC clock + crypto random. */
export function newCloudTaskId(now: Date): string {
  const stamp = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}T${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}`;
  let suffix = '';
  for (let i = 0; i < 6; i += 1) suffix += BASE36[randomInt(36)];
  return `ct_${stamp}_${suffix}`;
}
