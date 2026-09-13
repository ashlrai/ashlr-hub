import type { ResourceConsoleEngineeringEnrollment } from './console-engineering-types.js';
import type { ResourceConsoleEngineeringSupervisionSnapshot } from './console-engineering-supervisor-types.js';
import type { ResourceBinding } from './worker.js';
import type { ResourceObservation, ResourcePool } from './pool-policy.js';

/** Host-verified summary only. Model output never supplies delivery authority. */
export interface ResourceEngineeringSuccessorEvidence {
  enrollmentId: string; enrollmentDigest: string; projectId: string;
  deliveryDigest: string; commit: string; objective: string;
  /** Bounded verified profile/evaluation/delivered-file context; no volatile samples. */
  context: string;
}
export interface ResourceEngineeringSuccessorCoordinatorConfig {
  schemaVersion: 1; supervisionId: string; profileId: string; allowedWorkerIds: string[];
  maxOutputTokens: number; proposalTimeoutMs: number; maxSuccessors: number; pollIntervalMs: number;
}
/** Last reported process-local transition, not current health or journal authority. */
export interface EngineeringCoordinatorLifecycleReport {
  schemaVersion: 1; supervisionId: string; configDigest: string; deadlineAt: string;
  sequence: number; reportedAt: string;
  state: 'idle' | 'running' | 'waiting' | 'held' | 'timed-out' | 'closing' | 'closed' | 'faulted';
  reason: null | 'execution-guard-refused' | 'signal-aborted' | 'deadline-reached' | 'coordinator-loop-failed'
    | 'close-unresolved' | 'ownership-release-failed' | 'proposal-workers-ineligible' | 'proposal-admission-unavailable';
}
export interface ResourceEngineeringSuccessorCoordinatorOptions {
  root: string; config: ResourceEngineeringSuccessorCoordinatorConfig; pool: ResourcePool; bindings: ResourceBinding[]; cwd: string;
  supervision: {
    snapshot(): ResourceConsoleEngineeringSupervisionSnapshot;
    admit(input: { enrollments: Array<{ enrollmentId: string; expectedEnrollmentDigest: string }>; expectedRevision: number }): ResourceConsoleEngineeringSupervisionSnapshot;
  };
  readAdmissionEvidence(): { observations: ResourceObservation[]; unavailableWorkerIds: string[]; quotaUnavailableWorkerIds?: string[] };
  host: {
    source(enrollmentId: string, expectedEnrollmentDigest: string): ResourceEngineeringSuccessorEvidence | null;
    prepare(input: { id: string; name: string; objective: string; profileId: string; source: ResourceEngineeringSuccessorEvidence }): Promise<ResourceConsoleEngineeringEnrollment>;
    /** Synchronous, cheap and pool-read-free: KILL/config/project/closing veto. */
    isExecutionStopped(): boolean;
  };
  signal?: AbortSignal;
  onLifecycle?(report: EngineeringCoordinatorLifecycleReport): void;
}
export type ResourceEngineeringSuccessorProposal = { action: 'stop' } | { action: 'propose'; name: string; objective: string };
export interface ResourceEngineeringSuccessorCoordinatorSnapshot {
  schemaVersion: 1; supervisionId: string; profileId: string; configDigest: string; deadlineAt: string;
  state: 'observing' | 'idle' | 'running' | 'closed' | 'timed-out' | 'unavailable'; maxSuccessors: number;
  observation?: { kind: 'durable-journal'; sampledAt: string; recordsDigest: string; workerState: 'connected' | 'closing' | 'exited' | 'faulted';
    coordinator?: EngineeringCoordinatorLifecycleReport | null };
  entries: Array<{ sourceEnrollmentId: string; proposalTaskId: string; successorId: string;
    state: 'intent-recorded' | 'proposing' | 'waiting-for-capacity' | 'preparing' | 'admitting' | 'held' | 'proposed' | 'prepared' | 'admitted' | 'stopped'; reason: string | null }>;
}
