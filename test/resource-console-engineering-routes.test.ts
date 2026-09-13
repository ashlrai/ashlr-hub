/** HTTP privilege/serialization boundary only; real engineering is covered separately. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingMessage, request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const owner = vi.hoisted(() => ({ create: vi.fn(), validate: vi.fn(), catalog: vi.fn(), snapshot: vi.fn(),
  readiness: vi.fn(), launch: vi.fn(), cancel: vi.fn(), close: vi.fn() }));
const automatic = vi.hoisted(() => ({ create: vi.fn(), validate: vi.fn(), start: vi.fn(), snapshot: vi.fn(), setPaused: vi.fn(), admit: vi.fn(), close: vi.fn() }));
const preparation = vi.hoisted(() => ({ create: vi.fn(), validate: vi.fn(), profiles: vi.fn(), check: vi.fn(), prepare: vi.fn(),
  prepareAutomatically: vi.fn(), pendingAutomaticAdmissions: vi.fn() }));
const successors = vi.hoisted(() => ({ create: vi.fn(), start: vi.fn(), snapshot: vi.fn(), close: vi.fn() }));
const background = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../src/core/resources/engineering-background.js', () => ({ createEngineeringBackground: background.create }));
vi.mock('../src/core/resources/console-engineering-preparation.js', () => ({
  validateResourceConsoleEngineeringPreparationConfig: preparation.validate, createResourceConsoleEngineeringPreparation: preparation.create,
}));
vi.mock('../src/core/resources/console-engineering-supervisor.js', () => ({
  validateResourceConsoleEngineeringSupervisionConfig: automatic.validate, createResourceConsoleEngineeringSupervisor: automatic.create,
}));
vi.mock('../src/core/resources/console-engineering.js', () => ({
  validateResourceConsoleEngineeringCatalog: owner.validate, createResourceConsoleEngineeringOwner: owner.create,
}));
import { startResourceConsoleServer, type ResourceConsoleServerHandle, type ResourceConsoleServerOptions } from '../src/core/web/resource-console-server.js';
import { ResourceSupervisorError } from '../src/core/resources/pool-supervisor.js';
import { readResourceWorkspaceCustody } from '../src/core/resources/workspace-custody.js';
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
  automatic.validate.mockImplementation(value => value); automatic.create.mockReturnValue(automatic); automatic.close.mockResolvedValue(undefined);
  automatic.snapshot.mockReturnValue({ schemaVersion: 1, configId: 'automatic-fixture', paused: false, revision: 0 });
  automatic.setPaused.mockImplementation(paused => ({ schemaVersion: 1, configId: 'automatic-fixture', paused, revision: 1 }));
  preparation.validate.mockImplementation(value => value); preparation.create.mockReturnValue(preparation);
  preparation.pendingAutomaticAdmissions.mockResolvedValue([]);
  successors.create.mockReturnValue(successors); successors.close.mockResolvedValue(undefined);
  successors.snapshot.mockReturnValue({ schemaVersion: 1, supervisionId: 'automatic-fixture', profileId: 'evolve', state: 'running', entries: [] });
  background.create.mockImplementation(async () => ({ profiles: preparation.profiles, check: preparation.check, prepare: preparation.prepare,
    prepareAutomatically: preparation.prepareAutomatically, pendingAutomaticAdmissions: preparation.pendingAutomaticAdmissions,
    configureSuccessors: successors.create, start: successors.start, snapshot: successors.snapshot, close: successors.close }));
});

describe('host-configured engineering successor HTTP boundary', () => {
  const route = '/api/resources/engineering-successors';
  function config(overrides: Record<string, unknown> = {}) {
    const preparationFile = join(directory, 'profiles.json'); const supervisionFile = join(directory, 'supervision.json');
    const successorFile = join(directory, 'successors.json');
    save(preparationFile, { schemaVersion: 1, profiles: [{ id: 'evolve', recipe: { projectId: 'default' } }] });
    save(supervisionFile, { schemaVersion: 1, id: 'automatic-fixture', maxEnrollments: 4 });
    save(successorFile, { schemaVersion: 1, supervisionId: 'automatic-fixture', profileId: 'evolve', allowedWorkerIds: ['local'],
      maxOutputTokens: 256, proposalTimeoutMs: 10000, maxSuccessors: 2, pollIntervalMs: 1000, ...overrides });
    return { engineeringPreparationFile: preparationFile, engineeringSupervisionFile: supervisionFile, engineeringSuccessorsFile: successorFile };
  }
  it('starts only configured successor work and exposes authenticated metadata without re-executing on reads', async () => {
    const selected = config(); const handle = await start(selected);
    const scopeResponse = await fetch(`${handle.url}/api/resources/console`, { headers: { 'x-ashlr-token': handle.readToken } });
    expect(scopeResponse.status).toBe(200); expect(scopeResponse.headers.get('cache-control')).toBe('no-store');
    expect(await scopeResponse.json()).toMatchObject({ engineeringSuccessorsSupported: true,
      engineeringPreparationSupported: true, engineeringSupervisionSupported: true, engineeringSupported: true });
    expect(successors.create).toHaveBeenCalledOnce(); expect(successors.start).toHaveBeenCalledOnce();
    expect(background.create).toHaveBeenCalledOnce(); expect(preparation.create).not.toHaveBeenCalled();
    expect(successors.create.mock.calls[0]![0]).toMatchObject({ configFile: selected.engineeringSuccessorsFile, projectId: 'default' });
    expect((await fetch(`${handle.url}${route}`)).status).toBe(401);
    for (let index = 0; index < 2; index++) {
      const response = await fetch(`${handle.url}${route}`, { headers: { 'x-ashlr-token': handle.readToken } });
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ supervisionId: 'automatic-fixture', entries: [] });
    }
    expect(successors.start).toHaveBeenCalledOnce(); expect(owner.launch).not.toHaveBeenCalled();
    await handle.close(); expect(successors.close).toHaveBeenCalledOnce();
  });
  it('serves health and authenticated pause while background preparation is pending', async () => {
    const handle = await start(config());
    let finish!: (value: unknown) => void;
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { entered = resolve; });
    preparation.prepare.mockImplementation(() => { entered(); return new Promise(resolve => { finish = resolve; }); });
    const response = post(handle, '/api/resources/engineering/prepare', { id: 'next' });
    await pending;
    try {
      expect((await fetch(`${handle.url}/health`)).status).toBe(200);
      const pause = await post(handle, '/api/resources/engineering-supervision', { paused: true, expectedRevision: 0 });
      expect(pause.status).toBe(200); expect(await pause.json()).toMatchObject({ paused: true, revision: 1 });
      expect(automatic.setPaused).toHaveBeenCalledExactlyOnceWith(true, 0);
      expect(automatic.admit).not.toHaveBeenCalled();
    } finally { finish({ plan: { id: 'next' }, enrollment, disposition: 'created' }); }
    expect((await response).status).toBe(200);
  });
  it('drains the background owner on successor configuration failure', async () => {
    successors.create.mockRejectedValue(new Error('Configuration refused'));
    await expect(start(config())).rejects.toThrow('Configuration refused');
    expect(successors.start).not.toHaveBeenCalled(); expect(successors.close).toHaveBeenCalledOnce();
  });
  it('does not install a child observer after a startup-stage component fault already closed engineering', async () => {
    const veto = vi.fn(() => false);
    successors.start.mockImplementation(async () => { background.create.mock.calls[0]![0].onFault(); });
    const handle = await start({ ...config(), engineeringLifetime: { isExecutionStopped: veto } });
    await vi.waitFor(() => expect(owner.close).toHaveBeenCalledExactlyOnceWith({ preserveSupervisorTasks: true }));
    const calls = veto.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 350)); expect(veto).toHaveBeenCalledTimes(calls);
    expect((await fetch(`${handle.url}/health`)).status).toBe(200);
    await expect(handle.close()).rejects.toThrow('Resource console shutdown uncertain');
    handles.splice(handles.indexOf(handle), 1);
  });
  it('isolates a running engineering worker fault from the human console and retains held evidence', async () => {
    const handle = await start(config());
    const onFault = background.create.mock.calls[0]![0].onFault as () => void;
    onFault();
    await vi.waitFor(() => expect(owner.close).toHaveBeenCalledExactlyOnceWith({ preserveSupervisorTasks: true }));
    await vi.waitFor(async () => {
      const response = await fetch(`${handle.url}/api/resources/console`, { headers: { 'x-ashlr-token': handle.readToken } });
      expect(await response.json()).toMatchObject({ engineeringLifecycle: 'held' });
    });
    expect((await fetch(`${handle.url}/health`)).status).toBe(200);
    expect((await post(handle, '/api/resources/queue', { paused: true })).status).toBe(200);
    expect((await post(handle)).status).toBe(503); expect(owner.launch).not.toHaveBeenCalled();
    await expect(handle.close()).rejects.toThrow('Resource console shutdown uncertain');
    handles.splice(handles.indexOf(handle), 1); // Expected terminal refusal was asserted above.
  });
  it('keeps unconfigured successor work absent and does not expose host config paths', async () => {
    const handle = await start();
    const scopeResponse = await fetch(`${handle.url}/api/resources/console`, { headers: { 'x-ashlr-token': handle.readToken } });
    expect(scopeResponse.status).toBe(200); expect(await scopeResponse.json()).not.toHaveProperty('engineeringSuccessorsSupported');
    expect((await fetch(`${handle.url}${route}`, { headers: { 'x-ashlr-token': handle.readToken } })).status).toBe(403);
    expect(successors.create).not.toHaveBeenCalled(); expect(successors.start).not.toHaveBeenCalled();
    expect(JSON.stringify(handle.scope)).not.toContain('successors.json');
  });
  it('includes successor settlement in the engineering owner shared-ledger drain', async () => {
    const handle = await start(config()); let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    successors.close.mockReturnValue(pending);
    const drain = owner.create.mock.calls[0]![0].waitForResourceDrain as () => Promise<void>;
    let settled = false; const draining = drain().then(() => { settled = true; });
    await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false);
    expect(successors.close).toHaveBeenCalledOnce(); finish(); await draining; expect(settled).toBe(true);
    await handle.close();
  });
  it.each([{ profileId: 'foreign' }, { supervisionId: 'foreign' }, { maxSuccessors: 5 }, { force: true }])(
    'refuses mismatched or expanded successor policy before owner startup: %j', async override => {
      await expect(start(config(override))).rejects.toThrow();
      expect(successors.create).not.toHaveBeenCalled(); expect(owner.create).not.toHaveBeenCalled();
    });
  it('requires both preparation and supervision and keeps successor control outside projects', async () => {
    const selected = config();
    await expect(start({ engineeringSuccessorsFile: selected.engineeringSuccessorsFile })).rejects.toThrow('Invalid resource console options');
    const unsafe = join(options.workspace!, 'successors.json');
    save(unsafe, JSON.parse(JSON.stringify({ schemaVersion: 1, supervisionId: 'automatic-fixture', profileId: 'evolve', allowedWorkerIds: ['local'],
      maxOutputTokens: 256, proposalTimeoutMs: 10000, maxSuccessors: 2, pollIntervalMs: 1000 })));
    await expect(start({ ...selected, engineeringSuccessorsFile: unsafe })).rejects.toThrow('outside the writable workspace');
    expect(successors.create).not.toHaveBeenCalled(); expect(owner.create).not.toHaveBeenCalled();
  });
});

describe('explicit engineering supervision HTTP boundary', () => {
  const route = '/api/resources/engineering-supervision';
  async function supervised() {
    const file = join(directory, 'supervision.json'); save(file, { schemaVersion: 1, id: 'automatic-fixture' });
    return start({ engineeringSupervisionFile: file });
  }
  it('starts only the explicitly configured caller and makes status reads nonexecuting', async () => {
    const handle = await supervised(); expect(handle.scope.engineeringSupervisionSupported).toBe(true);
    expect(automatic.start).toHaveBeenCalledOnce();
    expect((await fetch(`${handle.url}${route}`)).status).toBe(401);
    const response = await fetch(`${handle.url}${route}`, { headers: { 'x-ashlr-token': handle.readToken } });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ configId: 'automatic-fixture', revision: 0 });
    expect(automatic.start).toHaveBeenCalledOnce(); expect(automatic.setPaused).not.toHaveBeenCalled(); expect(owner.launch).not.toHaveBeenCalled();
    // A preexisting enrollment literally named supervision retains its old route.
    expect((await fetch(`${handle.url}/api/resources/engineering/supervision`, { headers: { 'x-ashlr-token': handle.readToken } })).status).toBe(200);
    expect(owner.snapshot).toHaveBeenLastCalledWith('supervision');
  });
  it('requires exact origin, mutation authority and a closed revision-checked pause request', async () => {
    const handle = await supervised();
    expect((await post(handle, route, { paused: true, expectedRevision: 0 }, { 'x-ashlr-token': handle.readToken, origin: handle.url })).status).toBe(401);
    expect((await post(handle, route, { paused: true, expectedRevision: 0 }, { 'x-ashlr-token': handle.controlToken! })).status).toBe(403);
    for (const input of [{ paused: true }, { paused: 'true', expectedRevision: 0 }, { paused: true, expectedRevision: -1 },
      { paused: true, expectedRevision: 0, force: true }]) expect((await post(handle, route, input)).status).toBe(400);
    expect(automatic.setPaused).not.toHaveBeenCalled();
    const response = await post(handle, route, { paused: true, expectedRevision: 0 });
    expect(response.status).toBe(200); expect(automatic.setPaused).toHaveBeenCalledExactlyOnceWith(true, 0);
    automatic.setPaused.mockImplementation(() => { throw new ResourceSupervisorError('CONFLICT', '/private/state'); });
    const conflict = await post(handle, route, { paused: false, expectedRevision: 0 });
    expect(conflict.status).toBe(409); expect(await conflict.text()).not.toContain('/private/state');
  });
  it('admits only through explicit control authority and delegates the unchanged request to the owner', async () => {
    const handle = await supervised(); const request = { enrollments: [input], expectedRevision: 0 };
    automatic.admit.mockReturnValue({ configId: 'automatic-fixture', revision: 1 });
    expect((await post(handle, `${route}/admit`, request, { 'x-ashlr-token': handle.readToken, origin: handle.url })).status).toBe(401);
    expect((await post(handle, `${route}/admit`, request, { 'x-ashlr-token': handle.controlToken! })).status).toBe(403);
    expect((await post(handle, `${route}/admit`, request, { 'x-ashlr-token': handle.controlToken!, origin: 'http://other.invalid' })).status).toBe(403);
    expect(automatic.admit).not.toHaveBeenCalled();
    const response = await post(handle, `${route}/admit`, request);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(automatic.admit).toHaveBeenCalledExactlyOnceWith(request); expect(owner.launch).not.toHaveBeenCalled();
    automatic.admit.mockImplementation(() => { throw new ResourceSupervisorError('CONFLICT', '/private/queue'); });
    const conflict = await post(handle, `${route}/admit`, request);
    expect(conflict.status).toBe(409); expect(await conflict.text()).not.toContain('/private/queue');
    expect((await fetch(`${handle.url}${route}/admit`, { headers: { 'x-ashlr-token': handle.readToken } })).status).toBe(404);
  });
  it('refuses automatic preparation policy without profiles before creating owners', async () => {
    const file = join(directory, 'automatic-policy.json');
    save(file, { schemaVersion: 1, id: 'automatic-fixture', maxEnrollments: 2, autoAdmitPrepared: true });
    await expect(start({ engineeringSupervisionFile: file })).rejects.toThrow('requires preparation profiles');
    expect(owner.create).not.toHaveBeenCalled(); expect(automatic.create).not.toHaveBeenCalled();
  });
  it.each(['CAPACITY', 'UNAVAILABLE'] as const)('preserves prepared registration across %s admission failure and reconciles the exact retry', async code => {
    const supervisionFile = join(directory, 'automatic-policy.json'); const preparationFile = join(directory, 'profiles.json');
    save(supervisionFile, { schemaVersion: 1, id: 'automatic-fixture', maxEnrollments: 2, autoAdmitPrepared: true });
    save(preparationFile, { schemaVersion: 1, profiles: [] });
    const binding = { schemaVersion: 1, supervisionId: 'automatic-fixture', configDigest: 'c'.repeat(64), deadlineAt: new Date(Date.now() + 60000).toISOString() };
    const state = { schemaVersion: 1, configId: binding.supervisionId, configDigest: binding.configDigest, deadlineAt: binding.deadlineAt,
      sourceState: 'healthy', state: 'running', revision: 0, entries: [] as Array<{ enrollmentId: string; enrollmentDigest: string }>,
      admission: { autoAdmitPrepared: true, remainingEnrollments: 2, maxEnrollments: 2 } };
    automatic.snapshot.mockImplementation(() => structuredClone(state));
    const handle = await start({ engineeringPreparationFile: preparationFile, engineeringSupervisionFile: supervisionFile });
    expect(handle.scope.engineeringPreparationAutoAdmission).toBe(true);
    const request = { id: 'fix', profileId: 'fixture', name: 'Correction', objective: 'Bounded correction', expectedPlanDigest: 'b'.repeat(64) };
    const plan = { id: 'fix', planDigest: request.expectedPlanDigest };
    let prepared = false;
    preparation.pendingAutomaticAdmissions.mockImplementation(async () => prepared && !state.entries.length
      ? [{ enrollmentId: enrollment.id, expectedEnrollmentDigest: enrollment.enrollmentDigest, reason: null }] : []);
    preparation.prepareAutomatically.mockImplementationOnce(() => { prepared = true; return { plan, enrollment, disposition: 'created' }; })
      .mockReturnValueOnce({ plan, enrollment, disposition: 'replayed' });
    automatic.admit.mockImplementationOnce(() => { throw new ResourceSupervisorError(code, '/private/sensitive-registration-details'); })
      .mockImplementationOnce(() => { state.entries.push({ enrollmentId: enrollment.id, enrollmentDigest: enrollment.enrollmentDigest }); state.revision++; return state; });
    const first = await post(handle, '/api/resources/engineering/prepare', request);
    expect(first.status).toBe(200); expect(first.headers.get('cache-control')).toBe('no-store');
    const firstText = await first.text(); expect(firstText).not.toMatch(/private|sensitive-registration/);
    expect(JSON.parse(firstText)).toEqual({ plan, enrollment, disposition: 'created',
      automaticAdmission: { state: 'unavailable', supervisionId: 'automatic-fixture' } });
    expect(preparation.prepareAutomatically).toHaveBeenCalledExactlyOnceWith(request, binding); expect(owner.launch).not.toHaveBeenCalled();
    expect(preparation.prepare).not.toHaveBeenCalled(); expect(background.create).toHaveBeenCalledOnce();
    const readRoute = `${handle.url}/api/resources/engineering/automatic-admission`;
    expect((await fetch(readRoute)).status).toBe(401);
    const observed = await fetch(readRoute, { headers: { 'x-ashlr-token': handle.readToken } });
    expect(observed.status).toBe(200); expect(observed.headers.get('cache-control')).toBe('no-store');
    expect(await observed.json()).toMatchObject({ state: 'held', pending: [{ enrollmentId: 'fix' }] });
    const callsBeforeReads = automatic.admit.mock.calls.length;
    expect((await fetch(readRoute, { headers: { 'x-ashlr-token': handle.readToken, origin: 'http://foreign.invalid' } })).status).toBe(403);
    expect((await fetch(`${readRoute}?refresh=true`, { headers: { 'x-ashlr-token': handle.readToken } })).status).toBe(400);
    expect((await fetch(readRoute, { headers: { 'x-ashlr-token': handle.readToken } })).status).toBe(200);
    expect(automatic.admit).toHaveBeenCalledTimes(callsBeforeReads);
    const second = await post(handle, '/api/resources/engineering/prepare', request);
    expect(second.status).toBe(200); expect(await second.json()).toEqual({ plan, enrollment, disposition: 'replayed',
      automaticAdmission: { state: 'admitted', supervisionId: 'automatic-fixture' } });
    expect(preparation.prepareAutomatically).toHaveBeenNthCalledWith(2, request, binding);
    expect(automatic.admit.mock.calls).toEqual([[{ expectedRevision: 0, enrollments: [input] }], [{ expectedRevision: 0, enrollments: [input] }]]);
    expect(owner.launch).not.toHaveBeenCalled(); expect(automatic.start).toHaveBeenCalledOnce();
  });
  it('does not create or start a supervisor without the separate startup flag', async () => {
    const handle = await start(); expect(handle.scope.engineeringSupervisionSupported).toBeUndefined();
    expect((await fetch(`${handle.url}${route}`, { headers: { 'x-ashlr-token': handle.readToken } })).status).toBe(403);
    expect(automatic.create).not.toHaveBeenCalled(); expect(automatic.start).not.toHaveBeenCalled();
  });
  it('rejects supervision without enrollment before owner construction', async () => {
    await expect(start({ engineeringFile: undefined, engineeringSupervisionFile: join(directory, 'missing.json') })).rejects.toThrow();
    expect(owner.create).not.toHaveBeenCalled(); expect(automatic.create).not.toHaveBeenCalled();
  });
  it('awaits automatic work drain on shutdown', async () => {
    const handle = await supervised(); let finish!: () => void;
    automatic.close.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const closing = handle.close(); let closed = false; void closing.then(() => { closed = true; });
    try {
      await vi.waitFor(() => expect(automatic.close).toHaveBeenCalledOnce());
      expect(closed).toBe(false); expect((await post(handle, route, { paused: true, expectedRevision: 0 })).status).toBe(503);
    } finally { finish(); await closing; }
  });
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

async function pendingBody(handle: ResourceConsoleServerHandle, route: string, value: unknown) {
  const bytes = JSON.stringify(value); let entered!: () => void;
  const seen = new Promise<void>(resolve => { entered = resolve; });
  const original = IncomingMessage.prototype.on;
  const spy = vi.spyOn(IncomingMessage.prototype, 'on').mockImplementation(function(this: IncomingMessage, event, listener) {
    if (event === 'data' && this.url === route && this.headers['x-fixture-pending'] === 'true') entered();
    return original.call(this, event, listener);
  });
  let resolve!: (status: number) => void, reject!: (error: Error) => void;
  const response = new Promise<number>((done, fail) => { resolve = done; reject = fail; });
  const req = request(`${handle.url}${route}`, { method: 'POST', headers: { origin: handle.url, 'x-ashlr-token': handle.controlToken!,
    'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes), 'x-fixture-pending': 'true' } }, res => {
    res.resume(); res.once('end', () => resolve(res.statusCode!));
  });
  req.once('error', reject); req.write(bytes.slice(0, 1));
  try { await Promise.race([seen, response.then(() => { throw new Error('Request refused before body'); })]); }
  finally { spy.mockRestore(); }
  return { finish: () => req.end(bytes.slice(1)), response, destroy: () => req.destroy() };
}

describe('host-owned same-workspace engineering attachment', () => {
  it('binds live workspace custody to the exact closed attachment and invalidates it on replacement', async () => {
    const handle = await start(), previous = handle.engineeringAttachment()!;
    expect(() => handle.engineeringCustody(previous)).toThrow('not drained');
    await previous.close();
    expect(() => handle.engineeringCustody({ ...previous })).toThrow('changed');
    const custody = handle.engineeringCustody(previous);
    expect(readResourceWorkspaceCustody(custody).root).toBe(options.root);
    const nextOwner = { ...owner, close: vi.fn().mockResolvedValue(undefined) }; owner.create.mockReturnValueOnce(nextOwner);
    const next = await handle.attachEngineering({ expectedAttachment: previous, engineeringFile: options.engineeringFile });
    expect(() => readResourceWorkspaceCustody(custody)).toThrow('changed');
    await next.close();
    const current = handle.engineeringCustody(next);
    await handle.close();
    expect(() => readResourceWorkspaceCustody(current)).toThrow('unavailable');
  });
  it('publishes a read-only attachment identity and pins close to the displayed component', async () => {
    const handle = await start(); const previous = handle.engineeringAttachment()!;
    const headers = { 'x-ashlr-token': handle.readToken };
    expect(await (await fetch(`${handle.url}/api/resources/console`, { headers })).json()).toMatchObject({
      engineeringAttachmentSupported: true, engineeringAttachmentId: previous.id });
    const closed = await post(handle, '/api/resources/engineering-runtime/close', { expectedAttachmentId: previous.id });
    expect(closed.status).toBe(200); expect(await closed.json()).toEqual({ engineeringLifecycle: 'closed', engineeringAttachmentId: previous.id });
    const nextOwner = { ...owner, close: vi.fn().mockResolvedValue(undefined) }; owner.create.mockReturnValueOnce(nextOwner);
    const next = await handle.attachEngineering({ expectedAttachment: previous, engineeringFile: options.engineeringFile });
    expect((await post(handle, '/api/resources/engineering-runtime/close', { expectedAttachmentId: previous.id })).status).toBe(409);
    expect(nextOwner.close).not.toHaveBeenCalled(); expect(next.state()).toBe('running');
    expect(await (await fetch(`${handle.url}/api/resources/console`, { headers })).json()).toMatchObject({ engineeringAttachmentId: next.id });
  });
  it.each([null, 12, '', 'x'.repeat(32), 'a'.repeat(64)])('refuses malformed close attachment %j', async expectedAttachmentId => {
    const handle = await start();
    expect((await post(handle, '/api/resources/engineering-runtime/close', { expectedAttachmentId })).status).toBe(400);
    expect(owner.close).not.toHaveBeenCalled();
  });
  it('advertises attachment discovery without claiming an engineering component exists', async () => {
    const handle = await start({ engineeringFile: undefined });
    const response = await fetch(`${handle.url}/api/resources/console`, { headers: { 'x-ashlr-token': handle.readToken } });
    const scope = await response.json(); expect(scope.engineeringAttachmentSupported).toBe(true);
    expect(scope.engineeringAttachmentId).toBeUndefined(); expect(scope.engineeringLifecycle).toBeUndefined();
  });
  function workerConfiguration() {
    const profiles = join(directory, 'attached-profiles.json'), supervision = join(directory, 'attached-supervision.json');
    const policy = join(directory, 'attached-successors.json');
    save(profiles, { schemaVersion: 1, profiles: [{ id: 'evolve', recipe: { projectId: 'default' } }] });
    save(supervision, { schemaVersion: 1, id: 'attached-queue', maxEnrollments: 4 });
    save(policy, { schemaVersion: 1, supervisionId: 'attached-queue', profileId: 'evolve', allowedWorkerIds: ['local'],
      maxOutputTokens: 256, proposalTimeoutMs: 10000, maxSuccessors: 2, pollIntervalMs: 1000 });
    return { engineeringPreparationFile: profiles, engineeringSupervisionFile: supervision, engineeringSuccessorsFile: policy };
  }
  it('attaches to an empty workspace without replacing its human queue or tokens', async () => {
    const handle = await start({ engineeringFile: undefined }); const tokens = [handle.url, handle.readToken, handle.controlToken];
    expect(handle.engineeringAttachment()).toBeNull();
    expect((await post(handle, '/api/resources/queue', { paused: true })).status).toBe(200);
    expect((await post(handle, '/api/resources/tasks', { id: 'human-retained', prompt: 'inert', allowedWorkerIds: ['local'],
      mode: 'read-only', timeoutMs: 5000, maxOutputTokens: 10 })).status).toBe(202);
    const before = await (await fetch(`${handle.url}/api/resources`, { headers: { 'x-ashlr-token': handle.readToken } })).json();
    const attached = await handle.attachEngineering({ expectedAttachment: null, engineeringFile: options.engineeringFile });
    expect(attached.state()).toBe('running'); expect(handle.engineeringAttachment()).toBe(attached);
    const after = await (await fetch(`${handle.url}/api/resources`, { headers: { 'x-ashlr-token': handle.readToken } })).json();
    expect(after.supervisor.instanceId).toBe(before.supervisor.instanceId); expect(after.supervisor.jobs).toEqual(before.supervisor.jobs);
    expect(after.supervisor.paused).toBe(true); expect([handle.url, handle.readToken, handle.controlToken]).toEqual(tokens);
  });
  it('requires the exact drained predecessor and leaves a stale close bound to the old owner', async () => {
    const handle = await start(), previous = handle.engineeringAttachment()!;
    await expect(handle.attachEngineering({ expectedAttachment: previous, engineeringFile: options.engineeringFile })).rejects.toThrow('not drained');
    await previous.close();
    await expect(handle.attachEngineering({ expectedAttachment: { ...previous }, engineeringFile: options.engineeringFile })).rejects.toThrow('changed');
    const nextOwner = { ...owner, close: vi.fn().mockResolvedValue(undefined) }; owner.create.mockReturnValueOnce(nextOwner);
    const next = await handle.attachEngineering({ expectedAttachment: previous, engineeringFile: options.engineeringFile });
    expect(next.id).not.toBe(previous.id); await previous.close(); expect(nextOwner.close).not.toHaveBeenCalled();
    await expect(handle.attachEngineering({ expectedAttachment: previous, engineeringFile: options.engineeringFile })).rejects.toThrow('changed');
    expect(next.state()).toBe('running');
  });
  it.each(['/api/resources/engineering/start', '/api/resources/engineering-runtime/close'])('refuses a stale body at %s after replacement', async route => {
    const handle = await start(), previous = handle.engineeringAttachment()!;
    const pending = await pendingBody(handle, route, route.endsWith('/close') ? {} : input);
    try {
      await previous.close();
      const nextOwner = { ...owner, launch: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }; owner.create.mockReturnValueOnce(nextOwner);
      const next = await handle.attachEngineering({ expectedAttachment: previous, engineeringFile: options.engineeringFile });
      pending.finish(); expect([409, 503]).toContain(await pending.response);
      expect(nextOwner.launch).not.toHaveBeenCalled(); expect(nextOwner.close).not.toHaveBeenCalled(); expect(next.state()).toBe('running');
    } finally { pending.destroy(); }
  });
  it('does not inherit an aborted predecessor child signal', async () => {
    const child = new AbortController(), handle = await start({ engineeringLifetime: { signal: child.signal } });
    const previous = handle.engineeringAttachment()!; child.abort(); await previous.close();
    const next = await handle.attachEngineering({ expectedAttachment: previous, engineeringFile: options.engineeringFile });
    expect(next.state()).toBe('running'); expect((await post(handle)).status).toBe(202);
  });
  it('refuses held predecessors and retains whole-console cleanup uncertainty', async () => {
    const handle = await start(), previous = handle.engineeringAttachment()!;
    owner.close.mockRejectedValue(new Error('inert unresolved cleanup')); await expect(previous.close()).rejects.toThrow('uncertain');
    await expect(handle.attachEngineering({ expectedAttachment: previous, engineeringFile: options.engineeringFile })).rejects.toThrow('not drained');
    await expect(handle.close()).rejects.toThrow('uncertain'); handles.splice(handles.indexOf(handle), 1);
  });
  it.each(['pool', 'projects', 'workspace-control'] as const)('refuses %s drift or overlap before creating a replacement', async kind => {
    const handle = await start(), previous = handle.engineeringAttachment()!; await previous.close();
    let file = options.engineeringFile;
    if (kind === 'pool') save(options.poolFile, { invalid: true });
    if (kind === 'projects') save(options.projectsFile!, { schemaVersion: 1, projects: [{ id: 'changed' }] });
    if (kind === 'workspace-control') { file = join(options.workspace!, 'engineering.json'); save(file, { schemaVersion: 1, enrollments: [] }); }
    await expect(handle.attachEngineering({ expectedAttachment: previous, engineeringFile: file })).rejects.toThrow();
    expect(owner.create).toHaveBeenCalledOnce(); expect(handle.engineeringAttachment()).toBe(previous);
  });
  it('never invokes attachment property getters', async () => {
    const handle = await start(), previous = handle.engineeringAttachment()!; await previous.close();
    const getter = vi.fn(); const value = { expectedAttachment: previous, get engineeringFile() { getter(); return options.engineeringFile; } };
    await expect(handle.attachEngineering(value)).rejects.toThrow('Invalid'); expect(getter).not.toHaveBeenCalled();
  });
  it('withholds competing attachment while late initialization leaves human queue controls usable', async () => {
    const handle = await start(), previous = handle.engineeringAttachment()!; await previous.close();
    const create = background.create.getMockImplementation()!; let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    background.create.mockImplementationOnce(async value => { await gate; return create(value); });
    const configuration = workerConfiguration();
    const pending = handle.attachEngineering({ expectedAttachment: previous, ...configuration });
    await vi.waitFor(() => expect(background.create).toHaveBeenCalledOnce());
    try {
      await expect(handle.attachEngineering({ expectedAttachment: handle.engineeringAttachment(), ...configuration })).rejects.toThrow('not drained');
      expect((await post(handle, '/api/resources/queue', { paused: true })).status).toBe(200);
      expect((await post(handle)).status).toBe(503);
    } finally { finish(); }
    const attached = await pending; expect(attached.state()).toBe('running'); expect(successors.start).toHaveBeenCalledOnce();
  });
  it('awaits and drains a late attachment when the entire workspace closes', async () => {
    const handle = await start(), previous = handle.engineeringAttachment()!; await previous.close();
    const create = background.create.getMockImplementation()!; let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    background.create.mockImplementationOnce(async value => { await gate; return create(value); });
    const pending = handle.attachEngineering({ expectedAttachment: previous, ...workerConfiguration() });
    const refused = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(background.create).toHaveBeenCalledOnce());
    const closing = handle.close(); let finished = false; void closing.then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false); finish();
    await refused; await closing; expect(successors.close).toHaveBeenCalled(); expect(successors.start).not.toHaveBeenCalled();
  });
  it('refuses changed configuration during initialization before starting successors', async () => {
    const handle = await start(), previous = handle.engineeringAttachment()!; await previous.close();
    const configuration = workerConfiguration(), create = background.create.getMockImplementation()!;
    background.create.mockImplementationOnce(async value => {
      save(configuration.engineeringSuccessorsFile, { schemaVersion: 1, supervisionId: 'attached-queue', profileId: 'evolve', allowedWorkerIds: ['local'],
        maxOutputTokens: 257, proposalTimeoutMs: 10000, maxSuccessors: 2, pollIntervalMs: 1000 });
      return create(value);
    });
    await expect(handle.attachEngineering({ expectedAttachment: previous, ...configuration })).rejects.toThrow('configuration changed');
    expect(successors.start).not.toHaveBeenCalled(); expect(successors.close).toHaveBeenCalled();
    expect(handle.engineeringAttachment()!.state()).toBe('closed');
    expect((await post(handle, '/api/resources/queue', { paused: true })).status).toBe(200);
  });
  it('keeps a retired worker fault out of the replacement scope while retaining cleanup uncertainty', async () => {
    const handle = await start(workerConfiguration()), previous = handle.engineeringAttachment()!;
    const oldFault = background.create.mock.calls[0]![0].onFault;
    await previous.close();
    const nextOwner = { ...owner, close: vi.fn().mockResolvedValue(undefined) }; owner.create.mockReturnValueOnce(nextOwner);
    const next = await handle.attachEngineering({ expectedAttachment: previous, engineeringFile: options.engineeringFile });
    oldFault(); expect(next.state()).toBe('running'); expect(nextOwner.close).not.toHaveBeenCalled();
    const response = await fetch(`${handle.url}/api/resources/console`, { headers: { 'x-ashlr-token': handle.readToken } });
    expect(await response.json()).toMatchObject({ engineeringLifecycle: 'running' });
    await expect(handle.close()).rejects.toThrow('uncertain'); handles.splice(handles.indexOf(handle), 1);
  });
  it('has no browser route for attachment', async () => {
    const handle = await start(); expect((await post(handle, '/api/resources/engineering-runtime/attach', {})).status).toBe(404);
    expect(owner.create).toHaveBeenCalledOnce();
  });
});

describe('engineering HTTP capability boundary', () => {
  it('rejects an already-stopped child before acquiring execution ownership', async () => {
    const child = new AbortController(); child.abort();
    await expect(start({ engineeringLifetime: { signal: child.signal } })).rejects.toThrow('Engineering lifetime already stopped');
    expect(owner.create).not.toHaveBeenCalled(); expect(background.create).not.toHaveBeenCalled();
  });
  it('requires configured engineering for a child lifetime', async () => {
    await expect(start({ engineeringFile: undefined, engineeringLifetime: {} })).rejects.toThrow('requires configured engineering');
    expect(owner.create).not.toHaveBeenCalled();
  });
  it('fences a changed child veto before its polling close and never reopens after it clears', async () => {
    let stop = false; const handle = await start({ engineeringLifetime: { isExecutionStopped: () => stop } });
    stop = true;
    expect((await post(handle)).status).toBe(503); expect(owner.launch).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(owner.close).toHaveBeenCalledExactlyOnceWith({ preserveSupervisorTasks: true }));
    stop = false;
    expect((await post(handle)).status).toBe(503); expect((await fetch(`${handle.url}/health`)).status).toBe(200);
    expect((await post(handle, '/api/resources/queue', { paused: true })).status).toBe(200);
  });
  it('removes child observation and abort listeners when the console closes', async () => {
    const child = new AbortController(); const veto = vi.fn(() => false);
    const handle = await start({ engineeringLifetime: { signal: child.signal, isExecutionStopped: veto } });
    await handle.close(); const calls = veto.mock.calls.length; const closes = owner.close.mock.calls.length;
    child.abort(); await new Promise(resolve => setTimeout(resolve, 350));
    expect(veto).toHaveBeenCalledTimes(calls); expect(owner.close).toHaveBeenCalledTimes(closes);
  });
  it('fences engineering while draining but keeps the ordinary queue and read session available', async () => {
    const handle = await start(); const path = '/api/resources/engineering-runtime/close';
    expect((await post(handle, '/api/resources/queue', { paused: true })).status).toBe(200);
    let finish!: () => void;
    owner.close.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const closing = post(handle, path, {});
    try {
      await vi.waitFor(() => expect(owner.close).toHaveBeenCalledOnce());
      const scope = await fetch(`${handle.url}/api/resources/console`, { headers: { 'x-ashlr-token': handle.readToken } });
      expect(await scope.json()).toMatchObject({ engineeringLifecycle: 'stopping' });
      expect((await post(handle)).status).toBe(503); expect(owner.launch).not.toHaveBeenCalled();
      expect((await post(handle, '/api/resources/tasks', { id: 'human-during-drain', prompt: 'inert fixture',
        allowedWorkerIds: ['local'], mode: 'read-only', timeoutMs: 1000, maxOutputTokens: 16 })).status).toBe(202);
      expect((await fetch(`${handle.url}/health`)).status).toBe(200);
    } finally { finish(); }
    expect((await closing).status).toBe(200);
    expect((await post(handle, path, {})).status).toBe(200); expect(owner.close).toHaveBeenCalledOnce();
  });

  it('requires explicit control and origin for component close and reports held drains without closing HTTP', async () => {
    const handle = await start(); const path = '/api/resources/engineering-runtime/close';
    for (const headers of [{}, { 'x-ashlr-token': handle.readToken, origin: handle.url },
      { 'x-ashlr-token': handle.controlToken! }]) {
      expect((await post(handle, path, {}, headers as Record<string, string>)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await post(handle, path, { force: true })).status).toBe(400); expect(owner.close).not.toHaveBeenCalled();
    owner.close.mockRejectedValue(new Error('PRIVATE_SHUTDOWN_DIAGNOSTIC'));
    const held = await post(handle, path, {}); expect(held.status).toBe(503);
    expect(await held.text()).not.toContain('PRIVATE_SHUTDOWN_DIAGNOSTIC');
    expect(owner.close).toHaveBeenCalledExactlyOnceWith({ preserveSupervisorTasks: true });
    const scope = await fetch(`${handle.url}/api/resources/console`, { headers: { 'x-ashlr-token': handle.readToken } });
    expect(await scope.json()).toMatchObject({ engineeringLifecycle: 'held' });
    expect((await fetch(`${handle.url}/health`)).status).toBe(200);
    expect((await post(handle)).status).toBe(503); expect(owner.launch).not.toHaveBeenCalled();
    expect((await post(handle, path, {})).status).toBe(503); expect(owner.close).toHaveBeenCalledOnce();
    owner.close.mockResolvedValue(undefined);
  });

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
