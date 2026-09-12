import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startResourceConsoleServer, type ResourceConsoleServerHandle, type ResourceConsoleServerOptions } from '../src/core/web/resource-console-server.js';
import * as leases from '../src/core/resources/quota-refresh-lease.js';
import * as refreshers from '../src/core/resources/quota-refresh.js';
import * as monitors from '../src/core/resources/connection-monitor.js';
import * as coordinators from '../src/core/resources/metadata-coordinator.js';
import * as supervisors from '../src/core/resources/pool-supervisor.js';
import * as engineering from '../src/core/resources/console-engineering.js';
import * as engineeringSupervisors from '../src/core/resources/console-engineering-supervisor.js';
import * as preparation from '../src/core/resources/console-engineering-preparation.js';
import * as background from '../src/core/resources/engineering-background.js';
import * as automatic from '../src/core/resources/engineering-automatic-admission.js';
import * as codex from '../src/core/resources/codex-account-probe.js';
import * as claude from '../src/core/resources/claude-account-usage.js';
import * as grok from '../src/core/resources/grok-account-probe.js';
import * as boot from '../src/core/resources/native-boot-identity.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';

// Actual HTTP + private files. Every collector/probe/owner constructor is an
// inert refusal double; this suite never establishes provider or PID readiness.
let base: string; let options: ResourceConsoleServerOptions;
let effects: Record<string, { mock: { calls: unknown[][] } }>;
let allowed: Set<string>;
const handles: ResourceConsoleServerHandle[] = [];
const markerName = '.resource-quota-refresh-pending.json';
const pool = { schemaVersion: 1, id: 'inspection-fixture', workers: [{ id: 'personal', provider: 'codex',
  model: 'gpt-6-astra', maxConcurrent: 1, reservePercent: 25, maxTasksPerWindow: 5, taskWindowMs: 60_000, priority: 1 }] };
const bindings = [{ workerId: 'personal', capacityKey: 'personal-account', kind: 'native-cli',
  command: ['/synthetic/private-launcher', '--private-argument'] }];
const poolDigest = digest(canonical({ pool, bindings }));
function write(file: string, value: unknown) { writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); }
function marker(version = 1) {
  return { schemaVersion: version, scope: 'codex-native-metadata', state: 'pending', startedAt: '2026-09-12T00:00:00.000Z',
    ...(version > 1 ? { bootIdentity: { machineDigest: 'a'.repeat(64), bootId: '11111111-1111-4111-8111-111111111111' },
      ownerToken: '22222222-2222-4222-8222-222222222222' } : {}), ...(version > 2 ? { ownerPid: 123456 } : {}) };
}
function inventory(directory: string): unknown {
  return readdirSync(directory).sort().map(name => {
    const file = join(directory, name); const stat = lstatSync(file, { bigint: true });
    return { name, ino: String(stat.ino), mode: String(stat.mode), size: String(stat.size),
      mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
      ...(stat.isDirectory() ? { children: inventory(file) } : stat.isFile() ? { bytes: readFileSync(file).toString('hex') } : {}) };
  });
}
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'resource-passive-http-')));
  options = { root: join(base, 'ledger'), poolFile: join(base, 'pool.json'), bindingsFile: join(base, 'bindings.json'),
    observationsFile: join(base, 'observations.json') };
  mkdirSync(options.root, { mode: 0o700 });
  write(options.poolFile, pool); write(options.bindingsFile, bindings); write(options.observationsFile, []);
  write(join(options.root, 'pool-state.json'), { schemaVersion: 1, poolDigest, observations: [], attempts: [],
    workerAccess: { pausedWorkerIds: ['personal'], revision: 1, updatedAt: '2026-09-12T00:00:00.000Z' } });
  const blocked = (): never => { throw new Error('Unexpected effectful entrypoint in passive HTTP fixture'); };
  effects = {
    acquire: vi.spyOn(leases, 'acquireResourceQuotaRefreshLease').mockImplementation(blocked),
    refresh: vi.spyOn(refreshers, 'createResourceQuotaRefresher').mockImplementation(blocked),
    monitor: vi.spyOn(monitors, 'createResourceConnectionMonitor').mockImplementation(blocked),
    coordinator: vi.spyOn(coordinators, 'createNativeMetadataCoordinator').mockImplementation(blocked),
    supervisor: vi.spyOn(supervisors, 'createResourcePoolSupervisor').mockImplementation(blocked),
    engineering: vi.spyOn(engineering, 'createResourceConsoleEngineeringOwner').mockImplementation(blocked),
    engineeringSupervisor: vi.spyOn(engineeringSupervisors, 'createResourceConsoleEngineeringSupervisor').mockImplementation(blocked),
    preparation: vi.spyOn(preparation, 'createResourceConsoleEngineeringPreparation').mockImplementation(blocked),
    background: vi.spyOn(background, 'createEngineeringBackground').mockImplementation(blocked),
    automatic: vi.spyOn(automatic, 'createResourceEngineeringAutomaticAdmission').mockImplementation(blocked),
    codex: vi.spyOn(codex, 'probeCodexResourceAccount').mockImplementation(blocked),
    claude: vi.spyOn(claude, 'probeClaudeAccountUsage').mockImplementation(blocked),
    grok: vi.spyOn(grok, 'probeGrokAccount').mockImplementation(blocked),
    boot: vi.spyOn(boot, 'readNativeBootIdentity').mockImplementation(blocked),
  };
  allowed = new Set();
});
afterEach(async () => {
  try {
    for (const handle of handles.splice(0)) await handle.close();
    for (const [name, effect] of Object.entries(effects)) if (!allowed.has(name)) expect(effect.mock.calls, name).toEqual([]);
  } finally { vi.restoreAllMocks(); rmSync(base, { recursive: true, force: true }); }
});
async function start(extra: Partial<ResourceConsoleServerOptions> = {}) {
  const handle = await startResourceConsoleServer({ ...options, ...extra }); handles.push(handle); return handle;
}
async function http(handle: ResourceConsoleServerHandle, path = '/api/resources', authenticated = true,
  extraHeaders: Record<string, string> = {}) {
  return new Promise<{ status: number; text: string; cache: string | undefined }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: handle.port, path, agent: false,
      headers: { ...(authenticated ? { 'x-ashlr-token': handle.readToken } : {}), ...extraHeaders } }, res => {
      const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString('utf8'), cache: res.headers['cache-control'] }));
    });
    req.on('error', reject); req.setTimeout(10_000, () => req.destroy(new Error('Fixture HTTP timeout'))); req.end();
  });
}
function inspection(response: Awaited<ReturnType<typeof http>>) {
  expect(response.status).toBe(200); expect(response.cache).toBe('no-store');
  const body = JSON.parse(response.text);
  expect(body.supervisor).toBeNull(); expect(body.metadataCollector).toBeUndefined();
  expect(body.quotaRefresh).toBeUndefined(); expect(body.connections).toBeUndefined();
  expect(response.text).not.toContain('private-launcher'); expect(response.text).not.toContain('private-argument');
  const value = body.collectorInspection;
  expect(Object.keys(value).sort()).toEqual(['markerVersion', 'reasonCode', 'recoveryAttempted', 'sampledAt', 'scope', 'state']);
  expect(value.scope).toBe('local-record-inspection'); expect(value.recoveryAttempted).toBe(false);
  expect(new Date(value.sampledAt).toISOString()).toBe(value.sampledAt);
  return value;
}

