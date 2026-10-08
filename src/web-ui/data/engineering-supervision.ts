import { decodeEngineeringSupervision, type ResourceConsoleEngineeringSupervisionSnapshot as Snapshot } from '../../core/resources/console-engineering-supervisor-types.js';
import { clearMutationToken, getMutationToken, touchMutationHold } from './auth-store.js';
import { ApiError, apiGet, apiPost } from './client.js';

const route = '/api/resources/engineering-supervision';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const id = (value: unknown) => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const invalid = () => new Error('Supervision evidence could not be verified. Refresh before changing automatic launches.');
export { decodeEngineeringSupervision } from '../../core/resources/console-engineering-supervisor-types.js';

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
