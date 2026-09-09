import type { ResourceConsoleOutput, ResourceConsoleScope, ResourceConsoleSnapshot, ResourceConsoleTaskInput,
  ResourceSupervisorJob, ResourceSupervisorSnapshot } from '../../core/resources/console-types.js';
import { RESOURCE_COLLECTOR_RECOVERY_REASONS, RESOURCE_COLLECTOR_RECOVERY_MARKER_VERSIONS } from '../../core/resources/console-types.js';
import { validResourceNativeProcessForReceipt } from '../../core/resources/native-diagnostics.js';
import { clearMutationToken, getMutationToken, touchMutationHold } from './auth-store.js';
import { ApiError, apiGet, apiPost } from './client.js';
import type { QueryDef } from './queries.js';

function absolutePath(value: unknown): value is string {
  return typeof value === 'string' && /^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(value) &&
    ![...value].some((character) => character.charCodeAt(0) < 32 ||
      character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159);
}

const QUOTA_STATES = new Set(['pending', 'refreshing', 'observed', 'failed', 'timed-out', 'cancelled', 'uncertain', 'expired', 'closed']);
function validMetadataCollector(value: unknown): boolean {
  if (value === undefined) return true;
  if (!record(value) || !exact(value, ['state', 'reasonCode', 'sampledAt', ...(Object.hasOwn(value, 'recovery') ? ['recovery'] : [])])) return false;
  if (Object.hasOwn(value, 'recovery')) {
    const recovery = value.recovery;
    if (value.state !== 'blocked' || value.reasonCode === 'collector-owned' || !record(recovery) ||
      !exact(recovery, ['reasonCode', 'markerVersion']) || typeof recovery.reasonCode !== 'string' ||
      !RESOURCE_COLLECTOR_RECOVERY_REASONS.some((reason) => reason === recovery.reasonCode) ||
      recovery.markerVersion !== null && ![1, 2, 3, 4].includes(recovery.markerVersion as number)) return false;
    const reason = recovery.reasonCode as keyof typeof RESOURCE_COLLECTOR_RECOVERY_MARKER_VERSIONS;
    if (!RESOURCE_COLLECTOR_RECOVERY_MARKER_VERSIONS[reason].some((version) => version === recovery.markerVersion)) return false;
  }
  return timestamp(value.sampledAt) &&
    (value.state === 'running' && value.reasonCode === 'collector-running' || value.state === 'blocked' &&
      typeof value.reasonCode === 'string' && ['collector-owned', 'reconciliation-required', 'collector-unavailable'].includes(value.reasonCode));
}
function validWorkerAccess(value: unknown): value is NonNullable<ResourceConsoleSnapshot['workerAccess']> {
  if (!record(value) || !exact(value, ['pausedWorkerIds', 'revision', 'updatedAt']) ||
    !Array.isArray(value.pausedWorkerIds) || value.pausedWorkerIds.length > 32 ||
    value.pausedWorkerIds.some((id) => typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) ||
    new Set(value.pausedWorkerIds).size !== value.pausedWorkerIds.length || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return false;
  return value.revision === 0 ? value.updatedAt === null && value.pausedWorkerIds.length === 0 : timestamp(value.updatedAt);
}
const QUOTA_REASONS = new Set(['managed-allocation-unavailable', ...['pending', 'refreshing', 'observed', 'failed', 'timed-out', 'cancelled', 'uncertain',
  'expired', 'closed', 'future', 'unavailable', 'unknown', 'reserve-reached'].map((reason) => `managed-quota-${reason}`)]);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
const CONNECTION_REASONS = new Set([
  'connection-not-checked', 'connection-probe-unavailable', 'connection-monitor-stopped',
  ...['identity-unavailable', 'account-changed', 'native-reported', 'output-invalid', 'process-failed',
    'version-unsupported'].map((code) => `usage-${code}`),
  ...['observed', 'native-unavailable', 'protocol-invalid', 'output-limit', 'provider-error', 'protocol-unsupported',
    'server-request-refused', 'account-unavailable', 'account-unsupported', 'account-hint-mismatch', 'account-changed',
    'quota-invalid', 'native-exit-failed', 'cancelled', 'platform-unsupported', 'process-failed', 'process-output-invalid',
    'termination-uncertain', 'timed-out'].map((code) => `probe-${code}`),
  ...['cancelled', 'platform-unsupported', 'timed-out', 'termination-uncertain', 'output-limit', 'process-failed',
    'output-invalid', 'auth-method-unsupported', 'login-observed', 'not-logged-in'].map((code) => `status-${code}`),
]);
const CONNECTION_PLANS = new Set(['free', 'go', 'plus', 'pro', 'prolite', 'max', 'team', 'self_serve_business_usage_based',
  'business', 'enterprise_cbp_usage_based', 'enterprise', 'edu', 'unknown', 'Free', 'SuperGrok', 'SuperGrok Heavy',
  'SuperGrok Pro', 'SuperGrok Plus', 'SuperGrok Lite', 'SuperGrokPro', 'SuperGrokPlus', 'SuperGrokLite',
  'GrokPro', 'XPremiumPlus', 'XPremium', 'XBasic']);
function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && new TextEncoder().encode(value).byteLength <= maxBytes &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159);
}
function validConnections(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!record(value) || !exact(value, ['sampledAt', 'refreshing', 'accounts']) || !timestamp(value.sampledAt) ||
    typeof value.refreshing !== 'boolean' || !Array.isArray(value.accounts) || value.accounts.length > 8) return false;
  const ids = new Set<string>();
  for (const account of value.accounts) {
    if (!record(account) || !exact(account, ['id', 'label', 'provider', 'state', 'authentication', 'health', 'planType',
      'observedAt', 'expiresAt', 'windows', 'reason', 'onDemandEnabled', 'executionSupported']) ||
      typeof account.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(account.id) || ids.has(account.id) ||
      !boundedText(account.label, 80) || !['codex', 'claude', 'grok'].includes(String(account.provider)) ||
      !['checking', 'observed', 'signed-out', 'unavailable'].includes(String(account.state)) ||
      !['signed-in', 'signed-out', 'unknown'].includes(String(account.authentication)) ||
      !['reachable', 'unknown', 'unavailable'].includes(String(account.health)) ||
      account.planType !== null && (typeof account.planType !== 'string' || !CONNECTION_PLANS.has(account.planType)) ||
      ![account.observedAt, account.expiresAt].every((time) => time === null || timestamp(time)) ||
      typeof account.reason !== 'string' || !CONNECTION_REASONS.has(account.reason) ||
      account.onDemandEnabled !== null && typeof account.onDemandEnabled !== 'boolean' ||
      typeof account.executionSupported !== 'boolean' || account.provider === 'grok' && account.executionSupported ||
      !Array.isArray(account.windows) || account.windows.length > 64) return false;
    ids.add(account.id);
    const windows = new Set<string>();
    for (const window of account.windows) {
      if (!record(window) || !exact(window, ['id', 'usedPercent', 'resetsAt', ...(Object.hasOwn(window, 'nativeReport') ? ['nativeReport'] : [])]) || typeof window.id !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(window.id) || windows.has(window.id) ||
        window.usedPercent !== null && (typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent) ||
          window.usedPercent < 0 || window.usedPercent > 100) || window.resetsAt !== null && !timestamp(window.resetsAt)) return false;
      if (Object.hasOwn(window, 'nativeReport') && (account.provider !== 'claude' || window.resetsAt !== null ||
        !Number.isInteger(window.usedPercent) || !record(window.nativeReport) ||
        !exact(window.nativeReport, ['source', 'resetDescription']) || window.nativeReport.source !== 'claude-usage' ||
        window.nativeReport.resetDescription !== null && !boundedText(window.nativeReport.resetDescription, 128))) return false;
      windows.add(window.id);
    }
  }
  return true;
}
function validAllocation(value: unknown): value is NonNullable<ResourceConsoleSnapshot['allocation']> {
  return record(value) && exact(value, ['ceilingPercent', 'revision', 'updatedAt']) &&
    (value.ceilingPercent === null || Number.isSafeInteger(value.ceilingPercent) && Number(value.ceilingPercent) >= 0 && Number(value.ceilingPercent) <= 100) &&
    Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 &&
    (value.updatedAt === null || timestamp(value.updatedAt)) &&
    (value.ceilingPercent === null ? value.revision === 0 && value.updatedAt === null : Number(value.revision) > 0 && value.updatedAt !== null);
}
/** Validate this optional extension before any provider-controlled values reach the inspector. */
function validNativeDiagnostics(rows: unknown[], workers: ResourceConsoleSnapshot['pool']['workers']): boolean {
  return rows.every((row) => {
    if (!record(row)) return false;
    if (!Object.hasOwn(row, 'nativeProcess')) return true;
    if (!Array.isArray(workers)) return false;
    const worker = workers.find((candidate) => candidate?.id === row.workerId);
    return Boolean(worker && typeof row.status === 'string' &&
      validResourceNativeProcessForReceipt(row.nativeProcess, row.status, worker.provider));
  });
}
/** This optional extension is observation-only; malformed metadata never becomes a successful empty panel. */
function validQuotaRefresh(value: unknown, workers: ResourceConsoleSnapshot['pool']['workers']): boolean {
  if (value === undefined || value === null) return true; // Older servers have no collector.
  if (!record(value) || !exact(value, ['schemaVersion', 'scope', 'state', 'sampledAt', 'workers']) || value.schemaVersion !== 1 ||
    value.scope !== 'codex-native-metadata' || value.state !== 'running' && value.state !== 'closed' || !timestamp(value.sampledAt) ||
    !Array.isArray(value.workers) || value.workers.length < 1 || value.workers.length > 32 || !Array.isArray(workers)) return false;
  const known = new Set(workers.filter((worker) => worker?.provider === 'codex').map((worker) => worker.id));
  const seen = new Set<string>();
  for (const row of value.workers) {
    if (!record(row) || !exact(row, ['workerId', 'status', 'lastAttemptAt', 'lastSuccessAt', 'nextAttemptAt', 'reason']) ||
      typeof row.workerId !== 'string' || !known.has(row.workerId) || seen.has(row.workerId) ||
      typeof row.status !== 'string' || !QUOTA_STATES.has(row.status) || typeof row.reason !== 'string' || !QUOTA_REASONS.has(row.reason) ||
      ![row.lastAttemptAt, row.lastSuccessAt, row.nextAttemptAt].every((time) => time === null || timestamp(time)) ||
      row.lastSuccessAt !== null && row.lastAttemptAt === null ||
      value.state === 'closed' && (row.nextAttemptAt !== null || row.status !== 'closed' && row.status !== 'uncertain')) return false;
    seen.add(row.workerId);
  }
  return true;
}

