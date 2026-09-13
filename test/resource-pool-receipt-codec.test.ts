/** Pure receipt-domain checks; no ledger, worker, native process, or provider execution. */
import { describe, expect, it, vi } from 'vitest';
import { checkedResourceTaskReceipt, type ResourceTaskReceipt } from '../src/core/resources/pool-receipt-codec.js';
import { decodeResourcePoolState, type ResourceTaskReceipt as PublicReceipt } from '../src/core/resources/pool-runtime.js';
import { resourcePoolConfigSnapshot } from '../src/core/resources/pool-evolution-policy.js';
import { resourceGenerationTaskId } from '../src/core/resources/task-origin.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

const pool: ResourcePool = { schemaVersion: 1, id: 'fixture', workers: [{ id: 'worker', provider: 'codex', model: 'fixture',
  maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 5, taskWindowMs: 60_000, priority: 1 }] };
const bindings: ResourceBinding[] = [{ workerId: 'worker', capacityKey: 'account', kind: 'native-cli', command: ['/inert/worker'] }];
const epoch = resourcePoolConfigSnapshot(pool, bindings);
const start = '2026-01-01T00:00:00.000Z';
const finish = '2026-01-01T00:00:01.000Z';
const receipt = (patch: Partial<ResourceTaskReceipt> = {}): PublicReceipt => ({ schemaVersion: 1, id: 'task',
  taskDigest: 'a'.repeat(64), poolDigest: epoch.poolDigest, workerId: 'worker', capacityKey: 'account',
  status: 'completed', startedAt: start, finishedAt: finish, outputDigest: 'b'.repeat(64),
  inputTokens: null, outputTokens: null, reason: 'worker-completed', verifiedAccepted: false, ...patch });
const check = (value: unknown) => checkedResourceTaskReceipt(value, epoch.poolDigest, bindings, pool);
const measurement = { schemaVersion: 1 as const, scope: 'worker-execution' as const, durationMs: 12, usageScope: null };
const native = { schemaVersion: 1 as const, scope: 'native-process' as const, exitCode: 0, signal: null,
  stderrPresent: false, outputTruncated: false };

