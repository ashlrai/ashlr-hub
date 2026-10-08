/** Browser-safe finite-queue supervision metadata. Never effect or account authority. */
export interface ResourceConsoleEngineeringSupervisionConfig {
  schemaVersion: 1;
  id: string;
  maxDurationMs: number;
  pollIntervalMs: number;
  maxConcurrent: number;
  maxAttemptsPerEnrollment: number;
  /** Explicit lifetime enrollment cap. Absent keeps the original fixed queue. */
  maxEnrollments?: number;
  /** Host policy for the preparation caller; does not add another execution path. */
  autoAdmitPrepared?: true;
  enrollments: Array<{ enrollmentId: string; expectedEnrollmentDigest: string }>;
}

export interface ResourceConsoleEngineeringSupervisionAdmission {
  enrollments: Array<{ enrollmentId: string; expectedEnrollmentDigest: string }>;
  expectedRevision: number;
}

export const ENGINEERING_SUPERVISION_REASONS = [
  'not-started', 'waiting-for-readiness', 'supervisor-paused', 'running', 'completed',
  'cancelled', 'deadline-exhausted', 'unchanged-evidence', 'attempt-limit',
  'evidence-unavailable', 'launch-unavailable', 'supervisor-closed',
] as const;
export type ResourceConsoleEngineeringSupervisionReason = typeof ENGINEERING_SUPERVISION_REASONS[number];
export interface ResourceConsoleEngineeringSupervisionSnapshot {
  schemaVersion: 1;
  configId: string;
  configDigest: string;
  sourceState: 'healthy' | 'degraded';
  state: 'idle' | 'running' | 'paused' | 'completed' | 'timed-out' | 'closed' | 'unavailable';
  deadlineAt: string;
  paused: boolean;
  /** Shared pause/admission revision; task progress does not invalidate controls. */
  revision: number;
  admission?: { maxEnrollments: number; remainingEnrollments: number; autoAdmitPrepared: boolean };
  entries: Array<{ enrollmentId: string; enrollmentDigest: string;
    state: 'waiting' | 'running' | 'completed' | 'held' | 'stopped' | 'unavailable';
    reasons: ResourceConsoleEngineeringSupervisionReason[]; attempts: number }>;
}

/** Shared pure snapshot decoder; browser mutation adapters retain their own controls. */
type Snapshot = ResourceConsoleEngineeringSupervisionSnapshot;
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
