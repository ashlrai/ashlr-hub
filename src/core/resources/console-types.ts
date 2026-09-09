/** Browser-safe resource console contracts; no executables, credentials or task text. */
import type { ResourceAssignmentPlan, ResourceObservation, ResourceWorker } from './pool-policy.js';
import type { ResourceTaskReceipt } from './pool-runtime.js';
import type { ResourcePerformanceReport } from './performance.js';
import type { ResourceQuotaRefreshSnapshot } from './quota-refresh.js';
import type { ResourceConnectionsSnapshot } from './connection-types.js';

export interface ResourceConsoleScope {
  schemaVersion: 1;
  mode: 'resource-pool';
  root: string;
  poolId: string;
  readOnly: boolean;
  workspace: string | null;
  maxParallel: number;
  maxQueued: number;
  /** Explicit no-generation metadata collection; independent of task-write capability. */
  quotaRefreshEnabled?: boolean;
  connectionsEnabled?: boolean;
  allocationWritable?: boolean;
}

export interface ResourceConsoleGroup {
  capacityKey: string;
  workerIds: string[];
  maxConcurrent: number;
  maxTasksPerWindow: number;
  taskWindowMs: number;
  occupiedSlots: number | null;
  reservedCount: number | null;
  uncertainCount: number | null;
  recentTaskCount: number | null;
}

export interface ResourceConsoleEvidence {
  schemaVersion: 1;
  mode: 'resource-pool';
  authority: 'local-evidence';
  sampledAt: string;
  sourceState: 'missing' | 'healthy' | 'degraded';
  reasons: string[];
  pool: { id: string; workers: Array<ResourceWorker & { capacityKey: string }> };
  groups: ResourceConsoleGroup[];
  plan: ResourceAssignmentPlan | null;
  observations: ResourceObservation[];
  activeAttempts: ResourceTaskReceipt[];
  recentAttempts: ResourceTaskReceipt[];
  counts: { total: number | null; active: number | null; completed: number | null;
    failed: number | null; cancelled: number | null; timedOut: number | null;
    uncertain: number | null; omittedHistory: number | null };
  usage: { reportedAttempts: number | null; unknownAttempts: number | null;
    reportedInputTokens: number | null; reportedOutputTokens: number | null;
    totalInputTokens: number | null; totalOutputTokens: number | null; complete: boolean };
  /** Absent on legacy projections; null means the source is unavailable. */
  performance?: ResourcePerformanceReport | null;
}

export interface ResourceConsoleTaskInput {
  id: string;
  prompt: string;
  allowedWorkerIds: string[];
  mode: 'read-only' | 'workspace-write';
  timeoutMs: number;
  maxOutputTokens: number;
}

export interface ResourceSupervisorJob {
  id: string;
  state: 'queued' | 'dispatching' | 'settled' | 'cancelled' | 'unresolved';
  enqueuedAt: string;
  updatedAt: string;
  allowedWorkerIds: string[];
  mode: 'read-only' | 'workspace-write';
  workerId: string | null;
  outcome: ResourceTaskReceipt['status'] | null;
  reason: string | null;
  cancellable: boolean;
  outputAvailable: boolean;
}

export interface ResourceSupervisorSnapshot {
  instanceId: string;
  paused: boolean;
  closing: boolean;
  error: string | null;
  maxParallel: number;
  maxQueued: number;
  activeCount: number;
  queuedCount: number;
  jobs: ResourceSupervisorJob[];
}

/** Fixed acquisition-time diagnosis only; never process identities or recovery authority. */
export const RESOURCE_COLLECTOR_RECOVERY_REASONS = [
  'legacy-owner-evidence-missing', 'boot-identity-unavailable', 'machine-identity-mismatch',
  'same-boot-owner-evidence-missing', 'owner-not-confirmed-absent', 'activity-evidence-unavailable',
  'legacy-active-work-unverifiable', 'command-registration-incomplete', 'process-group-not-confirmed-absent',
  'pending-evidence-unavailable', 'recovery-confirmation-failed',
] as const;
export interface ResourceCollectorRecoveryDiagnosis {
  reasonCode: typeof RESOURCE_COLLECTOR_RECOVERY_REASONS[number];
  markerVersion: 1 | 2 | 3 | 4 | null;
}
/** Versions supported by each diagnosis; prevents contradictory recovery advice. */
export const RESOURCE_COLLECTOR_RECOVERY_MARKER_VERSIONS = {
  'legacy-owner-evidence-missing': [1],
  'boot-identity-unavailable': [2, 3, 4],
  'machine-identity-mismatch': [2, 3, 4],
  'same-boot-owner-evidence-missing': [2],
  'owner-not-confirmed-absent': [3, 4],
  'activity-evidence-unavailable': [3, 4],
  'legacy-active-work-unverifiable': [3],
  'command-registration-incomplete': [4],
  'process-group-not-confirmed-absent': [4],
  // A wait budget may expire after parsing but before a more specific refusal.
  'pending-evidence-unavailable': [null, 2, 3, 4],
  'recovery-confirmation-failed': [2, 3, 4],
} satisfies Record<ResourceCollectorRecoveryDiagnosis['reasonCode'], readonly ResourceCollectorRecoveryDiagnosis['markerVersion'][]>;

export interface ResourceConsoleSnapshot extends ResourceConsoleEvidence {
  supervisor: ResourceSupervisorSnapshot | null;
  /** Local collector lifecycle, not a provider health or quota observation. */
  metadataCollector?: {
    state: 'running' | 'blocked';
    reasonCode: 'collector-running' | 'collector-owned' | 'reconciliation-required' | 'collector-unavailable';
    sampledAt: string;
    recovery?: ResourceCollectorRecoveryDiagnosis;
  };
  quotaRefresh?: ResourceQuotaRefreshSnapshot | null;
  connections?: ResourceConnectionsSnapshot | null;
  allocation?: { ceilingPercent: number | null; revision: number; updatedAt: string | null };
  workerAccess?: { pausedWorkerIds: string[]; revision: number; updatedAt: string | null };
}

export interface ResourceConsoleOutput {
  id: string;
  text: string;
  truncated: boolean;
  retention: 'this-console-session';
}
