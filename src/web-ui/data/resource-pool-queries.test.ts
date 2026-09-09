import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiGet, apiPost } from './client.js';
import { clearMutationToken, getMutationToken, setMutationToken } from './auth-store.js';
import { resourceConsoleScopeQuery, resourceConsoleSnapshotQuery, setResourceAllocation, setResourceWorkerAccessControl } from './resource-pool-queries.js';
import { resourceFixture } from '../routes/resources/fixtures.test-support.js';
import { RESOURCE_COLLECTOR_RECOVERY_REASONS, RESOURCE_COLLECTOR_RECOVERY_MARKER_VERSIONS } from '../../core/resources/console-types.js';

vi.mock('./client.js', async (original) => ({ ...await original<typeof import('./client.js')>(), apiGet: vi.fn(), apiPost: vi.fn() }));
const read = vi.mocked(apiGet);
const write = vi.mocked(apiPost);
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
beforeEach(() => { vi.clearAllMocks(); clearMutationToken(); });

describe('configured metadata collector lifecycle', () => {
  async function lifecycle(value: unknown) {
    const { snapshot } = resourceFixture(); read.mockResolvedValue({ ...snapshot, metadataCollector: value });
    return resourceConsoleSnapshotQuery(snapshot.pool.id).fetch();
  }
  it.each(RESOURCE_COLLECTOR_RECOVERY_REASONS)('accepts fixed recovery diagnosis %s without mutation', async (reasonCode) => {
    const value = { state: 'blocked', reasonCode: 'reconciliation-required', sampledAt: NOW,
      recovery: { reasonCode, markerVersion: RESOURCE_COLLECTOR_RECOVERY_MARKER_VERSIONS[reasonCode][0] } };
    await expect(lifecycle(value)).resolves.toMatchObject({ metadataCollector: value });
    expect(write).not.toHaveBeenCalled();
  });
  it.each([null, {}, { reasonCode: 'PRIVATE', markerVersion: 1 },
    { reasonCode: 'legacy-owner-evidence-missing', markerVersion: 4 },
    { reasonCode: 'process-group-not-confirmed-absent', markerVersion: 1 },
    { reasonCode: 'command-registration-incomplete', markerVersion: null },
    { reasonCode: 'legacy-owner-evidence-missing', markerVersion: '1' },
    { reasonCode: 'legacy-owner-evidence-missing', markerVersion: 5 },
    { reasonCode: 'legacy-owner-evidence-missing', markerVersion: true },
    { reasonCode: 'legacy-owner-evidence-missing', markerVersion: 1, ownerToken: 'PRIVATE' },
    { reasonCode: 'legacy-owner-evidence-missing' }])('rejects malformed recovery evidence %#', async (recovery) => {
    await expect(lifecycle({ state: 'blocked', reasonCode: 'reconciliation-required', sampledAt: NOW, recovery })).rejects.toThrow('selected pool');
  });
  it.each(['running', 'owned'])('rejects recovery attached to a %s collector', async (state) => {
    await expect(lifecycle({ state: state === 'running' ? 'running' : 'blocked',
      reasonCode: state === 'running' ? 'collector-running' : 'collector-owned', sampledAt: NOW,
      recovery: { reasonCode: 'legacy-owner-evidence-missing', markerVersion: 1 } })).rejects.toThrow('selected pool');
  });
  it.each([undefined, { state: 'running', reasonCode: 'collector-running', sampledAt: NOW },
    ...['collector-owned', 'reconciliation-required', 'collector-unavailable'].map((reasonCode) => ({ state: 'blocked', reasonCode, sampledAt: NOW }))])(
    'accepts legacy absence and exact lifecycle %#', async (value) => {
      await expect(lifecycle(value)).resolves.toBeDefined(); expect(write).not.toHaveBeenCalled();
    });
  it.each([null, {}, { state: 'running', reasonCode: 'collector-owned', sampledAt: NOW },
    { state: 'blocked', reasonCode: 'collector-running', sampledAt: NOW },
    { state: 'blocked', reasonCode: 'cleanup-unconfirmed', sampledAt: NOW },
    { state: 'blocked', reasonCode: ['collector-owned'], sampledAt: NOW },
    { state: 'blocked', reasonCode: 'collector-owned', sampledAt: '2026-02-30T12:00:00.000Z' },
    { state: 'blocked', reasonCode: 'collector-owned', sampledAt: NOW, raw: '/private/token' }])(
    'rejects malformed or unsafe lifecycle %#', async (value) => { await expect(lifecycle(value)).rejects.toThrow('selected pool'); });
});

