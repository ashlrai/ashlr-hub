/** Byte sizing and private staged fixtures only; no provider or runtime admission. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical } from '../src/core/universe/artifacts.js';
import { resourcePoolConfigSnapshot } from '../src/core/resources/pool-evolution-policy.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceTaskReceipt } from '../src/core/resources/pool-receipt-codec.js';
import { decodeResourcePoolState, requireResourcePoolSettlementHeadroom as legacyRequire, type ResourcePoolState } from '../src/core/resources/pool-runtime.js';
import { resourcePoolSettlementEnvelopeBytes, requireResourcePoolSettlementHeadroom } from '../src/core/resources/pool-settlement-headroom.js';
import { readResourcePoolStorage, requireResourcePoolStorageSettlementHeadroom, stageResourcePoolReceiptCompaction,
  type ResourcePoolArchiveHeader } from '../src/core/resources/pool-state-storage.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

const LIMIT = 4 * 1024 * 1024;
const nativeId = 'n'.repeat(64); const capacityKey = 'c'.repeat(64);
const pool: ResourcePool = { schemaVersion: 1, id: 'headroom', workers: [{ id: nativeId, provider: 'codex', model: 'fixture',
  maxConcurrent: 3, reservePercent: 25, maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1 }] };
const bindings: ResourceBinding[] = [{ workerId: nativeId, capacityKey, kind: 'native-cli', command: ['/inert/native'] }];
const epoch = resourcePoolConfigSnapshot(pool, bindings);
const widestNumber = 1.0000000000000002e-6;
const at = '2000-01-01T00:00:00.000Z';
const row = (id: string): ResourceTaskReceipt => ({ schemaVersion: 1, id, taskDigest: 'a'.repeat(64), poolDigest: epoch.poolDigest,
  workerId: nativeId, capacityKey, status: 'completed', startedAt: at, finishedAt: '2000-01-01T00:00:01.000Z',
  outputDigest: 'b'.repeat(64), inputTokens: Number.MAX_SAFE_INTEGER - 1, outputTokens: 1, reason: 'x'.repeat(120), verifiedAccepted: false,
  execution: { schemaVersion: 1, scope: 'worker-execution', durationMs: widestNumber, usageScope: 'codex-turn' },
  nativeProcess: { schemaVersion: 1, scope: 'native-process', exitCode: 0, signal: null, stderrPresent: false, outputTruncated: false } });
function reserved(id = 'pending'): ResourceTaskReceipt {
  const receipt = row(id); delete receipt.execution; delete receipt.nativeProcess;
  return { ...receipt, status: 'reserved', finishedAt: null, outputDigest: null, inputTokens: null, outputTokens: null, reason: 'worker-reserved' };
}
function state(attempts: ResourceTaskReceipt[] = [reserved()]): ResourcePoolState {
  return { schemaVersion: 2, poolDigest: epoch.poolDigest, configurationHistory: [structuredClone(epoch)], attempts, observations: [],
    allocation: { ceilingPercent: 75, revision: 1, updatedAt: at },
    workerAccess: { pausedWorkerIds: [], revision: 1, updatedAt: at } };
}

/** Independent frozen arithmetic from the pre-extraction legacy envelope. These
 * deliberately conservative objects are byte budgets, not admissible evidence. */
function referenceEnvelope(source: ResourcePoolState, configuredPool = pool) {
  const attempts = source.attempts.map(receipt => {
    if (receipt.status !== 'reserved') return receipt;
    const provider = configuredPool.workers.find(worker => worker.id === receipt.workerId)!.provider;
    const usageScope = provider === 'local' ? 'local-chat-completion' : provider === 'claude' ? 'claude-main-loop' : 'codex-turn';
    return { ...receipt, status: 'completed', finishedAt: new Date(8_640_000_000_000_000).toISOString(), outputDigest: '0'.repeat(64),
      inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: Number.MAX_SAFE_INTEGER, reason: 'x'.repeat(120),
      execution: { schemaVersion: 1, scope: 'worker-execution', durationMs: widestNumber, usageScope },
      ...(provider === 'local' ? {} : { nativeProcess: { schemaVersion: 1, scope: 'native-process', exitCode: null,
        signal: 'SIGSTKFLT', stderrPresent: false, outputTruncated: false } }) };
  });
  const date = '9999-12-31T23:59:59.999Z';
  const observations = configuredPool.workers.map(worker => ({ workerId: worker.id, observedAt: date, expiresAt: date,
    updatedAt: date, health: 'unavailable', retryAfter: date, windows: Array.from({ length: 8 }, (_, index) => ({
      id: String(index).padStart(64, '0'), usedPercent: widestNumber, resetsAt: date })) }));
  return { ...source, attempts, observations };
}
const referenceBytes = (source: ResourcePoolState, configuredPool = pool) => Buffer.byteLength(canonical(referenceEnvelope(source, configuredPool)) + '\n');