export const resourceConsoleScopeQuery: QueryDef<ResourceConsoleScope> = {
  key: 'resource-console-scope',
  async fetch(signal) {
    const scope = await apiGet<ResourceConsoleScope>('/api/resources/console', signal);
    if (scope?.schemaVersion !== 1 || scope.mode !== 'resource-pool' || typeof scope.readOnly !== 'boolean' ||
      !absolutePath(scope.root) || typeof scope.poolId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(scope.poolId) ||
      (scope.workspace !== null && !absolutePath(scope.workspace)) || (!scope.readOnly && scope.workspace === null) ||
      !Number.isSafeInteger(scope.maxParallel) || scope.maxParallel < (scope.readOnly ? 0 : 1) || scope.maxParallel > 32 ||
      !Number.isSafeInteger(scope.maxQueued) || scope.maxQueued < (scope.readOnly ? 0 : 1) || scope.maxQueued > 64 ||
      scope.quotaRefreshEnabled !== undefined && typeof scope.quotaRefreshEnabled !== 'boolean' ||
      scope.connectionsEnabled !== undefined && typeof scope.connectionsEnabled !== 'boolean' ||
      scope.allocationWritable !== undefined && typeof scope.allocationWritable !== 'boolean') {
      throw new Error('The server did not establish an explicit resource-pool scope.');
    }
    return scope;
  },
};

