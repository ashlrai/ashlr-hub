/** Real private archive/index I/O over synthetic receipts; no runtime activation or workers. */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync,
  rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resourcePoolConfigSnapshot } from '../src/core/resources/pool-evolution-policy.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceTaskReceipt } from '../src/core/resources/pool-receipt-codec.js';
import type { ResourcePoolState } from '../src/core/resources/pool-runtime.js';
import { captureResourcePoolStateJson } from '../src/core/resources/pool-state-capture.js';
import { compareResourcePoolStorageReceipts, readResourcePoolStorage, stageResourcePoolReceiptCompaction,
  type ResourcePoolStoredState, type ResourcePoolStorageView } from '../src/core/resources/pool-state-storage.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

const hooks = vi.hoisted(() => ({ firstAssurance: null as (() => void) | null }));
vi.mock('../src/core/util/private-storage.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  return { ...actual, assurePrivateStoragePath: (...args: Parameters<typeof actual.assurePrivateStoragePath>) => {
    const result = actual.assurePrivateStoragePath(...args);
    const callback = hooks.firstAssurance; hooks.firstAssurance = null; callback?.(); return result;
  } };
});
const pool: ResourcePool = { schemaVersion: 1, id: 'comparison', workers: [{ id: 'local', provider: 'local', model: 'inert',
  maxConcurrent: 1, reservePercent: 25, maxTasksPerWindow: 5, taskWindowMs: 60_000, priority: 1 }] };
const bindings: ResourceBinding[] = [{ workerId: 'local', capacityKey: 'account', kind: 'local-chat', endpoint: 'http://127.0.0.1:1/v1' }];
const epoch = resourcePoolConfigSnapshot(pool, bindings);
const time = '2026-01-01T00:00:00.000Z';
const row = (id: string, patch: Partial<ResourceTaskReceipt> = {}): ResourceTaskReceipt => ({ schemaVersion: 1, id,
  taskDigest: 'a'.repeat(64), poolDigest: epoch.poolDigest, workerId: 'local', capacityKey: 'account', status: 'completed',
  startedAt: time, finishedAt: time, outputDigest: 'b'.repeat(64), inputTokens: null, outputTokens: null,
  reason: 'worker-completed', verifiedAccepted: false, ...patch });
const state = (attempts: ResourceTaskReceipt[]): ResourcePoolState => ({ schemaVersion: 2, poolDigest: epoch.poolDigest,
  configurationHistory: [structuredClone(epoch)], observations: [], attempts });
const payloadDigest = (receipt: ResourceTaskReceipt) => createHash('sha256')
  .update('resource-terminal-receipt-v1\n' + captureResourcePoolStateJson(receipt) + '\n').digest('hex');
const budget = { maxNodes: 128, maxChanges: 32 };
const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pool-comparison-'))); roots.push(root); chmodSync(root, 0o700);
  const archive = join(root, 'receipt-archive'); mkdirSync(archive, { mode: 0o700 });
  const archiveKeyFile = join(root, 'receipt-archive.key'); writeFileSync(archiveKeyFile, '11'.repeat(32) + '\n', { mode: 0o600 });
  const options = { root, pool: structuredClone(pool), bindings: structuredClone(bindings), archiveKeyFile };
  const open = (source: ResourcePoolStoredState) => readResourcePoolStorage(source, options);
  const stage = (source: ResourcePoolStoredState, ids: string[]) => stageResourcePoolReceiptCompaction(open(source), ids, { guard() {} });
  return { root, archive, archiveKeyFile, options, open, stage };
}
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]);
}
const compare = (before: ResourcePoolStorageView, after: ResourcePoolStorageView, limits = budget) =>
  compareResourcePoolStorageReceipts(before, after, limits);
