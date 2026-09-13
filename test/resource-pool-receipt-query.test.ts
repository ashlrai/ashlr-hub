/** Synthetic, pure complete-array query tests. No disk archive or >4096 task execution is claimed. */
import { describe, expect, it, vi } from 'vitest';
import { createResourcePoolReceiptQuery } from '../src/core/resources/pool-receipt-query.js';
import { checkedResourceTaskReceipt, type ResourceTaskReceipt } from '../src/core/resources/pool-receipt-codec.js';
import { resourcePoolConfigSnapshot } from '../src/core/resources/pool-evolution-policy.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

const NOW = Date.parse('2026-09-13T12:00:00.000Z');
const pool: ResourcePool = { schemaVersion: 1, id: 'query-fixture', workers: ['worker-a', 'worker-b', 'worker-c'].map(id => ({
  id, provider: 'codex', model: 'fixture', maxConcurrent: 2, reservePercent: 10, maxTasksPerWindow: 20, taskWindowMs: 60_000, priority: 1,
})) };
const bindings: ResourceBinding[] = pool.workers.map(worker => ({ workerId: worker.id,
  capacityKey: worker.id === 'worker-c' ? 'other-account' : 'shared-account', kind: 'native-cli', command: ['/inert/worker'] }));
const epoch = resourcePoolConfigSnapshot(pool, bindings);
const states: ResourceTaskReceipt['status'][] = ['reserved', 'completed', 'failed', 'timed-out', 'cancelled', 'uncertain'];
function receipt(index = 0, patch: Partial<ResourceTaskReceipt> = {}): ResourceTaskReceipt {
  const status = patch.status ?? 'completed';
  return { schemaVersion: 1, id: `task-${index}`, taskDigest: 'a'.repeat(64), poolDigest: epoch.poolDigest,
    workerId: 'worker-a', capacityKey: 'shared-account', status, startedAt: new Date(NOW + index).toISOString(),
    finishedAt: status === 'reserved' ? null : new Date(NOW + index + 1).toISOString(),
    outputDigest: status === 'completed' ? 'b'.repeat(64) : null, inputTokens: null, outputTokens: null,
    reason: 'worker-result', verifiedAccepted: false, ...patch };
}
// The original plan's receipt-only fold, intentionally independent of the new index.
function original(rows: readonly ResourceTaskReceipt[], capacity: string, windowMs: number, nowMs: number) {
  const attempts = rows.filter(row => row.capacityKey === capacity);
  const terminal = new Set(['completed', 'failed', 'timed-out', 'cancelled']);
  const recent = attempts.filter(row => Date.parse(row.startedAt) > nowMs - windowMs);
  const failures = attempts.filter(row => (row.status === 'failed' || row.status === 'timed-out') &&
    !(row.status === 'failed' && row.reason === 'worker-dispatch-precondition-failed' && row.execution === undefined &&
      row.nativeProcess === undefined && row.outputDigest === null && row.inputTokens === null && row.outputTokens === null));
  return { inFlightCount: attempts.filter(row => !terminal.has(row.status)).length, recentReservationCount: recent.length,
    earliestRecentStartedAtMs: recent.length ? Math.min(...recent.map(row => Date.parse(row.startedAt))) : null,
    latestCooldownFailureFinishedAtMs: failures.map(row => Date.parse(row.finishedAt!)).sort((left, right) => right - left)[0] ?? null };
}

