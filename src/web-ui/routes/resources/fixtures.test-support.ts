import type { ResourceConsoleScope, ResourceConsoleSnapshot } from '../../../core/resources/console-types.js';
import type { ResourceTaskReceipt } from '../../../core/resources/pool-runtime.js';

export function resourceFixture(): { scope: ResourceConsoleScope; snapshot: ResourceConsoleSnapshot } {
  const at = '2026-09-07T12:00:00.000Z';
  const worker = (id: string, provider: 'codex' | 'local', capacityKey: string) => ({ id, provider, capacityKey,
    model: provider === 'local' ? 'local-coder' : 'configured-codex', maxConcurrent: 2, reservePercent: 10,
    maxTasksPerWindow: 20, taskWindowMs: 60_000, priority: 10 });
  const receipt = (id: string, workerId: string, status: ResourceTaskReceipt['status']): ResourceTaskReceipt => ({
    schemaVersion: 1, id, workerId, capacityKey: workerId === 'local-a' ? 'local-machine' : 'codex-account',
    taskDigest: 'a'.repeat(64), poolDigest: 'b'.repeat(64), status, startedAt: at,
    finishedAt: status === 'reserved' ? null : at, outputDigest: status === 'completed' ? 'c'.repeat(64) : null,
    inputTokens: status === 'completed' ? 12 : null, outputTokens: status === 'completed' ? 4 : null,
    reason: status === 'completed' ? 'task-completed' : 'task-reserved', verifiedAccepted: false,
  });
  return {
    scope: { schemaVersion: 1, mode: 'resource-pool', root: "/private/resource O'Brien/$ledger", poolId: 'builder-pool',
      readOnly: false, workspace: '/private/project', maxParallel: 4, maxQueued: 64 },
    snapshot: { schemaVersion: 1, mode: 'resource-pool', authority: 'local-evidence', sampledAt: at,
      sourceState: 'healthy', reasons: [], pool: { id: 'builder-pool', workers: [
        worker('codex-a', 'codex', 'codex-account'), worker('codex-alias', 'codex', 'codex-account'), worker('local-a', 'local', 'local-machine'),
      ] }, groups: [
        { capacityKey: 'codex-account', workerIds: ['codex-a', 'codex-alias'], maxConcurrent: 2,
          maxTasksPerWindow: 20, taskWindowMs: 60_000, occupiedSlots: 1, reservedCount: 0, uncertainCount: 1, recentTaskCount: 3 },
        { capacityKey: 'local-machine', workerIds: ['local-a'], maxConcurrent: 2,
          maxTasksPerWindow: 20, taskWindowMs: 60_000, occupiedSlots: 1, reservedCount: 1, uncertainCount: 0, recentTaskCount: 2 },
      ], observations: [
        { workerId: 'codex-a', observedAt: '2026-09-07T11:59:30.000Z', updatedAt: '2026-09-07T11:59:55.000Z',
          expiresAt: '2026-09-07T12:00:30.000Z', health: 'ready', retryAfter: null,
          windows: [{ id: 'five_hour', usedPercent: 0, resetsAt: '2026-09-07T16:00:00.000Z' },
            { id: 'seven_day', usedPercent: 92, resetsAt: '2026-09-12T00:00:00.000Z' },
            { id: 'model_specific', usedPercent: null, resetsAt: null }] },
        { workerId: 'local-a', observedAt: '2026-09-07T11:59:55.000Z', expiresAt: '2026-09-07T12:00:55.000Z',
          health: 'ready', retryAfter: null, windows: [] },
      ], plan: { schemaVersion: 1, poolId: 'builder-pool', sampledAt: at, selectedWorkerId: 'local-a', nextEligibleAt: null,
        candidates: [{ workerId: 'local-a', provider: 'local', model: 'local-coder', priority: 10, reason: 'eligible',
          usedPercent: null, activeCount: 1, taskReservationCount: 2, pressure: .5 }], exclusions: [
          { workerId: 'codex-a', reasons: ['quota-reserve-reached'], nextEligibleAt: null },
          { workerId: 'codex-alias', reasons: ['worker-unavailable'], nextEligibleAt: null },
        ] }, activeAttempts: [receipt('owned-task', 'local-a', 'reserved'), receipt('external-task', 'codex-a', 'uncertain')],
      recentAttempts: [receipt('done-task', 'local-a', 'completed')],
      counts: { total: 3, active: 2, completed: 1, failed: 0, cancelled: 0, timedOut: 0, uncertain: 1, omittedHistory: 0 },
      usage: { reportedAttempts: 1, unknownAttempts: 2, reportedInputTokens: 12, reportedOutputTokens: 4,
        totalInputTokens: null, totalOutputTokens: null, complete: false },
      supervisor: { instanceId: 'console-instance', paused: false, closing: false, error: null,
        maxParallel: 4, maxQueued: 64, activeCount: 1, queuedCount: 1, jobs: [
          { id: 'queued-task', state: 'queued', enqueuedAt: at, updatedAt: at, allowedWorkerIds: ['codex-a'],
            mode: 'read-only', workerId: null, outcome: null, reason: null, cancellable: true, outputAvailable: false },
          { id: 'owned-task', state: 'dispatching', enqueuedAt: at, updatedAt: at, allowedWorkerIds: ['local-a'],
            mode: 'read-only', workerId: 'local-a', outcome: null, reason: null, cancellable: true, outputAvailable: false },
          { id: 'done-task', state: 'settled', enqueuedAt: at, updatedAt: at, allowedWorkerIds: ['local-a'],
            mode: 'read-only', workerId: 'local-a', outcome: 'completed', reason: 'task-completed', cancellable: false, outputAvailable: true },
        ] },
    },
  };
}