afterEach(() => { hooks.firstAssurance = null; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('logical receipt storage comparison, not policy equality or execution authority', () => {
  it('reports exact sorted additions, mutations and deletions from legacy captures without writing files', () => {
    const f = fixture(); const old = [row('z'), row('a'), row('same')]; const changed = row('z', { inputTokens: 2, outputTokens: 3 });
    const before = f.open(state(old)); const after = f.open(state([row('same'), changed, row('b')])); const names = files(f.root);
    expect(compare(before, after)).toMatchObject({ equal: false, preservesBefore: false, changes: [
      { id: 'a', beforeDigest: payloadDigest(old[1]!), afterDigest: null },
      { id: 'b', beforeDigest: null, afterDigest: payloadDigest(row('b')) },
      { id: 'z', beforeDigest: payloadDigest(old[0]!), afterDigest: payloadDigest(changed) },
    ] });
    expect(compare(f.open(state([row('same')])), after)).toMatchObject({ equal: false, preservesBefore: true });
    expect(compare(before, f.open(state([...old].reverse())))).toMatchObject({ equal: true, preservesBefore: true, changes: [] });
    expect(files(f.root)).toEqual(names);
  });
  it.each([1, 2] as const)('compares schema%s with staged schema3 in both directions at zero logical-change budget', schemaVersion => {
    const f = fixture(); const source = state([row('first'), row('second')]); source.schemaVersion = schemaVersion;
    if (schemaVersion === 1) delete source.configurationHistory;
    const before = f.open(source); const header = f.stage(source, ['second', 'first']); const after = f.open(header);
    for (const [left, right] of [[before, after], [after, before]] as const) {
      expect(compare(left, right, { maxNodes: 128, maxChanges: 0 })).toMatchObject({ equal: true, preservesBefore: true, changes: [] });
    }
    expect(after.receipts.get('first')).toMatchObject({ receipt: { inputTokens: null, outputTokens: null } });
  });
  it('reconciles partial cold/hot movement once while preserving a real added and changed logical row', () => {
    const f = fixture(); const original = state([row('first'), row('second'), row('third')]);
    const partial = f.stage(original, ['first']); const complete = f.stage(partial, ['second']);
    expect(compare(f.open(partial), f.open(complete), { maxNodes: 128, maxChanges: 0 })).toMatchObject({ equal: true, changes: [] });
    const changed = row('third', { status: 'failed', outputDigest: null, reason: 'worker-failed' });
    complete.hotState.attempts = [changed, row('new')];
    expect(compare(f.open(partial), f.open(complete), { maxNodes: 128, maxChanges: 2 })).toMatchObject({ equal: false, preservesBefore: false, changes: [
      { id: 'new', beforeDigest: null, afterDigest: payloadDigest(row('new')) },
      { id: 'third', beforeDigest: payloadDigest(row('third')), afterDigest: payloadDigest(changed) },
    ] });
  });
  it('detects independently certified alternate cold values and deletion instead of trusting count or certificate shape', () => {
    const f = fixture(); const first = row('same'); const altered = row('same', { taskDigest: 'c'.repeat(64) });
    const left = f.open(f.stage(state([first]), ['same'])); const right = f.open(f.stage(state([altered]), ['same']));
    expect(compare(left, right)).toMatchObject({ equal: false, preservesBefore: false,
      changes: [{ id: 'same', beforeDigest: payloadDigest(first), afterDigest: payloadDigest(altered) }] });
    expect(compare(left, f.open(state([])))).toMatchObject({ equal: false, preservesBefore: false,
      changes: [{ id: 'same', beforeDigest: payloadDigest(first), afterDigest: null }] });
  });
  it('reports a reserved-to-terminal-and-cold transition once without treating unknown usage as zero', () => {
    const f = fixture(); const reserved = row('active', { status: 'reserved', finishedAt: null, outputDigest: null, reason: 'task-reserved' });
    const terminal = row('active'); const left = f.open(state([reserved])); const right = f.open(f.stage(state([terminal]), ['active']));
    expect(compare(left, right, { maxNodes: 128, maxChanges: 1 })).toMatchObject({ equal: false, preservesBefore: false,
      changes: [{ id: 'active', beforeDigest: payloadDigest(reserved), afterDigest: payloadDigest(terminal) }] });
    expect(right.receipts.get('active')).toMatchObject({ receipt: { inputTokens: null, outputTokens: null } });
    const measuredZero = f.open(state([row('active', { inputTokens: 0, outputTokens: 0 })]));
    expect(compare(right, measuredZero).equal).toBe(false);
  });
  it('does not turn policy or observation differences into receipt-set equality claims', () => {
    const f = fixture(); const original = state([row('same')]); const header = f.stage(original, ['same']);
    header.hotState.allocation = { ceilingPercent: 0, revision: 1, updatedAt: time };
    header.hotState.workerAccess = { pausedWorkerIds: ['local'], revision: 1, updatedAt: time };
    header.hotState.observations = [{ workerId: 'local', health: 'unavailable', windows: [], retryAfter: null,
      observedAt: time, expiresAt: '2026-01-01T00:00:01.000Z' }];
    expect(compare(f.open(original), f.open(header))).toMatchObject({ equal: true, changes: [] });
    expect(header.hotState).not.toEqual(original); // Callers must compare controls independently.
  });
  it('uses private source/options captures and captures budgets before custody callbacks', () => {
    const f = fixture(); const source = state([row('first')]); const left = f.open(source);
    const header = f.stage(source, ['first']); const right = f.open(header); const limits = { maxNodes: 128, maxChanges: 0 };
    const getter = vi.fn(); const mutate = vi.fn(() => {
      source.attempts.length = 0; left.hotState.attempts.length = 0; header.hotState.attempts.push(row('intruder'));
      right.hotState.attempts.push(row('intruder')); f.options.root = join(f.root, 'foreign');
      f.options.pool.workers.length = 0; Object.defineProperty(limits, 'maxNodes', { enumerable: true, get: getter });
    });
    hooks.firstAssurance = mutate;
    expect(compare(left, right, limits)).toMatchObject({ equal: true, changes: [] });
    expect(mutate).toHaveBeenCalledOnce(); expect(getter).not.toHaveBeenCalled();
    const result = compare(left, right); result.changes.push({ id: 'fabricated', beforeDigest: null, afterDigest: 'f'.repeat(64) });
    expect(compare(left, right)).toMatchObject({ equal: true, changes: [] });
  });
  it('rejects foreign roots, alternate key enrollments, forged and malformed view handles', () => {
    const f = fixture(); const other = fixture(); const before = f.open(state([]));
    expect(() => compare(before, other.open(state([])))).toThrow();
    const alternateKey = join(f.root, 'alternate.key'); writeFileSync(alternateKey, '11'.repeat(32) + '\n', { mode: 0o600 });
    const alternate = readResourcePoolStorage(state([]), { ...f.options, archiveKeyFile: alternateKey });
    expect(() => compare(before, alternate)).toThrow();
    const otherPool = { ...pool, id: 'foreign-pool' }; const otherEpoch = resourcePoolConfigSnapshot(otherPool, bindings);
    const otherState: ResourcePoolState = { schemaVersion: 2, poolDigest: otherEpoch.poolDigest,
      configurationHistory: [otherEpoch], observations: [], attempts: [] };
    expect(() => compare(before, readResourcePoolStorage(otherState, { ...f.options, pool: otherPool }))).toThrow();
    for (const invalid of [null, {}, { ...before }, new Proxy(before, {})]) expect(() => compare(before, invalid as ResourcePoolStorageView)).toThrow();
  });
  it.each(['key-replacement', 'key-content', 'payload', 'node'] as const)('refuses %s drift even for identical compared views', kind => {
    const f = fixture(); const header = f.stage(state([row('one')]), ['one']); const view = f.open(header);
    if (kind === 'key-replacement') { renameSync(f.archiveKeyFile, f.archiveKeyFile + '-old'); writeFileSync(f.archiveKeyFile, '11'.repeat(32) + '\n', { mode: 0o600 }); }
    if (kind === 'key-content') writeFileSync(f.archiveKeyFile, '22'.repeat(32) + '\n');
    if (kind === 'payload') unlinkSync(files(f.archive).find(path => path.includes('/records/'))!);
    if (kind === 'node') writeFileSync(files(f.archive).find(path => path.includes('/nodes/'))!, '{}\n');
    const names = files(f.root); expect(() => compare(view, view)).toThrow(); expect(files(f.root)).toEqual(names);
  });
  it('rejects exhausted node and final logical-change budgets instead of reporting a partial result', () => {
    const f = fixture(); const first = f.stage(state([row('first')]), ['first']);
    const next = structuredClone(first); next.hotState.attempts = [row('second')]; const second = f.stage(next, ['second']);
    const left = f.open(first); const right = f.open(second); const before = files(f.root);
    expect(() => compare(left, right, { maxNodes: 1, maxChanges: 32 })).toThrow();
    expect(() => compare(left, right, { maxNodes: 128, maxChanges: 0 })).toThrow();
    const complete = compare(left, right, { maxNodes: 128, maxChanges: 1 });
    expect(complete).toMatchObject({ equal: false, preservesBefore: true,
      changes: [{ id: 'second', beforeDigest: null, afterDigest: payloadDigest(row('second')) }] });
    expect(complete.nodesRead).toBeGreaterThanOrEqual(2); expect(Number.isSafeInteger(complete.skippedSubtrees)).toBe(true);
    expect(files(f.root)).toEqual(before);
  });
  it('rejects malformed budgets before custody callbacks or filesystem mutation', () => {
    const f = fixture(); const view = f.open(state([])); const getter = vi.fn();
    const accessor = Object.defineProperty({ maxChanges: 0 }, 'maxNodes', { enumerable: true, get: getter });
    const callback = vi.fn(); hooks.firstAssurance = callback;
    for (const limits of [null, {}, accessor, { maxNodes: 0, maxChanges: 0 }, { maxNodes: 1, maxChanges: -1 },
      { maxNodes: 1, maxChanges: 4097 }, new Proxy(budget, {})]) expect(() => compare(view, view, limits as typeof budget)).toThrow();
    expect(callback).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled();
    expect(readFileSync(f.archiveKeyFile, 'utf8')).toBe('11'.repeat(32) + '\n'); expect(readdirSync(f.archive)).toEqual([]);
  });
});
