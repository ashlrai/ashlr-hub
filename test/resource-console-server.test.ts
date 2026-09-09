import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResourceConsoleServer, type ResourceConsoleServerHandle, type ResourceConsoleServerOptions } from '../src/core/web/resource-console-server.js';
import * as readers from '../src/core/web/resource-console-reads.js';
import * as refreshers from '../src/core/resources/quota-refresh.js';
import * as supervisors from '../src/core/resources/pool-supervisor.js';
import { projectResourceConsoleEvidence } from '../src/core/web/resource-console-public.js';
import { mergeResourceObservations, resourcePoolStatus } from '../src/core/resources/pool-runtime.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import type { ResourceObservation, ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

let directory: string; let options: ResourceConsoleServerOptions;
const handles: ResourceConsoleServerHandle[] = [];
function write(path: string, value: unknown) { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-resource-http-')));
  options = { root: join(directory, 'ledger'), poolFile: join(directory, 'pool.json'),
    bindingsFile: join(directory, 'bindings.json'), observationsFile: join(directory, 'observations.json') };
  write(options.poolFile, { schemaVersion: 1, id: 'http-fixture', workers: [{ id: 'local', provider: 'local',
    model: 'not-a-real-model', maxConcurrent: 1, reservePercent: 0, maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1 }] });
  write(options.bindingsFile, [{ workerId: 'local', capacityKey: 'fixture-local', kind: 'local-chat', endpoint: 'http://127.0.0.1:9/v1' }]);
  write(options.observationsFile, [{ workerId: 'local', health: 'ready', windows: [], retryAfter: null,
    observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }]);
});
afterEach(async () => { await Promise.allSettled(handles.splice(0).map((handle) => handle.close())); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });
async function start(extra: Partial<ResourceConsoleServerOptions> = {}) {
  const handle = await startResourceConsoleServer({ ...options, ...extra }); handles.push(handle); return handle;
}
async function http(handle: ResourceConsoleServerHandle, path: string, method = 'GET',
  headers: Record<string, string> = {}, input?: string) {
  return new Promise<{ status: number; text: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: handle.port, path, method, agent: false, headers }, (res) => {
      const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject); req.setTimeout(15_000, () => req.destroy(new Error('Fixture HTTP timeout'))); req.end(input);
  });
}

