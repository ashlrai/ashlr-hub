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

export const resourceConsoleScopeQuery: QueryDef<ResourceConsoleScope> = {
  key: 'resource-console-scope',
  async fetch(signal) {
    const scope = await apiGet<ResourceConsoleScope>('/api/resources/console', signal);
    if (scope?.schemaVersion !== 1 || scope.mode !== 'resource-pool' || typeof scope.readOnly !== 'boolean' ||
      !absolutePath(scope.root) || typeof scope.poolId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(scope.poolId) ||
      (scope.workspace !== null && !absolutePath(scope.workspace)) || (!scope.readOnly && scope.workspace === null) ||
      !Number.isSafeInteger(scope.maxParallel) || scope.maxParallel < (scope.readOnly ? 0 : 1) || scope.maxParallel > 32 ||
      !Number.isSafeInteger(scope.maxQueued) || scope.maxQueued < (scope.readOnly ? 0 : 1) || scope.maxQueued > 64) {
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
        !Array.isArray(snapshot.groups) || !Array.isArray(snapshot.activeAttempts) || !Array.isArray(snapshot.recentAttempts)) {
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
