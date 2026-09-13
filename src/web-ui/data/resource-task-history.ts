import type { ResourceSupervisorJob, ResourceSupervisorSnapshot, ResourceSupervisorJobsCursor, ResourceSupervisorJobsPage } from '../../core/resources/console-types.js';
import { apiGet } from './client.js';

const id = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const time = (value: unknown): value is string => typeof value === 'string' && value.length <= 27 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).every(key => typeof key === 'string' && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function exact(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
const text = (value: unknown) => typeof value === 'string' && value.length <= 256 && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159);
function job(value: unknown): value is ResourceSupervisorJob {
  if (!object(value) || !exact(value, ['id', 'state', 'enqueuedAt', 'updatedAt', 'allowedWorkerIds', 'mode', 'workerId', 'outcome', 'reason', 'cancellable', 'outputAvailable',
    ...['historyAvailable', 'parent', 'projectId'].filter(key => Object.hasOwn(value, key))])) return false;
  return id(value.id) && ['queued', 'dispatching', 'settled', 'cancelled', 'unresolved'].includes(String(value.state)) &&
    time(value.enqueuedAt) && time(value.updatedAt) && Date.parse(value.updatedAt) >= Date.parse(value.enqueuedAt) &&
    Array.isArray(value.allowedWorkerIds) && value.allowedWorkerIds.length > 0 && value.allowedWorkerIds.length <= 32 &&
    Object.keys(value.allowedWorkerIds).length === value.allowedWorkerIds.length && value.allowedWorkerIds.every(id) &&
    new Set(value.allowedWorkerIds).size === value.allowedWorkerIds.length && ['read-only', 'workspace-write'].includes(String(value.mode)) &&
    (value.workerId === null || id(value.workerId) && value.allowedWorkerIds.includes(value.workerId)) &&
    (value.outcome === null || ['reserved', 'completed', 'failed', 'timed-out', 'cancelled', 'uncertain'].includes(String(value.outcome))) &&
    (value.reason === null || text(value.reason)) && typeof value.cancellable === 'boolean' && typeof value.outputAvailable === 'boolean' &&
    (!Object.hasOwn(value, 'historyAvailable') || value.historyAvailable === true) &&
    (!Object.hasOwn(value, 'projectId') || id(value.projectId)) &&
    (!Object.hasOwn(value, 'parent') || object(value.parent) && exact(value.parent, ['taskId', 'expectedTranscriptDigest']) &&
      id(value.parent.taskId) && value.parent.taskId !== value.id && typeof value.parent.expectedTranscriptDigest === 'string' && value.parent.expectedTranscriptDigest.length === 64 && /^[a-f0-9]{64}$/.test(value.parent.expectedTranscriptDigest));
}
export function validResourceJobWindow(value: unknown, visible?: number): boolean {
  return object(value) && exact(value, ['totalJobs', 'visibleJobs', 'omittedJobs']) &&
    count(value.totalJobs) && count(value.visibleJobs) && count(value.omittedJobs) &&
    value.visibleJobs <= 256 && value.totalJobs === value.visibleJobs + value.omittedJobs &&
    (visible === undefined || value.visibleJobs === visible);
}
const cursor = (value: unknown): value is ResourceSupervisorJobsCursor => object(value) && exact(value, ['enqueuedAt', 'id']) && time(value.enqueuedAt) && id(value.id);
const older = (left: ResourceSupervisorJobsCursor, right: ResourceSupervisorJobsCursor) => Date.parse(left.enqueuedAt) < Date.parse(right.enqueuedAt) || left.enqueuedAt === right.enqueuedAt && left.id < right.id;
const invalid = () => new Error('Task history could not be verified. Refresh or try again.');

/** Metadata only. No prompt/output text or mutation token enters these queries. */
export async function readResourceTasksPage(options: { before?: ResourceSupervisorJobsCursor; limit?: number } = {}, signal?: AbortSignal): Promise<ResourceSupervisorJobsPage> {
  if (!object(options) || !exact(options, ['before', 'limit'].filter(key => Object.hasOwn(options, key))) ||
    options.before !== undefined && !cursor(options.before) || options.limit !== undefined && (!count(options.limit) || options.limit < 1 || options.limit > 256)) throw invalid();
  const limit = options.limit ?? 64;
  const before = options.before ? { enqueuedAt: options.before.enqueuedAt, id: options.before.id } : undefined;
  const query = new URLSearchParams({ limit: String(limit) });
  if (before) { query.set('before', before.enqueuedAt); query.set('beforeId', before.id); }
  try {
    const value = await apiGet<unknown>(`/api/resources/tasks?${query}`, signal); signal?.throwIfAborted();
    if (!object(value) || !exact(value, ['items', 'totalJobs', 'nextBefore']) || !Array.isArray(value.items) ||
      value.items.length > limit || Object.keys(value.items).length !== value.items.length || !value.items.every(job) ||
      !count(value.totalJobs) || value.totalJobs < value.items.length || new Set(value.items.map(row => row.id)).size !== value.items.length ||
      value.items.some((row, index, rows) => index > 0 && !older(row, rows[index - 1]!) || before && !older(row, before)) ||
      value.nextBefore !== null && (!cursor(value.nextBefore) || value.items.length === 0 ||
        value.nextBefore.id !== value.items.at(-1)!.id || value.nextBefore.enqueuedAt !== value.items.at(-1)!.enqueuedAt)) throw invalid();
    return value as unknown as ResourceSupervisorJobsPage;
  } catch { signal?.throwIfAborted(); throw invalid(); }
}
export async function readResourceTaskStatus(taskId: string, instanceId: string, signal?: AbortSignal): Promise<ResourceSupervisorJob> {
  if (!id(taskId) || !text(instanceId) || !instanceId) throw invalid();
  try {
    const value = await apiGet<unknown>(`/api/resources/tasks/${encodeURIComponent(taskId)}`, signal); signal?.throwIfAborted();
    if (!object(value) || !exact(value, ['supervisor', 'job']) || !job(value.job) || value.job.id !== taskId || !object(value.supervisor)) throw invalid();
    const status = value.supervisor;
    if (!exact(status, ['instanceId', 'paused', 'closing', 'error', 'maxParallel', 'maxQueued', 'activeCount', 'queuedCount',
      ...(Object.hasOwn(status, 'jobWindow') ? ['jobWindow'] : [])]) || status.instanceId !== instanceId ||
      typeof status.paused !== 'boolean' || status.closing !== false || status.error !== null ||
      !count(status.maxParallel) || status.maxParallel < 1 || status.maxParallel > 32 || !count(status.maxQueued) || status.maxQueued < 1 || status.maxQueued > 64 ||
      !count(status.activeCount) || !count(status.queuedCount) || Object.hasOwn(status, 'jobWindow') && !validResourceJobWindow(status.jobWindow)) throw invalid();
    return value.job;
  } catch { signal?.throwIfAborted(); throw invalid(); }
}

export function resourceJobWindow(status: ResourceSupervisorSnapshot | null | undefined) {
  return status?.jobWindow;
}
