/**
 * Devin lane persistence (3.15). Everything lives under `devinHome()` =
 * `<ashlr home>/devin` — the same home resolution and private-file helpers as
 * the cloud lane (cloud/store.ts): 0700 dirs, 0600 files written atomically
 * (O_EXCL temp, fchmod, fsync, rename), reads O_NOFOLLOW|O_NONBLOCK and
 * size-capped, readers total (a corrupt file is skipped or defaulted).
 *
 *   tasks/<id>.json    one DevinTaskV1 per task
 *   budget.json        DevinBudgetV1 (defaults when missing/corrupt)
 *   connection.json    DevinConnectionV1 — org id + principal; NEVER the key
 *
 * The API key is not stored here or anywhere on disk by Verse: see secret.ts.
 */
import { randomInt } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { ashlrHome, CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudTaskPr, CloudTaskReport } from '../cloud/types.js';
import { isPlaybookRef } from '../playbooks/types.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import {
  DEFAULT_DEVIN_BUDGET,
  DEVIN_BRANCH_PREFIX,
  DEVIN_BUDGET_SCHEMA_VERSION,
  DEVIN_CONNECTION_SCHEMA_VERSION,
  DEVIN_ORG_ID_PATTERN,
  DEVIN_TASK_ID_PATTERN,
  DEVIN_TASK_SCHEMA_VERSION,
  type DevinBudgetUpdate,
  type DevinBudgetV1,
  type DevinConnectionV1,
  type DevinFailureCode,
  type DevinSessionSnapshot,
  type DevinTaskOrigin,
  type DevinTaskState,
  type DevinTaskV1,
} from './types.js';

export const DEVIN_DIR = 'devin';
export const DEVIN_TASKS_DIR = 'tasks';
export const DEVIN_BUDGET_FILE = 'budget.json';
export const DEVIN_CONNECTION_FILE = 'connection.json';

const DEFAULT_LIST_LIMIT = 500;
const MAX_TASK_BYTES = 256 * 1024;
const MAX_SMALL_BYTES = 16 * 1024;