describe('shared resource receipt codec', () => {
  it.each(['completed', 'failed', 'timed-out', 'cancelled', 'uncertain'] as const)('preserves terminal %s and unknown measurements', status => {
    const row = receipt({ status, outputDigest: status === 'completed' ? 'b'.repeat(64) : null });
    const before = structuredClone(row);
    expect(check(row)).toBe(true); expect(row).toEqual(before);
    expect(row).not.toHaveProperty('execution'); expect(row.inputTokens).toBeNull();
  });
  it('accepts a reservation but not fabricated terminal or native evidence on it', () => {
    const row = receipt({ status: 'reserved', finishedAt: null, outputDigest: null });
    expect(check(row)).toBe(true);
    for (const patch of [{ finishedAt: finish }, { outputDigest: 'b'.repeat(64) }, { inputTokens: 0, outputTokens: 0 },
      { execution: measurement }, { nativeProcess: native }]) expect(check({ ...row, ...patch })).toBe(false);
  });
  it.each([{ poolDigest: 'f'.repeat(64) }, { workerId: 'foreign' }, { capacityKey: 'foreign' },
    { taskDigest: 'bad' }, { status: 'invented' }, { verifiedAccepted: true }, { finishedAt: null },
    { finishedAt: '2025-01-01T00:00:00.000Z' }, { startedAt: '2026-01-01' }, { outputDigest: null },
    { reason: 'Private arbitrary error!' }, { inputTokens: 1, outputTokens: null },
    { inputTokens: -1, outputTokens: 0 }, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }])(
    'rejects changed identity/status/measurement %#', patch => { expect(check({ ...receipt(), ...patch })).toBe(false); });
  it('distinguishes reported zero from unknown usage without backfilling', () => {
    expect(check(receipt({ inputTokens: 0, outputTokens: 0, execution: { ...measurement, usageScope: 'codex-turn' } }))).toBe(true);
    expect(check(receipt({ execution: measurement }))).toBe(true);
    expect(check(receipt({ execution: { ...measurement, usageScope: 'codex-turn' } }))).toBe(false);
    expect(check(receipt({ inputTokens: 1, outputTokens: 1, execution: { ...measurement, usageScope: 'claude-main-loop' } }))).toBe(false);
  });
  it('retains native provider/status constraints', () => {
    expect(check(receipt({ nativeProcess: native }))).toBe(true);
    expect(check(receipt({ nativeProcess: { ...native, exitCode: 2 } }))).toBe(false);
    expect(check(receipt({ nativeProcess: { ...native, outputTruncated: true } }))).toBe(false);
    expect(check(receipt({ status: 'uncertain', nativeProcess: { ...native, exitCode: null } }))).toBe(true);
    const local = { ...pool, workers: [{ ...pool.workers[0]!, provider: 'local' as const }] };
    const localBindings: ResourceBinding[] = [{ workerId: 'worker', capacityKey: 'account', kind: 'local-chat', endpoint: 'http://127.0.0.1:1/v1' }];
    const localEpoch = resourcePoolConfigSnapshot(local, localBindings);
    expect(checkedResourceTaskReceipt(receipt({ poolDigest: localEpoch.poolDigest, nativeProcess: native }),
      localEpoch.poolDigest, localBindings, local)).toBe(false);
  });
  it('pins both generation and successor origins to their task identities', () => {
    const identity = { universeId: 'universe', runId: 'run', variantId: 'variant' };
    const generation = receipt({ id: resourceGenerationTaskId(identity), origin: { kind: 'universe-generation', ...identity } });
    const proposal = receipt({ id: 'proposal-' + 'c'.repeat(48), origin: { kind: 'engineering-successor-proposal',
      scopeDigest: 'd'.repeat(64), proposalKey: 'c'.repeat(48) } });
    for (const row of [generation, proposal]) {
      expect(check(row)).toBe(true); expect(check({ ...row, id: 'foreign' })).toBe(false);
    }
  });
  it('refuses extended, inherited and accessor receipt data without invoking getters', () => {
    const getter = vi.fn(() => 'worker');
    expect(check({ ...receipt(), privateText: 'not-a-receipt-field' })).toBe(false);
    expect(check(Object.create(receipt()))).toBe(false);
    expect(check(Object.defineProperty(receipt(), 'workerId', { enumerable: true, get: getter }))).toBe(false);
    expect(check({ ...receipt(), execution: Object.defineProperty({ ...measurement }, 'durationMs', { get: getter }) })).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });
  it('retains epoch-aware outer decode, duplicate-ID rejection, and bounded capture', () => {
    const state = { schemaVersion: 1, poolDigest: epoch.poolDigest, observations: [], attempts: [receipt()] };
    expect(decodeResourcePoolState(state, pool, bindings).attempts).toEqual(state.attempts);
    expect(() => decodeResourcePoolState({ ...state, attempts: [receipt(), receipt()] }, pool, bindings)).toThrow(/ledger invalid/);
    // The outer container bound also refuses more than 4096 receipts.
    expect(() => decodeResourcePoolState({ ...state, attempts: Array.from({ length: 4097 }, (_, i) => receipt({ id: 'task-' + i })) }, pool, bindings))
      .toThrow('Invalid bounded resource ledger');
    const next = { ...pool, workers: [...pool.workers, { ...pool.workers[0]!, id: 'second' }] };
    const nextBindings: ResourceBinding[] = [...bindings,
      { workerId: 'second', capacityKey: 'second-account', kind: 'native-cli', command: ['/inert/second'] }];
    const nextEpoch = resourcePoolConfigSnapshot(next, nextBindings);
    expect(decodeResourcePoolState({ ...state, schemaVersion: 2, poolDigest: nextEpoch.poolDigest,
      configurationHistory: [epoch, nextEpoch] }, next, nextBindings).attempts).toEqual(state.attempts);
  });
});
