import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiGet } from './client.js';
import { resourceConsoleScopeQuery, resourceConsoleSnapshotQuery } from './resource-pool-queries.js';
import { resourceFixture } from '../routes/resources/fixtures.test-support.js';

vi.mock('./client.js', async (original) => ({ ...await original<typeof import('./client.js')>(), apiGet: vi.fn() }));
const read = vi.mocked(apiGet);
const NOW = '2026-09-07T12:00:00.000Z';
const NEXT = '2026-09-07T12:00:30.000Z';
function refresh(): Record<string, unknown> {
  return { schemaVersion: 1, scope: 'codex-native-metadata', state: 'running', sampledAt: NOW, workers: [{
    workerId: 'codex-a', status: 'observed', lastAttemptAt: NOW, lastSuccessAt: NOW, nextAttemptAt: NEXT,
    reason: 'managed-quota-observed' }] };
}
function row(value: Record<string, unknown>): Record<string, unknown> { return (value.workers as Record<string, unknown>[])[0]!; }
async function query(value?: unknown) {
  const { snapshot } = resourceFixture();
  read.mockResolvedValue({ ...snapshot, ...(value === undefined ? {} : { quotaRefresh: value }) });
  return resourceConsoleSnapshotQuery(snapshot.pool.id).fetch();
}
beforeEach(() => { vi.clearAllMocks(); });

describe('optional native quota response boundary', () => {
  it.each([undefined, null])('preserves legacy absence %#', async (value) => { await expect(query(value)).resolves.toBeDefined(); });
  it('accepts a bounded enrolled-Codex snapshot and forwards only the existing fixed endpoint', async () => {
    const value = refresh(); const output = await query(value); expect(output.quotaRefresh).toEqual(value);
    expect(read).toHaveBeenCalledWith('/api/resources', undefined);
  });
  it.each(['pending', 'refreshing', 'observed', 'failed', 'timed-out', 'cancelled', 'uncertain', 'expired', 'closed'])(
    'accepts documented %s metadata without treating it as task success', async (status) => {
      const value = refresh(); Object.assign(row(value), { status, reason: `managed-quota-${status}` });
      if (status === 'closed' || status === 'uncertain') { value.state = 'closed'; row(value).nextAttemptAt = null; }
      await expect(query(value)).resolves.toBeDefined();
    });
  it('accepts observed-but-exhausted/unknown states without converting them to readiness', async () => {
    for (const reason of ['managed-quota-reserve-reached', 'managed-quota-unknown']) {
      const value = refresh(); row(value).reason = reason; await expect(query(value)).resolves.toBeDefined();
    }
  });
  it.each([
    ['wrong version', (value: Record<string, unknown>) => { value.schemaVersion = 2; }],
    ['wrong scope', (value: Record<string, unknown>) => { value.scope = 'global-auth'; }],
    ['unknown collector state', (value: Record<string, unknown>) => { value.state = 'active'; }],
    ['bad sample time', (value: Record<string, unknown>) => { value.sampledAt = '2026-02-31T12:00:00.000Z'; }],
    ['empty roster', (value: Record<string, unknown>) => { value.workers = []; }],
    ['oversized roster', (value: Record<string, unknown>) => { value.workers = Array(33).fill(row(value)); }],
    ['duplicate rows', (value: Record<string, unknown>) => { value.workers = [row(value), row(value)]; }],
    ['unknown worker', (value: Record<string, unknown>) => { row(value).workerId = 'not-enrolled'; }],
    ['local worker', (value: Record<string, unknown>) => { row(value).workerId = 'local-a'; }],
    ['unsupported status', (value: Record<string, unknown>) => { row(value).status = 'accepted'; }],
    ['unknown reason', (value: Record<string, unknown>) => { row(value).reason = 'private@example.invalid'; }],
    ['bad attempt time', (value: Record<string, unknown>) => { row(value).lastAttemptAt = 'not-time'; }],
    ['bad success time', (value: Record<string, unknown>) => { row(value).lastSuccessAt = Infinity; }],
    ['bad retry time', (value: Record<string, unknown>) => { row(value).nextAttemptAt = 123; }],
    ['success without attempt', (value: Record<string, unknown>) => { row(value).lastAttemptAt = null; }],
    ['closed still scheduled', (value: Record<string, unknown>) => { value.state = 'closed'; row(value).status = 'closed'; }],
    ['closed claims running', (value: Record<string, unknown>) => { value.state = 'closed'; row(value).nextAttemptAt = null; }],
    ['private account field', (value: Record<string, unknown>) => { row(value).accountHint = 'a'.repeat(64); }],
    ['private snapshot field', (value: Record<string, unknown>) => { value.command = ['/private/wrapper']; }],
  ])('rejects %s rather than rendering an empty or successful panel', async (_label, change) => {
    const value = refresh(); change(value); await expect(query(value)).rejects.toThrow('did not match the selected pool');
  });
  it.each([undefined, false, true])('accepts the optional scope flag %#', async (flag) => {
    const { scope } = resourceFixture(); read.mockResolvedValue({ ...scope, quotaRefreshEnabled: flag });
    await expect(resourceConsoleScopeQuery.fetch()).resolves.toBeDefined();
  });
  it.each(['true', 1, null, {}])('rejects malformed scope flags %#', async (flag) => {
    const { scope } = resourceFixture(); read.mockResolvedValue({ ...scope, quotaRefreshEnabled: flag });
    await expect(resourceConsoleScopeQuery.fetch()).rejects.toThrow('did not establish an explicit');
  });
});