const TASK_STATES: readonly DevinTaskState[] = ['queued', 'launching', 'running', 'blocked', 'pr-open', 'merged', 'closed', 'failed', 'expired'];
const TASK_ORIGINS: readonly DevinTaskOrigin[] = ['chat', 'operator', 'cli', 'fleet'];
const FAILURE_CODES: readonly DevinFailureCode[] = [
  'not-enabled', 'not-connected', 'auth', 'forbidden', 'rate-limited', 'budget', 'invalid-request', 'server', 'network', 'unparsed', 'session-error', 'unknown',
];
const SESSION_STATUSES = ['new', 'claimed', 'running', 'exit', 'error', 'suspended', 'resuming'];
const REPORT_STATUSES: readonly CloudTaskReport['status'][] = ['done', 'partial', 'blocked', 'no-change'];
const PR_STATES: readonly CloudTaskPr['state'][] = ['open', 'closed', 'merged'];
const SHA1_HEX = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const PROPOSAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Budget bounds: they stop a typo (an extra zero, a negative), not the operator. */
export const DEVIN_BUDGET_LIMITS = Object.freeze({
  maxAcu: 100_000,
  maxAcuPerSession: 1_000,
  maxUsdPerAcu: 100,
  maxConcurrent: 10,
  maxSessionsPerDay: 200,
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function devinHome(): string {
  return join(ashlrHome(), DEVIN_DIR);
}

export function devinTasksDir(): string {
  return join(devinHome(), DEVIN_TASKS_DIR);
}

export function devinBudgetPath(): string {
  return join(devinHome(), DEVIN_BUDGET_FILE);
}

export function devinConnectionPath(): string {
  return join(devinHome(), DEVIN_CONNECTION_FILE);
}

export function ensureDevinDirectory(...sub: string[]): string {
  ensurePrivateDirectory(ashlrHome());
  let dir = devinHome();
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
// Validation
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const isIso = (value: unknown): boolean => isString(value) && Number.isFinite(Date.parse(value));

function isReport(value: unknown): value is CloudTaskReport {
  return isRecord(value)
    && REPORT_STATUSES.includes(value['status'] as CloudTaskReport['status'])
    && isString(value['summary'])
    && isStringArray(value['testsRun'])
    && isStringArray(value['risks'])
    && (value['filesChanged'] === undefined || (typeof value['filesChanged'] === 'number' && Number.isFinite(value['filesChanged'])));
}

function isPr(value: unknown, repo: string): value is CloudTaskPr {
  return isRecord(value)
    && Number.isSafeInteger(value['number']) && (value['number'] as number) >= 1
    && isString(value['url']) && value['url'].toLowerCase() === `https://github.com/${repo}/pull/${value['number']}`.toLowerCase()
    && PR_STATES.includes(value['state'] as CloudTaskPr['state'])
    && typeof value['draft'] === 'boolean'
    && isString(value['title']);
}

function isSession(value: unknown): value is DevinSessionSnapshot {
  return isRecord(value)
    && SESSION_STATUSES.includes(value['status'] as string)
    && isNullableString(value['statusDetail'])
    && (value['acusConsumed'] === null || (typeof value['acusConsumed'] === 'number' && Number.isFinite(value['acusConsumed']) && value['acusConsumed'] >= 0))
    && isStringArray(value['prUrls'])
    && isIso(value['readAt']);
}

function isPin(value: unknown, repo: string): boolean {
  return isRecord(value) && Number.isSafeInteger(value['number']) && (value['number'] as number) >= 1 && isString(value['url'])
    && value['url'].toLowerCase() === `https://github.com/${repo}/pull/${value['number']}`.toLowerCase();
}

function isSupersededBy(value: unknown, repo: string): boolean {
  return isRecord(value) && isString(value['repo']) && value['repo'].toLowerCase() === repo.toLowerCase()
    && Number.isSafeInteger(value['number']) && (value['number'] as number) >= 1;
}

function isIntakeMemo(value: unknown): boolean {
  if (!isRecord(value) || !isString(value['headSha']) || !SHA1_HEX.test(value['headSha']) || !isIso(value['at'])) return false;
  const { proposalId, diffHash, refused } = value;
  const filed = isString(proposalId) && PROPOSAL_ID.test(proposalId) && isString(diffHash) && SHA256_HEX.test(diffHash) && refused === null;
  const declined = proposalId === null && diffHash === null && isString(refused) && refused.length > 0 && refused.length <= 200;
  return filed || declined;
}

/** Structural check of a persisted task. Hand-edited or foreign files fail it and are skipped. */
export function isDevinTask(value: unknown): value is DevinTaskV1 {
  if (!isRecord(value)) return false;
  const id = value['id'];
  const repo = value['repo'];
  if (!isString(id) || !DEVIN_TASK_ID_PATTERN.test(id) || !isString(repo) || !CLOUD_REPO_PATTERN.test(repo)) return false;
  return value['v'] === DEVIN_TASK_SCHEMA_VERSION
    && isString(value['baseBranch'])
    && value['branch'] === `${DEVIN_BRANCH_PREFIX}${id}`
    && isString(value['title'])
    && isString(value['prompt'])
    && TASK_ORIGINS.includes(value['origin'] as DevinTaskOrigin)
    && (value['requestedBy'] === 'mason' || value['requestedBy'] === 'fleet')
    && isNullableString(value['sessionId'])
    && isNullableString(value['sessionUrl'])
    && TASK_STATES.includes(value['state'] as DevinTaskState)
    && isNullableString(value['stateReason'])
    && (value['failure'] === null || FAILURE_CODES.includes(value['failure'] as DevinFailureCode))
    && isIso(value['createdAt'])
    && isNullableString(value['launchedAt'])
    && isString(value['updatedAt'])
    && (value['session'] === null || isSession(value['session']))
    && Number.isSafeInteger(value['maxAcu']) && (value['maxAcu'] as number) >= 1
    && ['normal', 'fast', 'lite', 'ultra'].includes(value['devinMode'] as string)
    && (value['pr'] === null || isPr(value['pr'], repo))
    && (value['headSha'] === null || (isString(value['headSha']) && SHA1_HEX.test(value['headSha'])))
    && (value['report'] === null || isReport(value['report']))
    && (value['deliveryPin'] === undefined || isPin(value['deliveryPin'], repo))
    && (value['supersededBy'] === undefined || isSupersededBy(value['supersededBy'], repo))
    && (value['intake'] === undefined || isIntakeMemo(value['intake']))
    && (value['playbookRef'] === undefined || isPlaybookRef(value['playbookRef']))
    && isNullableString(value['backlogItemId'])
    && (value['messagesSent'] === undefined || (Number.isSafeInteger(value['messagesSent']) && (value['messagesSent'] as number) >= 0));
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

function taskPath(id: string): string {
  return join(devinTasksDir(), `${id}.json`);
}

/** Newest first (by createdAt), corrupt files skipped, at most `limit`. */
export function listDevinTasks(limit: number = DEFAULT_LIST_LIMIT): DevinTaskV1[] {
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_LIST_LIMIT;
  let names: string[];
  try {
    names = readdirSync(devinTasksDir());
  } catch {
    return [];
  }
  const tasks: DevinTaskV1[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!DEVIN_TASK_ID_PATTERN.test(id)) continue;
    const task = readDevinTask(id);
    if (task) tasks.push(task);
  }
  tasks.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
  return tasks.slice(0, cap);
}

export function readDevinTask(id: string): DevinTaskV1 | null {
  if (typeof id !== 'string' || !DEVIN_TASK_ID_PATTERN.test(id)) return null;
  const value = readJsonFile(taskPath(id), MAX_TASK_BYTES);
  return isDevinTask(value) && value.id === id ? value : null;
}

/** Atomic write; sets updatedAt on the record and (unless frozen) on the caller's object. */
export function writeDevinTask(task: DevinTaskV1): void {
  if (!task || typeof task.id !== 'string' || !DEVIN_TASK_ID_PATTERN.test(task.id)) {
    throw new Error('devin lane: refusing to write a task with an invalid id');
  }
  const updatedAt = new Date().toISOString();
  const record: DevinTaskV1 = { ...task, updatedAt };
  if (!isDevinTask(record)) throw new Error('devin lane: refusing to write a malformed task');
  ensureDevinDirectory(DEVIN_TASKS_DIR);
  writePrivateFileAtomic(taskPath(task.id), `${JSON.stringify(record, null, 2)}\n`);
  if (!Object.isFrozen(task)) task.updatedAt = updatedAt;
}

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** `dv_<yyyymmdd>T<hhmm>_<6 base36>` from a UTC clock + crypto random. */
export function newDevinTaskId(now: Date): string {
  const stamp = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}T${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}`;
  let suffix = '';
  for (let i = 0; i < 6; i += 1) suffix += BASE36[randomInt(36)];
  return `dv_${stamp}_${suffix}`;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

const round2 = (value: number): number => Math.round(value * 100) / 100;

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return round2(Math.min(max, Math.max(min, value)));
}

function clampCount(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function defaultBudget(): DevinBudgetV1 {
  return { ...DEFAULT_DEVIN_BUDGET, updatedAt: new Date(0).toISOString() };
}

/** Field-by-field merge; a wrong-typed field keeps the base value, a number out of range is clamped. */
function mergeBudget(base: DevinBudgetV1, input: unknown): DevinBudgetV1 {
  const src = isRecord(input) ? input : {};
  const L = DEVIN_BUDGET_LIMITS;
  return {
    v: DEVIN_BUDGET_SCHEMA_VERSION,
    acuBudgetTotal: clampNumber(src['acuBudgetTotal'], base.acuBudgetTotal, 0, L.maxAcu),
    acuSpentAdjustment: clampNumber(src['acuSpentAdjustment'], base.acuSpentAdjustment, 0, L.maxAcu),
    usdPerAcu: clampNumber(src['usdPerAcu'], base.usdPerAcu, 0, L.maxUsdPerAcu),
    // Whole ACUs: the API's max_acu_limit is an integer > 0.
    maxAcuPerSession: clampCount(src['maxAcuPerSession'], base.maxAcuPerSession, 1, L.maxAcuPerSession),
    maxAcuPerDay: clampNumber(src['maxAcuPerDay'], base.maxAcuPerDay, 0, L.maxAcu),
    reserveAcu: clampNumber(src['reserveAcu'], base.reserveAcu, 0, L.maxAcu),
    // Below one half the lane would pause almost immediately; above 1 it would never pause.
    pauseAtFraction: clampNumber(src['pauseAtFraction'], base.pauseAtFraction, 0.5, 1),
    maxConcurrent: clampCount(src['maxConcurrent'], base.maxConcurrent, 1, L.maxConcurrent),
    maxSessionsPerDay: clampCount(src['maxSessionsPerDay'], base.maxSessionsPerDay, 0, L.maxSessionsPerDay),
    // 0 is a valid choice for both: "the fleet launches no Devin sessions".
    fleetMaxConcurrent: clampCount(src['fleetMaxConcurrent'], base.fleetMaxConcurrent, 0, L.maxConcurrent),
    fleetMaxSessionsPerDay: clampCount(src['fleetMaxSessionsPerDay'], base.fleetMaxSessionsPerDay, 0, L.maxSessionsPerDay),
    updatedAt: isIso(src['updatedAt']) ? (src['updatedAt'] as string) : base.updatedAt,
  };
}

export function readDevinBudget(): DevinBudgetV1 {
  const value = readJsonFile(devinBudgetPath(), MAX_SMALL_BYTES);
  if (!isRecord(value) || value['v'] !== DEVIN_BUDGET_SCHEMA_VERSION) return defaultBudget();
  return mergeBudget(defaultBudget(), value);
}

export function updateDevinBudget(update: DevinBudgetUpdate): DevinBudgetV1 {
  const current = readDevinBudget();
  const { updatedAt: _ignored, v: _version, ...fields } = (isRecord(update) ? update : {}) as Record<string, unknown>;
  const next = { ...mergeBudget(current, fields), updatedAt: new Date().toISOString() };
  ensureDevinDirectory();
  writePrivateFileAtomic(devinBudgetPath(), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// ---------------------------------------------------------------------------
// Connection (non-secret)
// ---------------------------------------------------------------------------

export function isDevinConnection(value: unknown): value is DevinConnectionV1 {
  return isRecord(value)
    && value['v'] === DEVIN_CONNECTION_SCHEMA_VERSION
    && isString(value['orgId']) && DEVIN_ORG_ID_PATTERN.test(value['orgId'])
    && ['service_user', 'pat_user', 'other'].includes(value['principal'] as string)
    && isNullableString(value['principalName'])
    && (value['keyStore'] === 'custody' || value['keyStore'] === 'keychain')
    && isIso(value['connectedAt'])
    && isIso(value['updatedAt']);
}

export function readDevinConnection(): DevinConnectionV1 | null {
  const value = readJsonFile(devinConnectionPath(), MAX_SMALL_BYTES);
  return isDevinConnection(value) ? value : null;
}

export function writeDevinConnection(connection: Omit<DevinConnectionV1, 'v' | 'updatedAt'>): DevinConnectionV1 {
  const record: DevinConnectionV1 = { v: DEVIN_CONNECTION_SCHEMA_VERSION, ...connection, updatedAt: new Date().toISOString() };
  if (!isDevinConnection(record)) throw new Error('devin lane: refusing to write a malformed connection');
  ensureDevinDirectory();
  writePrivateFileAtomic(devinConnectionPath(), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function clearDevinConnection(): void {
  try {
    rmSync(devinConnectionPath(), { force: true });
  } catch { /* already gone */ }
}
