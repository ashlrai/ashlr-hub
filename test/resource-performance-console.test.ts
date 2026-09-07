import { describe, expect, it } from 'vitest';
import { planResourceAssignment, type ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceTaskReceipt, resourcePoolStatus } from '../src/core/resources/pool-runtime.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';
import { degradedResourceConsoleEvidence, projectResourceConsoleEvidence, serializeResourceConsoleEvidence,
  MAX_RESOURCE_CONSOLE_RESPONSE_BYTES, validateResourceConsoleResponse } from '../src/core/web/resource-console-public.js';

const NOW = Date.parse('2026-09-07T16:00:00.000Z');
const pool: ResourcePool = { schemaVersion: 1, id: 'pool', workers: [{ id: 'local', provider: 'local', model: 'fixture',
  maxConcurrent: 1, maxTasksPerWindow: 10, taskWindowMs: 60_000, reservePercent: 10, priority: 1 }] };
const bindings: ResourceBinding[] = [{ workerId: 'local', capacityKey: 'local', kind: 'local-chat', endpoint: 'http://127.0.0.1:12345/v1' }];
function row(index = 0): ResourceTaskReceipt {
  return { schemaVersion: 1, id: `task-${index}`, taskDigest: 'a'.repeat(64), poolDigest: 'b'.repeat(64), workerId: 'local', capacityKey: 'local',
    status: 'completed', startedAt: new Date(NOW - 2000 - index).toISOString(), finishedAt: new Date(NOW - 1000).toISOString(),
    outputDigest: 'c'.repeat(64), inputTokens: 10, outputTokens: 2, reason: 'worker-completed', verifiedAccepted: false,
    execution: { schemaVersion: 1, scope: 'worker-execution', durationMs: index + 1, usageScope: 'local-chat-completion' } };
}
function project(attempts = [row()]) {
  const status: ReturnType<typeof resourcePoolStatus> = { schemaVersion: 1, sourceState: 'healthy', poolId: pool.id,
    attempts, observations: [], plan: planResourceAssignment({ pool, observations: [], allowedWorkerIds: ['local'],
      activeCounts: {}, taskReservationCounts: {}, nowMs: NOW }) };
  return projectResourceConsoleEvidence(pool, bindings, status);
}
const validate = (value: unknown) => validateResourceConsoleResponse(JSON.stringify(value), pool, bindings);
describe('resource performance console transport', () => {
  it('exposes complete-ledger measurements despite recent-history display truncation', () => {
    const value = project(Array.from({ length: 125 }, (_, index) => row(index)));
    expect(value.recentAttempts).toHaveLength(100);
    expect(value.performance).toMatchObject({ attempts: 125, workers: [{ counts: { completed: 125 } }] });
    expect(value.performance?.workers[0]?.durations[0]).toMatchObject({ samples: 125, p50Ms: 63, p95Ms: 119 });
    expect(validate(value)).toEqual(value);
  });

  it('serializes versioned measurements but no private worker source or text', () => {
    const input = row(); const value = project([input]);
    const bytes = serializeResourceConsoleEvidence(value, pool, bindings);
    expect(validateResourceConsoleResponse(bytes, pool, bindings)).toEqual(value);
    expect(bytes).not.toContain('127.0.0.1');
    value.recentAttempts[0]!.execution!.durationMs = 50;
    expect(input.execution?.durationMs).toBe(1);
  });

  it('accepts legacy projection omission, withholds failed-source measurements, and rejects false success', () => {
    const legacy = project(); delete legacy.performance; delete legacy.recentAttempts[0]!.execution;
    expect(validate(legacy)).toEqual(legacy);
    const degraded = degradedResourceConsoleEvidence(pool, bindings, new Date(NOW).toISOString());
    expect(degraded.performance).toBeNull(); expect(validate(degraded)).toEqual(degraded);
    degraded.performance = project().performance;
    expect(() => validate(degraded)).toThrow();
  });

  it.each(['count', 'duration', 'coverage', 'extra', 'scope'])('rejects inconsistent performance at transport: %s', (kind) => {
    const value = project(); const worker = value.performance!.workers[0]!;
    if (kind === 'count') worker.counts.completed++;
    if (kind === 'duration') { worker.durations[0]!.p50Ms = 5; worker.durations[0]!.p95Ms = 5; }
    if (kind === 'coverage') worker.usage.reportedAttempts = 0;
    if (kind === 'extra') Object.assign(worker.durations[0]!, { rawOutput: 'private' });
    if (kind === 'scope') value.recentAttempts[0]!.execution!.usageScope = 'claude-main-loop';
    expect(() => validate(value)).toThrow();
  });

  it('rejects contradictory worker/global token subtotals even when history is omitted', () => {
    const value = project(Array.from({ length: 125 }, (_, index) => row(index)));
    expect(value.counts.omittedHistory).toBe(25);
    Object.assign(value.performance!.workers[0]!.usage, { reportedInputTokens: 0, reportedOutputTokens: 0,
      totalInputTokens: 0, totalOutputTokens: 0 });
    expect(() => validate(value)).toThrow();
  });

  it('rejects reserved usage in legacy public snapshots without a performance report', () => {
    const value = project([{ ...row(), status: 'reserved', inputTokens: null, outputTokens: null, finishedAt: null,
      outputDigest: null, execution: undefined }]);
    delete value.performance;
    Object.assign(value.usage, { reportedAttempts: 1, unknownAttempts: 0, reportedInputTokens: 10, reportedOutputTokens: 2 });
    expect(() => validate(value)).toThrow();
  });

  it('fits the bounded measured-active ledger at maximum worker and window cardinality', () => {
    const definition: ResourcePool = { schemaVersion: 1, id: 'p'.repeat(64), workers: Array.from({ length: 32 }, (_, index) => ({
      ...pool.workers[0]!, id: `worker-${index}-`.padEnd(64, 'w'), model: 'm'.repeat(160),
    })) };
    const locators: ResourceBinding[] = definition.workers.map((worker) => ({ workerId: worker.id, capacityKey: worker.id,
      kind: 'local-chat', endpoint: 'http://127.0.0.1:12345/v1' }));
    const observations = definition.workers.map((worker) => ({ workerId: worker.id, observedAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString(), health: 'ready' as const,
      retryAfter: new Date(NOW + 60_000).toISOString(), windows: Array.from({ length: 8 }, (_, index) => ({
        id: `window-${index}-`.padEnd(64, 'w'), usedPercent: 1, resetsAt: new Date(NOW + 60_000).toISOString(),
      })) }));
    const attempts = Array.from({ length: 4_096 }, (_, index) => ({ ...row(index), id: `task-${index}-`.padEnd(64, 't'),
      workerId: definition.workers[index % 32]!.id, capacityKey: definition.workers[index % 32]!.id,
      status: 'uncertain' as const, reason: 'r'.repeat(120), inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0,
      execution: { schemaVersion: 1 as const, scope: 'worker-execution' as const, durationMs: 12_345_678.123456789,
        usageScope: 'local-chat-completion' as const } }));
    const value = projectResourceConsoleEvidence(definition, locators, { schemaVersion: 1, sourceState: 'healthy', poolId: definition.id,
      observations, attempts, plan: planResourceAssignment({ pool: definition, observations,
        allowedWorkerIds: definition.workers.map((worker) => worker.id), activeCounts: {}, taskReservationCounts: {}, nowMs: NOW }) });
    expect(value.activeAttempts).toHaveLength(4_096); expect(value.performance?.attempts).toBe(4_096);
    const bytes = serializeResourceConsoleEvidence(value, definition, locators);
    expect(Buffer.byteLength(bytes)).toBeLessThan(MAX_RESOURCE_CONSOLE_RESPONSE_BYTES);
    expect(validateResourceConsoleResponse(bytes, definition, locators)).toEqual(value);
  });
});
