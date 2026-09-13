/** Real private configuration/project identities; mocked proof transport and
 * inert enrollment projections. No child, worker, provider, or graph executes. */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ factory: vi.fn(), campaign: vi.fn(), universe: vi.fn(), read: vi.fn(), close: vi.fn() }));
vi.mock('../src/core/universe/firm-engineering-control-handler.js', async original => ({
  ...await original<typeof import('../src/core/universe/firm-engineering-control-handler.js')>(), createFirmEngineeringControlHandler: mocks.factory,
}));
vi.mock('../src/core/universe/campaign-store.js', async original => ({
  ...await original<typeof import('../src/core/universe/campaign-store.js')>(), readUniverseCampaign: mocks.campaign, campaignUniverse: mocks.universe,
}));
vi.mock('../src/core/resources/engineering-outcomes-reader.js', () => ({
  createResourceEngineeringOutcomesReader: () => ({ read: mocks.read, close: mocks.close }),
}));
import { createResourceConsoleEngineeringOwner, type ResourceConsoleEngineeringCatalog,
  type ResourceConsoleEngineeringOwner } from '../src/core/resources/console-engineering.js';
import { pinResourceConsoleProject } from '../src/core/resources/console-projects.js';
import type { ResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import type { ResourceEngineeringOutcomes } from '../src/core/resources/engineering-outcomes-types.js';

const roots: string[] = [], owners: ResourceConsoleEngineeringOwner[] = [];
beforeEach(() => { vi.resetAllMocks(); mocks.close.mockResolvedValue(undefined); });
afterEach(async () => {
  await Promise.allSettled(owners.splice(0).map(owner => owner.close()));
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'outcomes-owner-'))); roots.push(root);
  const project = join(root, 'project'), graphRoot = join(root, 'graph'), universeRoot = join(root, 'universe'), transport = join(root, 'transport');
  for (const path of [project, graphRoot, universeRoot, transport]) mkdirSync(path, { mode: 0o700 });
  const pool = { schemaVersion: 1, id: 'fixture', workers: [{ id: 'worker', provider: 'local', model: 'fixture',
    maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 4, taskWindowMs: 60_000, priority: 1 }] };
  const bindings = [{ workerId: 'worker', capacityKey: 'account', kind: 'local-chat', endpoint: 'http://127.0.0.1:1/v1' }];
  const control = { root: join(root, 'accounting'), poolFile: join(root, 'pool.json'),
    bindingsFile: join(root, 'bindings.json'), observationsFile: join(root, 'observations.json') };
  const save = (path: string, value: unknown) => writeFileSync(path, canonical(value) + '\n', { mode: 0o600 });
  save(control.poolFile, pool); save(control.bindingsFile, bindings); save(control.observationsFile, []);
  const runtime = { schemaVersion: 1, root: control.root, poolPath: control.poolFile, bindingsPath: control.bindingsFile,
    observationsPath: control.observationsFile, workspace: transport };
  const runtimeFile = join(root, 'runtime.json'); save(runtimeFile, runtime);
  mocks.campaign.mockReturnValue({ definition: { budget: { maxGenerations: 3, maxDurationMs: 60_000,
    maxModelRequests: 3, maxStagnantGenerations: 2, maxReportedTokens: null } } });
  mocks.universe.mockReturnValue({ manifest: { seed: { repo: project }, objective: 'Inert fixture',
    budget: { maxTrials: 1, maxDurationMs: 1000, trialTimeoutMs: 500, maxParallel: 1 } } });
  const expectedNodeInput = { bindingDigest: 'b'.repeat(64), requestDigest: 'c'.repeat(64) };
  const run = vi.fn(() => { throw new Error('Read must not dispatch'); });
  mocks.factory.mockReturnValue({ nodeInput: expectedNodeInput, handler: { effectClass: 'resource-completion',
    constitutionVersion: 'fixture', policyEpoch: 0, bindingDigest: expectedNodeInput.bindingDigest, run } });
  const catalog: ResourceConsoleEngineeringCatalog = { schemaVersion: 1, enrollments: [{ id: 'engineering', projectId: 'default',
    graphId: 'fixture', graphRoot, host: { root: universeRoot, nodeId: 'deliver', constitutionVersion: 'fixture', policyEpoch: 0,
      definition: { schemaVersion: 1, id: 'controller', tasks: [{ campaignId: 'campaign', dependsOn: [] }], maxParallel: 1, maxDurationMs: 60_000 },
      deliveryPlan: { schemaVersion: 1, deliveries: [{ campaignId: 'campaign', branch: 'codex/fixture', baseCommit: 'a'.repeat(40) }] },
      resourceRuntime: runtimeFile, expectedRuntimeDigest: digest(canonical(runtime)) } }] };
  const pinned = pinResourceConsoleProject({ id: 'default', label: 'Fixture', workspace: project });
  const scope = { project: pinned, root: control.root, poolDigest: digest(canonical({ pool, bindings })) };
  const supervisor = { projects: () => [{ id: pinned.id, label: pinned.label, workspace: project, enabled: true }],
    engineeringBinding: vi.fn(() => scope) } as unknown as ResourcePoolSupervisor;
  const waitForResourceDrain = vi.fn(async () => {});
  const owner = createResourceConsoleEngineeringOwner({ catalog, supervisor, ...control, waitForResourceDrain }); owners.push(owner);
  // Only identity handoff is under test: this sentinel is not delivery proof.
  const report = { schemaVersion: 1, enrollmentId: 'engineering', enrollmentDigest: owner.catalog()[0]!.enrollmentDigest,
    productionAccepted: null, routingChanged: false } as ResourceEngineeringOutcomes;
  return { root, project, graphRoot, control, catalog, owner, expectedNodeInput, report, run, waitForResourceDrain };
}