describe('saved worker access response and mutation boundaries', () => {
  async function accessSnapshot(workerAccess: unknown) {
    const { snapshot } = resourceFixture(); read.mockResolvedValue({ ...snapshot, workerAccess });
    return resourceConsoleSnapshotQuery(snapshot.pool.id).fetch();
  }
  it.each([undefined, { pausedWorkerIds: [], revision: 0, updatedAt: null },
    { pausedWorkerIds: ['codex-a'], revision: 1, updatedAt: NOW }, { pausedWorkerIds: [], revision: 2, updatedAt: NOW }])(
    'accepts legacy absence and explicit saved access %#', async (value) => {
      await expect(accessSnapshot(value)).resolves.toBeDefined(); expect(read).toHaveBeenCalledOnce();
    });
  it.each([null, {}, { pausedWorkerIds: ['not-enrolled'], revision: 1, updatedAt: NOW },
    { pausedWorkerIds: ['codex-a', 'codex-a'], revision: 1, updatedAt: NOW },
    { pausedWorkerIds: ['codex-a'], revision: 0, updatedAt: null },
    { pausedWorkerIds: [], revision: 0, updatedAt: NOW }, { pausedWorkerIds: [], revision: 1, updatedAt: null },
    { pausedWorkerIds: [], revision: -1, updatedAt: NOW }, { pausedWorkerIds: [], revision: 1.5, updatedAt: NOW },
    { pausedWorkerIds: [], revision: 1, updatedAt: '2026-02-31T12:00:00.000Z' },
    { pausedWorkerIds: ['../secret'], revision: 1, updatedAt: NOW },
    { pausedWorkerIds: [], revision: 1, updatedAt: NOW, raw: 'PRIVATE' }])('rejects malformed/unknown access snapshot %#', async (value) => {
    await expect(accessSnapshot(value)).rejects.toThrow('did not match the selected pool');
  });
  it('requires the mutation token and sends one exact fixed-route request', async () => {
    await expect(setResourceWorkerAccessControl(['codex-a'], 0)).rejects.toThrow('Unlock controls');
    expect(write).not.toHaveBeenCalled(); setMutationToken('a'.repeat(64));
    write.mockResolvedValue({ workerAccess: { pausedWorkerIds: ['codex-a'], revision: 1, updatedAt: NOW } });
    await expect(setResourceWorkerAccessControl(['codex-a'], 0)).resolves.toHaveProperty('workerAccess.revision', 1);
    expect(write).toHaveBeenCalledExactlyOnceWith('/api/resources/worker-access',
      { pausedWorkerIds: ['codex-a'], expectedRevision: 0 }, 'a'.repeat(64));
  });
  it('accepts canonical server ordering without changing caller IDs', async () => {
    setMutationToken('a'.repeat(64)); const requested = ['local-a', 'codex-a'];
    write.mockResolvedValue({ workerAccess: { pausedWorkerIds: ['codex-a', 'local-a'], revision: 4, updatedAt: NOW } });
    await expect(setResourceWorkerAccessControl(requested, 3)).resolves.toBeDefined();
    expect(requested).toEqual(['local-a', 'codex-a']);
  });
  it.each([{ ids: ['codex-a', 'codex-a'], revision: 0 }, { ids: ['../secret'], revision: 0 },
    { ids: [''], revision: 0 }, { ids: Array.from({ length: 33 }, (_, i) => `worker-${i}`), revision: 0 },
    { ids: [], revision: -1 }, { ids: [], revision: 0.5 }, { ids: [], revision: NaN },
    { ids: [], revision: Infinity }, { ids: [], revision: Number.MAX_SAFE_INTEGER }])(
    'rejects invalid access before contact %#', async ({ ids, revision }) => {
      setMutationToken('a'.repeat(64));
      await expect(setResourceWorkerAccessControl(ids, revision)).rejects.toThrow('Invalid fleet access change');
      expect(write).not.toHaveBeenCalled();
    });
  it.each([{}, { workerAccess: null }, { workerAccess: { pausedWorkerIds: [], revision: 1, updatedAt: NOW } },
    { workerAccess: { pausedWorkerIds: ['codex-a'], revision: 2, updatedAt: NOW } },
    { workerAccess: { pausedWorkerIds: ['codex-a'], revision: 1, updatedAt: null } },
    { workerAccess: { pausedWorkerIds: ['codex-a', 'codex-a'], revision: 1, updatedAt: NOW } },
    { workerAccess: { pausedWorkerIds: ['unknown'], revision: 1, updatedAt: NOW } },
    { workerAccess: { pausedWorkerIds: ['codex-a'], revision: 1, updatedAt: NOW }, raw: 'PRIVATE' }])(
    'rejects malformed or contradictory save response %#', async (response) => {
      setMutationToken('a'.repeat(64)); write.mockResolvedValue(response);
      await expect(setResourceWorkerAccessControl(['codex-a'], 0)).rejects.toThrow('could not be verified');
    });
  it.each([401, 403, 404, 409, 500])('redacts HTTP %s failures without retrying', async (status) => {
    setMutationToken('a'.repeat(64)); write.mockRejectedValue(new ApiError('PRIVATE_SERVER_DETAIL', status, '/api/resources/worker-access'));
    const error = await setResourceWorkerAccessControl(['codex-a'], 0).catch((value: Error) => value);
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).not.toContain('PRIVATE_SERVER_DETAIL');
    expect(write).toHaveBeenCalledOnce();
    if (status === 409) expect(error).toMatchObject({ status: 409 });
    if (status === 401) expect(getMutationToken()).toBeNull();
  });
  it('does not expose unexpected transport details', async () => {
    setMutationToken('a'.repeat(64)); write.mockRejectedValue(new Error('PRIVATE_TRANSPORT_DETAIL'));
    const error = await setResourceWorkerAccessControl(['codex-a'], 0).catch((value: Error) => value);
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).not.toContain('PRIVATE_TRANSPORT_DETAIL');
    expect(write).toHaveBeenCalledOnce();
  });
});

