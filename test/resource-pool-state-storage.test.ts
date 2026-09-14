/** Real private archive I/O with synthetic receipt history, never provider execution.
 * This is a staged adapter contract, not proof of a 4097th runtime admission. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resourcePoolConfigSnapshot } from '../src/core/resources/pool-evolution-policy.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceTaskReceipt } from '../src/core/resources/pool-receipt-codec.js';
import { createResourcePoolReceiptQuery } from '../src/core/resources/pool-receipt-query.js';
import { decodeResourcePoolState, type ResourcePoolState } from '../src/core/resources/pool-runtime.js';
import { readResourcePoolStorage, stageResourcePoolReceiptCompaction, type ResourcePoolArchiveHeader } from '../src/core/resources/pool-state-storage.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

const pool: ResourcePool = { schemaVersion: 1, id: 'storage-fixture', workers: [
  { id: 'general', provider: 'codex', model: 'gpt-6-astra', quotaScope: 'codex-general-v1',
    maxConcurrent: 1, reservePercent: 25, maxTasksPerWindow: 5, taskWindowMs: 60_000, priority: 1 },
  { id: 'spark', provider: 'codex', model: 'gpt-5.3-codex-spark', quotaScope: 'codex-spark-v1',
    maxConcurrent: 1, reservePercent: 25, maxTasksPerWindow: 5, taskWindowMs: 60_000, priority: 1 },
] };
const bindings: ResourceBinding[] = pool.workers.map(worker => ({ workerId: worker.id, capacityKey: 'personal',
  kind: 'native-cli', command: ['/inert/fixture-worker'] }));
const epoch = resourcePoolConfigSnapshot(pool, bindings);
const startedAt = '2026-01-01T00:00:00.000Z';
const finishedAt = '2026-01-01T00:00:01.000Z';
const noGuard = { guard() {} };
const roots: string[] = [];
const row = (id: string, patch: Partial<ResourceTaskReceipt> = {}): ResourceTaskReceipt => ({
  schemaVersion: 1, id, taskDigest: 'a'.repeat(64), poolDigest: epoch.poolDigest, workerId: 'spark', capacityKey: 'personal',
  status: 'completed', startedAt, finishedAt, outputDigest: 'b'.repeat(64), inputTokens: null, outputTokens: null,
  reason: 'worker-completed', verifiedAccepted: false, ...patch,
});
function state(attempts: ResourceTaskReceipt[] = [row('done')]): ResourcePoolState {
  return { schemaVersion: 2, poolDigest: epoch.poolDigest, configurationHistory: [structuredClone(epoch)], observations: [], attempts,
    allocation: { ceilingPercent: 75, revision: 1, updatedAt: startedAt },
    workerAccess: { pausedWorkerIds: ['general'], revision: 1, updatedAt: startedAt },
    quotaScopeAccess: { exclusions: [{ capacityKey: 'personal', quotaScope: 'codex-general-v1' }], revision: 1, updatedAt: startedAt } };
}
function fixture(source = state()) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pool-state-storage-'))); roots.push(root); chmodSync(root, 0o700);
  const archive = join(root, 'receipt-archive'); mkdirSync(archive, { mode: 0o700 });
  const archiveKeyFile = join(root, 'receipt-archive.key'); writeFileSync(archiveKeyFile, '11'.repeat(32) + '\n', { mode: 0o600 });
  const file = join(root, 'pool-state.json'); const bytes = JSON.stringify(source) + '\n'; writeFileSync(file, bytes, { mode: 0o600 });
  const options = { root, pool: structuredClone(pool), bindings: structuredClone(bindings), archiveKeyFile };
  return { root, archive, archiveKeyFile, file, bytes, options, source, open: () => readResourcePoolStorage(source, options) };
}
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]);
}
function stage(f: ReturnType<typeof fixture>, ids = ['done']) { return stageResourcePoolReceiptCompaction(f.open(), ids, noGuard); }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('staged legacy-to-certified receipt storage', () => {
  it.each([1, 2] as const)('reads legacy schema %s without enrolling or inspecting a key', schemaVersion => {
    const source = state(); source.schemaVersion = schemaVersion; if (schemaVersion === 1) delete source.configurationHistory;
    const f = fixture(source); unlinkSync(f.archiveKeyFile); rmSync(f.archive, { recursive: true });
    const names = readdirSync(f.root); const view = f.open();
    expect(view.source).toEqual(source); expect(view.hotState).toEqual(source); expect(view.isCurrent()).toBe(true);
    expect(view.receipts.get('done')).toEqual({ status: 'found', id: 'done', receipt: source.attempts[0] });
    expect(readResourcePoolStorage(source, { root: f.root, pool, bindings }).hotState).toEqual(source);
    expect(() => stageResourcePoolReceiptCompaction(view, ['done'], noGuard)).toThrow();
    expect(readdirSync(f.root)).toEqual(names); expect(readFileSync(f.file, 'utf8')).toBe(f.bytes);
  });

  it('stages only selected terminal rows, preserves active rows and controls, and reopens an exact union', () => {
    const rows = [row('done'), row('reserved', { status: 'reserved', finishedAt: null, outputDigest: null, reason: 'worker-reserved' }),
      row('failed', { status: 'failed', outputDigest: null, reason: 'worker-failed' }),
      row('uncertain', { status: 'uncertain', outputDigest: null, reason: 'worker-uncertain' }), row('later')];
    const f = fixture(state(rows)); const original = structuredClone(f.source); const view = f.open();
    const header = stageResourcePoolReceiptCompaction(view, ['failed', 'done'], noGuard);
    expect(header).toMatchObject({ schemaVersion: 3, kind: 'resource-pool-archive-header',
      archiveCertificate: { sourceStateDigest: view.sourceDigest, archiveRoot: { byId: { count: 2 } } } });
    expect(header.hotState).toEqual({ ...original, attempts: rows.filter(item => !['done', 'failed'].includes(item.id)) });
    expect(f.source).toEqual(original); expect(readFileSync(f.file, 'utf8')).toBe(f.bytes);
    const reopened = readResourcePoolStorage(header, f.options); const golden = createResourcePoolReceiptQuery(rows);
    expect(reopened.isCurrent()).toBe(true);
    expect(reopened.receipts.getMany(['later', 'done', 'absent', 'failed', 'done'])).toEqual(golden.getMany(['later', 'done', 'absent', 'failed', 'done']));
    expect(reopened.receipts.unresolved()).toEqual(golden.unresolved());
    for (const now of [Date.parse(startedAt) - 1, Date.parse(startedAt), Date.parse(startedAt) + 60_000]) {
      expect(reopened.receipts.accountWindow('personal', 60_000, now)).toEqual(golden.accountWindow('personal', 60_000, now));
    }
    expect(reopened.receipts.accountWindow('unknown', 60_000, Date.parse(startedAt))).toEqual(golden.accountWindow('unknown', 60_000, Date.parse(startedAt)));
  });

  it('reduces a full 4096-row synthetic hot state without dropping any unresolved or unselected receipt', () => {
    const rows = Array.from({ length: 4095 }, (_, index) => row('task-' + index));
    rows.push(row('active', { status: 'reserved', finishedAt: null, outputDigest: null, reason: 'worker-reserved' }));
    const f = fixture(state(rows)); const header = stage(f, ['task-0']);
    expect(header.hotState.attempts).toEqual(rows.slice(1)); expect(header.hotState.attempts).toHaveLength(4095);
    const reopened = readResourcePoolStorage(header, f.options);
    expect(reopened.receipts.getMany(['task-0', 'task-4094', 'active'])).toEqual(createResourcePoolReceiptQuery(rows).getMany(['task-0', 'task-4094', 'active']));
    expect(reopened.receipts.accountWindow('personal', 60_000, Date.parse(startedAt)).recentReservationCount).toBe(4096);
    expect(readFileSync(f.file, 'utf8')).toBe(f.bytes);
  });

  it('retries a nonpublished stage deterministically and chains another batch without rewriting the old root', () => {
    const f = fixture(state([row('done'), row('later')])); const first = stage(f); const retry = stage(f);
    expect(retry).toEqual(first);
    const second = stageResourcePoolReceiptCompaction(readResourcePoolStorage(first, f.options), ['later'], noGuard);
    expect(second.archiveCertificate.sequence).toBe(first.archiveCertificate.sequence + 1);
    expect(second.archiveCertificate.priorCertificateDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(second.hotState.attempts).toEqual([]);
    expect(readResourcePoolStorage(second, f.options).receipts.getMany(['done', 'later'])).toEqual(createResourcePoolReceiptQuery(f.source.attempts).getMany(['done', 'later']));
    expect(readResourcePoolStorage(first, f.options).receipts.get('done').status).toBe('found');
    expect(() => stageResourcePoolReceiptCompaction(readResourcePoolStorage(second, f.options), ['done'], noGuard)).toThrow();
    expect(readFileSync(f.file, 'utf8')).toBe(f.bytes);
  });

  it('rejects invalid selections before callbacks or archive publication', () => {
    const f = fixture(state([row('done'), row('reserved', { status: 'reserved', finishedAt: null, outputDigest: null }),
      row('uncertain', { status: 'uncertain', outputDigest: null })])); const view = f.open(); const guard = vi.fn(); const getter = vi.fn();
    const accessor = Object.defineProperty(['done'], '0', { enumerable: true, get: getter });
    for (const ids of [[], ['missing'], ['done', 'done'], ['reserved'], ['uncertain'], Array.from({ length: 9 }, (_, i) => 'task-' + i), accessor]) {
      expect(() => stageResourcePoolReceiptCompaction(view, ids, { guard })).toThrow();
    }
    expect(guard).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled(); expect(readdirSync(f.archive)).toEqual([]);
  });

  it('refuses pending evolution, invalid controls and invalid epochs before staging', () => {
    const f = fixture(); const pending = state(); pending.pendingEvolution = { planDigest: 'c'.repeat(64) };
    const invalidControl = state(); invalidControl.allocation!.ceilingPercent = 101;
    const invalidEpoch = state(); invalidEpoch.configurationHistory![0]!.poolDigest = 'd'.repeat(64);
    for (const source of [pending, invalidControl, invalidEpoch]) expect(() => readResourcePoolStorage(source, f.options)).toThrow();
    expect(readdirSync(f.archive)).toEqual([]); expect(readFileSync(f.file, 'utf8')).toBe(f.bytes);
  });

  it('rejects malformed headers, cold/hot overlap and signed certificate mutation, but not valid unsigned policy edits', () => {
    const f = fixture(state([row('done'), row('later')])); const header = stage(f);
    const changes: Array<(value: ResourcePoolArchiveHeader) => void> = [
      value => { value.hotState.schemaVersion = 1; delete value.hotState.configurationHistory; },
      value => { value.hotState.pendingEvolution = { planDigest: 'c'.repeat(64) }; },
      value => { value.hotState.attempts.push(row('done')); },
      value => { value.hotState.allocation!.ceilingPercent = 101; },
      value => { value.archiveCertificate.provenanceSig = '0'.repeat(64); },
      value => { value.archiveCertificate.archiveRoot.byId.count++; },
    ];
    for (const change of changes) { const value = structuredClone(header); change(value); expect(() => readResourcePoolStorage(value, f.options)).toThrow(); }
    const changed = structuredClone(header); changed.hotState.allocation!.ceilingPercent = 74;
    expect(readResourcePoolStorage(changed, f.options).hotState.allocation!.ceilingPercent).toBe(74);
    // A certificate attests cold derivation; the host remains responsible for header/policy freshness.
    expect(readResourcePoolStorage(header, f.options).sourceDigest).not.toBe(readResourcePoolStorage(changed, f.options).sourceDigest);
  });

  it('captures source and options privately rather than trusting mutated public view fields or forged views', () => {
    const f = fixture(state([row('done'), row('later')])); const original = structuredClone(f.source); const view = f.open();
    view.hotState.attempts.length = 0; view.hotState.allocation!.ceilingPercent = 1;
    if (view.source.schemaVersion !== 3) view.source.attempts.length = 0;
    f.source.attempts.length = 0; f.options.archiveKeyFile = join(f.root, 'missing.key'); f.options.pool.workers.length = 0;
    const header = stageResourcePoolReceiptCompaction(view, ['done'], noGuard);
    expect(header.hotState).toEqual({ ...original, attempts: [original.attempts[1]!] });
    expect(() => stageResourcePoolReceiptCompaction({ ...view }, ['done'], noGuard)).toThrow();
    expect(readFileSync(f.file, 'utf8')).toBe(f.bytes);
  });

  it('requires a host source guard: disk drift refuses staging without overwriting the changed source', () => {
    const f = fixture(); const view = f.open(); const changed = JSON.stringify({ ...f.source, observations: [] }, null, 2) + '\n';
    writeFileSync(f.file, changed); expect(view.isCurrent()).toBe(true);
    const guard = vi.fn(() => { if (readFileSync(f.file, 'utf8') !== f.bytes) throw new Error('fixture source changed'); });
    expect(() => stageResourcePoolReceiptCompaction(view, ['done'], { guard })).toThrow();
    expect(guard).toHaveBeenCalled(); expect(readFileSync(f.file, 'utf8')).toBe(changed);
    expect(readdirSync(f.archive)).toEqual([]);
  });

  it('retains the original schema3 key identity and refuses same-byte replacement before staging writes', () => {
    const f = fixture(state([row('done'), row('later')])); const header = stage(f);
    const view = readResourcePoolStorage(header, f.options); const previousFiles = files(f.archive).sort();
    renameSync(f.archiveKeyFile, f.archiveKeyFile + '-old');
    writeFileSync(f.archiveKeyFile, '11'.repeat(32) + '\n', { mode: 0o600 });
    expect(view.isCurrent()).toBe(false); const guard = vi.fn();
    expect(() => stageResourcePoolReceiptCompaction(view, ['later'], { guard })).toThrow();
    expect(guard).not.toHaveBeenCalled(); expect(files(f.archive).sort()).toEqual(previousFiles);
    expect(readFileSync(f.file, 'utf8')).toBe(f.bytes);
  });

  it('retains the staging certifier through final legacy source callbacks, including byte-identical key replacement', () => {
    const f = fixture(); const view = f.open(); stageResourcePoolReceiptCompaction(view, ['done'], noGuard);
    // Repeat the uninstalled legacy derivation to measure this exact existing-file path.
    let expectedCalls = 0;
    stageResourcePoolReceiptCompaction(view, ['done'], { guard() { expectedCalls++; } });
    expect(expectedCalls).toBeGreaterThan(0); let calls = 0;
    expect(() => stageResourcePoolReceiptCompaction(view, ['done'], { guard() {
      if (++calls === expectedCalls) {
        renameSync(f.archiveKeyFile, f.archiveKeyFile + '-old');
        writeFileSync(f.archiveKeyFile, '11'.repeat(32) + '\n', { mode: 0o600 });
      }
    } })).toThrow();
    expect(calls).toBe(expectedCalls); expect(view.isCurrent()).toBe(true);
    expect(readFileSync(f.file, 'utf8')).toBe(f.bytes);
  });

  it.each(['key', 'payload', 'archive-root'] as const)('fails fresh custody after %s loss rather than returning partial history or repairing storage', kind => {
    const f = fixture(); const header = stage(f); const view = readResourcePoolStorage(header, f.options); expect(view.isCurrent()).toBe(true);
    if (kind === 'key') unlinkSync(f.archiveKeyFile);
    if (kind === 'payload') unlinkSync(files(f.archive).find(file => file.includes('/records/'))!);
    if (kind === 'archive-root') renameSync(f.archive, f.archive + '-old');
    expect(view.isCurrent()).toBe(false); expect(() => readResourcePoolStorage(header, f.options)).toThrow();
    expect(() => view.receipts.get('done')).toThrow(); expect(readFileSync(f.file, 'utf8')).toBe(f.bytes);
  });

  it('keeps the legacy decoder boundary closed to schema3 and refuses descriptor hooks', () => {
    const f = fixture(); const getter = vi.fn(); const hostile = Object.defineProperty(state(), 'attempts', { enumerable: true, get: getter });
    expect(() => readResourcePoolStorage(hostile, f.options)).toThrow(); expect(getter).not.toHaveBeenCalled();
    const header = stage(f); expect(() => decodeResourcePoolState(header, pool, bindings)).toThrow();
    const injected = Object.defineProperty(structuredClone(header), 'archiveCertificate', { enumerable: true, get: getter });
    expect(() => readResourcePoolStorage(injected, f.options)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
});