describe('passive collector inspection over authenticated HTTP', () => {
  it('reports retained legacy custody without changing marker, ledger or account pause', async () => {
    write(join(options.root, markerName), marker()); const before = inventory(base); const handle = await start();
    const response = await http(handle);
    expect(inspection(response)).toMatchObject({ state: 'pending', markerVersion: 1, reasonCode: 'legacy-owner-evidence-missing' });
    expect(JSON.parse(response.text).workerAccess.pausedWorkerIds).toEqual(['personal']);
    await handle.close(); expect(inventory(base)).toEqual(before);
  });

  it('requires authentication and same-origin scope before inspecting private metadata', async () => {
    write(join(options.root, markerName), marker()); const observed = vi.spyOn(leases, 'inspectResourceQuotaRefreshPending');
    const before = inventory(base); const handle = await start();
    expect((await http(handle, '/api/resources', false)).status).toBe(401);
    expect((await http(handle, '/api/resources', true, { origin: 'https://foreign.invalid' })).status).toBe(403);
    expect((await http(handle, '/api/resources?root=/elsewhere')).status).toBe(400);
    expect(observed).not.toHaveBeenCalled(); expect(inventory(base)).toEqual(before);
    inspection(await http(handle)); expect(observed).toHaveBeenCalledExactlyOnceWith(options.root);
  });

  it('reads each fresh filesystem state, without treating absent or modern custody as ready', async () => {
    const handle = await start(); const first = inspection(await http(handle));
    expect(first).toMatchObject({ state: 'absent', markerVersion: null, reasonCode: 'no-pending-record' });
    write(join(options.root, markerName), marker());
    const second = inspection(await http(handle)); expect(second.state).toBe('pending');
    write(join(options.root, markerName), marker(4)); const before = inventory(base);
    const third = inspection(await http(handle));
    expect(third).toMatchObject({ state: 'pending', markerVersion: 4, reasonCode: 'recovery-not-evaluated' });
    expect(Date.parse(third.sampledAt)).toBeGreaterThanOrEqual(Date.parse(first.sampledAt));
    expect(inventory(base)).toEqual(before);
    unlinkSync(join(options.root, markerName)); expect(inspection(await http(handle)).state).toBe('absent');
  });

  it.each(['malformed', 'oversized', 'nonprivate', 'symlink', 'directory'] as const)('refuses %s markers without writes or private detail leakage', async kind => {
    const file = join(options.root, markerName);
    if (kind === 'malformed') writeFileSync(file, '{ PRIVATE_DIAGNOSTIC_SENTINEL', { mode: 0o600 });
    if (kind === 'oversized') writeFileSync(file, 'X'.repeat(513), { mode: 0o600 });
    if (kind === 'nonprivate') { write(file, marker()); chmodSync(file, 0o644); }
    if (kind === 'symlink') { write(join(base, 'outside-marker.json'), marker()); symlinkSync(join(base, 'outside-marker.json'), file); }
    if (kind === 'directory') mkdirSync(file, { mode: 0o700 });
    const before = inventory(base); const handle = await start(); const response = await http(handle);
    expect(inspection(response)).toMatchObject({ state: 'unavailable', markerVersion: null, reasonCode: 'pending-evidence-unavailable' });
    expect(response.text).not.toContain('PRIVATE_DIAGNOSTIC_SENTINEL'); expect(response.text).not.toContain(base);
    await handle.close(); expect(inventory(base)).toEqual(before);
  });

  it('does not create a missing ledger or turn it into ready collector evidence', async () => {
    rmSync(options.root, { recursive: true }); const before = inventory(base); const handle = await start();
    expect(inspection(await http(handle))).toMatchObject({ state: 'unavailable', markerVersion: null, reasonCode: 'pending-evidence-unavailable' });
    await handle.close(); expect(inventory(base)).toEqual(before);
  });

  it.each(['quota', 'connections', 'both'] as const)('keeps explicitly configured %s acquisition separate from passive inspection', async kind => {
    const quotaConfigFile = join(base, 'quota.json'); const connectionsConfigFile = join(base, 'connections.json');
    write(quotaConfigFile, { schemaVersion: 1, poolDigest, workers: [{ workerId: 'personal', accountHint: 'a'.repeat(64), bucketIds: ['codex'] }] });
    write(connectionsConfigFile, { schemaVersion: 1, intervalMs: 30_000, accounts: [{ id: 'personal', label: 'Fixture',
      provider: 'codex', command: bindings[0]!.command }] });
    allowed.add('acquire');
    vi.mocked(leases.acquireResourceQuotaRefreshLease).mockRejectedValue(new leases.ResourceQuotaRefreshLeaseError('reconciliation-required', 'Fixed fixture refusal'));
    const observed = vi.spyOn(leases, 'inspectResourceQuotaRefreshPending'); const before = inventory(base);
    const handle = await start({ ...(kind !== 'connections' ? { quotaConfigFile } : {}), ...(kind !== 'quota' ? { connectionsConfigFile } : {}) });
    const response = await http(handle); expect(response.status).toBe(200);
    const body = JSON.parse(response.text); expect(body.collectorInspection).toBeUndefined();
    expect(body.metadataCollector).toMatchObject({ state: 'blocked', reasonCode: 'reconciliation-required' });
    expect(observed).not.toHaveBeenCalled(); expect(effects.acquire!.mock.calls).toHaveLength(1);
    await handle.close(); expect(inventory(base)).toEqual(before);
  });

  it('does not use passive inspection in execute mode with an inert supervisor', async () => {
    const workspace = join(base, 'workspace'); mkdirSync(workspace, { mode: 0o700 }); allowed.add('supervisor');
    const unused = (): never => { throw new Error('Unused fixture supervisor operation'); };
    const owner: supervisors.ResourcePoolSupervisor = { snapshot: () => ({ instanceId: 'fixture', paused: true, closing: false,
      error: null, maxParallel: 1, maxQueued: 1, activeCount: 0, queuedCount: 0, jobs: [] }),
      projects: () => undefined, projectFileBinding: unused, engineeringBinding: unused, projectExecutionBinding: unused,
      submit: unused, cancel: unused, setPaused: unused, output: unused, history: unused, deleteHistory: unused, close: vi.fn(async () => {}) };
    vi.mocked(supervisors.createResourcePoolSupervisor).mockResolvedValue(owner);
    const observed = vi.spyOn(leases, 'inspectResourceQuotaRefreshPending'); const before = inventory(base);
    const handle = await start({ execute: true, workspace }); const response = await http(handle);
    expect(response.status).toBe(200); expect(JSON.parse(response.text).collectorInspection).toBeUndefined();
    expect(observed).not.toHaveBeenCalled(); expect(effects.supervisor!.mock.calls).toHaveLength(1);
    await handle.close(); expect(inventory(base)).toEqual(before);
  });
});
