/** Bounded public selection over already validated joined console history. */
import { types } from 'node:util';
import { ResourceSupervisorError } from './console-state-codec.js';
import type { ResourceSupervisorJob, ResourceSupervisorJobWindow, ResourceSupervisorJobsCursor } from './console-types.js';

const MAX_VISIBLE = 256;
type Row = Pick<ResourceSupervisorJob, 'id' | 'enqueuedAt' | 'state'>;
const invalid = (): never => { throw new ResourceSupervisorError('INVALID_INPUT', 'Invalid resource task history query'); };
export function validateResourceConsoleJobId(value: unknown): string {
  // Comparing the entire match also rejects the final newline permitted by `$`.
  if (typeof value !== 'string' || value.match(/^[a-z0-9][a-z0-9_-]{0,63}$/)?.[0] !== value) invalid();
  return value as string;
}
function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) return invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function capturePageOptions(value: unknown): { before?: ResourceSupervisorJobsCursor; limit: number } {
  const options = record(value === undefined ? {} : value, ['before', 'limit']);
  const limit = Object.hasOwn(options, 'limit') ? options.limit : 64;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_VISIBLE) return invalid();
  if (!Object.hasOwn(options, 'before')) return { limit };
  const before = record(options.before, ['enqueuedAt', 'id']);
  const id = validateResourceConsoleJobId(before.id);
  const at = before.enqueuedAt;
  if (typeof at !== 'string' || at.length > 27 || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) return invalid();
  return { limit, before: { id, enqueuedAt: at } };
}
function compare(a: ResourceSupervisorJobsCursor, b: ResourceSupervisorJobsCursor): number {
  const left = Date.parse(a.enqueuedAt); const right = Date.parse(b.enqueuedAt);
  return left < right ? -1 : left > right ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
export function selectResourceConsoleJobView<T extends Row>(rows: readonly T[]): { jobs: T[]; jobWindow: ResourceSupervisorJobWindow } {
  const active = rows.filter(row => row.state === 'queued' || row.state === 'dispatching' || row.state === 'unresolved');
  // The validated hot store bounds nonterminal identities. Never silently hide one.
  if (active.length > MAX_VISIBLE) throw new ResourceSupervisorError('UNAVAILABLE', 'Resource task history unavailable');
  const terminal = rows.filter(row => row.state === 'settled' || row.state === 'cancelled').sort(compare);
  const slots = MAX_VISIBLE - active.length;
  const jobs = [...active, ...(slots ? terminal.slice(-slots) : [])].sort(compare);
  return { jobs, jobWindow: { totalJobs: rows.length, visibleJobs: jobs.length, omittedJobs: rows.length - jobs.length } };
}
export function selectResourceConsoleJobsPage<T extends Row>(rows: readonly T[], value?: unknown): {
  items: T[]; totalJobs: number; nextBefore: ResourceSupervisorJobsCursor | null;
} {
  const { before, limit } = capturePageOptions(value);
  const ordered = rows.filter(row => !before || compare(row, before) < 0).sort((a, b) => compare(b, a));
  const items = ordered.slice(0, limit);
  const last = items.at(-1);
  return { items, totalJobs: rows.length,
    nextBefore: ordered.length > items.length && last ? { enqueuedAt: last.enqueuedAt, id: last.id } : null };
}