describe('optional native execution response boundary', () => {
  const diagnostic = { schemaVersion: 1, scope: 'native-process', exitCode: 1, signal: null,
    stderrPresent: true, outputTruncated: false };
  async function withDiagnostic(nativeProcess: unknown, status = 'failed', workerId = 'codex-a') {
    const { snapshot } = resourceFixture();
    read.mockResolvedValue({ ...snapshot, recentAttempts: [{ id: 'diagnostic', workerId, status, nativeProcess }] });
    return resourceConsoleSnapshotQuery(snapshot.pool.id).fetch();
  }
  it('accepts bounded native failure metadata without extra requests', async () => {
    await expect(withDiagnostic(diagnostic)).resolves.toBeDefined();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('/api/resources', undefined);
  });
  it.each([null, undefined, { ...diagnostic, stderr: 'PRIVATE_PROVIDER_TEXT' }, { ...diagnostic, exitCode: -1 },
    { ...diagnostic, signal: 'PRIVATE_SIGNAL' }, { ...diagnostic, scope: 'other' }])('rejects malformed diagnostics %#', async (value) => {
    await expect(withDiagnostic(value)).rejects.toThrow('did not match the selected pool');
  });
  it.each(['completed', 'timed-out', 'cancelled', 'uncertain', 'reserved', 'unknown'])(
    'rejects exit1 contradicting %s', async (status) => {
      await expect(withDiagnostic(diagnostic, status)).rejects.toThrow('did not match the selected pool');
    });
  it.each(['local-a', 'orphan'])('rejects native diagnostics for %s', async (workerId) => {
    await expect(withDiagnostic(diagnostic, 'failed', workerId)).rejects.toThrow('did not match the selected pool');
  });
});

