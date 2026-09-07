import { describe, expect, it } from 'vitest';
import { planResourceAssignment, RESOURCE_OBSERVATION_OVERFLOW, type ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';
import type { ResourceTaskReceipt, resourcePoolStatus } from '../src/core/resources/pool-runtime.js';
import { degradedResourceConsoleEvidence, MAX_RESOURCE_CONSOLE_RESPONSE_BYTES, projectResourceConsoleEvidence,
  serializeResourceConsoleEvidence, validateResourceConsoleResponse } from '../src/core/web/resource-console-public.js';

const NOW = Date.parse('2026-09-07T16:00:00.000Z');
const time = (offset = 0) => new Date(NOW + offset).toISOString();
const worker = { id: 'claude-a', provider: 'claude' as const, model: 'explicit-model', maxConcurrent: 2,
  maxTasksPerWindow: 10, taskWindowMs: 60_000, reservePercent: 10, priority: 50 };
const pool: ResourcePool = { schemaVersion: 1, id: 'pool', workers: [worker, { ...worker, id: 'claude-b' }] };
const bindings: ResourceBinding[] = pool.workers.map((row) => ({ workerId: row.id, capacityKey: 'shared-account',
  kind: 'native-cli', command: ['/private/secret-owner-wrapper', '--private-config'] }));
function attempt(id: string, status: ResourceTaskReceipt['status'] = 'completed', offset = 0): ResourceTaskReceipt {
  return { schemaVersion: 1, id, taskDigest: 'a'.repeat(64), poolDigest: 'b'.repeat(64), workerId: 'claude-a', capacityKey: 'shared-account',
    status, startedAt: time(offset - 10_000), finishedAt: status === 'reserved' ? null : time(offset - 1_000),
    outputDigest: status === 'reserved' ? null : 'c'.repeat(64), inputTokens: status === 'reserved' ? null : 10,
    outputTokens: status === 'reserved' ? null : 20, reason: status === 'reserved' ? 'task-reserved' : 'worker-completed', verifiedAccepted: false };
}
function source(attempts: ResourceTaskReceipt[] = []): ReturnType<typeof resourcePoolStatus> {
  return { schemaVersion: 1, sourceState: 'healthy', poolId: pool.id, attempts, observations: [],
    plan: planResourceAssignment({ pool, observations: [], allowedWorkerIds: pool.workers.map((row) => row.id),
      activeCounts: {}, taskReservationCounts: {}, nowMs: NOW }) };
}
const project = (rows: ResourceTaskReceipt[] = []) => projectResourceConsoleEvidence(pool, bindings, source(rows));
const parse = (value: unknown) => validateResourceConsoleResponse(JSON.stringify(value), pool, bindings);

describe('resource console public evidence projection', () => {
  it('deduplicates occupied shared capacity and keeps uncertain attempts active despite finishedAt', () => {
    const value = project([attempt('reserved', 'reserved'), { ...attempt('uncertain', 'uncertain'), workerId: 'claude-b' }, attempt('done')]);
    expect(value.groups).toEqual([{ capacityKey: 'shared-account', workerIds: ['claude-a', 'claude-b'], maxConcurrent: 2,
      maxTasksPerWindow: 10, taskWindowMs: 60_000, occupiedSlots: 2, reservedCount: 1, uncertainCount: 1, recentTaskCount: 3 }]);
    expect(value.counts).toMatchObject({ total: 3, active: 2, completed: 1, uncertain: 1 });
    expect(value.activeAttempts.map((row) => row.id)).toEqual(['reserved', 'uncertain']);
    expect(parse(value)).toEqual(value);
  });

  it('keeps all unresolved attempts while bounding terminal history and counting the entire ledger', () => {
    const rows = Array.from({ length: 125 }, (_, index) => attempt(`done-${index}`, 'completed', -index));
    rows.push(attempt('old-reserved', 'reserved', -90_000), attempt('old-uncertain', 'uncertain', -90_000));
    const value = project(rows);
    expect(value.activeAttempts).toHaveLength(2); expect(value.recentAttempts).toHaveLength(100);
    expect(value.recentAttempts[0]?.id).toBe('done-0');
    expect(value.counts).toMatchObject({ total: 127, active: 2, completed: 125, omittedHistory: 25 });
    expect(value.groups[0]).toMatchObject({ occupiedSlots: 2, recentTaskCount: 125 });
    expect(parse(value)).toEqual(value);
  });

  it('projects the maximum ledger footprint without truncating active evidence', () => {
    const value = project(Array.from({ length: 4_096 }, (_, index) => attempt(`active-${index}`, 'reserved')));
    expect(value.activeAttempts).toHaveLength(4_096); expect(value.counts.active).toBe(4_096);
    expect(Buffer.byteLength(serializeResourceConsoleEvidence(value, pool, bindings))).toBeLessThan(MAX_RESOURCE_CONSOLE_RESPONSE_BYTES);
  });

  it('reports measured token coverage without inventing totals for unknown or active attempts', () => {
    const value = project([attempt('known'), { ...attempt('unknown', 'failed'), inputTokens: null, outputTokens: null }, attempt('reserved', 'reserved')]);
    expect(value.usage).toEqual({ reportedAttempts: 1, unknownAttempts: 2, reportedInputTokens: 10, reportedOutputTokens: 20,
      totalInputTokens: null, totalOutputTokens: null, complete: false });
    expect(parse(value)).toEqual(value);
    expect(project([attempt('uncertain', 'uncertain')]).usage).toMatchObject({ reportedAttempts: 1, totalInputTokens: null, complete: false });
  });

  it('provides totals only for fully settled reported evidence, including genuine zero', () => {
    expect(project([attempt('one'), attempt('two')]).usage).toEqual({ reportedAttempts: 2, unknownAttempts: 0,
      reportedInputTokens: 20, reportedOutputTokens: 40, totalInputTokens: 20, totalOutputTokens: 40, complete: true });
    expect(project([{ ...attempt('zero'), inputTokens: 0, outputTokens: 0 }]).usage).toMatchObject({ totalInputTokens: 0, totalOutputTokens: 0, complete: true });
    expect(project().usage).toMatchObject({ reportedAttempts: 0, unknownAttempts: 0, totalInputTokens: null, reportedInputTokens: null, complete: false });
  });

  it('keeps overflowing aggregate token counts unknown even when individual receipts are valid', () => {
    const value = project([{ ...attempt('one'), inputTokens: Number.MAX_SAFE_INTEGER - 1, outputTokens: 0 },
      { ...attempt('two'), inputTokens: 2, outputTokens: 0 }]);
    expect(value.usage).toMatchObject({ reportedAttempts: 2, reportedInputTokens: null, reportedOutputTokens: 0,
      totalInputTokens: null, totalOutputTokens: null, complete: false });
    expect(parse(value)).toEqual(value);
  });

  it('retains original mixed quota ages and overflow sentinel without claiming a new provider capture', () => {
    const status = source();
    status.observations = [{ workerId: 'claude-a', observedAt: time(-90_000), updatedAt: time(-1_000), expiresAt: time(-30_000),
      health: 'unavailable', retryAfter: time(60_000), windows: [{ id: RESOURCE_OBSERVATION_OVERFLOW, usedPercent: 100, resetsAt: null }] }];
    const value = projectResourceConsoleEvidence(pool, bindings, status);
    expect(value.observations).toEqual(status.observations); expect(value.sampledAt).toBe(time()); expect(parse(value)).toEqual(value);
  });

  it('does not expose binding locators or extra raw receipt fields and leaves source objects unchanged', () => {
    const row = Object.assign(attempt('one'), { prompt: 'private prompt', output: 'private text', cwd: '/private/workspace' });
    const value = project([row]); const encoded = serializeResourceConsoleEvidence(value, pool, bindings);
    expect(encoded).not.toMatch(/private|command|endpoint|cwd|prompt|"output"/);
    expect(row.prompt).toBe('private prompt'); expect(value.recentAttempts[0]?.verifiedAccepted).toBe(false);
  });

  it('keeps absent storage distinct from degraded evidence and does not invent zero on source failure', () => {
    const missing = projectResourceConsoleEvidence(pool, bindings, { ...source(), sourceState: 'missing' });
    expect(missing.sourceState).toBe('missing'); expect(missing.counts.total).toBe(0);
    const degraded = degradedResourceConsoleEvidence(pool, bindings, time());
    expect(Object.values(degraded.counts).every((value) => value === null)).toBe(true);
    expect(degraded.groups[0]?.occupiedSlots).toBeNull(); expect(degraded.plan).toBeNull(); expect(parse(degraded)).toEqual(degraded);
  });
});

describe('strict resource console worker response boundary', () => {
  it.each([null, {}, [], '[]', '{', '{"schemaVersion":1}'])('rejects incomplete or nonserialized responses %#', (value) => {
    expect(() => validateResourceConsoleResponse(value, pool, bindings)).toThrow();
  });

  it.each(['root', 'command', 'prompt', 'output', 'endpoint', '__proto__'])('rejects extra top-level private fields %s', (key) => {
    const value = project(); Object.defineProperty(value, key, { enumerable: true, value: 'private' });
    expect(() => parse(value)).toThrow();
  });

  it.each(['worker', 'group', 'receipt', 'plan', 'quota', 'counts', 'usage'])('rejects extra nested fields at %s', (kind) => {
    const value = JSON.parse(JSON.stringify(project([attempt('one')]))) as ReturnType<typeof project>;
    const target = kind === 'worker' ? value.pool.workers[0] : kind === 'group' ? value.groups[0] : kind === 'receipt' ? value.recentAttempts[0]
      : kind === 'plan' ? value.plan : kind === 'counts' ? value.counts : kind === 'usage' ? value.usage :
        (value.observations[0] = { workerId: 'claude-a', health: 'ready', observedAt: time(), expiresAt: time(1000), retryAfter: null, windows: [] });
    Object.assign(target!, { privateData: 'never expose' }); expect(() => parse(value)).toThrow();
  });

  it.each(['config', 'group', 'worker', 'status', 'accepted', 'tokens', 'time', 'duplicate', 'active', 'usage', 'degraded'])('rejects inconsistent bounded evidence: %s', (kind) => {
    const value = project([attempt('one')]);
    if (kind === 'config') value.pool.workers[0]!.model = 'different-model';
    if (kind === 'group') value.groups[0]!.capacityKey = 'different';
    if (kind === 'worker') value.recentAttempts[0]!.workerId = 'unknown';
    if (kind === 'status') value.recentAttempts[0]!.status = 'running' as ResourceTaskReceipt['status'];
    if (kind === 'accepted') (value.recentAttempts[0] as unknown as { verifiedAccepted: boolean }).verifiedAccepted = true;
    if (kind === 'tokens') value.recentAttempts[0]!.inputTokens = null;
    if (kind === 'time') value.recentAttempts[0]!.startedAt = 'not-time';
    if (kind === 'duplicate') value.recentAttempts.push(value.recentAttempts[0]!);
    if (kind === 'active') value.activeAttempts.push(value.recentAttempts.pop()!);
    if (kind === 'usage') value.usage.unknownAttempts = 20;
    if (kind === 'degraded') value.sourceState = 'degraded';
    expect(() => parse(value)).toThrow();
  });

  it('bounds actual UTF-8 serialized bytes', () => {
    expect(() => validateResourceConsoleResponse(JSON.stringify({ text: 'é'.repeat(MAX_RESOURCE_CONSOLE_RESPONSE_BYTES / 2) }), pool, bindings)).toThrow();
  });
});
