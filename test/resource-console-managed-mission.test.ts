/** Real HTTP, supervisor and durable controls. Only the mission runner is a lifecycle double. */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/core/resources/engineering-mission.js', () => ({ runResourceEngineeringMission: backend.run }));
import { startResourceConsoleServer, type ResourceConsoleServerOptions, type ResourceConsoleWorkspaceHandle } from '../src/core/web/resource-console-server.js';
import type { ResourceEngineeringMissionConfig } from '../src/core/resources/engineering-mission-store.js';
import type { ResourceEngineeringMissionHost } from '../src/core/resources/engineering-mission.js';
import type { EngineeringMissionSnapshot } from '../src/core/resources/engineering-mission-manager-types.js';
let directory: string;
const handles: ResourceConsoleWorkspaceHandle[] = [];
const write = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
beforeEach(() => { vi.resetAllMocks(); directory = realpathSync(mkdtempSync(join(tmpdir(), 'managed-mission-http-'))); });
afterEach(async () => { await Promise.allSettled(handles.splice(0).map(handle => handle.close())); rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const workspace = join(directory, 'workspace'), missionRoot = join(directory, 'mission');
  for (const dir of [workspace, missionRoot]) mkdirSync(dir, { mode: 0o700 });
  const options: ResourceConsoleServerOptions = { root: join(directory, 'ledger'), workspace, execute: true,
    projectsFile: join(directory, 'projects.json'), engineeringMissionFile: join(directory, 'mission.json'),
    poolFile: join(directory, 'pool.json'), bindingsFile: join(directory, 'bindings.json'), observationsFile: join(directory, 'observations.json') };
  write(options.poolFile, { schemaVersion: 1, id: 'fixture', workers: [{ id: 'local', provider: 'local', model: 'fixture',
    maxConcurrent: 1, reservePercent: 0, maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1 }] });
  write(options.bindingsFile, [{ workerId: 'local', capacityKey: 'fixture', kind: 'local-chat', endpoint: 'http://127.0.0.1:9/v1' }]);
  write(options.observationsFile, []); write(options.projectsFile!, { schemaVersion: 1, projects: [] });
  const runtimeFile = join(directory, 'runtime.json');
  const runtime = { schemaVersion: 1, root: options.root, workspace, poolPath: options.poolFile, bindingsPath: options.bindingsFile, observationsPath: options.observationsFile };
  write(runtimeFile, runtime);
  const config: ResourceEngineeringMissionConfig = { schemaVersion: 1, id: 'fixture', root: missionRoot, maxScopes: 2, pollIntervalMs: 100,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), initial: { expectedPlanDigest: 'a'.repeat(64), setup: {
      recipe: {}, policy: {}, output: join(directory, 'output'), resourceRuntime: runtimeFile, workspace, projectsFile: options.projectsFile! } } };
  write(options.engineeringMissionFile!, config);
  backend.run.mockImplementation(async (_config, host: ResourceEngineeringMissionHost) => {
    await new Promise<void>(resolve => { if (host.signal!.aborted) resolve(); else host.signal!.addEventListener('abort', () => resolve(), { once: true }); });
    return { schemaVersion: 1, missionId: config.id, state: 'stopped', reason: 'stop-requested', scopesReserved: 0, deadlineAt: config.deadlineAt, tip: null };
  });
  return { options, config, runtime, runtimeFile };
}
async function start(options: ResourceConsoleServerOptions) { const handle = await startResourceConsoleServer(options); handles.push(handle); return handle; }
const command = (sample: EngineeringMissionSnapshot) => ({ expectedControllerId: sample.controllerId, expectedConfigDigest: sample.configDigest, expectedRevision: sample.revision });
const read = (handle: ResourceConsoleWorkspaceHandle) => fetch(handle.url + '/api/resources/engineering-mission', { headers: { 'x-ashlr-token': handle.readToken } });
const post = (handle: ResourceConsoleWorkspaceHandle, action: string, input: unknown, headers: Record<string, string> = {}) => fetch(handle.url + '/api/resources/engineering-mission/' + action,
  { method: 'POST', headers: { origin: handle.url, 'x-ashlr-token': handle.controlToken!, 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) });