function atEnvelopeBytes(source: ResourcePoolState, target: number): ResourcePoolState {
  const value = structuredClone(source); const template = row('h'.repeat(64));
  const before = referenceBytes(value); const perRow = Buffer.byteLength(canonical(template)) + 1;
  const count = Math.ceil((target - before) / perRow);
  expect(count).toBeGreaterThan(0); expect(count + value.attempts.length).toBeLessThanOrEqual(4096);
  value.attempts.push(...Array.from({ length: count }, (_, index) => ({ ...template, id: 'h' + String(index).padStart(63, '0') })));
  let excess = referenceBytes(value) - target;
  for (let index = value.attempts.length - 1; excess > 0; index--) {
    const reduction = Math.min(119, excess); value.attempts[index]!.reason = 'x'.repeat(120 - reduction); excess -= reduction;
  }
  expect(referenceBytes(value)).toBe(target);
  expect(decodeResourcePoolState(value, pool, bindings)).toEqual(value);
  return value;
}

const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pool-storage-headroom-'))); roots.push(root); chmodSync(root, 0o700);
  mkdirSync(join(root, 'receipt-archive'), { mode: 0o700 }); const archiveKeyFile = join(root, 'receipt-archive.key');
  writeFileSync(archiveKeyFile, '11'.repeat(32) + '\n', { mode: 0o600 });
  const source = state([row('cold')]); const file = join(root, 'pool-state.json'); const bytes = canonical(source) + '\n';
  writeFileSync(file, bytes, { mode: 0o600 }); const options = { root, pool, bindings, archiveKeyFile };
  const header = stageResourcePoolReceiptCompaction(readResourcePoolStorage(source, options), ['cold'], { guard() {} });
  return { root, file, bytes, archiveKeyFile, options, header };
}
function envelopeBytes(header: ResourcePoolArchiveHeader) {
  return Buffer.byteLength(canonical({ ...header, hotState: referenceEnvelope(header.hotState) }) + '\n');
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('full stored resource settlement byte headroom', () => {
  it.each([1, 2] as const)('preserves legacy schema%s sizing and the public runtime export without mutating inputs', schemaVersion => {
    const source = state([reserved('first'), reserved('second'), row('done')]); source.schemaVersion = schemaVersion;
    if (schemaVersion === 1) delete source.configurationHistory;
    const before = structuredClone(source); const poolBefore = structuredClone(pool);
    expect(resourcePoolSettlementEnvelopeBytes(source, pool)).toBe(referenceBytes(source));
    expect(legacyRequire).toBe(requireResourcePoolSettlementHeadroom); expect(() => legacyRequire(source, pool)).not.toThrow();
    expect(source).toEqual(before); expect(pool).toEqual(poolBefore);
  });

  it('includes every concurrent reservation and complete quota inventory, with native metadata only for native providers', () => {
    const workers = [pool.workers[0]!, { ...pool.workers[0]!, id: 'local', provider: 'local' as const },
      { ...pool.workers[0]!, id: 'claude', provider: 'claude' as const }];
    const configuredPool: ResourcePool = { ...pool, workers };
    const configuredBindings: ResourceBinding[] = workers.map((worker, index) => ({ workerId: worker.id, capacityKey: 'account-' + index,
      ...(worker.provider === 'local' ? { kind: 'local-chat' as const, endpoint: 'http://127.0.0.1:1/v1' }
        : { kind: 'native-cli' as const, command: ['/inert/fixture'] }) }));
    const configuredEpoch = resourcePoolConfigSnapshot(configuredPool, configuredBindings);
    const source = state(workers.map((worker, index) => ({ ...reserved('pending-' + index), workerId: worker.id,
      capacityKey: 'account-' + index, poolDigest: configuredEpoch.poolDigest })));
    source.poolDigest = configuredEpoch.poolDigest; source.configurationHistory = [configuredEpoch];
    expect(decodeResourcePoolState(source, configuredPool, configuredBindings)).toEqual(source);
    const expected = referenceEnvelope(source, configuredPool);
    expect(expected.observations).toHaveLength(3); expect(expected.observations.every(item => item.windows.length === 8)).toBe(true);
    expect(expected.attempts[0]).toHaveProperty('nativeProcess'); expect(expected.attempts[1]).not.toHaveProperty('nativeProcess');
    expect(expected.attempts[2]).toHaveProperty('nativeProcess');
    expect(resourcePoolSettlementEnvelopeBytes(source, configuredPool)).toBe(referenceBytes(source, configuredPool));
    expect(resourcePoolSettlementEnvelopeBytes(source, configuredPool)).toBeGreaterThan(Buffer.byteLength(canonical(source) + '\n'));
  });

  it('accepts exactly4MiB including newline and rejects one byte over with unchanged legacy error', () => {
    const exact = atEnvelopeBytes(state(), LIMIT); const over = structuredClone(exact);
    const shortened = over.attempts.find(item => item.status === 'completed' && item.reason.length < 120)!; shortened.reason += 'x';
    expect(referenceBytes(over)).toBe(LIMIT + 1);
    expect(resourcePoolSettlementEnvelopeBytes(exact, pool)).toBe(LIMIT); expect(() => legacyRequire(exact, pool)).not.toThrow();
    expect(resourcePoolSettlementEnvelopeBytes(over, pool)).toBe(LIMIT + 1);
    expect(() => legacyRequire(over, pool)).toThrow('Resource ledger settlement capacity reached');
  });

  it('counts the real certificate and outer header exactly once, including its sole persisted newline', () => {
    const f = fixture(); const emptyHot = state(); const overhead = envelopeBytes({ ...f.header, hotState: emptyHot }) - referenceBytes(emptyHot);
    expect(overhead).toBeGreaterThan(0);
    const exact = { ...f.header, hotState: atEnvelopeBytes(emptyHot, LIMIT - overhead) };
    expect(envelopeBytes(exact)).toBe(LIMIT); const exactView = readResourcePoolStorage(exact, f.options);
    expect(() => requireResourcePoolStorageSettlementHeadroom(exactView)).not.toThrow();
    const over = structuredClone(exact); over.hotState.attempts.find(item => item.status === 'completed' && item.reason.length < 120)!.reason += 'x';
    expect(envelopeBytes(over)).toBe(LIMIT + 1); expect(Buffer.byteLength(canonical(over) + '\n')).toBeLessThan(LIMIT);
    // The legacy hot-only gate would pass; it does not account for schema3's certificate.
    expect(() => legacyRequire(over.hotState, pool)).not.toThrow();
    const view = readResourcePoolStorage(over, f.options);
    expect(() => requireResourcePoolStorageSettlementHeadroom(view)).toThrow('settlement capacity');
    view.hotState.attempts.length = 0;
    if (view.source.schemaVersion === 3) view.source.hotState.attempts.length = 0;
    expect(() => requireResourcePoolStorageSettlementHeadroom(view)).toThrow('settlement capacity');
    expect(readFileSync(f.file, 'utf8')).toBe(f.bytes);
  });

  it('refuses forged or stale archive views without repairing storage or accepting callback authority', () => {
    const f = fixture(); const view = readResourcePoolStorage(f.header, f.options); const before = readdirSync(f.root).sort();
    expect(() => requireResourcePoolStorageSettlementHeadroom({ ...view })).toThrow();
    const getter = vi.fn(); const forged = Object.defineProperty({}, 'hotState', { enumerable: true, get: getter });
    expect(() => requireResourcePoolStorageSettlementHeadroom(forged as typeof view)).toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(readdirSync(f.root).sort()).toEqual(before);
    unlinkSync(f.archiveKeyFile); expect(view.isCurrent()).toBe(false);
    expect(() => requireResourcePoolStorageSettlementHeadroom(view)).toThrow();
    expect(readdirSync(f.root)).not.toContain('receipt-archive.key'); expect(readFileSync(f.file, 'utf8')).toBe(f.bytes);
  });

  it('refuses a staged candidate whose released terminal row still leaves insufficient full settlement space', () => {
    const f = fixture(); const hot = state([reserved('first'), reserved('second')]);
    const overhead = envelopeBytes({ ...f.header, hotState: hot }) - referenceBytes(hot);
    const source = { ...f.header, hotState: atEnvelopeBytes(hot, LIMIT - overhead + 1500) };
    expect(envelopeBytes(source)).toBe(LIMIT + 1500);
    expect(Buffer.byteLength(canonical(source) + '\n')).toBeLessThan(LIMIT);
    const selected = source.hotState.attempts.find(receipt => receipt.status === 'completed')!;
    // Even before counting the next certificate, the one selected row cannot
    // release the missing envelope bytes. No worker is contacted or settled.
    expect(Buffer.byteLength(canonical(selected)) + 1).toBeLessThan(1500);
    const view = readResourcePoolStorage(source, f.options); const guard = vi.fn();
    expect(() => stageResourcePoolReceiptCompaction(view, [selected.id], { guard })).toThrow();
    expect(guard).toHaveBeenCalled(); expect(view.isCurrent()).toBe(true);
    expect(view.receipts.get(selected.id)).toMatchObject({ status: 'found', receipt: selected });
    expect(readFileSync(f.file, 'utf8')).toBe(f.bytes);
  });
});
