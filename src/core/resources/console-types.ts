/** Browser-safe resource console contracts; no executables, credentials or task text. */
import type { ResourceAssignmentPlan, ResourceObservation, ResourceWorker } from './pool-policy.js';
import type { ResourceTaskReceipt } from './pool-runtime.js';
import type { ResourcePerformanceReport } from './performance.js';

export interface ResourceConsoleScope {
  schemaVersion: 1;
  mode: 'resource-pool';
  root: string;
  poolId: string;
  readOnly: boolean;
  workspace: string | null;
  maxParallel: number;
  maxQueued: number;
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

export interface ResourceConsoleSnapshot extends ResourceConsoleEvidence {
  supervisor: ResourceSupervisorSnapshot | null;
}

export interface ResourceConsoleOutput {
  id: string;
  text: string;
  truncated: boolean;
  retention: 'this-console-session';
}