describe('connection and allocation response boundaries', () => {
  function connection() {
    return { sampledAt: NOW, refreshing: false, accounts: [{ id: 'codex-a', label: 'Personal', provider: 'codex',
      state: 'observed', authentication: 'signed-in', health: 'reachable', planType: 'pro', observedAt: NOW, expiresAt: NEXT,
      windows: [{ id: 'codex:five_hour', usedPercent: 25, resetsAt: NEXT }], reason: 'probe-observed',
      onDemandEnabled: null, executionSupported: true }] };
  }
  async function extension(value: Record<string, unknown>) {
    const { snapshot } = resourceFixture(); read.mockResolvedValue({ ...snapshot, ...value });
    return resourceConsoleSnapshotQuery(snapshot.pool.id).fetch();
  }
  it('accepts separate bounded Codex, Claude and Grok rows without extra requests', async () => {
    const connections = connection();
    connections.accounts.push({ ...connections.accounts[0]!, id: 'codex-b', label: 'Company' });
    connections.accounts.push({ ...connections.accounts[0]!, id: 'claude', label: 'Claude', provider: 'claude', health: 'unknown',
      planType: 'max', windows: [], reason: 'status-login-observed' });
    connections.accounts.push({ ...connections.accounts[0]!, id: 'grok', label: 'Grok', provider: 'grok',
      planType: 'SuperGrok Heavy', executionSupported: false });
    await expect(extension({ connections })).resolves.toMatchObject({ connections });
    expect(read).toHaveBeenCalledExactlyOnceWith('/api/resources', undefined);
  });
  it('accepts explicitly display-only Claude native reports', async () => {
    const connections = connection();
    Object.assign(connections.accounts[0]!, { provider: 'claude', reason: 'usage-native-reported', health: 'unknown',
      windows: [{ id: 'seven_day', usedPercent: 1, resetsAt: null,
        nativeReport: { source: 'claude-usage', resetDescription: 'Sep 11 at 7pm (America/New_York)' } }] });
    await expect(extension({ connections })).resolves.toMatchObject({ connections });
  });
  it.each([
    { source: 'unknown', resetDescription: null }, { source: 'claude-usage', resetDescription: '\u0000' },
    { source: 'claude-usage', resetDescription: 'x'.repeat(129) }, { source: 'claude-usage', resetDescription: null, token: 'PRIVATE' },
    { source: 'claude-usage' }, null,
  ])('rejects malformed native report metadata %#', async (nativeReport) => {
    const connections = connection();
    Object.assign(connections.accounts[0]!, { provider: 'claude', windows: [{ id: 'seven_day', usedPercent: 1, resetsAt: null, nativeReport }] });
    await expect(extension({ connections })).rejects.toThrow('did not match the selected pool');
  });
  it.each(['provider', 'reset', 'fraction', 'unknown-percent'])('rejects contradictory native %s', async (field) => {
    const connections = connection();
    Object.assign(connections.accounts[0]!, { provider: field === 'provider' ? 'codex' : 'claude',
      windows: [{ id: 'seven_day', usedPercent: field === 'fraction' ? 1.5 : field === 'unknown-percent' ? null : 1,
        resetsAt: field === 'reset' ? NEXT : null, nativeReport: { source: 'claude-usage', resetDescription: null } }] });
    await expect(extension({ connections })).rejects.toThrow('did not match the selected pool');
  });
  it.each([undefined, null])('preserves legacy absence of connections %#', async (connections) => {
    await expect(extension({ connections })).resolves.toBeDefined();
  });
  it('accepts unknown/stopped quota observations without manufacturing an error or zero', async () => {
    const connections = connection();
    Object.assign(connections.accounts[0]!, { state: 'unavailable', health: 'unknown', reason: 'connection-monitor-stopped',
      windows: [{ id: 'unknown', usedPercent: null, resetsAt: null }] });
    await expect(extension({ connections })).resolves.toMatchObject({ connections });
  });
  it.each([
    ['raw diagnostic', { reason: 'SECRET: /private/auth' }], ['raw identity field', { email: 'private@example.invalid' }],
    ['bad provider', { provider: 'local' }], ['bad state', { state: 'ready' }], ['bad authentication', { authentication: true }],
    ['bad health', { health: 'ready' }], ['bad plan', { planType: 'PRIVATE_PLAN' }], ['bad label', { label: '\u0000' }],
    ['long label bytes', { label: '€'.repeat(27) }], ['bad id', { id: '../private' }], ['invalid timestamp', { observedAt: '2026-02-31T12:00:00.000Z' }],
    ['invalid expiry', { expiresAt: 1 }], ['bad billing', { onDemandEnabled: 'false' }], ['bad execution', { executionSupported: 1 }],
    ['Grok execution claim', { provider: 'grok', executionSupported: true }], ['bad window count', { windows: Array(65).fill({}) }],
    ['private window id', { windows: [{ id: '/private/auth', usedPercent: 1, resetsAt: null }] }],
    ['oversized percent', { windows: [{ id: 'usage', usedPercent: 101, resetsAt: null }] }],
    ['negative percent', { windows: [{ id: 'usage', usedPercent: -1, resetsAt: null }] }],
    ['nonfinite percent', { windows: [{ id: 'usage', usedPercent: Infinity, resetsAt: null }] }],
    ['string percent', { windows: [{ id: 'usage', usedPercent: '0', resetsAt: null }] }],
    ['bad window reset', { windows: [{ id: 'usage', usedPercent: 1, resetsAt: 'invalid' }] }],
    ['extra window field', { windows: [{ id: 'usage', usedPercent: 1, resetsAt: null, raw: 'SECRET' }] }],
  ])('rejects malformed connection %s before rendering', async (_label, patch) => {
    const connections = connection(); Object.assign(connections.accounts[0]!, patch);
    await expect(extension({ connections })).rejects.toThrow('did not match the selected pool');
  });
  it.each([
    { sampledAt: 'invalid' }, { refreshing: 1 }, { private: 'SECRET' }, { accounts: Array(9).fill({}) },
  ])('rejects malformed connection envelope %#', async (patch) => {
    await expect(extension({ connections: { ...connection(), ...patch } })).rejects.toThrow('did not match the selected pool');
  });
  it('rejects duplicate account/window IDs', async () => {
    const connections = connection(); connections.accounts.push(connections.accounts[0]!);
    await expect(extension({ connections })).rejects.toThrow('did not match the selected pool');
    connections.accounts.pop(); connections.accounts[0]!.windows.push(connections.accounts[0]!.windows[0]!);
    await expect(extension({ connections })).rejects.toThrow('did not match the selected pool');
  });
  it.each(['allocationWritable', 'connectionsEnabled'] as const)('checks optional scope boolean %s', async (key) => {
    for (const value of [undefined, false, true]) {
      read.mockResolvedValue({ ...resourceFixture().scope, [key]: value });
      await expect(resourceConsoleScopeQuery.fetch()).resolves.toBeDefined();
    }
    for (const value of [null, 1, 'true', {}]) {
      read.mockResolvedValue({ ...resourceFixture().scope, [key]: value });
      await expect(resourceConsoleScopeQuery.fetch()).rejects.toThrow('did not establish an explicit');
    }
  });
  it.each([undefined, { ceilingPercent: null, revision: 0, updatedAt: null },
    { ceilingPercent: 0, revision: 1, updatedAt: NOW }, { ceilingPercent: 100, revision: 4, updatedAt: NOW }])(
    'accepts absent, legacy and saved allocation %#', async (allocation) => {
      await expect(extension({ allocation })).resolves.toBeDefined();
    });
  it.each([null, {}, { ceilingPercent: 75, revision: 0, updatedAt: NOW }, { ceilingPercent: null, revision: 1, updatedAt: NOW },
    { ceilingPercent: 101, revision: 1, updatedAt: NOW }, { ceilingPercent: -1, revision: 1, updatedAt: NOW },
    { ceilingPercent: 75.5, revision: 1, updatedAt: NOW }, { ceilingPercent: 75, revision: 1.5, updatedAt: NOW },
    { ceilingPercent: 75, revision: -1, updatedAt: NOW }, { ceilingPercent: 75, revision: 1, updatedAt: null },
    { ceilingPercent: 75, revision: 1, updatedAt: 'invalid' }, { ceilingPercent: 75, revision: 1, updatedAt: NOW, secret: 'PRIVATE' }])(
    'rejects malformed allocation %#', async (allocation) => {
      await expect(extension({ allocation })).rejects.toThrow('did not match the selected pool');
    });
});

