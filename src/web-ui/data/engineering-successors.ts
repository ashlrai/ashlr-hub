import type { ResourceEngineeringSuccessorCoordinatorSnapshot as Snapshot } from '../../core/resources/engineering-successor-coordinator-types.js';
import { apiGet } from './client.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.values(Object.getOwnPropertyDescriptors(value)).every(row => Object.hasOwn(row, 'value'));
const exact = (value: Record<string, unknown>, keys: string[]) => Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const iso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const states = ['idle', 'running', 'closed', 'timed-out', 'unavailable'];
const entryStates = ['proposing', 'waiting-for-capacity', 'preparing', 'admitting', 'held', 'proposed', 'prepared', 'admitted', 'stopped'];
const recordedStates = ['intent-recorded', 'proposed', 'prepared', 'admitted', 'stopped'];
export const engineeringSuccessorReasons: Record<string, string> = {
  'proposal-output-unresolved': 'The proposal output is unresolved. This identity will not automatically request another response.',
  'source-or-authority-unavailable': 'The verified source or execution authority is unavailable. No further work is authorized by this status.',
  'proposal-capacity-unavailable': 'The bounded proposal capacity wait could not proceed.',
  'successor-evidence-unavailable': 'Successor evidence could not be verified. Inspect the retained local evidence before further action.',
};
const invalid = () => new Error('Successor status could not be verified. Refresh status before relying on it.');

/** Metadata only: no proposal text, source content or execution authority is accepted. */
export function decodeEngineeringSuccessors(value: unknown): Snapshot {
  if (!object(value)) throw invalid();
  const journal = Object.hasOwn(value, 'observation');
  if (!exact(value, ['schemaVersion', 'supervisionId', 'profileId', 'configDigest', 'deadlineAt', 'state', 'maxSuccessors', 'entries', ...(journal ? ['observation'] : [])]) ||
    value.schemaVersion !== 1 || !id(value.supervisionId) || !id(value.profileId) || !hash(value.configDigest) ||
    !iso(value.deadlineAt) || typeof value.state !== 'string' || !(journal ? [...states, 'observing'] : states).includes(value.state) || !Number.isSafeInteger(value.maxSuccessors) ||
    Number(value.maxSuccessors) < 1 || Number(value.maxSuccessors) > 32 || !Array.isArray(value.entries) || value.entries.length > Number(value.maxSuccessors)) throw invalid();
  if (journal) {
    const observation = value.observation;
    if (!object(observation) || !exact(observation, ['kind', 'sampledAt', 'recordsDigest', 'workerState']) ||
      observation.kind !== 'durable-journal' || !iso(observation.sampledAt) || !hash(observation.recordsDigest) ||
      typeof observation.workerState !== 'string' || !['connected', 'closing', 'exited', 'faulted'].includes(observation.workerState)) throw invalid();
    const expected = observation.workerState === 'faulted' || observation.workerState === 'exited' ? 'unavailable' :
      observation.workerState === 'closing' ? 'closed' : Date.parse(observation.sampledAt) >= Date.parse(value.deadlineAt) ? 'timed-out' : 'observing';
    if (value.state !== expected) throw invalid();
  }
  const sources = new Set<string>(), tasks = new Set<string>(), successors = new Set<string>();
  for (const row of value.entries) {
    if (!object(row) || !exact(row, ['sourceEnrollmentId', 'proposalTaskId', 'successorId', 'state', 'reason']) || !id(row.sourceEnrollmentId) ||
      typeof row.proposalTaskId !== 'string' || !/^proposal-[a-f0-9]{48}$/.test(row.proposalTaskId) ||
      typeof row.successorId !== 'string' || row.successorId !== `successor-${row.proposalTaskId.slice('proposal-'.length)}` ||
      typeof row.state !== 'string' || !(journal ? recordedStates : entryStates).includes(row.state) ||
      !(row.reason === null || !journal && typeof row.reason === 'string' && Object.hasOwn(engineeringSuccessorReasons, row.reason)) ||
      sources.has(row.sourceEnrollmentId) || tasks.has(row.proposalTaskId) || successors.has(row.successorId)) throw invalid();
    sources.add(row.sourceEnrollmentId); tasks.add(row.proposalTaskId); successors.add(row.successorId);
  }
  return value as unknown as Snapshot;
}

/** A single authenticated read; polling and session lifetime belong to the caller. */
export async function readEngineeringSuccessors(signal?: AbortSignal): Promise<Snapshot> {
  try {
    if (signal?.aborted) throw invalid();
    const value = await apiGet<unknown>('/api/resources/engineering-successors', signal);
    if (signal?.aborted) throw invalid();
    return decodeEngineeringSuccessors(value);
  } catch { throw invalid(); }
}
