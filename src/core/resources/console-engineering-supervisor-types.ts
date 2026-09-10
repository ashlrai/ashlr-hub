/** Browser-safe finite-queue supervision metadata. Never effect or account authority. */
export interface ResourceConsoleEngineeringSupervisionConfig {
  schemaVersion: 1;
  id: string;
  maxDurationMs: number;
  pollIntervalMs: number;
  maxConcurrent: number;
  maxAttemptsPerEnrollment: number;
  enrollments: Array<{ enrollmentId: string; expectedEnrollmentDigest: string }>;
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
  /** Pause-control revision only; task progress does not invalidate a pause form. */
  revision: number;
  entries: Array<{ enrollmentId: string; enrollmentDigest: string;
    state: 'waiting' | 'running' | 'completed' | 'held' | 'stopped' | 'unavailable';
    reasons: ResourceConsoleEngineeringSupervisionReason[]; attempts: number }>;
}
