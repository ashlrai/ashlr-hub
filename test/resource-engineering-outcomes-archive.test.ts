/** Real archive/certificate/header reads. Campaign/evaluator projections are
 * controlled fixture mocks, not live delivery or provider acceptance evidence. */
import { cpSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import * as delivery from '../src/core/universe/delivery.js';
import * as reader from '../src/core/resources/pool-state-reader.js';
import { readResourcePoolStorage, stageResourcePoolReceiptCompaction,
  type ResourcePoolStoredState } from '../src/core/resources/pool-state-storage.js';
import { cleanupEngineeringOutcomesFixtures, createEngineeringOutcomesFixture,
  engineeringOutcomesFixtureTree as tree } from './helpers/resource-engineering-outcomes-fixture.js';

afterEach(cleanupEngineeringOutcomesFixtures);
function fixture() {
  const f = createEngineeringOutcomesFixture(); const generated = f.add(1, true);
  const archiveKeyFile = join(f.root, 'receipt-archive.key');
  mkdirSync(join(f.root, 'receipt-archive'), { mode: 0o700 });
  writeFileSync(archiveKeyFile, '11'.repeat(32) + '\n', { mode: 0o600 });
  const runtime = { ...f.runtime, archiveKeyFile }; f.save(f.options.host.resourceRuntime, runtime);
  f.options.host.expectedRuntimeDigest = digest(canonical(runtime));
  const settings = { root: f.root, pool: f.pool, bindings: f.bindings, archiveKeyFile };
  const stage = (source: ResourcePoolStoredState = f.state) => stageResourcePoolReceiptCompaction(
    readResourcePoolStorage(source, settings), [generated.receipt.id], { guard() {} });
  const publish = (source: ResourcePoolStoredState) => f.save(join(f.root, 'pool-state.json'), source);
  return { ...f, generated, archiveKeyFile, runtime, stage, publish };
}
function withoutSample<T extends { sampledAt: string }>(report: T) { return { ...report, sampledAt: '<sample>' }; }
function secondSample(action: () => void) {
  const original = reader.readResourcePoolStorageSnapshot; let count = 0;
  return vi.spyOn(reader, 'readResourcePoolStorageSnapshot').mockImplementation((...args) => {
    if (++count === 2) action();
    return original(...args);
  });
}

describe('engineering outcomes across real immutable receipt storage', () => {
  it('observes equal complete logical history from legacy and installed schema3 without writing', () => {
    const f = fixture(); const before = tree(f.outer); const legacy = f.read();
    expect(legacy.sourceState).toBe('healthy'); expect(tree(f.outer)).toBe(before);
    const header = f.stage(); f.publish(header); const installed = tree(f.outer);
    const archived = f.read(); expect(withoutSample(archived)).toEqual(withoutSample(legacy));
    expect(tree(f.outer)).toBe(installed); expect(archived.productionAccepted).toBeNull(); expect(archived.routingChanged).toBe(false);
  });
  it('allows exact physical compaction between samples, with explicit fixture publication', () => {
    const f = fixture(); const expected = f.read(); const header = f.stage(); let published = '';
    const read = secondSample(() => { f.publish(header); published = tree(f.outer); });
    const report = f.read(); expect(read).toHaveBeenCalledTimes(3);
    expect(withoutSample(report)).toEqual(withoutSample(expected)); expect(tree(f.outer)).toBe(published);
  });
  it.each(['addition', 'mutation'] as const)('invalidates unreferenced receipt %s through the real zero-change comparison budget', kind => {
    const f = fixture(); const unrelated = { ...f.generated.receipt, id: 'unrelated' };
    if (kind === 'mutation') { f.state.attempts.push(unrelated); f.write(); }
    const header = f.stage(); f.publish(header); let published = '';
    secondSample(() => {
      if (kind === 'addition') header.hotState.attempts.push(unrelated);
      else header.hotState.attempts[0]!.reason = 'changed-unrelated';
      f.publish(header); published = tree(f.outer);
    });
    const report = f.read(); expect(report).toMatchObject({ sourceState: 'degraded', complete: false,
      reasons: ['evidence-changed-during-sampling'], usage: { complete: false, totalTokens: null },
      timing: { complete: false, totalDurationMs: null } });
    expect(tree(f.outer)).toBe(published);
  });
  it('ignores control-only changes without equating those controls or writing anything itself', () => {
    const f = fixture(); const header = f.stage(); f.publish(header); const expected = f.read(); let published = '';
    secondSample(() => {
      header.hotState.allocation = { ceilingPercent: 75, revision: 1, updatedAt: '2026-09-10T00:00:00.000Z' };
      header.hotState.workerAccess = { pausedWorkerIds: ['worker'], revision: 1, updatedAt: '2026-09-10T00:00:00.000Z' };
      f.publish(header); published = tree(f.outer);
    });
    expect(withoutSample(f.read())).toEqual(withoutSample(expected)); expect(tree(f.outer)).toBe(published);
  });
  it.each(['legacy', 'archived'] as const)('ignores excluded controls and observations written during the first %s sample', layout => {
    const f = fixture(); const source = layout === 'archived' ? f.stage() : f.state;
    f.publish(source); const expected = f.read(); let published = '';
    // This projection is reached AFTER the real reader has captured its source
    // and joined the task receipt. Only campaign projections are controlled;
    // ledger acquisition, validation, comparison and file writes are real.
    vi.mocked(delivery.readUniverseDeliveries).mockImplementationOnce(() => {
      const hot = source.schemaVersion === 3 ? source.hotState : source;
      hot.allocation = { ceilingPercent: 75, revision: 1, updatedAt: '2026-09-10T00:00:01.000Z' };
      hot.workerAccess = { pausedWorkerIds: ['worker'], revision: 1, updatedAt: '2026-09-10T00:00:01.000Z' };
      hot.observations = [{ workerId: 'worker', health: 'ready', windows: [], retryAfter: null,
        observedAt: '2026-09-10T00:00:01.000Z', expiresAt: '2026-09-10T00:01:01.000Z' }];
      f.publish(source); published = tree(f.outer);
      return { sourceState: 'missing', deliveries: [], reasons: [] };
    });
    expect(withoutSample(f.read())).toEqual(withoutSample(expected));
    expect(tree(f.outer)).toBe(published);
  });
  it('allows excluded refresh writes during both samples without claiming unchanged scheduling controls', () => {
    const f = fixture(); const header = f.stage(); f.publish(header); const expected = f.read();
    let calls = 0; let published = '';
    vi.mocked(delivery.readUniverseDeliveries).mockImplementation(() => {
      header.hotState.allocation = { ceilingPercent: 75, revision: ++calls, updatedAt: '2026-09-10T00:00:01.000Z' };
      f.publish(header); published = tree(f.outer);
      return { sourceState: 'missing', deliveries: [], reasons: [] };
    });
    expect(withoutSample(f.read())).toEqual(withoutSample(expected));
    expect(calls).toBe(2); expect(tree(f.outer)).toBe(published);
  });
  it('allows receipt-identical compaction during the first sample after strict source acquisition', () => {
    const f = fixture(); const expected = f.read(); const header = f.stage(); let published = '';
    vi.mocked(delivery.readUniverseDeliveries).mockImplementationOnce(() => {
      f.publish(header); published = tree(f.outer);
      return { sourceState: 'missing', deliveries: [], reasons: [] };
    });
    expect(withoutSample(f.read())).toEqual(withoutSample(expected));
    expect(tree(f.outer)).toBe(published);
  });
  it.each([1, 2])('still invalidates an unrelated receipt added during sample %i after its capture', sample => {
    const f = fixture(); const header = f.stage(); f.publish(header); let published = ''; let calls = 0;
    vi.mocked(delivery.readUniverseDeliveries).mockImplementation(() => {
      if (++calls === sample) {
        header.hotState.attempts.push({ ...f.generated.receipt, id: 'added-during-sample' });
        f.publish(header); published = tree(f.outer);
      }
      return { sourceState: 'missing', deliveries: [], reasons: [] };
    });
    expect(f.read()).toMatchObject({ sourceState: 'degraded', complete: false,
      reasons: ['evidence-changed-during-sampling'], usage: { totalTokens: null } });
    expect(calls).toBe(2); expect(tree(f.outer)).toBe(published);
  });
  it('refuses a byte-identical private root replacement during the second sample', () => {
    const f = fixture(); const file = join(f.root, 'pool-state.json'); const original = readFileSync(file);
    let calls = 0; let replaced = '';
    vi.mocked(delivery.readUniverseDeliveries).mockImplementation(() => {
      if (++calls === 2) {
        const retired = join(f.outer, 'retired-ledger'); renameSync(f.root, retired);
        mkdirSync(f.root, { mode: 0o700 }); cpSync(retired, f.root, { recursive: true });
        expect(readFileSync(file)).toEqual(original);
        // The replacement is independently valid, not a permissions fixture
        // failure: only the earlier sample's retained root identity must fail.
        expect(reader.readResourcePoolStorageSnapshot(f.root, f.pool, f.bindings, f.archiveKeyFile).isCurrent()).toBe(true);
        replaced = tree(f.outer);
      }
      return { sourceState: 'missing', deliveries: [], reasons: [] };
    });
    expect(f.read()).toMatchObject({ sourceState: 'degraded', complete: false,
      reasons: ['evidence-changed-during-sampling'], usage: { totalTokens: null } });
    expect(calls).toBe(2); expect(tree(f.outer)).toBe(replaced);
  });
  it('still withholds archive custody lost during the first sample', () => {
    const f = fixture(); f.publish(f.stage()); let damaged = '';
    vi.mocked(delivery.readUniverseDeliveries).mockImplementationOnce(() => {
      unlinkSync(f.archiveKeyFile); damaged = tree(f.outer);
      return { sourceState: 'missing', deliveries: [], reasons: [] };
    });
    const report = f.read(); expect(report.sourceState).not.toBe('healthy');
    expect(report.complete).toBe(false); expect(report.usage.totalTokens).toBeNull();
    expect(tree(f.outer)).toBe(damaged);
  });
  it.each(['key', 'payload'] as const)('withholds unavailable %s evidence instead of inventing zero usage or repairing files', kind => {
    const f = fixture(); f.publish(f.stage());
    const payload = readdirSync(join(f.root, 'receipt-archive'), { recursive: true, withFileTypes: true })
      .find(row => row.isFile() && row.parentPath.includes('/records'));
    expect(payload).toBeDefined(); unlinkSync(kind === 'key' ? f.archiveKeyFile : join(payload!.parentPath, payload!.name));
    const damaged = tree(f.outer); const report = f.read();
    expect(report.sourceState).not.toBe('healthy'); expect(report.complete).toBe(false);
    expect(report.usage.totalTokens).toBeNull(); expect(report.timing.totalDurationMs).toBeNull();
    expect(tree(f.outer)).toBe(damaged);
  });
  it('rejects a changed runtime key pin before any ledger/key reader is invoked', () => {
    const f = fixture(); f.publish(f.stage());
    f.save(f.options.host.resourceRuntime, { ...f.runtime, archiveKeyFile: join(f.root, 'alternate.key') });
    const snapshot = vi.spyOn(reader, 'readResourcePoolStorageSnapshot'); const before = tree(f.outer);
    const report = f.read(); expect(snapshot).not.toHaveBeenCalled();
    expect(report).toMatchObject({ sourceState: 'unavailable', complete: false, usage: { totalTokens: null } });
    expect(tree(f.outer)).toBe(before);
  });
  it('joins a campaign receipt beyond4096 total logical identities without materializing a recent page as history', () => {
    const f = fixture(); const header = f.stage();
    header.hotState.attempts = Array.from({ length: 4096 }, (_, index) => ({ ...f.generated.receipt, id: `unrelated-${index}` }));
    f.publish(header); const before = tree(f.outer); const report = f.read();
    expect(report).toMatchObject({ sourceState: 'healthy', usage: { attempts: 1, joinedAttempts: 1, totalTokens: 30 } });
    expect(header.archiveCertificate.archiveRoot.byId.count + header.hotState.attempts.length).toBe(4097);
    expect(report.campaigns[0]!.usage.joinedAttempts).toBe(1); expect(tree(f.outer)).toBe(before);
  });
});
