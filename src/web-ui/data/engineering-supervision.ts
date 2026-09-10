import { ENGINEERING_SUPERVISION_REASONS, type ResourceConsoleEngineeringSupervisionSnapshot as Snapshot } from '../../core/resources/console-engineering-supervisor-types.js';
import { clearMutationToken, getMutationToken, touchMutationHold } from './auth-store.js';
import { ApiError, apiGet, apiPost } from './client.js';

const route = '/api/resources/engineering-supervision';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const id = (value: unknown) => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const invalid = () => new Error('Supervision evidence could not be verified. Refresh before changing automatic launches.');
export function decodeEngineeringSupervision(value: unknown): Snapshot {
  if (!object(value) || !exact(value, ['schemaVersion', 'configId', 'configDigest', 'sourceState', 'state', 'deadlineAt', 'paused', 'revision', 'entries']) ||
    value.schemaVersion !== 1 || !id(value.configId) || !hash(value.configDigest) ||
    typeof value.sourceState !== 'string' || !['healthy', 'degraded'].includes(value.sourceState) ||
    typeof value.state !== 'string' || !['idle', 'running', 'paused', 'completed', 'timed-out', 'closed', 'unavailable'].includes(value.state) ||
    typeof value.deadlineAt !== 'string' || !Number.isFinite(Date.parse(value.deadlineAt)) || new Date(value.deadlineAt).toISOString() !== value.deadlineAt ||
    typeof value.paused !== 'boolean' || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
    !Array.isArray(value.entries) || !value.entries.length || value.entries.length > 32) throw invalid();
  const known = new Set<string>();
  for (const row of value.entries) {
    if (!object(row) || !exact(row, ['enrollmentId', 'enrollmentDigest', 'state', 'reasons', 'attempts']) ||
      !id(row.enrollmentId) || known.has(String(row.enrollmentId)) || !hash(row.enrollmentDigest) ||
      typeof row.state !== 'string' || !['waiting', 'running', 'completed', 'held', 'stopped', 'unavailable'].includes(row.state) ||
      !Number.isSafeInteger(row.attempts) || Number(row.attempts) < 0 || Number(row.attempts) > 16 ||
      !Array.isArray(row.reasons) || row.reasons.length > ENGINEERING_SUPERVISION_REASONS.length ||
      row.reasons.some(reason => !ENGINEERING_SUPERVISION_REASONS.includes(reason)) || new Set(row.reasons).size !== row.reasons.length) throw invalid();
    known.add(String(row.enrollmentId));
  }
  if (value.sourceState === 'degraded' && value.state !== 'unavailable' ||
    value.state === 'paused' && value.paused !== true ||
    value.state === 'completed' && (value.sourceState !== 'healthy' || value.entries.some(row => (row as Snapshot['entries'][number]).state !== 'completed'))) throw invalid();
  return value as unknown as Snapshot;
}
export async function readEngineeringSupervision(signal?: AbortSignal): Promise<Snapshot> {
  const result = decodeEngineeringSupervision(await apiGet<unknown>(route, signal));
  if (signal?.aborted) throw new Error('Supervision read was cancelled.');
  return result;
}
export async function pauseEngineeringSupervision(current: Snapshot, paused: boolean, signal?: AbortSignal): Promise<Snapshot> {
  decodeEngineeringSupervision(current);
  const token = getMutationToken();
  if (!token) throw new Error('Unlock controls to change automatic launches.');
  try {
    const value = decodeEngineeringSupervision(await apiPost<unknown>(route, { paused, expectedRevision: current.revision }, token, signal));
    if (signal?.aborted || getMutationToken() !== token) throw new Error('Supervision response was interrupted. Refresh before acting again.');
    if (value.configId !== current.configId || value.configDigest !== current.configDigest || value.deadlineAt !== current.deadlineAt ||
      value.paused !== paused || value.revision !== current.revision + (current.paused === paused ? 0 : 1)) throw invalid();
    touchMutationHold(); return value;
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401 && getMutationToken() === token) clearMutationToken();
    throw cause;
  }
}
