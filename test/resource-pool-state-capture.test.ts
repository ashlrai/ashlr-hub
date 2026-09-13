/** Pool-local bounded capture only; no filesystem, worker, or provider calls. */
import { describe, expect, it, vi } from 'vitest';
import { captureResourcePoolStateJson } from '../src/core/resources/pool-state-capture.js';
import { canonicalEvidencePackJsonV3 } from '../src/core/foundry/provenance.js';
import { decodeResourcePoolState, type ResourceTaskReceipt } from '../src/core/resources/pool-runtime.js';
import { resourcePoolConfigSnapshot } from '../src/core/resources/pool-evolution-policy.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

function configuration(count: number, argumentCount = 1) {
  const pool: ResourcePool = { schemaVersion: 1, id: 'pool', workers: Array.from({ length: count }, (_, index) => ({
    id: 'worker-' + index, provider: 'codex', model: 'fixture', maxConcurrent: 1,
    reservePercent: 10, maxTasksPerWindow: 5, taskWindowMs: 60_000, priority: 1 })) };
  const bindings: ResourceBinding[] = pool.workers.map(worker => ({ workerId: worker.id, capacityKey: worker.id,
    kind: 'native-cli', command: ['/inert/' + worker.id, ...Array.from({ length: argumentCount - 1 }, (_, index) => 'argument-' + index)] }));
  return resourcePoolConfigSnapshot(pool, bindings);
}
const epoch = configuration(1);
const row = (index: number): ResourceTaskReceipt => ({ schemaVersion: 1, id: 'task-' + index,
  taskDigest: 'a'.repeat(64), poolDigest: epoch.poolDigest, workerId: 'worker-0', capacityKey: 'worker-0',
  status: 'completed', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z',
  outputDigest: 'b'.repeat(64), inputTokens: null, outputTokens: null, reason: 'worker-completed', verifiedAccepted: false });
const ledger = (count: number) => ({ schemaVersion: 1, poolDigest: epoch.poolDigest, observations: [],
  attempts: Array.from({ length: count }, (_, index) => row(index)) });
const invalid = (value: unknown) => expect(() => captureResourcePoolStateJson(value)).toThrow('Invalid bounded resource ledger');