describe('managed mission HTTP operating surface', () => {
  it('requires read auth, control auth, exact origin and identity; human operations stay available', async () => {
    const f = fixture(), handle = await start(f.options);
    expect(handle.scope.engineeringMissionSupported).toBe(true);
    expect((await fetch(handle.url + '/api/resources/engineering-mission')).status).toBe(401);
    const initial = await (await read(handle)).json() as EngineeringMissionSnapshot;
    expect(initial.state).toBe('idle'); expect(backend.run).not.toHaveBeenCalled();
    expect((await post(handle, 'start', command(initial), { 'x-ashlr-token': handle.readToken })).status).toBe(401);
    expect((await post(handle, 'start', command(initial), { origin: 'http://example.invalid' })).status).toBe(403);
    expect((await post(handle, 'start', { ...command(initial), path: '/private/other' })).status).toBe(400);
    const response = await post(handle, 'start', command(initial)); expect(response.status).toBe(202);
    const running = await response.json() as EngineeringMissionSnapshot;
    expect(running).toMatchObject({ state: 'running', revision: 1 });
    expect((await post(handle, 'start', command(initial))).status).toBe(409);
    expect(backend.run).toHaveBeenCalledOnce();
    expect((await fetch(handle.url + '/api/resources/engineering-runtime/close', { method: 'POST', headers: {
      origin: handle.url, 'x-ashlr-token': handle.controlToken!, 'content-type': 'application/json' }, body: '{}' })).status).toBe(409);
    const stopped = await post(handle, 'stop', command(running)); expect(stopped.status).toBe(202);
    expect(await stopped.json()).toMatchObject({ state: 'stopping', enabled: false });
    await vi.waitFor(async () => expect(await (await read(handle)).json()).toMatchObject({ state: 'stopped', enabled: false }));
    expect((await fetch(handle.url + '/api/resources/console', { headers: { 'x-ashlr-token': handle.readToken } })).status).toBe(200);
    expect(backend.run.mock.calls[0]![1].workspace.handle).toBe(handle);
    await handle.close();
    const restarted = await start({ ...f.options, engineeringMissionAutoStart: true });
    expect(await (await read(restarted)).json()).toMatchObject({ enabled: false, revision: 2 }); expect(backend.run).toHaveBeenCalledOnce();
  });
  it('starts once when explicitly configured and drains its child on console close', async () => {
    const f = fixture(), handle = await start({ ...f.options, engineeringMissionAutoStart: true });
    expect(backend.run).toHaveBeenCalledOnce(); await handle.close();
    expect(backend.run.mock.calls[0]![1].signal.aborted).toBe(true);
  });
  it('retains supervisor custody until the managed mission drains on host signal', async () => {
    const f = fixture(), signal = new AbortController(); let finish!: () => void; let childStopped = false;
    backend.run.mockImplementation(async (_config, host: ResourceEngineeringMissionHost) => {
      await new Promise<void>(resolve => { finish = resolve; host.signal!.addEventListener('abort', () => { childStopped = true; }); });
      return { schemaVersion: 1, missionId: f.config.id, state: 'stopped', reason: 'stop-requested', scopesReserved: 0, deadlineAt: f.config.deadlineAt, tip: null };
    });
    const handle = await start({ ...f.options, engineeringMissionAutoStart: true, signal: signal.signal });
    signal.abort(); await vi.waitFor(() => expect(childStopped).toBe(true));
    try { expect(existsSync(join(f.options.root, '.resource-console.lock'))).toBe(true); }
    finally { finish(); await handle.close(); }
    expect(existsSync(join(f.options.root, '.resource-console.lock'))).toBe(false);
  });
  it.each(['root', 'bindingsPath', 'poolPath', 'observationsPath'])('refuses mismatched runtime %s before owner or runner startup', async key => {
    const f = fixture(); write(f.runtimeFile, { ...f.runtime, [key]: join(directory, 'other') });
    await expect(start(f.options)).rejects.toThrow('same workspace'); expect(backend.run).not.toHaveBeenCalled();
  });
  it('preserves a separately pinned generation transport workspace', async () => {
    const f = fixture(), transport = join(directory, 'transport'); mkdirSync(transport, { mode: 0o700 });
    write(f.runtimeFile, { ...f.runtime, workspace: transport });
    const handle = await start(f.options); expect(handle.scope.workspace).toBe(f.options.workspace); expect(backend.run).not.toHaveBeenCalled();
  });
  it.each(['execute', 'projects', 'mixed', 'auto-without-mission'])('refuses invalid %s enrollment before execution', async kind => {
    const f = fixture();
    const options = { ...f.options, ...(kind === 'execute' ? { execute: false } : kind === 'projects' ? { projectsFile: undefined }
      : kind === 'mixed' ? { engineeringFile: join(directory, 'unread.json') } : { engineeringMissionFile: undefined, engineeringMissionAutoStart: true }) };
    await expect(start(options)).rejects.toThrow('Invalid resource console options'); expect(backend.run).not.toHaveBeenCalled();
  });
});
