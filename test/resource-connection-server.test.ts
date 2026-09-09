/** Loopback-only account monitoring and allocation capability integration. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResourceConsoleServer, type ResourceConsoleServerHandle, type ResourceConsoleServerOptions } from '../src/core/web/resource-console-server.js';
import * as connections from '../src/core/resources/connection-monitor.js';
import * as readers from '../src/core/web/resource-console-reads.js';
import * as quotas from '../src/core/resources/quota-refresh.js';
import * as collectorLease from '../src/core/resources/quota-refresh-lease.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { readResourceJson, readResourcePoolAllocation, setResourcePoolAllocation,
  readResourceWorkerAccess, setResourceWorkerAccess } from '../src/core/resources/pool-runtime.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

let root: string; let options: ResourceConsoleServerOptions; const servers: ResourceConsoleServerHandle[] = [];
const save = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'connection-server-')));
  options = { root: join(root, 'ledger'), poolFile: join(root, 'pool.json'), bindingsFile: join(root, 'bindings.json'), observationsFile: join(root, 'observations.json') };
  save(options.poolFile, { schemaVersion: 1, id: 'test', workers: [{ id: 'codex', provider: 'codex', model: 'inert', maxConcurrent: 1,
    reservePercent: 15, maxTasksPerWindow: 5, taskWindowMs: 60_000, priority: 1 }] });
  save(options.bindingsFile, [{ workerId: 'codex', capacityKey: 'test', kind: 'native-cli', command: ['/not-executed'] }]);
  save(options.observationsFile, []);
});
afterEach(async () => { await Promise.allSettled(servers.splice(0).map((server) => server.close())); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
async function start(extra: Partial<ResourceConsoleServerOptions> = {}) { const server = await startResourceConsoleServer({ ...options, ...extra }); servers.push(server); return server; }
async function get(server: ResourceConsoleServerHandle, token = server.readToken) {
  return fetch(`${server.url}/api/resources`, { headers: { 'X-Ashlr-Token': token } });
}
async function set(server: ResourceConsoleServerHandle, body: unknown, token = server.controlToken ?? '') {
  return fetch(`${server.url}/api/resources/allocation`, { method: 'POST', headers: { 'X-Ashlr-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function setAccess(server: ResourceConsoleServerHandle, body: unknown, token = server.controlToken ?? '') {
  return fetch(`${server.url}/api/resources/worker-access`, { method: 'POST',
    headers: { 'X-Ashlr-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
function config() {
  const path = join(root, 'connections.json'); save(path, { schemaVersion: 1, intervalMs: 30_000,
    accounts: [{ id: 'codex-cmp', label: 'Company account', provider: 'codex', command: ['/private-command-never-exposed'] }] }); return path;
}
function monitor(close: () => Promise<void> = async () => {}) {
  return vi.spyOn(connections, 'createResourceConnectionMonitor').mockReturnValue({ snapshot: () => ({ sampledAt: new Date().toISOString(),
    refreshing: false, accounts: [] }), close });
}
describe('connection monitoring and allocation capabilities', () => {
  it.each(['collector-owned', 'reconciliation-required', 'collector-unavailable'] as const)(
    'keeps configured metadata visible but all managed workers denied after safe startup refusal %s', async (code) => {
      const pool = readResourceJson(options.poolFile) as ResourcePool;
      pool.workers.push({ ...pool.workers[0]!, id: 'codex-two', allowUnknownQuota: true });
      const bindings = readResourceJson(options.bindingsFile) as ResourceBinding[];
      bindings.push({ ...bindings[0]!, workerId: 'codex-two', capacityKey: 'second' });
      save(options.poolFile, pool); save(options.bindingsFile, bindings);
      const observedAt = new Date().toISOString();
      save(options.observationsFile, pool.workers.map(({ id }) => ({ workerId: id, observedAt,
        expiresAt: new Date(Date.now() + 60_000).toISOString(), health: 'ready', retryAfter: null,
        windows: [{ id: 'primary', usedPercent: 0, resetsAt: new Date(Date.now() + 3600_000).toISOString() }] })));
      const quotaConfigFile = join(root, 'quota.json');
      save(quotaConfigFile, { schemaVersion: 1, poolDigest: digest(canonical({ pool, bindings })),
        workers: pool.workers.map(({ id }, index) => ({ workerId: id, accountHint: (index ? 'b' : 'a').repeat(64), bucketIds: ['codex'] })) });
      vi.spyOn(collectorLease, 'acquireResourceQuotaRefreshLease').mockRejectedValue(
        new collectorLease.ResourceQuotaRefreshLeaseError(code, '/private/collector-detail'));
      const connection = monitor(); const quota = vi.spyOn(quotas, 'createResourceQuotaRefresher');
      const server = await start({ quotaConfigFile, connectionsConfigFile: config() });
      expect(server.scope).toMatchObject({ quotaRefreshEnabled: true, connectionsEnabled: true, readOnly: true });
      const response = await get(server); expect(response.status).toBe(200); const value = await response.json();
      expect(value.metadataCollector).toEqual({ state: 'blocked', reasonCode: code, sampledAt: expect.any(String) });
      expect(value.plan.selectedWorkerId).toBeNull();
      expect(value.plan.candidates).toEqual([]);
      expect(value.plan.exclusions).toEqual(expect.arrayContaining(pool.workers.map(({ id }) => expect.objectContaining({ workerId: id }))));
      expect(value.connections).toBeUndefined(); expect(value.quotaRefresh).toBeUndefined();
      expect(JSON.stringify(value)).not.toContain('/private/collector-detail');
      await get(server); await server.close();
      expect(connection).not.toHaveBeenCalled(); expect(quota).not.toHaveBeenCalled();
      expect(existsSync(join(options.root, '.resource-quota-refresh-pending.json'))).toBe(false);
    });

  it.each(['cleanup-unconfirmed', 'cancelled'] as const)('does not serve a blocked success after terminal acquisition failure %s', async (code) => {
    vi.spyOn(collectorLease, 'acquireResourceQuotaRefreshLease').mockRejectedValue(
      new collectorLease.ResourceQuotaRefreshLeaseError(code, 'terminal fixture acquisition failure'));
    const probe = monitor();
    await expect(start({ connectionsConfigFile: config() })).rejects.toThrow('terminal fixture acquisition failure');
    expect(probe).not.toHaveBeenCalled();
  });

  it('does not treat an untyped private acquisition error as a safe read-only fallback', async () => {
    vi.spyOn(collectorLease, 'acquireResourceQuotaRefreshLease').mockRejectedValue(new Error('untyped fixture failure'));
    const probe = monitor();
    await expect(start({ connectionsConfigFile: config() })).rejects.toThrow('untyped fixture failure');
    expect(probe).not.toHaveBeenCalled();
  });

  it('shares one native-client coordinator across explicit collectors and disposes it at close', async () => {
    const quotaConfigFile = join(root, 'quota.json');
    const pool = readResourceJson(options.poolFile); const bindings = readResourceJson(options.bindingsFile);
    save(quotaConfigFile, { schemaVersion: 1, poolDigest: digest(canonical({ pool, bindings })),
      workers: [{ workerId: 'codex', accountHint: 'a'.repeat(64), bucketIds: ['codex'] }] });
    const connection = monitor();
    const quota = vi.spyOn(quotas, 'createResourceQuotaRefresher').mockReturnValue({
      readObservations: (base) => base, unavailableWorkerIds: () => ['codex'],
      snapshot: () => ({ schemaVersion: 1, scope: 'codex-native-metadata', state: 'running', sampledAt: new Date().toISOString(), workers: [] }),
      close: async () => {},
    });
    const server = await start({ quotaConfigFile, connectionsConfigFile: config() });
    const shared = quota.mock.calls[0]![0].coordinator;
    expect(shared).toBeDefined(); expect(connection.mock.calls[0]![0].coordinator).toBe(shared);
    expect(shared!.signal.aborted).toBe(false); expect(server.scope.readOnly).toBe(true);
    await server.close(); expect(shared!.signal.aborted).toBe(true);
    await expect(shared!.run(async () => 'unexpected')).rejects.toThrow();
    expect(existsSync(join(options.root, '.resource-quota-refresh-pending.json'))).toBe(false);
  });
  it('default read-only startup stays inert and returns legacy allocation without initializing storage', async () => {
    const probe = monitor(); const server = await start(); const response = await get(server);
    expect(response.status).toBe(200); const value = await response.json();
    expect(value.allocation).toEqual({ ceilingPercent: null, revision: 0, updatedAt: null });
    expect(value.connections).toBeUndefined(); expect(probe).not.toHaveBeenCalled(); expect(existsSync(options.root)).toBe(false);
  });
  it('budget-only controls persist atomically while all task execution remains disabled', async () => {
    const original = readFileSync(options.poolFile); const server = await start({ allocationControls: true });
    expect(server.scope.readOnly).toBe(true); expect(server.scope.allocationWritable).toBe(true); expect(server.controlToken).not.toBeNull();
    expect((await set(server, { ceilingPercent: 75, expectedRevision: 0 }, server.readToken)).status).toBe(401);
    const saved = await set(server, { ceilingPercent: 75, expectedRevision: 0 }); expect(saved.status).toBe(200);
    expect((await saved.json()).allocation).toMatchObject({ ceilingPercent: 75, revision: 1 });
    expect((await (await get(server)).json()).allocation).toMatchObject({ ceilingPercent: 75, revision: 1 });
    expect((await fetch(`${server.url}/api/resources/tasks`, { method: 'POST', headers: { 'X-Ashlr-Token': server.controlToken! } })).status).toBe(403);
    expect(readFileSync(options.poolFile)).toEqual(original);
    const restarted = await start({ allocationControls: true });
    expect((await (await get(restarted)).json()).allocation).toMatchObject({ ceilingPercent: 75, revision: 1 });
  });
  it('rejects stale allocation revisions without overwriting the saved limit', async () => {
    const server = await start({ allocationControls: true });
    expect((await set(server, { ceilingPercent: 75, expectedRevision: 0 })).status).toBe(200);
    expect((await set(server, { ceilingPercent: 100, expectedRevision: 0 })).status).toBe(409);
    expect((await (await get(server)).json()).allocation.ceilingPercent).toBe(75);
    expect((await set(server, { ceilingPercent: 100, expectedRevision: 1 })).status).toBe(200);
    expect((await set(server, { ceilingPercent: 0, expectedRevision: 2 })).status).toBe(200);
  });
  it.each([false, true])('never pairs eligibility with another allocation revision (continuous change=%s)', async (continuous) => {
    const original = readers.createResourceConsoleReader; let reads = 0;
    const pool = readResourceJson(options.poolFile) as ResourcePool; const bindings = readResourceJson(options.bindingsFile) as ResourceBinding[];
    vi.spyOn(readers, 'createResourceConsoleReader').mockImplementation((input) => {
      const reader = original(input); return { ...reader, async snapshot(managed) {
        const result = await reader.snapshot(managed); reads++;
        if (continuous || reads === 1) {
          const current = readResourcePoolAllocation(options.root, pool, bindings);
          setResourcePoolAllocation(options.root, pool, bindings, current.ceilingPercent === 75 ? 100 : 75, current.revision);
        }
        return result;
      } };
    });
    const server = await start({ allocationControls: true });
    expect((await set(server, { ceilingPercent: 75, expectedRevision: 0 })).status).toBe(200);
    const response = await get(server); expect(reads).toBe(2);
    if (continuous) expect(response.status).toBe(503);
    else { expect(response.status).toBe(200); expect((await response.json()).allocation).toMatchObject({ ceilingPercent: 100, revision: 2 }); }
  });
  it.each([
    { used: 80, ceiling: 75, expected: null },
    { used: 75, ceiling: 75, expected: null },
    { used: 0, ceiling: 0, expected: null },
    { used: 74, ceiling: 75, expected: 'codex' },
  ])('reapplies allocation to a reused pre-save eligibility snapshot: %j', async ({ used, ceiling, expected }) => {
    save(options.observationsFile, [{ workerId: 'codex', observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(), health: 'ready', retryAfter: null,
      windows: [{ id: 'primary', usedPercent: used, resetsAt: new Date(Date.now() + 3600_000).toISOString() }] }]);
    const original = readers.createResourceConsoleReader;
    let cached: Awaited<ReturnType<readers.ResourceConsoleReader['snapshot']>> | undefined;
    vi.spyOn(readers, 'createResourceConsoleReader').mockImplementation((input) => {
      const reader = original(input); return { ...reader, async snapshot(managed) {
        return cached ??= await reader.snapshot(managed);
      } };
    });
    const server = await start({ allocationControls: true });
    expect((await set(server, { ceilingPercent: 100, expectedRevision: 0 })).status).toBe(200);
    expect((await (await get(server)).json()).plan.selectedWorkerId).toBe('codex');
    expect((await set(server, { ceilingPercent: ceiling, expectedRevision: 1 })).status).toBe(200);
    const response = await get(server); expect(response.status).toBe(200);
    const snapshot = await response.json();
    expect(snapshot.allocation).toMatchObject({ ceilingPercent: ceiling, revision: 2 });
    expect(snapshot.plan.selectedWorkerId).toBe(expected);
    expect(cached!.plan!.selectedWorkerId).toBe('codex');
  });

  it.each([80, null])('withholds shared aliases under the current ceiling without withholding local models (alias usage=%s)', async (used) => {
    const pool = readResourceJson(options.poolFile) as ResourcePool;
    pool.workers[0]!.priority = 2;
    pool.workers.push({ ...pool.workers[0]!, id: 'alias', priority: 1, allowUnknownQuota: true },
      { ...pool.workers[0]!, id: 'local', provider: 'local', priority: 0 });
    const bindings = readResourceJson(options.bindingsFile) as ResourceBinding[];
    bindings.push({ ...bindings[0]!, workerId: 'alias' },
      { workerId: 'local', capacityKey: 'local', kind: 'local-chat', endpoint: 'http://127.0.0.1:23456/v1' });
    save(options.poolFile, pool); save(options.bindingsFile, bindings);
    save(options.observationsFile, pool.workers.map((worker) => ({ workerId: worker.id,
      observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), health: 'ready', retryAfter: null,
      windows: worker.provider === 'local' ? [] : [{ id: 'primary', usedPercent: worker.id === 'alias' ? used : 10,
        resetsAt: new Date(Date.now() + 3600_000).toISOString() }] })));
    const original = readers.createResourceConsoleReader;
    let cached: Awaited<ReturnType<readers.ResourceConsoleReader['snapshot']>> | undefined;
    vi.spyOn(readers, 'createResourceConsoleReader').mockImplementation((input) => {
      const reader = original(input); return { ...reader, async snapshot(managed) {
        return cached ??= await reader.snapshot(managed);
      } };
    });
    const server = await start({ allocationControls: true });
    expect((await set(server, { ceilingPercent: 100, expectedRevision: 0 })).status).toBe(200);
    expect((await (await get(server)).json()).plan.selectedWorkerId).toBe('codex');
    expect((await set(server, { ceilingPercent: 75, expectedRevision: 1 })).status).toBe(200);
    const snapshot = await (await get(server)).json();
    expect(snapshot.plan.selectedWorkerId).toBe('local');
    expect(snapshot.plan.candidates.map((row: { workerId: string }) => row.workerId)).toEqual(['local']);
    expect(cached!.plan!.selectedWorkerId).toBe('codex');
  });

  it.each([{ ceilingPercent: -1, expectedRevision: 0 }, { ceilingPercent: 101, expectedRevision: 0 },
    { ceilingPercent: 75.5, expectedRevision: 0 }, { ceilingPercent: 75, expectedRevision: -1 },
    { ceilingPercent: 75, expectedRevision: 0, root: '/elsewhere' }, {}])('rejects invalid allocation %j', async (body) => {
    const server = await start({ allocationControls: true }); expect((await set(server, body)).status).toBe(400);
    expect(existsSync(options.root)).toBe(false);
  });
  it('does not infer budget authority from a read session or valid request', async () => {
    const server = await start(); expect((await set(server, { ceilingPercent: 75, expectedRevision: 0 }, server.readToken)).status).toBe(403);
  });
  it('starts metadata only with explicit configuration, hides private commands and awaits close', async () => {
    const closed = vi.fn(async () => {}); const probe = monitor(closed); const path = config();
    const server = await start({ connectionsConfigFile: path });
    expect(server.scope.connectionsEnabled).toBe(true); expect(server.scope.readOnly).toBe(true); expect(probe).toHaveBeenCalledTimes(1);
    expect((await get(server, '')).status).toBe(401);
    const response = await get(server); const text = await response.text(); expect(response.status).toBe(200);
    expect(JSON.parse(text).connections.accounts).toEqual([]); expect(text).not.toContain('private-command');
    expect(existsSync(join(options.root, '.resource-quota-refresh-pending.json'))).toBe(true);
    await server.close(); expect(closed).toHaveBeenCalledTimes(1);
    expect(existsSync(join(options.root, '.resource-quota-refresh-pending.json'))).toBe(false);
  });
  it('keeps ownership reconciliation evidence when metadata cleanup is uncertain', async () => {
    monitor(async () => { throw new Error('inert-uncertainty'); }); const server = await start({ connectionsConfigFile: config() });
    await expect(server.close()).rejects.toThrow('shutdown uncertain');
    expect(existsSync(join(options.root, '.resource-quota-refresh-pending.json'))).toBe(true);
  });
  it('refuses malformed and task-writable connection configs before native startup', async () => {
    const probe = monitor(); const path = config(); save(path, { unexpected: true });
    await expect(start({ connectionsConfigFile: path })).rejects.toThrow(); expect(probe).not.toHaveBeenCalled();
    const workspace = join(root, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
    const inside = join(workspace, 'config.json'); save(inside, {});
    await expect(start({ execute: true, workspace, connectionsConfigFile: inside })).rejects.toThrow('outside the writable workspace');
    expect(probe).not.toHaveBeenCalled(); expect(existsSync(options.root)).toBe(false);
  });
});

describe('saved worker access capability', () => {
  function readyWorker() {
    const now = Date.now();
    save(options.observationsFile, [{ workerId: 'codex', observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(), health: 'ready', retryAfter: null,
      windows: [{ id: 'primary', usedPercent: 10, resetsAt: new Date(now + 3600_000).toISOString() }] }]);
  }
  it('requires explicit controls and the separate control token, never a read token', async () => {
    const body = { pausedWorkerIds: ['codex'], expectedRevision: 0 };
    const readOnly = await start();
    expect((await setAccess(readOnly, body, readOnly.readToken)).status).toBe(403);
    expect(existsSync(options.root)).toBe(false);
    const controls = await start({ allocationControls: true });
    expect(controls.scope.readOnly).toBe(true);
    for (const token of ['', controls.readToken, 'wrong-control']) expect((await setAccess(controls, body, token)).status).toBe(401);
    expect(existsSync(options.root)).toBe(false);
    expect((await setAccess(controls, body)).status).toBe(200);
    expect((await fetch(`${controls.url}/api/resources/tasks`, { method: 'POST',
      headers: { 'X-Ashlr-Token': controls.controlToken! } })).status).toBe(403);
  });

  it.each([{}, { pausedWorkerIds: ['missing'], expectedRevision: 0 },
    { pausedWorkerIds: ['codex', 'codex'], expectedRevision: 0 }, { pausedWorkerIds: 'codex', expectedRevision: 0 },
    { pausedWorkerIds: [null], expectedRevision: 0 }, { pausedWorkerIds: ['codex'], expectedRevision: -1 },
    { pausedWorkerIds: ['codex'], expectedRevision: 0.5 }, { pausedWorkerIds: ['codex'], expectedRevision: '0' },
    { pausedWorkerIds: ['codex'], expectedRevision: 0, root: '/unrelated' }])('rejects invalid access body %# without creating a ledger', async (body) => {
    const server = await start({ allocationControls: true });
    expect((await setAccess(server, body)).status).toBe(400); expect(existsSync(options.root)).toBe(false);
  });

  it('persists pause across restart, enforces CAS and preserves the independent 75% ceiling', async () => {
    readyWorker();
    const source = readFileSync(options.poolFile); const server = await start({ allocationControls: true });
    expect((await set(server, { ceilingPercent: 75, expectedRevision: 0 })).status).toBe(200);
    const initial = await (await get(server)).json(); const before = initial.allocation;
    expect(initial.plan.selectedWorkerId).toBe('codex');
    const paused = await setAccess(server, { pausedWorkerIds: ['codex'], expectedRevision: 0 });
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({ workerAccess: { pausedWorkerIds: ['codex'], revision: 1 } });
    expect((await setAccess(server, { pausedWorkerIds: [], expectedRevision: 0 })).status).toBe(409);
    await server.close();
    const restarted = await start({ allocationControls: true });
    const snapshot = await (await get(restarted)).json();
    expect(snapshot.workerAccess).toMatchObject({ pausedWorkerIds: ['codex'], revision: 1 });
    expect(snapshot.allocation).toEqual(before); expect(snapshot.plan.selectedWorkerId).toBeNull();
    expect((await setAccess(restarted, { pausedWorkerIds: [], expectedRevision: 1 })).status).toBe(200);
    const resumed = await (await get(restarted)).json();
    expect(resumed.workerAccess).toMatchObject({ pausedWorkerIds: [], revision: 2 });
    expect(resumed.plan.selectedWorkerId).toBe('codex');
    expect(resumed.allocation).toEqual(before); expect(readFileSync(options.poolFile)).toEqual(source);
  });

  it.each([false, true])('does not attach a different access revision to routing evidence (continuous=%s)', async (continuous) => {
    readyWorker();
    const original = readers.createResourceConsoleReader; let reads = 0;
    const pool = readResourceJson(options.poolFile) as ResourcePool;
    const bindings = readResourceJson(options.bindingsFile) as ResourceBinding[];
    vi.spyOn(readers, 'createResourceConsoleReader').mockImplementation((input) => {
      const reader = original(input); return { ...reader, async snapshot(managed) {
        const result = await reader.snapshot(managed); reads++;
        if (continuous || reads === 1) {
          const current = readResourceWorkerAccess(options.root, pool, bindings);
          setResourceWorkerAccess(options.root, pool, bindings, current.pausedWorkerIds.length ? [] : ['codex'], current.revision);
        }
        return result;
      } };
    });
    const server = await start({ allocationControls: true });
    const response = await get(server); expect(reads).toBe(2);
    if (continuous) expect(response.status).toBe(503);
    else {
      expect(response.status).toBe(200);
      const snapshot = await response.json();
      expect(snapshot.workerAccess).toMatchObject({ pausedWorkerIds: ['codex'], revision: 1 });
      expect(snapshot.plan.selectedWorkerId).toBeNull();
    }
  });

  it('withholds a paused worker when the reader reuses a pre-pause eligibility snapshot', async () => {
    readyWorker(); const original = readers.createResourceConsoleReader;
    let cached: Awaited<ReturnType<readers.ResourceConsoleReader['snapshot']>> | undefined;
    let freshReads = 0;
    vi.spyOn(readers, 'createResourceConsoleReader').mockImplementation((input) => {
      const reader = original(input); return { ...reader, async snapshot(managed) {
        if (!cached) { cached = await reader.snapshot(managed); freshReads++; }
        return cached;
      } };
    });
    const server = await start({ allocationControls: true });
    expect((await (await get(server)).json()).plan.selectedWorkerId).toBe('codex');
    expect((await setAccess(server, { pausedWorkerIds: ['codex'], expectedRevision: 0 })).status).toBe(200);
    const response = await get(server); expect(response.status).toBe(200);
    const snapshot = await response.json();
    expect(snapshot.workerAccess).toMatchObject({ pausedWorkerIds: ['codex'], revision: 1 });
    expect(snapshot.plan.selectedWorkerId).toBeNull(); expect(snapshot.plan.candidates).toEqual([]);
    expect(snapshot.plan.exclusions).toContainEqual(expect.objectContaining({ workerId: 'codex', reasons: ['worker-unavailable'] }));
    expect(freshReads).toBe(1); expect(cached!.plan.selectedWorkerId).toBe('codex');
  });

  it('fails closed on corrupted saved access instead of treating it as an empty pause list', async () => {
    const server = await start({ allocationControls: true });
    expect((await setAccess(server, { pausedWorkerIds: ['codex'], expectedRevision: 0 })).status).toBe(200);
    const file = join(options.root, 'pool-state.json');
    const state = readResourceJson(file) as Record<string, unknown>;
    state.workerAccess = { pausedWorkerIds: ['unknown-worker'], revision: 1, updatedAt: new Date().toISOString() };
    save(file, state); const corrupted = readFileSync(file);
    expect((await get(server)).status).toBe(503);
    expect((await setAccess(server, { pausedWorkerIds: [], expectedRevision: 1 })).status).toBe(409);
    expect(readFileSync(file)).toEqual(corrupted);
  });
});