describe('internal complete receipt-array queries', () => {
  it('matches the original fold across aliases, epochs, windows, future starts and clock rollback', () => {
    const offsets = [-120_001, -120_000, -60_001, -60_000, -59_999, -1, 0, 1, 60_000];
    const rows = offsets.flatMap((offset, i) => states.map((status, j) => receipt(i * states.length + j, {
      status, workerId: j % 3 === 0 ? 'worker-c' : j % 2 ? 'worker-a' : 'worker-b',
      capacityKey: j % 3 === 0 ? 'other-account' : 'shared-account',
      startedAt: new Date(NOW + offset).toISOString(), finishedAt: status === 'reserved' ? null : new Date(NOW + offset + 1).toISOString(),
    })));
    for (const row of rows) expect(checkedResourceTaskReceipt(row, epoch.poolDigest, bindings, pool)).toBe(true);
    // Epoch identity is preserved, not relabelled by the query. The caller is
    // responsible for supplying the originating epoch's validation evidence.
    rows[1]!.poolDigest = 'c'.repeat(64);
    const query = createResourcePoolReceiptQuery(rows.reverse());
    for (const capacity of ['shared-account', 'other-account', 'unused-account']) {
      for (const windowMs of [1, 1_000, 60_000, 120_000, 604_800_000]) {
        for (const nowMs of [NOW - 120_000, NOW, NOW + 60_000, NOW + 700_000_000]) {
          expect(query.accountWindow(capacity, windowMs, nowMs)).toEqual(original(rows, capacity, windowMs, nowMs));
        }
      }
    }
  });
  it('excludes the exact lower boundary but includes future, failed and cancelled reservations', () => {
    const rows = [-1_001, -1_000, -999, 100].map((offset, index) => receipt(index, { status: index === 2 ? 'cancelled' : 'failed',
      startedAt: new Date(NOW + offset).toISOString(), finishedAt: new Date(NOW + offset + 1).toISOString() }));
    expect(createResourcePoolReceiptQuery(rows).accountWindow('shared-account', 1_000, NOW)).toEqual({
      inFlightCount: 0, recentReservationCount: 2, earliestRecentStartedAtMs: NOW - 999, latestCooldownFailureFinishedAtMs: NOW + 101,
    });
  });
  it('keeps uncertain receipts in flight, regardless of finishedAt', () => {
    const rows = states.map((status, index) => receipt(index, { status })); const query = createResourcePoolReceiptQuery(rows);
    expect(query.unresolved()).toEqual([rows[0], rows[5]]);
    expect(query.unresolved('shared-account')).toEqual(query.unresolved());
    expect(query.unresolved('other-account')).toEqual([]);
    expect(query.accountWindow('shared-account', 1, NOW + 10_000).inFlightCount).toBe(2);
  });
  it('never uses a clean precondition veto as a provider failure, but still counts its reservation', () => {
    const veto = receipt(20, { status: 'failed', reason: 'worker-dispatch-precondition-failed' });
    const failure = receipt(1, { status: 'timed-out' });
    const query = createResourcePoolReceiptQuery([failure, veto]);
    expect(query.accountWindow('shared-account', 60_000, NOW)).toEqual({ inFlightCount: 0, recentReservationCount: 2,
      earliestRecentStartedAtMs: NOW + 1, latestCooldownFailureFinishedAtMs: NOW + 2 });
    expect(createResourcePoolReceiptQuery([veto]).accountWindow('shared-account', 60_000, NOW).latestCooldownFailureFinishedAtMs).toBeNull();
  });
  it.each([
    { execution: { schemaVersion: 1, scope: 'worker-execution', durationMs: null, usageScope: null } },
    { nativeProcess: { schemaVersion: 1, scope: 'native-process', exitCode: 1, signal: null, stderrPresent: false, outputTruncated: false } },
    { outputDigest: 'd'.repeat(64) }, { inputTokens: 0, outputTokens: 0 }, { reason: 'different-failure' }, { status: 'timed-out' },
  ] satisfies Partial<ResourceTaskReceipt>[])('preserves every discriminator of the precondition exception %#', patch => {
    const row = receipt(10, { status: 'failed', reason: 'worker-dispatch-precondition-failed', ...patch });
    expect(createResourcePoolReceiptQuery([row]).accountWindow('shared-account', 60_000, NOW).latestCooldownFailureFinishedAtMs).toBe(NOW + 11);
  });
  it('returns explicit per-ID absence, preserves request order, and does not fabricate usage', () => {
    const row = receipt(); const query = createResourcePoolReceiptQuery([row]);
    expect(query.getMany(['missing', row.id, 'missing'])).toEqual([
      { status: 'proven-absent', id: 'missing' }, { status: 'found', id: row.id, receipt: row }, { status: 'proven-absent', id: 'missing' },
    ]);
    expect(query.get(row.id)).toMatchObject({ receipt: { inputTokens: null, outputTokens: null } });
    expect(query.get(row.id)).not.toHaveProperty('receipt.execution');
  });
  it('detaches input and returned receipt objects, including nested optional metadata', () => {
    const row = receipt(0, { status: 'uncertain', execution: { schemaVersion: 1, scope: 'worker-execution', durationMs: 15, usageScope: null },
      origin: { kind: 'engineering-successor-proposal', scopeDigest: 'c'.repeat(64), proposalKey: 'd'.repeat(48) },
      id: `proposal-${'d'.repeat(48)}` });
    const expected = structuredClone(row); const rows = [row]; const query = createResourcePoolReceiptQuery(rows);
    row.capacityKey = 'other-account'; row.execution!.durationMs = 999; rows.push(receipt(1));
    const first = query.get(expected.id); expect(first.status).toBe('found');
    if (first.status !== 'found') throw new Error('Expected fixture result');
    first.receipt.execution!.durationMs = 500;
    if (first.receipt.origin?.kind === 'engineering-successor-proposal') first.receipt.origin.scopeDigest = 'f'.repeat(64);
    const open = query.unresolved(); open[0]!.reason = 'changed'; open.length = 0;
    expect(query.get(expected.id)).toEqual({ status: 'found', id: expected.id, receipt: expected });
    expect(query.get('task-1')).toEqual({ status: 'proven-absent', id: 'task-1' });
    expect(query.unresolved()).toEqual([expected]);
    expect(query.accountWindow('shared-account', 60_000, NOW).inFlightCount).toBe(1);
    expect(query.accountWindow('other-account', 60_000, NOW).recentReservationCount).toBe(0);
  });
  it('has no 4096 lifetime ceiling in the synthetic query layer', () => {
    const rows = Array.from({ length: 8_193 }, (_, index) => receipt(index));
    const query = createResourcePoolReceiptQuery(rows);
    expect(query.get('task-8192')).toEqual({ status: 'found', id: 'task-8192', receipt: rows[8192] });
    expect(query.accountWindow('shared-account', 60_000, NOW).recentReservationCount).toBe(8_193);
    expect(query.accountWindow('shared-account', 1, NOW + 8_193).recentReservationCount).toBe(0);
  });
  it('uses numerical chronology for canonical extended years', () => {
    const row = receipt(0, { status: 'failed', startedAt: '+010000-01-01T00:00:00.000Z', finishedAt: '+010000-01-01T00:00:00.001Z' });
    const prior = receipt(1, { status: 'failed', startedAt: '9999-12-31T23:59:59.998Z', finishedAt: '9999-12-31T23:59:59.999Z' });
    const query = createResourcePoolReceiptQuery([row, prior]);
    expect(query.accountWindow('shared-account', 2, Date.parse(row.startedAt))).toEqual({ inFlightCount: 0,
      recentReservationCount: 1, earliestRecentStartedAtMs: Date.parse(row.startedAt), latestCooldownFailureFinishedAtMs: Date.parse(row.finishedAt!) });
  });
  it('preserves legacy ID acceptance and refuses trailing newline identities', () => {
    const row = receipt(0, { id: 't'.repeat(64) });
    expect(checkedResourceTaskReceipt(row, epoch.poolDigest, bindings, pool)).toBe(true);
    expect(createResourcePoolReceiptQuery([row]).get(row.id)).toEqual({ status: 'found', id: row.id, receipt: row });
    row.id += '\n';
    expect(checkedResourceTaskReceipt(row, epoch.poolDigest, bindings, pool)).toBe(false);
    expect(() => createResourcePoolReceiptQuery([row])).toThrow('unavailable');
  });
  it.each([null, {}, new Array(1), [receipt(), receipt()], [receipt(0, { startedAt: 'bad' })],
    [receipt(0, { status: 'invented' as ResourceTaskReceipt['status'] })]])('rejects non-indexable input %#', value => {
    expect(() => createResourcePoolReceiptQuery(value as ResourceTaskReceipt[])).toThrow('Resource receipt query unavailable');
  });
  it.each(['array-getter', 'row-getter', 'nested-getter', 'proxy', 'nested-proxy', 'cycle'])('refuses %s before executing user code', kind => {
    const invoked = vi.fn(() => 'PRIVATE'); const row = receipt(); const rows = [row];
    if (kind === 'array-getter') Object.defineProperty(rows, '0', { enumerable: true, get: invoked });
    if (kind === 'row-getter') Object.defineProperty(row, 'reason', { enumerable: true, get: invoked });
    if (kind === 'nested-getter') {
      row.execution = { schemaVersion: 1, scope: 'worker-execution', durationMs: 1, usageScope: null };
      Object.defineProperty(row.execution, 'durationMs', { enumerable: true, get: invoked });
    }
    if (kind === 'proxy') rows[0] = new Proxy(row, { get: invoked });
    if (kind === 'nested-proxy') row.execution = new Proxy({ schemaVersion: 1 as const, scope: 'worker-execution' as const, durationMs: 1, usageScope: null }, { get: invoked });
    if (kind === 'cycle') Object.assign(row, { circular: row });
    expect(() => createResourcePoolReceiptQuery(rows)).toThrow('Resource receipt query unavailable'); expect(invoked).not.toHaveBeenCalled();
  });
  it('rejects invalid query arguments without converting uncertainty into absence or zero', () => {
    const query = createResourcePoolReceiptQuery([]);
    for (const id of ['', '../task', null, 42]) expect(() => query.get(id as string)).toThrow('unavailable');
    for (const ids of [null, new Array(1), ['../task']]) expect(() => query.getMany(ids as string[])).toThrow('unavailable');
    expect(() => query.unresolved('../account')).toThrow('unavailable');
    for (const window of [0, -1, 0.5, NaN, Infinity]) expect(() => query.accountWindow('account', window, NOW)).toThrow('unavailable');
    for (const now of [NaN, Infinity, -Infinity, '2026']) expect(() => query.accountWindow('account', 1, now as number)).toThrow('unavailable');
    expect(query.accountWindow('account', 1, NOW)).toEqual({ inFlightCount: 0, recentReservationCount: 0,
      earliestRecentStartedAtMs: null, latestCooldownFailureFinishedAtMs: null });
  });
});