describe('resource console HTTP fences', () => {
  it('reads explicit missing-store evidence without initialization or exposing bindings', async () => {
    const original = readFileSync(options.observationsFile); const handle = await start();
    expect(handle.controlToken).toBeNull(); expect(handle.scope.readOnly).toBe(true);
    const response = await http(handle, '/api/resources', 'GET', { 'x-ashlr-token': handle.readToken });
    expect(response.status).toBe(200); const value = JSON.parse(response.text);
    expect(value.sourceState).toBe('missing'); expect(value.supervisor).toBeNull();
    expect(value.pool.id).toBe('http-fixture'); expect(response.text).not.toContain(':9/v1');
    expect(response.headers['cache-control']).toBe('no-store'); expect(response.headers['x-frame-options']).toBe('DENY');
    expect(existsSync(options.root)).toBe(false); expect(readFileSync(options.observationsFile)).toEqual(original);
  });
  it.each(['/api/resources', '/api/resources/console', '/api/resources/tasks/a/output'])('rejects unauthenticated %s', async (path) => {
    const handle = await start(); expect((await http(handle, path)).status).toBe(401);
    expect(existsSync(options.root)).toBe(false);
  });
  it('requires independent read proof for a port-scoped session and revokes logout', async () => {
    const handle = await start(); const client = 'c'.repeat(64);
    const session = await http(handle, '/api/session', 'POST', { 'x-ashlr-token': handle.readToken, 'x-ashlr-read-client': client });
    expect(session.status).toBe(204); const cookie = (session.headers['set-cookie'] as string[])[0]!.split(';')[0]!;
    expect((await http(handle, '/api/resources/console', 'GET', { cookie })).status).toBe(401);
    expect((await http(handle, '/api/resources/console', 'GET', { cookie, 'x-ashlr-read-client': 'd'.repeat(64) })).status).toBe(401);
    expect((await http(handle, '/api/resources/console', 'GET', { cookie, 'x-ashlr-read-client': client })).status).toBe(200);
    expect((await http(handle, '/api/session', 'DELETE', { cookie, 'x-ashlr-read-client': client })).status).toBe(204);
    expect((await http(handle, '/api/resources/console', 'GET', { cookie, 'x-ashlr-read-client': client })).status).toBe(401);
  });
  it.each(['/api/resources/tasks', '/api/resources/queue', '/api/resources/tasks/task/cancel'])('read-only refuses mutation %s', async (path) => {
    const handle = await start(); expect((await http(handle, path, 'POST', { 'x-ashlr-token': handle.readToken,
      'content-type': 'application/json' }, '{}')).status).toBe(403); expect(existsSync(options.root)).toBe(false);
  });
  it.each(['/api/events', '/api/config', '/api/fleet', '/api/universe', '/api/resources/tasks/../output', '/next/index.html', '/universe/'])('does not expose unrelated route %s', async (path) => {
    const handle = await start(); expect((await http(handle, path, 'GET', { 'x-ashlr-token': handle.readToken })).status).toBe(404);
  });
  it.each([{ host: 'evil.invalid' }, { origin: 'https://evil.invalid' }, { origin: 'null' }])('rejects host/origin %j', async (headers) => {
    const handle = await start(); expect((await http(handle, '/api/resources/console', 'GET', {
      'x-ashlr-token': handle.readToken, ...headers } as Record<string, string>)).status).toBe(403);
  });
  it.each(['/api/resources?root=/private/elsewhere', '/api/resources?client=secret', '/api/session?token=secret', '/resources/?token=secret'])('rejects query scope or token delivery %s', async (path) => {
    const handle = await start(); expect((await http(handle, path, 'GET', { 'x-ashlr-token': handle.readToken })).status).toBe(400);
  });
  it('reports source degradation while cheap scope stays reachable', async () => {
    const handle = await start(); writeFileSync(options.observationsFile, '{invalid private source', { mode: 0o600 });
    const response = await http(handle, '/api/resources', 'GET', { 'x-ashlr-token': handle.readToken });
    expect(response.status).toBe(200); expect(JSON.parse(response.text).sourceState).toBe('degraded');
    expect(JSON.parse(response.text).counts.total).toBeNull(); expect(response.text).not.toContain('private source');
    expect((await http(handle, '/api/resources/console', 'GET', { 'x-ashlr-token': handle.readToken })).status).toBe(200);
  });
  it.each(['root', 'poolFile', 'bindingsFile', 'observationsFile'] as const)('rejects mutable control input %s inside workspace before writes', async (key) => {
    const workspace = join(directory, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
    const nested = join(workspace, key);
    if (key !== 'root') writeFileSync(nested, readFileSync(options[key]), { mode: 0o600 });
    await expect(start({ execute: true, workspace, [key]: nested })).rejects.toThrow(/outside the writable workspace/);
    expect(existsSync(options.root)).toBe(false); expect(existsSync(join(workspace, 'root'))).toBe(false);
  });
  it.each([{ execute: true }, { workspace: '/private/work' }, { maxParallel: 1 }, { port: -1 }, { port: 65536 }])('rejects invalid programmatic options before state %j', async (extra) => {
    await expect(start(extra)).rejects.toThrow(); expect(existsSync(options.root)).toBe(false);
  });
  it('pre-aborted startup is inert and close is idempotent', async () => {
    const controller = new AbortController(); controller.abort(); await expect(start({ signal: controller.signal })).rejects.toThrow(/cancelled/);
    expect(existsSync(options.root)).toBe(false); const handle = await start(); await handle.close(); await handle.close();
  });
});

/** Transport doubles exercise the server await boundary without native/provider contact. */
function managedFixture() {
  const pool: ResourcePool = { schemaVersion: 1, id: 'managed-http-fixture', workers: [{ id: 'codex-a', provider: 'codex',
    model: 'inert-fixture', maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 10,
    taskWindowMs: 60_000, priority: 1, allowUnknownQuota: true }] };
  const bindings: ResourceBinding[] = [{ workerId: 'codex-a', capacityKey: 'managed-fixture', kind: 'native-cli',
    command: [process.execPath, join(directory, 'never-executed.cjs')] }];
  const observations: ResourceObservation[] = [{ workerId: 'codex-a', health: 'ready', retryAfter: null,
    observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    windows: [{ id: 'codex_codex_primary', usedPercent: 25, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] }];
  options.quotaConfigFile = join(directory, 'quota.json');
  write(options.poolFile, pool); write(options.bindingsFile, bindings); write(options.observationsFile, observations);
  write(options.quotaConfigFile, { schemaVersion: 1, poolDigest: digest(canonical({ pool, bindings })),
    workers: [{ workerId: 'codex-a', accountHint: 'a'.repeat(64), bucketIds: ['codex'] }] });
  const state: { observations: ResourceObservation[]; unavailable: string[]; status: refreshers.ResourceQuotaRefreshStatus } = {
    observations, unavailable: [], status: 'observed',
  };
  const close = vi.fn(async () => {});
  const refresher: refreshers.ResourceQuotaRefresher = {
    readObservations: (base) => mergeResourceObservations(base, state.observations),
    unavailableWorkerIds: () => [...state.unavailable],
    snapshot: () => ({ schemaVersion: 1, scope: 'codex-native-metadata', state: 'running', sampledAt: new Date().toISOString(),
      workers: [{ workerId: 'codex-a', status: state.status, lastAttemptAt: observations[0]!.observedAt,
        lastSuccessAt: state.status === 'observed' ? observations[0]!.observedAt : null,
        nextAttemptAt: null, reason: `managed-quota-${state.status}` }] }),
    close,
  };
  const created = vi.spyOn(refreshers, 'createResourceQuotaRefresher').mockReturnValue(refresher);
  const projected = (managed?: readers.ResourceConsoleManagedRead) => projectResourceConsoleEvidence(pool, bindings,
    resourcePoolStatus(options.root, pool, bindings, managed?.observations ?? [], managed?.unavailableWorkerIds ?? []));
  const snapshot = vi.fn(async (managed?: readers.ResourceConsoleManagedRead) => projected(managed));
  vi.spyOn(readers, 'createResourceConsoleReader').mockReturnValue({ snapshot, close: async () => {} });
  return { state, created, close, snapshot, projected, observations,
    marker: join(options.root, '.resource-quota-refresh-pending.json') };
}

describe('managed quota server lifecycle and coherent reads', () => {
  it('retries a pending-to-observed transition before publishing current eligibility', async () => {
    const f = managedFixture(); f.state.observations = []; f.state.unavailable = ['codex-a']; f.state.status = 'pending';
    f.snapshot.mockImplementationOnce(async (managed) => {
      const before = f.projected(managed); f.state.observations = f.observations; f.state.unavailable = []; f.state.status = 'observed';
      return before;
    });
    const handle = await start(); const response = await http(handle, '/api/resources', 'GET', { 'x-ashlr-token': handle.readToken });
    expect(response.status).toBe(200); expect(f.snapshot).toHaveBeenCalledTimes(2);
    const result = JSON.parse(response.text);
    expect(result.plan.selectedWorkerId).toBe('codex-a'); expect(result.quotaRefresh.workers[0].status).toBe('observed');
  });

  it('withholds eligibility when the collector fails while a read is pending', async () => {
    const f = managedFixture();
    f.snapshot.mockImplementationOnce(async (managed) => {
      const before = f.projected(managed); f.state.unavailable = ['codex-a']; f.state.status = 'failed'; return before;
    });
    const handle = await start(); const response = await http(handle, '/api/resources', 'GET', { 'x-ashlr-token': handle.readToken });
    expect(response.status).toBe(200); expect(f.snapshot).toHaveBeenCalledTimes(2);
    const result = JSON.parse(response.text);
    expect(result.plan.selectedWorkerId).toBeNull(); expect(result.quotaRefresh.workers[0].status).toBe('failed');
    expect(result.observations).toEqual(f.observations); expect(result.counts.total).toBe(0);
  });

  it('bounds repeated collector changes to two reads and returns no contradictory evidence', async () => {
    const f = managedFixture();
    f.snapshot.mockImplementation(async (managed) => {
      const before = f.projected(managed);
      f.state.unavailable = f.state.unavailable.length ? [] : ['codex-a'];
      f.state.status = f.state.unavailable.length ? 'failed' : 'observed'; return before;
    });
    const handle = await start(); const response = await http(handle, '/api/resources', 'GET', { 'x-ashlr-token': handle.readToken });
    expect(response.status).toBe(503); expect(f.snapshot).toHaveBeenCalledTimes(2);
    expect(JSON.parse(response.text)).toEqual({ error: 'Resource quota or allocation evidence changed during this read' });
  });

  it('waits for execution ownership with a placeholder managed gate before creating a collector', async () => {
    const f = managedFixture(); const workspace = join(directory, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
    const original = supervisors.createResourcePoolSupervisor;
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    const owning = vi.spyOn(supervisors, 'createResourcePoolSupervisor').mockImplementation(async (input) => {
      expect(input.readUnavailableWorkerIds?.()).toEqual(['codex-a']);
      await held; return original(input);
    });
    const starting = start({ execute: true, workspace });
    await vi.waitFor(() => expect(owning).toHaveBeenCalledOnce());
    expect(f.created).not.toHaveBeenCalled(); expect(existsSync(f.marker)).toBe(false);
    release(); const handle = await starting;
    expect(f.created).toHaveBeenCalledOnce(); expect(existsSync(f.marker)).toBe(true);
    expect(owning.mock.calls[0]![0].readUnavailableWorkerIds?.()).toEqual([]);
    await handle.close(); expect(existsSync(f.marker)).toBe(false);
  });

  it('does not create a collector when execution ownership fails', async () => {
    const f = managedFixture(); const workspace = join(directory, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
    vi.spyOn(supervisors, 'createResourcePoolSupervisor').mockRejectedValue(new Error('Fixture owner unavailable'));
    await expect(start({ execute: true, workspace })).rejects.toThrow('Fixture owner unavailable');
    expect(f.created).not.toHaveBeenCalled(); expect(existsSync(f.marker)).toBe(false);
    expect(existsSync(join(options.root, '.resource-quota-refresh.lock'))).toBe(false);
  });

  it('aborting during execution preflight prevents collector startup', async () => {
    const f = managedFixture(); const workspace = join(directory, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
    const controller = new AbortController(); const original = supervisors.createResourcePoolSupervisor;
    vi.spyOn(supervisors, 'createResourcePoolSupervisor').mockImplementation(async (input) => {
      const supervisor = await original(input); controller.abort(); return supervisor;
    });
    await expect(start({ execute: true, workspace, signal: controller.signal })).rejects.toThrow(/cancelled/);
    expect(f.created).not.toHaveBeenCalled(); expect(existsSync(f.marker)).toBe(false);
  });

  it.each(['invalid-json', 'wrong-pool'])('rejects existing %s ledger before metadata contact', async (mode) => {
    const f = managedFixture(); mkdirSync(options.root, { mode: 0o700 });
    const ledger = join(options.root, 'pool-state.json');
    if (mode === 'invalid-json') writeFileSync(ledger, '{invalid', { mode: 0o600 });
    else write(ledger, { schemaVersion: 1, poolDigest: 'b'.repeat(64), observations: [], attempts: [] });
    await expect(start()).rejects.toThrow(); expect(f.created).not.toHaveBeenCalled(); expect(existsSync(f.marker)).toBe(false);
  });

  it('retains a changed pending marker rather than deleting evidence it no longer owns', async () => {
    const f = managedFixture(); const handle = await start(); write(f.marker, { schemaVersion: 1, state: 'changed-fixture' });
    expect(() => f.created.mock.calls[0]![0].assertOwnership?.()).toThrow(/marker changed/);
    await expect(handle.close()).rejects.toThrow(/shutdown uncertain/);
    expect(JSON.parse(readFileSync(f.marker, 'utf8')).state).toBe('changed-fixture');
    const original = readFileSync(f.marker); const blocked = await start();
    expect(blocked.scope).toMatchObject({ readOnly: true, quotaRefreshEnabled: true });
    const response = await http(blocked, '/api/resources', 'GET', { 'x-ashlr-token': blocked.readToken });
    expect(response.status).toBe(200); const value = JSON.parse(response.text);
    expect(value.metadataCollector).toMatchObject({ state: 'blocked', reasonCode: 'reconciliation-required' });
    expect(value.quotaRefresh).toBeUndefined(); expect(value.plan.selectedWorkerId).toBeNull();
    expect(f.created).toHaveBeenCalledOnce();
    await blocked.close(); await blocked.close();
    expect(readFileSync(f.marker)).toEqual(original);
    expect(existsSync(join(options.root, '.resource-quota-refresh.lock'))).toBe(false);
  });

  it('preserves a preexisting crash marker while serving a configured blocked console', async () => {
    const f = managedFixture(); mkdirSync(options.root, { mode: 0o700 }); write(f.marker, { state: 'test-owned-crash' });
    const original = readFileSync(f.marker);
    const blocked = await start();
    expect(blocked.scope).toMatchObject({ readOnly: true, quotaRefreshEnabled: true });
    const response = await http(blocked, '/api/resources', 'GET', { 'x-ashlr-token': blocked.readToken });
    expect(response.status).toBe(200); const value = JSON.parse(response.text);
    expect(value.metadataCollector).toMatchObject({ state: 'blocked', reasonCode: 'reconciliation-required' });
    expect(value.quotaRefresh).toBeUndefined(); expect(value.plan.selectedWorkerId).toBeNull();
    expect(f.snapshot).toHaveBeenCalledWith({ observations: [], unavailableWorkerIds: ['codex-a'] });
    await blocked.close(); await blocked.close();
    expect(f.created).not.toHaveBeenCalled(); expect(readFileSync(f.marker)).toEqual(original);
    expect(f.close).not.toHaveBeenCalled();
    expect(existsSync(join(options.root, '.resource-quota-refresh.lock'))).toBe(false);
  });
});