describe('asynchronous outcome proof owner boundary', () => {
  it('hands the exact enrolled node input to a fresh read without rebuilding the expensive factory on the parent', async () => {
    const f = fixture(), done = deferred<ResourceEngineeringOutcomes>(); mocks.read.mockReturnValue(done.promise);
    const factoryCalls = mocks.factory.mock.calls.length, abort = new AbortController();
    const reading = f.owner.outcomes('engineering', { signal: abort.signal });
    expect(mocks.read).toHaveBeenCalledWith({ enrollment: f.owner.catalog()[0], host: f.catalog.enrollments[0]!.host,
      root: f.control.root, poolFile: f.control.poolFile, bindingsFile: f.control.bindingsFile },
    { expectedNodeInput: f.expectedNodeInput, signal: abort.signal });
    done.resolve(f.report); expect(await reading).toBe(f.report);
    mocks.read.mockResolvedValueOnce(f.report); expect(await f.owner.outcomes('engineering')).toBe(f.report);
    expect(mocks.read).toHaveBeenCalledTimes(2); expect(mocks.factory).toHaveBeenCalledTimes(factoryCalls);
    expect(f.run).not.toHaveBeenCalled(); expect(readdirSync(f.graphRoot)).toEqual([]);
  });

  it.each(['project-replaced', 'request-aborted'] as const)('refuses a successful late proof after %s', async change => {
    const f = fixture(), done = deferred<ResourceEngineeringOutcomes>(), abort = new AbortController();
    mocks.read.mockReturnValue(done.promise);
    const reading = f.owner.outcomes('engineering', { signal: abort.signal });
    const rejected = expect(reading).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    if (change === 'project-replaced') { renameSync(f.project, join(f.root, 'old-project')); mkdirSync(f.project, { mode: 0o700 }); }
    else abort.abort();
    done.resolve(f.report); await rejected;
    expect(f.run).not.toHaveBeenCalled(); expect(readdirSync(f.graphRoot)).toEqual([]);
  });

  it('delegates close immediately, drains the read before peers, and refuses late publication', async () => {
    const f = fixture(), read = deferred<ResourceEngineeringOutcomes>(), drain = deferred<void>();
    mocks.read.mockReturnValue(read.promise); mocks.close.mockReturnValue(drain.promise);
    const reading = f.owner.outcomes('engineering');
    const rejected = expect(reading).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    let closed = false; const closing = f.owner.close(); void closing.then(() => { closed = true; });
    expect(f.owner.close()).toBe(closing); expect(mocks.close).toHaveBeenCalledTimes(1);
    await Promise.resolve(); expect(closed).toBe(false); expect(f.waitForResourceDrain).not.toHaveBeenCalled();
    await expect(f.owner.outcomes('engineering')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    // The reader owns child abort/group settlement. This mock models its
    // delayed drain; real subprocess cancellation belongs to transport tests.
    read.resolve(f.report); await rejected; drain.resolve(); await closing;
    expect(f.waitForResourceDrain).toHaveBeenCalledTimes(1); expect(f.run).not.toHaveBeenCalled();
  });

  it('keeps cleanup uncertainty as a sticky failed owner close, not a clean shutdown', async () => {
    const f = fixture(); mocks.close.mockRejectedValue(new Error('READ_PROJECTION_CLEANUP_UNCONFIRMED'));
    const closing = f.owner.close();
    await expect(closing).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'Engineering shutdown evidence unavailable' });
    expect(f.owner.close()).toBe(closing); expect(mocks.close).toHaveBeenCalledTimes(1);
    await expect(f.owner.outcomes('engineering')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(f.run).not.toHaveBeenCalled(); expect(readdirSync(f.graphRoot)).toEqual([]);
  });
});