export function resourceConsoleSnapshotQuery(poolId: string): QueryDef<ResourceConsoleSnapshot> {
  return {
    key: `resource-console-snapshot:${poolId}`,
    async fetch(signal) {
      const snapshot = await apiGet<ResourceConsoleSnapshot>('/api/resources', signal);
      if (snapshot?.schemaVersion !== 1 || snapshot.mode !== 'resource-pool' || snapshot.pool?.id !== poolId ||
        snapshot.authority !== 'local-evidence' || !['healthy', 'missing', 'degraded'].includes(snapshot.sourceState) ||
        !Array.isArray(snapshot.groups) || !Array.isArray(snapshot.activeAttempts) || !Array.isArray(snapshot.recentAttempts) ||
        !validNativeDiagnostics(snapshot.activeAttempts, snapshot.pool.workers) ||
        !validNativeDiagnostics(snapshot.recentAttempts, snapshot.pool.workers) ||
        !validQuotaRefresh(snapshot.quotaRefresh, snapshot.pool.workers) || !validConnections(snapshot.connections) || !validMetadataCollector(snapshot.metadataCollector) ||
        snapshot.allocation !== undefined && !validAllocation(snapshot.allocation) ||
        snapshot.workerAccess !== undefined && (!validWorkerAccess(snapshot.workerAccess) ||
          snapshot.workerAccess.pausedWorkerIds.some((id) => !snapshot.pool.workers.some((worker) => worker.id === id)))) {
        throw new Error('The resource response did not match the selected pool.');
      }
      return snapshot;
    },
  };
}

