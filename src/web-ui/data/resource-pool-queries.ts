import type { ResourceConsoleOutput, ResourceConsoleScope, ResourceConsoleSnapshot, ResourceConsoleTaskInput,
  ResourceSupervisorJob, ResourceSupervisorSnapshot } from '../../core/resources/console-types.js';
import { clearMutationToken, getMutationToken, touchMutationHold } from './auth-store.js';
import { ApiError, apiGet, apiPost } from './client.js';
import type { QueryDef } from './queries.js';

function absolutePath(value: unknown): value is string {
  return typeof value === 'string' && /^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(value) &&
    ![...value].some((character) => character.charCodeAt(0) < 32 ||
      character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159);
}

const QUOTA_STATES = new Set(['pending', 'refreshing', 'observed', 'failed', 'timed-out', 'cancelled', 'uncertain', 'expired', 'closed']);
const QUOTA_REASONS = new Set(['pending', 'refreshing', 'observed', 'failed', 'timed-out', 'cancelled', 'uncertain',
  'expired', 'closed', 'future', 'unavailable', 'unknown', 'reserve-reached'].map((reason) => `managed-quota-${reason}`));
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
      scope.quotaRefreshEnabled !== undefined && typeof scope.quotaRefreshEnabled !== 'boolean') {
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
        !validQuotaRefresh(snapshot.quotaRefresh, snapshot.pool.workers)) {
        throw new Error('The resource response did not match the selected pool.');
      }
      return snapshot;
    },
  };
}

async function control<T>(path: string, body: unknown): Promise<T> {
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
    if (error instanceof ApiError && error.status === 403) throw new Error('Task execution is disabled for this console.');
    throw error;
  }
}

export const submitResourceTask = (task: ResourceConsoleTaskInput) => control<{ job: ResourceSupervisorJob }>('/api/resources/tasks', task);
export const cancelResourceTask = (id: string) => control<{ job: ResourceSupervisorJob }>(`/api/resources/tasks/${encodeURIComponent(id)}/cancel`, {});
export const setResourceQueuePaused = (paused: boolean) => control<{ supervisor: ResourceSupervisorSnapshot }>('/api/resources/queue', { paused });

export async function readResourceTaskOutput(id: string, signal?: AbortSignal): Promise<ResourceConsoleOutput> {
  const output = await apiGet<ResourceConsoleOutput>(`/api/resources/tasks/${encodeURIComponent(id)}/output`, signal);
  if (output?.id !== id || typeof output.text !== 'string' || new TextEncoder().encode(output.text).byteLength > 262_144 ||
    typeof output.truncated !== 'boolean' || output.retention !== 'this-console-session') {
    throw new Error('Task output is unavailable in this console session.');
  }
  return output;
}
