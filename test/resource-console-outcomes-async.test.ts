/** Real loopback HTTP and private console files; deferred read-only owner, no workers/providers. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ onSpawn: null as null | ((child: import('node:child_process').ChildProcess) => void) }));
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: (...args: Parameters<typeof original.spawn>) => {
    const child = original.spawn(...args);
    native.onSpawn?.(child); // Observe the actual owned subprocess; never replace its launch or cleanup.
    return child;
  } };
});
const owner = vi.hoisted(() => ({ create: vi.fn(), validate: vi.fn(), catalog: vi.fn(), snapshot: vi.fn(),
  readiness: vi.fn(), outcomes: vi.fn(), launch: vi.fn(), cancel: vi.fn(), close: vi.fn() }));
vi.mock('../src/core/resources/console-engineering.js', () => ({
  validateResourceConsoleEngineeringCatalog: owner.validate, createResourceConsoleEngineeringOwner: owner.create,
}));
import { startResourceConsoleServer, type ResourceConsoleServerOptions, type ResourceConsoleWorkspaceHandle } from '../src/core/web/resource-console-server.js';
import type { ResourceEngineeringOutcomes } from '../src/core/resources/engineering-outcomes-types.js';
import { ReadProjectionError } from '../src/core/web/bounded-read-worker.js';

const route = '/api/resources/engineering/fix/outcomes';
const handles: ResourceConsoleWorkspaceHandle[] = [];
const releases: Array<() => void> = [];
let directory: string; let options: ResourceConsoleServerOptions; let nativeCleanupConfirmed = true;
function result(): ResourceEngineeringOutcomes {
  return { schemaVersion: 1, enrollmentId: 'fix', enrollmentDigest: 'a'.repeat(64), sampledAt: '2026-09-13T00:00:00.000Z',
    sourceState: 'healthy', scope: 'campaign-evaluations-and-recorded-worker-usage', authority: 'observation-only',
    acceptanceScope: 'fixed-evaluator-and-local-branch-only', attribution: 'campaign-cumulative-not-graph-invocation',
    productionAccepted: null, routingChanged: false, complete: true, reasons: [], campaigns: [],
    usage: { attempts: 0, joinedAttempts: 0, reportedAttempts: 0, unknownAttempts: 0, recordedInputTokens: 0,
      recordedOutputTokens: 0, totalTokens: null, complete: true },
    timing: { scope: 'summed-worker-execution', attempts: 0, measuredAttempts: 0, recordedDurationMs: 0, totalDurationMs: null, complete: true } };
}
function deferredRead() {
  let entered!: (signal: AbortSignal | undefined) => void;
  let resolve!: (value: ResourceEngineeringOutcomes) => void;
  let reject!: (error: Error) => void;
  const started = new Promise<AbortSignal | undefined>(done => { entered = done; });
  const value = new Promise<ResourceEngineeringOutcomes>((done, fail) => { resolve = done; reject = fail; });
  owner.outcomes.mockImplementation((_id: string, options?: { signal?: AbortSignal }) => { entered(options?.signal); return value; });
  releases.push(() => resolve(result()));
  return { started, resolve, reject };
}
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
beforeEach(() => {
  native.onSpawn = null;
  nativeCleanupConfirmed = true;
  vi.resetAllMocks(); directory = realpathSync(mkdtempSync(join(tmpdir(), 'console-outcomes-async-')));
  const workspace = join(directory, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
  options = { root: join(directory, 'ledger'), poolFile: join(directory, 'pool.json'), bindingsFile: join(directory, 'bindings.json'),
    observationsFile: join(directory, 'observations.json'), projectsFile: join(directory, 'projects.json'),
    engineeringFile: join(directory, 'engineering.json'), execute: true, workspace };
  save(options.poolFile, { schemaVersion: 1, id: 'fixture', workers: [{ id: 'local', provider: 'local', model: 'inert',
    maxConcurrent: 1, reservePercent: 0, maxTasksPerWindow: 1, taskWindowMs: 60000, priority: 1 }] });
  save(options.bindingsFile, [{ workerId: 'local', capacityKey: 'shared', kind: 'local-chat', endpoint: 'http://127.0.0.1:1/v1' }]);
  save(options.observationsFile, []); save(options.projectsFile!, { schemaVersion: 1, projects: [] });
  save(options.engineeringFile!, { schemaVersion: 1, enrollments: [] });
  owner.validate.mockImplementation(value => value); owner.create.mockReturnValue(owner); owner.close.mockResolvedValue(undefined);
  owner.catalog.mockReturnValue([{ id: 'fix', projectId: 'default', enrollmentDigest: 'a'.repeat(64) }]);
  owner.snapshot.mockReturnValue({ enrollmentId: 'fix', projectId: 'default', state: 'ready' });
  owner.outcomes.mockResolvedValue(result());
});
afterEach(async () => {
  native.onSpawn = null;
  for (const release of releases.splice(0)) release();
  for (const handle of handles.splice(0)) await handle.close();
  vi.restoreAllMocks();
  if (nativeCleanupConfirmed) rmSync(directory, { recursive: true, force: true });
  else console.warn(`Preserved uncertain native outcomes fixture: ${directory}`);
});

describe('actual fixed outcomes helper bootstrap cancellation', () => {
  it.each(['request-abort', 'owner-close'] as const)('settles the real owned bootstrap process group after %s', async cancellation => {
    const { createResourceEngineeringOutcomesReader } = await import('../src/core/resources/engineering-outcomes-reader.js');
    const reader = createResourceEngineeringOutcomesReader(); const abort = new AbortController();
    mkdirSync(options.root, { mode: 0o700 });
    // Protocol-valid private scope only. Deliberately no real campaign: this
    // test proves native bootstrap cancellation, NOT signal-handler hold during
    // a synchronous Git read, successful proof reading, or descendant cleanup.
    const input = { root: options.root, poolFile: options.poolFile, bindingsFile: options.bindingsFile,
      enrollment: { id: 'fixture', enrollmentDigest: 'a'.repeat(64), campaigns: [] },
      host: { root: join(directory, 'universe'), resourceRuntime: join(directory, 'runtime.json') },
    } as Parameters<typeof reader.read>[0];
    const readOptions = { expectedNodeInput: { bindingDigest: 'b'.repeat(64), requestDigest: 'c'.repeat(64) }, signal: abort.signal };
    let launched!: (pid: number) => void; let launches = 0;
    const spawned = new Promise<number>(resolve => { launched = resolve; });
    native.onSpawn = child => {
      launches++; nativeCleanupConfirmed = false;
      child.once('spawn', () => launched(child.pid!));
    };
    const reading = reader.read(input, readOptions);
    const rejected = expect(reading).rejects.toMatchObject({ code: 'READ_PROJECTION_CANCELLED' });
    try {
      const pid = await spawned; expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      await expect(reader.read(input, readOptions)).rejects.toMatchObject({ code: 'READ_PROJECTION_BUSY' });
      if (cancellation === 'request-abort') { abort.abort(); await rejected; await reader.close(); }
      else { const closed = reader.close(); await rejected; await closed; }
      let absent = false;
      try { process.kill(-pid, 0); } catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      nativeCleanupConfirmed = absent;
      expect(absent).toBe(true); expect(launches).toBe(1);
      expect(owner.launch).not.toHaveBeenCalled(); expect(owner.cancel).not.toHaveBeenCalled();
    } finally { abort.abort(); await reader.close(); native.onSpawn = null; }
  }, 15000);
});
async function start() { const handle = await startResourceConsoleServer(options); handles.push(handle); return handle; }
function get(handle: ResourceConsoleWorkspaceHandle, path = route) {
  return fetch(`${handle.url}${path}`, { headers: { 'x-ashlr-token': handle.readToken }, signal: AbortSignal.timeout(5000) });
}

describe('asynchronous engineering outcomes HTTP boundary', () => {
  it('awaits the exact report while health and authenticated reads remain responsive', async () => {
    const pending = deferredRead(); const handle = await start(); let finished = false;
    const response = get(handle).then(async response => ({ status: response.status, body: await response.json() }))
      .then(value => { finished = true; return value; });
    const signal = await pending.started;
    expect(signal).toBeInstanceOf(AbortSignal); expect(signal!.aborted).toBe(false);
    const health = await get(handle, '/health'); expect(health.status).toBe(200); expect(await health.json()).toEqual({ ok: true });
    const other = await get(handle, '/api/resources/engineering'); expect(other.status).toBe(200);
    expect(await other.json()).toEqual(owner.catalog());
    expect(finished).toBe(false); expect(signal!.aborted).toBe(false);
    pending.resolve(result()); expect(await response).toEqual({ status: 200, body: result() });
    expect(owner.launch).not.toHaveBeenCalled(); expect(owner.cancel).not.toHaveBeenCalled();
  });

  it('does not treat a fully received GET request as a client disconnect', async () => {
    const pending = deferredRead(); const handle = await start(); const response = get(handle);
    const signal = await pending.started;
    await get(handle, '/health'); // Cross a real server event-loop boundary before completing the deferred GET.
    expect(signal?.aborted).toBe(false);
    pending.resolve(result()); const completed = await response;
    expect(completed.status).toBe(200); expect(completed.headers.get('cache-control')).toBe('no-store');
    expect(await completed.json()).toEqual(result()); expect(signal?.aborted).toBe(false);
  });

  it('aborts only the disconnected request and keeps the console available', async () => {
    const pending = deferredRead(); const handle = await start();
    const client = request(`${handle.url}${route}`, { headers: { 'x-ashlr-token': handle.readToken }, agent: false });
    client.on('error', () => {}); client.end();
    const signal = await pending.started; expect(signal).toBeInstanceOf(AbortSignal);
    const aborted = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Request abort was not propagated')), 1500);
      signal!.addEventListener('abort', () => { clearTimeout(timer); pending.reject(new Error('Cancelled fixture observation')); resolve(); }, { once: true });
    });
    client.destroy(); await aborted; expect(signal!.aborted).toBe(true);
    owner.outcomes.mockResolvedValue(result());
    expect((await get(handle, '/health')).status).toBe(200);
    const next = await get(handle); expect(next.status).toBe(200); expect(await next.json()).toEqual(result());
    expect(owner.cancel).not.toHaveBeenCalled(); expect(owner.launch).not.toHaveBeenCalled();
  });

  it('maps asynchronous reader rejection to a sanitized unavailable response', async () => {
    const pending = deferredRead(); const handle = await start(); const response = get(handle); await pending.started;
    pending.reject(new Error('/private/fixture raw provider-shaped diagnostics'));
    const refused = await response; expect(refused.status).toBe(503);
    expect(await refused.text()).not.toMatch(/private|provider-shaped/);
    expect((await get(handle, '/health')).status).toBe(200);
  });

  it.each([
    ['READ_PROJECTION_BUSY', 429, 'OUTCOME_READ_BUSY'],
    ['READ_PROJECTION_TIMEOUT', 504, 'OUTCOME_READ_TIMEOUT'],
    ['READ_PROJECTION_CLEANUP_UNCONFIRMED', 503, 'OUTCOME_READ_CLEANUP_UNCONFIRMED'],
    ['READ_PROJECTION_UNAVAILABLE', 503, 'OUTCOME_READ_UNAVAILABLE'],
  ] as const)('maps %s to its fixed public diagnostic without private error text', async (code, status, publicCode) => {
    owner.outcomes.mockRejectedValue(new ReadProjectionError('/private/provider/credential-shaped-fixture', code));
    const handle = await start(); const response = await get(handle);
    expect(response.status).toBe(status); expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json(); expect(body).toMatchObject({ code: publicCode });
    expect(JSON.stringify(body)).not.toMatch(/private|provider|credential/);
    expect((await get(handle, '/health')).status).toBe(200);
    expect(owner.outcomes).toHaveBeenCalledTimes(1); expect(owner.launch).not.toHaveBeenCalled();
  });

  it('does not return an old attachment report after the drained component is replaced', async () => {
    const pending = deferredRead(); const handle = await start(); const response = get(handle); await pending.started;
    const prior = handle.engineeringAttachment()!; await prior.close();
    await handle.attachEngineering({ expectedAttachment: prior, engineeringFile: options.engineeringFile });
    expect(handle.engineeringAttachment()).not.toBe(prior);
    pending.resolve(result()); const refused = await response;
    expect(refused.status).toBe(409); expect(await refused.json()).toEqual({ error: 'Engineering attachment changed' });
    expect(owner.launch).not.toHaveBeenCalled();
  });
});
