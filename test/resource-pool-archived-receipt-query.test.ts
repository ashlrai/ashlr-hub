/** Pure composition tests with explicitly synthetic archive queries; no disk or dispatch proof. */
import { describe, expect, it, vi } from 'vitest';
import { createArchivedResourcePoolReceiptQuery } from '../src/core/resources/pool-archived-receipt-query.js';
import { emptyResourcePoolReceiptArchiveRoot, type ResourcePoolReceiptArchive } from '../src/core/resources/pool-receipt-archive.js';
import { createResourcePoolReceiptQuery, type ResourcePoolReceiptLookup } from '../src/core/resources/pool-receipt-query.js';
import type { ResourceTaskReceipt } from '../src/core/resources/pool-receipt-codec.js';

const NOW = Date.parse('2026-09-13T12:00:00.000Z');
function receipt(id: string, status: ResourceTaskReceipt['status'], offset = 0, capacityKey = 'account'): ResourceTaskReceipt {
  return { schemaVersion: 1, id, taskDigest: 'a'.repeat(64), poolDigest: 'b'.repeat(64),
    workerId: 'worker', capacityKey, status, startedAt: new Date(NOW + offset).toISOString(),
    finishedAt: status === 'reserved' ? null : new Date(NOW + offset + 1).toISOString(),
    outputDigest: null, inputTokens: null, outputTokens: null, reason: 'fixture', verifiedAccepted: false };
}
function fixture(cold: ResourceTaskReceipt[] = [], active: ResourceTaskReceipt[] = []) {
  const source = createResourcePoolReceiptQuery(cold);
  const root = emptyResourcePoolReceiptArchiveRoot();
  const archive: ResourcePoolReceiptArchive = {
    get: vi.fn((_root, id) => source.get(id)),
    getMany: vi.fn((_root, ids) => source.getMany(ids)),
    accountWindow: vi.fn((_root, key, window, now) => source.accountWindow(key, window, now)),
    page: vi.fn(() => { throw new Error('Pages must not establish receipt authority'); }),
    stage: vi.fn(() => { throw new Error('Query must not publish'); }),
  };
  const input = { active, archive, root };
  return { input, archive, root, create: () => createArchivedResourcePoolReceiptQuery(input) };
}

