/** Small, historical telemetry only. Never an execution or journal capability. */
import type { EngineeringCoordinatorLifecycleReport } from './engineering-successor-coordinator-types.js';

type Pins = Pick<EngineeringCoordinatorLifecycleReport, 'supervisionId' | 'configDigest' | 'deadlineAt'>;
const keys = ['schemaVersion', 'supervisionId', 'configDigest', 'deadlineAt', 'sequence', 'reportedAt', 'state', 'reason'];
const reasons: Record<string, readonly (string | null)[]> = {
  idle: [null], running: [null], held: ['execution-guard-refused', 'signal-aborted'],
  'timed-out': ['deadline-reached'], closing: [null], closed: [null],
  faulted: ['coordinator-loop-failed', 'close-unresolved', 'ownership-release-failed'],
};
function iso(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export function readEngineeringCoordinatorObservation(value: unknown, pins?: Pins): EngineeringCoordinatorLifecycleReport | null {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) return null;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || typeof row.supervisionId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(row.supervisionId) ||
      typeof row.configDigest !== 'string' || !/^[a-f0-9]{64}$/.test(row.configDigest) || !iso(row.deadlineAt) || !iso(row.reportedAt) ||
      !Number.isSafeInteger(row.sequence) || Number(row.sequence) < 1 || typeof row.state !== 'string' ||
      !Object.hasOwn(reasons, row.state) || !reasons[row.state]!.includes(row.reason as string | null) ||
      pins && (row.supervisionId !== pins.supervisionId || row.configDigest !== pins.configDigest || row.deadlineAt !== pins.deadlineAt)) return null;
  return { ...row } as unknown as EngineeringCoordinatorLifecycleReport;
}
