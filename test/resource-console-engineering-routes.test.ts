/** HTTP privilege/serialization boundary only; real engineering is covered separately. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const owner = vi.hoisted(() => ({ create: vi.fn(), validate: vi.fn(), catalog: vi.fn(), snapshot: vi.fn(),
  readiness: vi.fn(), launch: vi.fn(), cancel: vi.fn(), close: vi.fn() }));
vi.mock('../src/core/resources/console-engineering.js', () => ({
  validateResourceConsoleEngineeringCatalog: owner.validate, createResourceConsoleEngineeringOwner: owner.create,
}));
import { startResourceConsoleServer, type ResourceConsoleServerHandle, type ResourceConsoleServerOptions } from '../src/core/web/resource-console-server.js';
import { ResourceSupervisorError } from '../src/core/resources/pool-supervisor.js';
import type { ResourceConsoleEngineeringReadiness } from '../src/core/resources/console-engineering-types.js';

let directory: string; let options: ResourceConsoleServerOptions;
const handles: ResourceConsoleServerHandle[] = [];
const enrollment = { id: 'fix', projectId: 'default', enrollmentDigest: 'a'.repeat(64) };
const job = { enrollmentId: 'fix', projectId: 'default', state: 'ready' };
const readiness: ResourceConsoleEngineeringReadiness = { schemaVersion: 1, enrollmentId: 'fix', enrollmentDigest: 'a'.repeat(64), sampledAt: '2026-09-10T00:00:00.000Z',
  status: 'blocked', action: 'none', reasons: ['global-kill-active'], scope: 'local-admission-check-only', effectsExecuted: false, providerContacted: false };
const input = { enrollmentId: 'fix', expectedEnrollmentDigest: 'a'.repeat(64) };
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
beforeEach(() => {
  vi.resetAllMocks(); directory = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-engineering-routes-')));
  const workspace = join(directory, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
  options = { root: join(directory, 'ledger'), poolFile: join(directory, 'pool.json'), bindingsFile: join(directory, 'bindings.json'),
    observationsFile: join(directory, 'observations.json'), projectsFile: join(directory, 'projects.json'),
    engineeringFile: join(directory, 'engineering.json'), execute: true, workspace };
  save(options.poolFile, { schemaVersion: 1, id: 'fixture', workers: [{ id: 'local', provider: 'local', model: 'inert',
    maxConcurrent: 1, reservePercent: 0, maxTasksPerWindow: 1, taskWindowMs: 60_000, priority: 1 }] });
  save(options.bindingsFile, [{ workerId: 'local', capacityKey: 'shared', kind: 'local-chat', endpoint: 'http://127.0.0.1:1/v1' }]);
  save(options.observationsFile, []); save(options.projectsFile!, { schemaVersion: 1, projects: [] });
  save(options.engineeringFile!, { schemaVersion: 1, enrollments: [] });
  owner.validate.mockImplementation((value) => value); owner.catalog.mockReturnValue([enrollment]); owner.snapshot.mockReturnValue(job);
  owner.readiness.mockReturnValue(readiness);
  owner.launch.mockReturnValue({ ...job, state: 'running' }); owner.cancel.mockReturnValue({ ...job, state: 'stopped' });
  owner.close.mockResolvedValue(undefined); owner.create.mockReturnValue(owner);
});

describe('engineering readiness read protocol', () => {
  const route = '/api/resources/engineering/fix/readiness';
  it('accepts a bound read session without a control token and never launches', async () => {
    const handle = await start(); const proof = 'd'.repeat(64);
    const session = await fetch(`${handle.url}/api/session`, { method: 'POST', headers: {
      'x-ashlr-token': handle.readToken, 'x-ashlr-read-client': proof, origin: handle.url } });
    expect(session.status).toBe(204);
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    const result = await fetch(`${handle.url}${route}`, { headers: { cookie, 'x-ashlr-read-client': proof } });
    expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.headers.get('x-content-type-options')).toBe('nosniff'); expect(await result.json()).toEqual(readiness);
    expect(owner.readiness).toHaveBeenCalledExactlyOnceWith('fix');
    expect(owner.launch).not.toHaveBeenCalled(); expect(owner.cancel).not.toHaveBeenCalled();
  });
  it('rejects unauthenticated, cross-origin and query-bearing reads before collection', async () => {
    const handle = await start(); const headers = { 'x-ashlr-token': handle.readToken };
    expect((await fetch(`${handle.url}${route}`)).status).toBe(401);
    expect((await fetch(`${handle.url}${route}`, { headers: { ...headers, origin: 'http://other.invalid' } })).status).toBe(403);
    expect((await fetch(`${handle.url}${route}?refresh=true`, { headers })).status).toBe(400);
    expect(owner.readiness).not.toHaveBeenCalled(); expect(owner.launch).not.toHaveBeenCalled();
  });
  it('preserves the job schema and does not add a readiness mutation route', async () => {
    const handle = await start(); const headers = { 'x-ashlr-token': handle.readToken };
    expect(await (await fetch(`${handle.url}/api/resources/engineering/fix`, { headers })).json()).toEqual(job);
    expect((await post(handle, route, {})).status).toBe(404);
    expect(owner.readiness).not.toHaveBeenCalled(); expect(owner.launch).not.toHaveBeenCalled(); expect(owner.cancel).not.toHaveBeenCalled();
  });
  it('refuses unconfigured capability without inspecting readiness', async () => {
    const handle = await start({ engineeringFile: undefined });
    expect((await fetch(`${handle.url}${route}`, { headers: { 'x-ashlr-token': handle.readToken } })).status).toBe(403);
    expect(owner.readiness).not.toHaveBeenCalled();
  });
  it.each([['NOT_FOUND', 404], ['UNAVAILABLE', 503]] as const)('sanitizes %s readiness errors', async (code, status) => {
    const handle = await start(); owner.readiness.mockImplementation(() => { throw new ResourceSupervisorError(code, '/private/sensitive-fixture'); });
    const result = await fetch(`${handle.url}${route}`, { headers: { 'x-ashlr-token': handle.readToken } });
    expect(result.status).toBe(status); expect(await result.text()).not.toContain('/private/sensitive-fixture');
    expect(result.headers.get('cache-control')).toBe('no-store'); expect(owner.launch).not.toHaveBeenCalled();
  });
  it('applies the existing bounded response limit', async () => {
    const handle = await start(); owner.readiness.mockReturnValue({ ...readiness, reasons: ['x'.repeat(8 * 1024 * 1024)] });
    const result = await fetch(`${handle.url}${route}`, { headers: { 'x-ashlr-token': handle.readToken } });
    expect(result.status).toBe(503); expect(await result.text()).toContain('response limit'); expect(owner.launch).not.toHaveBeenCalled();
  });
});
afterEach(async () => { for (const handle of handles.splice(0)) await handle.close(); rmSync(directory, { recursive: true, force: true }); });
async function start(patch: Partial<ResourceConsoleServerOptions> = {}) {
  const handle = await startResourceConsoleServer({ ...options, ...patch }); handles.push(handle); return handle;
}
function post(handle: ResourceConsoleServerHandle, path = '/api/resources/engineering/start', value: unknown = input,
  headers: Record<string, string> = { 'x-ashlr-token': handle.controlToken!, origin: handle.url }) {
  return fetch(`${handle.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });
}

describe('engineering HTTP capability boundary', () => {
  it('publishes metadata through read auth without launching and preserves query refusal', async () => {
    const handle = await start(); expect(handle.scope.engineeringSupported).toBe(true);
    expect((await fetch(`${handle.url}/api/resources/engineering`)).status).toBe(401);
    const headers = { 'x-ashlr-token': handle.readToken };
    const list = await fetch(`${handle.url}/api/resources/engineering`, { headers });
    expect(list.status).toBe(200); expect(list.headers.get('cache-control')).toBe('no-store'); expect(await list.json()).toEqual([enrollment]);
    expect(await (await fetch(`${handle.url}/api/resources/engineering/fix`, { headers })).json()).toEqual(job);
    expect((await fetch(`${handle.url}/api/resources/engineering?projectId=default`, { headers })).status).toBe(400);
    expect(owner.launch).not.toHaveBeenCalled(); expect(owner.create).toHaveBeenCalledOnce();
    expect(owner.create.mock.calls[0]![0]).toMatchObject({ root: options.root, poolFile: options.poolFile,
      bindingsFile: options.bindingsFile, observationsFile: options.observationsFile });
  });
  it.each(['none', 'read-token', 'no-origin', 'wrong-origin'])('refuses %s writes before launch', async (kind) => {
    const handle = await start(); const headers: Record<string, string> = {};
    if (kind !== 'none') headers['x-ashlr-token'] = kind === 'read-token' ? handle.readToken : handle.controlToken!;
    if (kind !== 'no-origin') headers.origin = kind === 'wrong-origin' ? 'http://other.invalid' : handle.url;
    expect((await post(handle, undefined, input, headers)).status).toBe(kind === 'none' || kind === 'read-token' ? 401 : 403);
    expect(owner.launch).not.toHaveBeenCalled();
  });
  it.each([{ ...input, path: '/private/untrusted' }, { ...input, command: 'unused' },
    { ...input, expectedEnrollmentDigest: 'bad' }, { ...input, enrollmentId: '../invalid' }, {}, []])('rejects non-contract input %j', async (value) => {
    const handle = await start(); expect((await post(handle, undefined, value)).status).toBe(400); expect(owner.launch).not.toHaveBeenCalled();
  });
  it('starts exactly the pinned enrollment and cancels only with an empty body', async () => {
    const handle = await start(); const launched = await post(handle);
    expect(launched.status).toBe(202); expect(launched.headers.get('cache-control')).toBe('no-store');
    expect(await launched.json()).toEqual({ ...job, state: 'running' }); expect(owner.launch).toHaveBeenCalledExactlyOnceWith(input);
    expect((await post(handle, '/api/resources/engineering/fix/cancel', { force: true })).status).toBe(400);
    const cancelled = await post(handle, '/api/resources/engineering/fix/cancel', {});
    expect(cancelled.status).toBe(200); expect(await cancelled.json()).toEqual({ ...job, state: 'stopped' });
    expect(owner.cancel).toHaveBeenCalledExactlyOnceWith('fix');
  });
  it('maps typed conflicts without exposing private error text', async () => {
    const handle = await start(); owner.launch.mockImplementation(() => { throw new ResourceSupervisorError('CONFLICT', 'private-host-path'); });
    const result = await post(handle); expect(result.status).toBe(409); expect(await result.text()).not.toContain('private-host-path');
  });
  it('leaves the capability absent when not enrolled', async () => {
    const handle = await start({ engineeringFile: undefined }); expect(handle.scope.engineeringSupported).toBeUndefined();
    expect((await post(handle)).status).toBe(403); expect(owner.create).not.toHaveBeenCalled();
  });
  it.each([{ execute: false, workspace: undefined, projectsFile: undefined }, { projectsFile: undefined }])('refuses enrollment without explicit execution and projects', async (patch) => {
    await expect(start(patch)).rejects.toThrow(); expect(owner.create).not.toHaveBeenCalled();
  });
  it('awaits engineering close and makes new requests unavailable immediately', async () => {
    const handle = await start(); let finish!: () => void;
    owner.close.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const closing = handle.close();
    try { await vi.waitFor(() => expect(owner.close).toHaveBeenCalledOnce());
      expect((await post(handle)).status).toBe(503); expect(owner.launch).not.toHaveBeenCalled();
      let closed = false; void closing.then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false);
    } finally { finish(); await closing; }
  });
});