describe('pool-specific bounded JSON capture', () => {
  it.each([null, true, false, 0, -0, 1.0000000000000002e-6, 'escaped\n"\\💠',
    { z: 1, A: 2, a: 3, '2': 4, '10': 5, nested: [{ '__proto__': null, b: 1 }] }, ledger(2)])(
    'preserves exact prior accepted canonical JSON %#', value => {
      const before = canonicalEvidencePackJsonV3(value); expect(before).not.toBeNull();
      expect(captureResourcePoolStateJson(value)).toBe(before);
    });
  it('detaches captured data and permits repeated acyclic references', () => {
    const shared = { value: 1 }; const source = { a: shared, b: shared };
    const encoded = captureResourcePoolStateJson(source); shared.value = 2;
    expect(JSON.parse(encoded)).toEqual({ a: { value: 1 }, b: { value: 1 } });
  });
  it('accepts exactly 4096 valid receipts above the old evidence-pack budgets', () => {
    const state = ledger(4096); expect(canonicalEvidencePackJsonV3(state)).toBeNull();
    expect(decodeResourcePoolState(state, epoch.pool, epoch.bindings).attempts).toHaveLength(4096);
    expect(() => decodeResourcePoolState(ledger(4097), epoch.pool, epoch.bindings)).toThrow('Invalid bounded resource ledger');
  });
  it('accepts large valid terminal metadata without inventing unknown usage', () => {
    const state = ledger(4096);
    state.attempts = state.attempts.map(receipt => ({ ...receipt, reason: 'r'.repeat(120),
      execution: { schemaVersion: 1, scope: 'worker-execution', durationMs: null, usageScope: null },
      nativeProcess: { schemaVersion: 1, scope: 'native-process', exitCode: 0, signal: null, stderrPresent: true, outputTruncated: false } }));
    const decoded = decodeResourcePoolState(state, epoch.pool, epoch.bindings);
    expect(decoded.attempts).toEqual(state.attempts); expect(decoded.attempts[0]!.inputTokens).toBeNull();
  });
  it('enforces exactly 4MiB including the persisted newline during capture', () => {
    const limit = 4 * 1024 * 1024;
    const values = Array.from({ length: 32 }, () => 'a'.repeat(128 * 1024));
    values[31] = 'a'.repeat(limit - 1 - 97 - 31 * 128 * 1024);
    expect(Buffer.byteLength(captureResourcePoolStateJson(values)) + 1).toBe(limit);
    values[31] += 'a'; invalid(values);
  });
  it('keeps depth, key, string and container ceilings', () => {
    let nested: unknown = null; for (let index = 0; index < 32; index++) nested = [nested];
    expect(captureResourcePoolStateJson(nested)).toBeDefined(); invalid([nested]);
    expect(captureResourcePoolStateJson({ ['k'.repeat(256)]: 'a'.repeat(128 * 1024) })).toBeDefined();
    invalid({ ['k'.repeat(257)]: 1 }); invalid('a'.repeat(128 * 1024 + 1));
    invalid(Array.from({ length: 4097 }, () => null));
    invalid(Object.fromEntries(Array.from({ length: 4097 }, (_, index) => [String(index), null])));
  });
  it('rejects accessors before invoking them, including array elements and toJSON', () => {
    const getter = vi.fn(() => 1);
    invalid(Object.defineProperty({}, 'key', { enumerable: true, get: getter }));
    invalid(Object.defineProperty([1], '0', { enumerable: true, get: getter }));
    invalid(Object.defineProperty({}, 'toJSON', { enumerable: true, get: getter }));
    invalid({ toJSON: getter }); expect(getter).not.toHaveBeenCalled();
  });
  it('rejects proxies without invoking reflection traps', () => {
    const trap = vi.fn(() => { throw Error('must not run'); });
    invalid(new Proxy({}, { getPrototypeOf: trap, ownKeys: trap, get: trap }));
    invalid({ nested: new Proxy([], { getPrototypeOf: trap, ownKeys: trap, get: trap }) });
    const revoked = Proxy.revocable({}, {}); revoked.revoke(); invalid(revoked.proxy);
    expect(trap).not.toHaveBeenCalled();
  });
  it('rejects cycles, sparse/extended arrays, symbols, nonplain and non-JSON values', () => {
    const cyclic: unknown[] = []; cyclic.push(cyclic);
    for (const value of [cyclic, Array(2), Object.assign([1], { extra: 2 }), { [Symbol('hidden')]: 1 },
      new Date(), Object.create({ inherited: 1 }), undefined, NaN, Infinity, BigInt(1), () => 1]) invalid(value);
  });
  it('preserves all sixteen valid additive epochs without changing the epoch limit', () => {
    const history = Array.from({ length: 16 }, (_, index) => configuration(index + 1));
    const current = history.at(-1)!;
    const state = { ...ledger(1), schemaVersion: 2, poolDigest: current.poolDigest, configurationHistory: history };
    expect(decodeResourcePoolState(state, current.pool, current.bindings).configurationHistory).toHaveLength(16);
    const tooMany = [...history, configuration(17)]; const next = tooMany.at(-1)!;
    expect(() => decodeResourcePoolState({ ...state, poolDigest: next.poolDigest, configurationHistory: tooMany }, next.pool, next.bindings))
      .toThrow('Invalid resource configuration history');
  });
  it('does not silently relax the separate large-epoch evidence-pack boundary', () => {
    const history = Array.from({ length: 16 }, (_, index) => configuration(index + 17, 32));
    const current = history.at(-1)!;
    const state = { schemaVersion: 2, poolDigest: current.poolDigest, configurationHistory: history, observations: [], attempts: [] };
    expect(captureResourcePoolStateJson(state)).toBeDefined();
    expect(canonicalEvidencePackJsonV3(history)).toBeNull();
    expect(() => decodeResourcePoolState(state, current.pool, current.bindings)).toThrow('Invalid resource configuration history');
  });
});