describe('active plus immutable archived receipt queries', () => {
  it('proves every active ID absent in one batch and merges exact lookups without pages', () => {
    const f = fixture([receipt('old', 'completed')], [receipt('live', 'reserved'), receipt('held', 'uncertain')]);
    const query = f.create();
    expect(f.archive.getMany).toHaveBeenCalledExactlyOnceWith(f.root, ['live', 'held']);
    expect(query.get('live')).toMatchObject({ status: 'found', id: 'live', receipt: { status: 'reserved' } });
    expect(f.archive.get).not.toHaveBeenCalled();
    expect(query.getMany(['old', 'live', 'missing', 'old', 'held'])).toEqual([
      { status: 'found', id: 'old', receipt: receipt('old', 'completed') },
      { status: 'found', id: 'live', receipt: receipt('live', 'reserved') },
      { status: 'proven-absent', id: 'missing' },
      { status: 'found', id: 'old', receipt: receipt('old', 'completed') },
      { status: 'found', id: 'held', receipt: receipt('held', 'uncertain') },
    ]);
    expect(f.archive.getMany).toHaveBeenLastCalledWith(f.root, ['old', 'missing']);
    expect(query.unresolved().map(row => row.id)).toEqual(['live', 'held']);
    expect(query.getMany([])).toEqual([]);
    expect(f.archive.page).not.toHaveBeenCalled(); expect(f.archive.stage).not.toHaveBeenCalled();
  });
  it('validates an empty archive sample even with no active receipts', () => {
    const f = fixture(); f.create(); expect(f.archive.getMany).toHaveBeenCalledExactlyOnceWith(f.root, []);
  });
  it('matches complete-array aggregation across capacities, strict boundaries, future starts and clock rollback', () => {
    const cold = [receipt('past', 'completed', -60_001), receipt('boundary', 'failed', -60_000),
      receipt('recent', 'cancelled', -59_999), receipt('future', 'timed-out', 10_000), receipt('other', 'failed', -2, 'other')];
    const active = [receipt('reserved', 'reserved', -60_000), receipt('uncertain', 'uncertain', 1), receipt('alias', 'reserved', -1, 'other')];
    const f = fixture(cold, active); const query = f.create(); const complete = createResourcePoolReceiptQuery([...cold, ...active]);
    for (const capacity of ['account', 'other', 'unused']) for (const window of [1, 60_000, 120_000]) {
      for (const now of [NOW - 1, NOW, NOW + 500_000]) expect(query.accountWindow(capacity, window, now))
        .toEqual(complete.accountWindow(capacity, window, now));
      expect(query.unresolved(capacity)).toEqual(complete.unresolved(capacity));
    }
  });
  it('preserves the pristine precondition cooldown exception without omitting its reservation', () => {
    const veto = { ...receipt('veto', 'failed'), reason: 'worker-dispatch-precondition-failed' };
    const f = fixture([veto], [receipt('active', 'uncertain', -1)]);
    expect(f.create().accountWindow('account', 60_000, NOW)).toEqual({ inFlightCount: 1, recentReservationCount: 2,
      earliestRecentStartedAtMs: NOW - 1, latestCooldownFailureFinishedAtMs: null });
  });
  it('detaches incoming root/active and returned receipts while retaining cold read failures', () => {
    const row = receipt('active', 'reserved'); const f = fixture([receipt('old', 'completed')], [row]); const query = f.create();
    row.status = 'completed'; f.input.active.length = 0; f.root.byId.count = 999;
    const first = query.get('active'); if (first.status === 'found') first.receipt.status = 'completed';
    query.unresolved()[0]!.capacityKey = 'changed';
    expect(query.get('active')).toMatchObject({ receipt: { status: 'reserved', capacityKey: 'account' } });
    query.get('old'); expect(vi.mocked(f.archive.get).mock.calls[0]![0].byId.count).toBe(0);
    vi.mocked(f.archive.get).mockImplementation(() => { throw new Error('PRIVATE_PAYLOAD_MISSING'); });
    expect(() => query.get('old')).toThrow(/^Resource receipt query unavailable$/);
  });
  it.each(['completed', 'failed', 'cancelled', 'timed-out'] as const)('rejects %s in the active root before archive contact', status => {
    const f = fixture([], [receipt('bad', status)]); expect(f.create).toThrow(); expect(f.archive.getMany).not.toHaveBeenCalled();
  });
  it('rejects duplicate active identities and archive overlap', () => {
    const duplicate = fixture([], [receipt('same', 'reserved'), receipt('same', 'uncertain')]);
    expect(duplicate.create).toThrow(); expect(duplicate.archive.getMany).not.toHaveBeenCalled();
    expect(fixture([receipt('same', 'completed')], [receipt('same', 'reserved')]).create).toThrow();
  });
  it.each(['missing', 'extra', 'foreign', 'unknown', 'sparse', 'getter', 'throws'] as const)(
    'rejects %s active-absence evidence', kind => {
      const f = fixture([], [receipt('live', 'reserved')]); const getter = vi.fn();
      vi.mocked(f.archive.getMany).mockImplementation(() => {
        if (kind === 'throws') throw new Error('PRIVATE_ARCHIVE_ERROR');
        if (kind === 'missing') return [];
        if (kind === 'extra') return [{ status: 'proven-absent', id: 'live' }, { status: 'proven-absent', id: 'extra' }];
        if (kind === 'sparse') return new Array<ResourcePoolReceiptLookup>(1);
        if (kind === 'getter') return [Object.defineProperty({}, 'status', { enumerable: true, get: getter })] as ResourcePoolReceiptLookup[];
        return [{ status: kind === 'unknown' ? 'unavailable' : 'proven-absent', id: kind === 'foreign' ? 'other' : 'live' }] as ResourcePoolReceiptLookup[];
      });
      expect(f.create).toThrow(/^Resource receipt query unavailable$/); expect(getter).not.toHaveBeenCalled();
    });
  it.each(['foreign-envelope', 'foreign-receipt', 'active', 'unknown', 'throws'] as const)('rejects %s cold lookup outcomes', kind => {
    const f = fixture(); const query = f.create();
    vi.mocked(f.archive.get).mockImplementation(() => {
      if (kind === 'throws') throw new Error('PRIVATE');
      if (kind === 'unknown') return { status: 'missing', id: 'old' } as unknown as ResourcePoolReceiptLookup;
      return { status: 'found', id: kind === 'foreign-envelope' ? 'foreign' : 'old',
        receipt: receipt(kind === 'foreign-receipt' ? 'foreign' : 'old', kind === 'active' ? 'uncertain' : 'completed') };
    });
    expect(() => query.get('old')).toThrow(/^Resource receipt query unavailable$/);
  });
  it.each(['inflight', 'overflow', 'count-time-mismatch', 'boundary', 'nan', 'fractional-time'] as const)(
    'rejects malformed %s archive accounting', kind => {
      const f = fixture([], [receipt('live', 'reserved')]); const query = f.create();
      vi.mocked(f.archive.accountWindow).mockReturnValue({ inFlightCount: kind === 'inflight' ? 1 : 0,
        recentReservationCount: kind === 'overflow' ? Number.MAX_SAFE_INTEGER : kind === 'nan' ? NaN : 1,
        earliestRecentStartedAtMs: kind === 'count-time-mismatch' ? null : kind === 'boundary' ? NOW - 60_000 : kind === 'fractional-time' ? NOW + 0.5 : NOW,
        latestCooldownFailureFinishedAtMs: null });
      expect(() => query.accountWindow('account', 60_000, NOW)).toThrow(/^Resource receipt query unavailable$/);
    });
  it('does not materialize lifetime history to answer a large indexed count', () => {
    const f = fixture(); const query = f.create();
    vi.mocked(f.archive.accountWindow).mockReturnValue({ inFlightCount: 0, recentReservationCount: 10_000_000,
      earliestRecentStartedAtMs: NOW, latestCooldownFailureFinishedAtMs: null });
    expect(query.accountWindow('account', 60_000, NOW).recentReservationCount).toBe(10_000_000);
    expect(f.archive.get).not.toHaveBeenCalled(); expect(f.archive.getMany).toHaveBeenCalledTimes(1);
    expect(f.archive.page).not.toHaveBeenCalled();
  });
  it('captures input descriptors before invoking the archive', () => {
    const f = fixture(); const getter = vi.fn();
    Object.defineProperty(f.input, 'active', { enumerable: true, get: getter });
    expect(f.create).toThrow(); expect(getter).not.toHaveBeenCalled(); expect(f.archive.getMany).not.toHaveBeenCalled();
  });
  it('retains arbitrary request order and duplicates across 4096-ID batches on one detached root', () => {
    const f = fixture([receipt('task-0', 'completed')]); const query = f.create();
    const ids = Array.from({ length: 4353 }, (_, index) => `task-${index}`);
    ids[4096] = 'task-0'; ids[4352] = 'task-0'; const expectedIds = [...ids];
    const actualGetMany = f.archive.getMany;
    vi.mocked(f.archive.getMany).mockClear();
    f.archive.getMany = vi.fn((root, requested) => {
      expect(requested.length).toBeLessThanOrEqual(4096);
      expect(root).toEqual(emptyResourcePoolReceiptArchiveRoot());
      ids[0] = 'changed'; ids[4200] = 'changed'; f.root.byId.count = 3;
      const response = actualGetMany(root, requested); root.byId.count = 99; return response;
    });
    const rows = query.getMany(ids);
    expect(rows.map(row => row.id)).toEqual(expectedIds);
    expect(f.archive.getMany).toHaveBeenCalledTimes(2);
    expect(rows[0]).toMatchObject({ status: 'found', receipt: { id: 'task-0' } });
    if (rows[0]!.status === 'found') rows[0]!.receipt.reason = 'changed';
    expect(rows[4096]).toMatchObject({ receipt: { reason: 'fixture' } });
    expect(rows[4352]).toMatchObject({ receipt: { reason: 'fixture' } });
  });
  it('bounds active-root absence to one hot-state batch, not lifetime history', () => {
    const f = fixture([], Array.from({ length: 4097 }, (_, index) => receipt(`active-${index}`, 'reserved')));
    expect(f.create).toThrow(); expect(f.archive.getMany).not.toHaveBeenCalled();
  });
  it('isolates root arguments for constructor, point lookup and account calls', () => {
    const active = receipt('live', 'reserved'); const f = fixture([receipt('old', 'completed')], [active]);
    const getMany = f.archive.getMany; const get = f.archive.get; const window = f.archive.accountWindow;
    const sampledCounts: number[] = [];
    f.archive.getMany = (root, ids) => {
      sampledCounts.push(root.byId.count); root.byId.count = 1; active.status = 'completed'; f.root.byId.count = 2;
      return getMany(root, ids);
    };
    f.archive.get = (root, id) => { sampledCounts.push(root.byId.count); root.byId.count = 3; return get(root, id); };
    f.archive.accountWindow = (root, ...args) => {
      sampledCounts.push(root.byId.count); root.byId.count = 4; return window(root, ...args);
    };
    const query = f.create(); expect(query.get('live')).toMatchObject({ receipt: { status: 'reserved' } });
    query.get('old'); query.accountWindow('account', 60_000, NOW); query.accountWindow('account', 60_000, NOW);
    expect(sampledCounts).toEqual([0, 0, 0, 0]);
  });
  it('does not let an archive callback erase the requested active absence proof', () => {
    const f = fixture([], [receipt('live', 'reserved')]);
    f.archive.getMany = (_root, ids) => { (ids as string[]).length = 0; return []; };
    expect(f.create).toThrow(/^Resource receipt query unavailable$/);
  });
  it('does not accept a sparse or accessor request list or read its getters', () => {
    const f = fixture(); const query = f.create(); const getter = vi.fn();
    const ids = ['old']; Object.defineProperty(ids, '0', { enumerable: true, get: getter });
    expect(() => query.getMany(ids)).toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(() => query.getMany(new Array<string>(1))).toThrow(); expect(f.archive.getMany).toHaveBeenCalledTimes(1);
  });
  it('rejects an asynchronous archive instead of leaving a rejected promise unhandled', async () => {
    const f = fixture();
    vi.mocked(f.archive.getMany).mockImplementation(() => Promise.reject(new Error('PRIVATE')) as unknown as ResourcePoolReceiptLookup[]);
    expect(f.create).toThrow(/^Resource receipt query unavailable$/);
    await Promise.resolve();
  });
});
