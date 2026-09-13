/** Browser-safe resource console contracts; no executables, credentials or task text. */
import type { ResourceAssignmentPlan, ResourceObservation, ResourceWorker } from './pool-policy.js';
import type { ResourceTaskReceipt } from './pool-runtime.js';
import type { ResourcePerformanceReport } from './performance.js';
import type { ResourceQuotaRefreshSnapshot } from './quota-refresh.js';
import type { ResourceConnectionsSnapshot } from './connection-types.js';
import type { ResourceQuotaScopeAccess } from './quota-scope-access.js';

export interface ResourceConsoleScope {
  engineeringMissionSupported?: boolean;
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
  /** Explicit capability to retain opt-in task text in the private local store. */
  historySupported?: boolean;
  followUpSupported?: boolean;
  projects?: ResourceConsoleProject[];
  defaultProjectId?: 'default';
  /** Control-unlocked, project-pinned local file inspection; never read-session authority. */
  workspaceFilesSupported?: true;
  /** Explicit host-enrolled evaluated engineering; separate from ordinary task completion. */
  engineeringSupported?: true;
  /** Current console lifetime only; closing engineering does not close human tasks. */
  engineeringLifecycle?: 'running' | 'stopping' | 'closed' | 'held';
  /** Host-managed attachment discovery; never browser attachment authority. */
  engineeringAttachmentSupported?: true;
  /** Read-only identity of the current component; not the host capability object. */
  engineeringAttachmentId?: string;
  /** Read-only evaluation and shared-ledger attribution; never routing authority. */
  engineeringOutcomesSupported?: true;
  /** Host-pinned objective preparation and durable same-console enrollment. */
  engineeringPreparationSupported?: true;
  /** Host policy automatically admits prepared plans to the existing bounded queue. */
  engineeringPreparationAutoAdmission?: true;
  /** Explicit automatic queue in this console lifetime; not an OS service. */
  engineeringSupervisionSupported?: true;
  /** Metadata-only observation of host-configured successor planning. */
  engineeringSuccessorsSupported?: true;
}

export interface ResourceConsoleProjectInput { id: string; label: string; workspace: string }
export interface ResourceConsoleProject extends ResourceConsoleProjectInput { enabled: boolean }

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
  /** Present only for a verified evolved ledger. Digests, never private binding locators. */
  configurationDigests?: string[];
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
  /** Consent is immutable for this task ID; omission and false are equivalent. */
  retainHistory?: boolean;
  parent?: ResourceConsoleParent;
  projectId?: string;
}

export interface ResourceConsoleParent { taskId: string; expectedTranscriptDigest: string }
export interface ResourceConsoleContextTurn {
  taskId: string;
  prompt: string;
  output: { text: string; truncated: boolean } | null;
  outcome: ResourceTaskReceipt['status'] | null;
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
  historyAvailable?: true;
  parent?: ResourceConsoleParent;
  projectId?: string;
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
/** Sampled local marker facts only; no ownership, process or recovery assessment. */
export interface ResourceCollectorInspection {
  scope: 'local-record-inspection';
  sampledAt: string;
  state: 'absent' | 'pending' | 'unavailable';
  markerVersion: 1 | 2 | 3 | 4 | null;
  reasonCode: 'no-pending-record' | 'legacy-owner-evidence-missing' | 'recovery-not-evaluated' | 'pending-evidence-unavailable';
  recoveryAttempted: false;
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
  /** Read-only global stop observation. Missing legacy evidence is not inactive. */
  executionStop?: { state: 'active' | 'inactive' | 'unknown'; sampledAt: string };
  /** Independent read-only local record inspection, not collector activity or quota. */
  collectorInspection?: ResourceCollectorInspection;
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
  /** Independent operator reservations; not provider health or available quota. */
  quotaScopeAccess?: ResourceQuotaScopeAccess;
}

export interface ResourceConsoleOutput {
  id: string;
  text: string;
  truncated: boolean;
  retention: 'this-console-session';
}

/** Private task text, returned only by a dedicated authenticated read. */
export interface ResourceConsoleTranscript {
  id: string;
  prompt: string;
  output: { text: string; truncated: boolean } | null;
  retention: 'local-until-deleted';
  transcriptDigest?: string;
  context?: ResourceConsoleContextTurn[];
  parent?: ResourceConsoleParent;
  projectId?: string;
}
