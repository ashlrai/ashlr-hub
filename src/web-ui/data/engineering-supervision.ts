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
  if (!object(value) || !exact(value, ['schemaVersion', 'configId', 'configDigest', 'sourceState', 'state', 'deadlineAt', 'paused', 'revision', 'entries',
    ...(Object.hasOwn(value, 'admission') ? ['admission'] : [])]) ||
    value.schemaVersion !== 1 || !id(value.configId) || !hash(value.configDigest) ||
    typeof value.sourceState !== 'string' || !['healthy', 'degraded'].includes(value.sourceState) ||
    typeof value.state !== 'string' || !['idle', 'running', 'paused', 'completed', 'timed-out', 'closed', 'unavailable'].includes(value.state) ||
    typeof value.deadlineAt !== 'string' || !Number.isFinite(Date.parse(value.deadlineAt)) || new Date(value.deadlineAt).toISOString() !== value.deadlineAt ||
    typeof value.paused !== 'boolean' || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
    !Array.isArray(value.entries) || value.entries.length > 32) throw invalid();
  if (Object.hasOwn(value, 'admission')) {
    const admission = value.admission;
    if (!object(admission) || !exact(admission, ['maxEnrollments', 'remainingEnrollments', 'autoAdmitPrepared']) || typeof admission.autoAdmitPrepared !== 'boolean' ||
      !Number.isSafeInteger(admission.maxEnrollments) || Number(admission.maxEnrollments) < 1 || Number(admission.maxEnrollments) > 32 ||
      !Number.isSafeInteger(admission.remainingEnrollments) || Number(admission.remainingEnrollments) < 0 ||
      Number(admission.remainingEnrollments) !== Number(admission.maxEnrollments) - value.entries.length) throw invalid();
  } else if (!value.entries.length) throw invalid();
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

export async function admitEngineeringSupervision(current: Snapshot,
  enrollments: Array<{ enrollmentId: string; expectedEnrollmentDigest: string }>, signal?: AbortSignal): Promise<Snapshot> {
  decodeEngineeringSupervision(current);
  if (!current.admission || current.sourceState !== 'healthy' || ['closed', 'unavailable', 'timed-out'].includes(current.state) ||
    !Array.isArray(enrollments) || enrollments.length < 1 || enrollments.length > 32 ||
    enrollments.some(row => !object(row) || !exact(row, ['enrollmentId', 'expectedEnrollmentDigest']) || !id(row.enrollmentId) || !hash(row.expectedEnrollmentDigest)) ||
    new Set(enrollments.map(row => row.enrollmentId)).size !== enrollments.length) throw invalid();
  const additions = enrollments.filter(row => !current.entries.some(entry => entry.enrollmentId === row.enrollmentId));
  if (additions.length > current.admission.remainingEnrollments || additions.length > 0 && Date.now() >= Date.parse(current.deadlineAt) ||
    enrollments.some(row => current.entries.some(entry => entry.enrollmentId === row.enrollmentId && entry.enrollmentDigest !== row.expectedEnrollmentDigest))) throw invalid();
  const token = getMutationToken();
  if (!token) throw new Error('Unlock controls to add a plan to automatic work.');
  try {
    const value = decodeEngineeringSupervision(await apiPost<unknown>(`${route}/admit`, { enrollments, expectedRevision: current.revision }, token, signal));
    if (signal?.aborted || getMutationToken() !== token) throw invalid();
    if (value.configId !== current.configId || value.configDigest !== current.configDigest || value.deadlineAt !== current.deadlineAt ||
      value.paused !== current.paused || !value.admission || value.admission.maxEnrollments !== current.admission.maxEnrollments || value.admission.autoAdmitPrepared !== current.admission.autoAdmitPrepared ||
      value.revision !== current.revision + (additions.length ? 1 : 0) || value.entries.length !== current.entries.length + additions.length ||
      current.entries.some((entry, index) => value.entries[index]?.enrollmentId !== entry.enrollmentId || value.entries[index]?.enrollmentDigest !== entry.enrollmentDigest) ||
      enrollments.some(row => !value.entries.some(entry => entry.enrollmentId === row.enrollmentId && entry.enrollmentDigest === row.expectedEnrollmentDigest))) throw invalid();
    touchMutationHold(); return value;
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401 && getMutationToken() === token) clearMutationToken();
    throw new Error('Automatic-work admission was not confirmed. Refresh supervision before acting again; the plan may already have been added.');
  }
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