async function control<T>(path: string, body: unknown, disabledMessage = 'Task execution is disabled for this console.'): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new Error('Unlock controls with this console’s control token first.');
  try {
    const result = await apiPost<T>(path, body, token);
    touchMutationHold();
    return result;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      clearMutationToken();
      throw new Error('Control token rejected. Unlock with the token printed by this console.');
    }
    if (error instanceof ApiError && error.status === 403) throw new Error(disabledMessage);
    throw error;
  }
}

export const submitResourceTask = (task: ResourceConsoleTaskInput) => control<{ job: ResourceSupervisorJob }>('/api/resources/tasks', task);
export const cancelResourceTask = (id: string) => control<{ job: ResourceSupervisorJob }>(`/api/resources/tasks/${encodeURIComponent(id)}/cancel`, {});
export const setResourceQueuePaused = (paused: boolean) => control<{ supervisor: ResourceSupervisorSnapshot }>('/api/resources/queue', { paused });

export async function setResourceAllocation(ceilingPercent: number, expectedRevision: number) {
  if (!Number.isSafeInteger(ceilingPercent) || ceilingPercent < 0 || ceilingPercent > 100 ||
    !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('Invalid allocation change.');
  let response: { allocation: NonNullable<ResourceConsoleSnapshot['allocation']> };
  try {
    response = await control('/api/resources/allocation', { ceilingPercent, expectedRevision }, 'Allocation changes are disabled for this console.');
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) throw new ApiError('Allocation changed elsewhere. Refresh and use the latest allocation before saving.', 409, '/api/resources/allocation');
    if (error instanceof Error && ['Unlock controls with this console’s control token first.',
      'Control token rejected. Unlock with the token printed by this console.',
      'Allocation changes are disabled for this console.'].includes(error.message)) throw error;
    throw new Error('Allocation could not be saved. Refresh the current allocation before trying again.');
  }
  if (!record(response) || !exact(response, ['allocation']) || !validAllocation(response.allocation) ||
    response.allocation.ceilingPercent !== ceilingPercent || response.allocation.revision !== expectedRevision + 1) {
    throw new Error('The allocation response could not be verified. Refresh before trying again.');
  }
  return response;
}

export async function setResourceWorkerAccessControl(pausedWorkerIds: string[], expectedRevision: number): Promise<{
  workerAccess: NonNullable<ResourceConsoleSnapshot['workerAccess']>;
}> {
  if (!Array.isArray(pausedWorkerIds) || pausedWorkerIds.length > 32 ||
    pausedWorkerIds.some((id) => typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) ||
    new Set(pausedWorkerIds).size !== pausedWorkerIds.length || !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid fleet access change.');
  let response: { workerAccess: NonNullable<ResourceConsoleSnapshot['workerAccess']> };
  try {
    response = await control('/api/resources/worker-access', { pausedWorkerIds, expectedRevision }, 'Fleet access controls are disabled for this console.');
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) throw new ApiError('Fleet access changed elsewhere. Refresh before saving again.', 409, '/api/resources/worker-access');
    if (error instanceof Error && ['Unlock controls with this console’s control token first.',
      'Control token rejected. Unlock with the token printed by this console.',
      'Fleet access controls are disabled for this console.'].includes(error.message)) throw error;
    throw new Error('Fleet access could not be saved. Refresh before trying again.');
  }
  if (!record(response) || !exact(response, ['workerAccess']) || !validWorkerAccess(response.workerAccess) ||
    response.workerAccess.revision !== expectedRevision + 1 ||
    [...response.workerAccess.pausedWorkerIds].sort().join('\0') !== [...pausedWorkerIds].sort().join('\0')) {
    throw new Error('Fleet access response could not be verified. Refresh before trying again.');
  }
  return response;
}

export async function readResourceTaskOutput(id: string, signal?: AbortSignal): Promise<ResourceConsoleOutput> {
  const output = await apiGet<ResourceConsoleOutput>(`/api/resources/tasks/${encodeURIComponent(id)}/output`, signal);
  if (output?.id !== id || typeof output.text !== 'string' || new TextEncoder().encode(output.text).byteLength > 262_144 ||
    typeof output.truncated !== 'boolean' || output.retention !== 'this-console-session') {
    throw new Error('Task output is unavailable in this console session.');
  }
  return output;
}