describe('allocation mutations', () => {
  it('requires a control token, then uses the fixed route and exact revision body', async () => {
    await expect(setResourceAllocation(75, 0)).rejects.toThrow('Unlock controls');
    expect(write).not.toHaveBeenCalled();
    setMutationToken('a'.repeat(64));
    write.mockResolvedValue({ allocation: { ceilingPercent: 75, revision: 1, updatedAt: NOW } });
    await expect(setResourceAllocation(75, 0)).resolves.toHaveProperty('allocation.ceilingPercent', 75);
    expect(write).toHaveBeenCalledExactlyOnceWith('/api/resources/allocation', { ceilingPercent: 75, expectedRevision: 0 }, 'a'.repeat(64));
  });
  it.each([[-1, 0], [101, 0], [75.5, 0], [75, -1], [75, 0.5], [NaN, 0], [75, Infinity]])(
    'rejects invalid ceiling/revision %s/%s before a request', async (ceiling, revision) => {
      setMutationToken('a'.repeat(64));
      await expect(setResourceAllocation(ceiling, revision)).rejects.toThrow('Invalid allocation change');
      expect(write).not.toHaveBeenCalled();
    });
  it.each([{}, { allocation: null }, { allocation: { ceilingPercent: 80, revision: 1, updatedAt: NOW } },
    { allocation: { ceilingPercent: 75, revision: 2, updatedAt: NOW } },
    { allocation: { ceilingPercent: 75, revision: 1, updatedAt: NOW }, secret: 'PRIVATE' }])(
    'rejects malformed or contradictory save response %#', async (response) => {
      setMutationToken('a'.repeat(64)); write.mockResolvedValue(response);
      await expect(setResourceAllocation(75, 0)).rejects.toThrow('could not be verified');
    });
  it.each([401, 403, 404, 409, 500])('redacts failure details for HTTP %s and never retries a write', async (status) => {
    setMutationToken('a'.repeat(64)); write.mockRejectedValue(new ApiError('PRIVATE_SERVER_DETAIL', status, '/api/resources/allocation'));
    const error = await setResourceAllocation(75, 0).catch((value: Error) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('PRIVATE_SERVER_DETAIL');
    expect(write).toHaveBeenCalledTimes(1);
    if (status === 409) expect(error).toMatchObject({ status: 409 });
    if (status === 401) expect(getMutationToken()).toBeNull();
  });
  it('does not echo unexpected transport error details', async () => {
    setMutationToken('a'.repeat(64)); write.mockRejectedValue(new Error('PRIVATE_TRANSPORT_DETAIL'));
    await expect(setResourceAllocation(75, 0)).rejects.toThrow('Allocation could not be saved. Refresh');
  });
});

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
    for (const reason of ['managed-quota-reserve-reached', 'managed-quota-unknown', 'managed-allocation-unavailable']) {
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
