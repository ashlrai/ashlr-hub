/** Registration is local validation only. Campaign/adapter projections are inert;
 * project identities, supervisor ownership, and launch/cancel records are real. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const projections = vi.hoisted(() => ({ factory: vi.fn(), campaign: vi.fn(), universe: vi.fn(), readiness: vi.fn(), run: vi.fn() }));
vi.mock('../src/core/universe/firm-engineering-control-handler.js', async original => ({
  ...await original<typeof import('../src/core/universe/firm-engineering-control-handler.js')>(), createFirmEngineeringControlHandler: projections.factory,
}));
vi.mock('../src/core/universe/campaign-store.js', async original => ({
  ...await original<typeof import('../src/core/universe/campaign-store.js')>(), readUniverseCampaign: projections.campaign, campaignUniverse: projections.universe,
}));
vi.mock('../src/core/universe/campaign-readiness.js', async original => ({
  ...await original<typeof import('../src/core/universe/campaign-readiness.js')>(), readUniverseCampaignReadiness: projections.readiness,
}));
vi.mock('../src/core/universe/control-graph.js', async original => ({
  ...await original<typeof import('../src/core/universe/control-graph.js')>(), runControlGraph: projections.run,
}));
import { createResourceConsoleEngineeringOwner, validateResourceConsoleEngineeringCatalog,
  type ResourceConsoleEngineeringCatalog, type ResourceConsoleEngineeringOwner } from '../src/core/resources/console-engineering.js';
import { createResourcePoolSupervisor, type ResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import * as policy from '../src/core/sandbox/policy.js';
import * as provenance from '../src/core/foundry/provenance.js';

let root: string;
const owners: ResourceConsoleEngineeringOwner[] = [];
const supervisors: ResourcePoolSupervisor[] = [];
beforeEach(() => { vi.resetAllMocks(); root = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-registration-'))); });
afterEach(async () => {
  await Promise.allSettled(owners.splice(0).map(owner => owner.close()));
  await Promise.allSettled(supervisors.splice(0).map(owner => owner.close()));
  vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true });
});
function tree(directory: string): unknown {
  const stat = statSync(directory, { bigint: true });
  return { ino: String(stat.ino), mode: String(stat.mode), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
    content: stat.isFile() ? readFileSync(directory, 'utf8') : Object.fromEntries(readdirSync(directory).sort().map(name => [name, tree(join(directory, name))])) };
}
async function fixture() {
  const project = join(root, 'project'); const universe = join(root, 'universe'); const transport = join(root, 'transport');
  for (const directory of [project, universe, transport]) mkdirSync(directory, { mode: 0o700 });
  const pool = validateResourcePool({ schemaVersion: 1, id: 'pool', workers: [{ id: 'worker', provider: 'local', model: 'fixture',
    maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 5, taskWindowMs: 60_000, priority: 1 }] });
  const bindings = validateResourceBindings([{ workerId: 'worker', capacityKey: 'account', kind: 'local-chat', endpoint: 'http://127.0.0.1:1/v1' }], pool);
  const control = { root: join(root, 'ledger'), poolFile: join(root, 'pool.json'), bindingsFile: join(root, 'bindings.json'), observationsFile: join(root, 'observations.json') };
  const save = (file: string, value: unknown) => writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
  save(control.poolFile, pool); save(control.bindingsFile, bindings); save(control.observationsFile, []);
  const runtime = { schemaVersion: 1, root: control.root, poolPath: control.poolFile, bindingsPath: control.bindingsFile,
    observationsPath: control.observationsFile, workspace: transport };
  const runtimeFile = join(root, 'runtime.json'); save(runtimeFile, runtime);
  projections.factory.mockImplementation(host => ({ nodeInput: { bindingDigest: digest(canonical(host)), requestDigest: 'c'.repeat(64) },
    handler: { effectClass: 'resource-completion', constitutionVersion: 'fixture', policyEpoch: 0, bindingDigest: digest(canonical(host)), run: vi.fn() } }));
  projections.campaign.mockReturnValue({ definition: { budget: { maxGenerations: 1, maxDurationMs: 30_000, maxModelRequests: 1,
    maxStagnantGenerations: 1, maxReportedTokens: null } } });
  projections.universe.mockReturnValue({ manifest: { seed: { repo: project }, objective: 'Fixed objective',
    budget: { maxTrials: 1, maxDurationMs: 1000, trialTimeoutMs: 500, maxParallel: 1 } } });
  projections.readiness.mockReturnValue({ sourceState: 'healthy', automaticAction: 'run', observedState: 'ready', disposition: 'startable' });
  const supervisor = await createResourcePoolSupervisor({ ...control, pool, bindings, workspace: project, projects: [], readObservations: () => [], pollIntervalMs: 60_000 });
  supervisors.push(supervisor);
  const row = (id: string): ResourceConsoleEngineeringCatalog['enrollments'][number] => {
    const graphRoot = join(root, `graph-${id}`); mkdirSync(graphRoot, { mode: 0o700 });
    return { id, projectId: 'default', graphId: `graph-${id}`, graphRoot, host: { root: universe, nodeId: 'deliver', constitutionVersion: 'fixture', policyEpoch: 0,
      definition: { schemaVersion: 1, id: `controller-${id}`, tasks: [{ campaignId: `campaign-${id}`, dependsOn: [] }], maxParallel: 1, maxDurationMs: 30_000 },
      deliveryPlan: { schemaVersion: 1, deliveries: [{ campaignId: `campaign-${id}`, branch: `codex/${id}`, baseCommit: 'a'.repeat(40) }] },
      resourceRuntime: runtimeFile, expectedRuntimeDigest: digest(canonical(runtime)) } };
  };
  const options = { ...control, supervisor, registrationEnabled: true as const };
  const create = (catalog?: ResourceConsoleEngineeringCatalog) => {
    const owner = createResourceConsoleEngineeringOwner({ ...options, ...(catalog ? { catalog } : {}) }); owners.push(owner); return owner;
  };
  return { options, create, row, supervisor, project, runtimeFile, runtime, pool, control, save };
}
const catalog = (...enrollments: ResourceConsoleEngineeringCatalog['enrollments']): ResourceConsoleEngineeringCatalog => ({ schemaVersion: 1, enrollments });

describe('explicit host-only engineering registration', () => {
  it('allows omitted or exact empty catalog only under explicit capability, without writes', async () => {
    const f = await fixture(); const before = tree(root);
    expect(f.create().catalog()).toEqual([]); expect(f.create(catalog()).catalog()).toEqual([]);
    expect(tree(root)).toEqual(before);
    const { registrationEnabled: _flag, ...legacy } = f.options;
    expect(() => createResourceConsoleEngineeringOwner(legacy)).toThrow('catalog required');
    expect(() => createResourceConsoleEngineeringOwner({ ...legacy, catalog: catalog() })).toThrow();
    expect(() => validateResourceConsoleEngineeringCatalog(catalog())).toThrow(); expect(projections.run).not.toHaveBeenCalled();
  });
  it.each([false, undefined, 'true', null])('refuses malformed explicit capability %#', async value => {
    const f = await fixture(); const before = tree(root);
    expect(() => createResourceConsoleEngineeringOwner({ ...f.options, registrationEnabled: value as true })).toThrow(); expect(tree(root)).toEqual(before);
  });
  it('refuses inherited/getter capabilities and catalog accessors without invoking them', async () => {
    const f = await fixture(); const getter = vi.fn(() => true);
    expect(() => createResourceConsoleEngineeringOwner({ ...f.options, get registrationEnabled() { return getter() as true; } })).toThrow();
    const { registrationEnabled: _flag, ...rest } = f.options;
    expect(() => createResourceConsoleEngineeringOwner(Object.assign(Object.create({ registrationEnabled: true }), rest))).toThrow();
    expect(() => createResourceConsoleEngineeringOwner({ ...f.options, get catalog() { getter(); return catalog(); } })).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it('registers detached entries atomically with exact immutable replay and no graph dispatch or files', async () => {
    const f = await fixture(); const first = f.row('first'); const second = f.row('second'); const owner = f.create(catalog(first));
    const before = tree(root); const old = owner.catalog();
    const preview = owner.checkRegistration(catalog(second)); expect(preview.map(row => row.id)).toEqual(['first', 'second']);
    expect(owner.catalog()).toEqual(old); expect(tree(root)).toEqual(before);
    const added = owner.register(catalog(second)); expect(added.map(row => row.id)).toEqual(['first', 'second']);
    expect(added).toEqual(preview);
    expect(added[0]).toEqual(old[0]); expect(owner.register(catalog(second, first))).toEqual(added);
    second.host.constitutionVersion = 'mutated'; added[1]!.objective = 'mutated';
    expect(owner.catalog()[1]!.objective).toBe('Fixed objective'); expect(owner.snapshot('second')).toMatchObject({ state: 'ready', launched: false });
    expect(tree(root)).toEqual(before); expect(projections.run).not.toHaveBeenCalled();
  });
  it('requires registration capability even when a startup catalog exists, and refuses after close', async () => {
    const f = await fixture(); const row = f.row('first'); const { registrationEnabled: _flag, ...legacy } = f.options;
    const owner = createResourceConsoleEngineeringOwner({ ...legacy, catalog: catalog(row) }); owners.push(owner);
    expect(() => owner.register(catalog(row))).toThrow('disabled');
    expect(() => owner.checkRegistration(catalog(row))).toThrow('disabled');
    const enabled = f.create(); await enabled.close(); expect(() => enabled.register(catalog(row))).toThrow('closing');
    expect(() => enabled.checkRegistration(catalog(row))).toThrow('closing');
  });
  it.each(['id', 'graph', 'root', 'controller', 'project', 'account'] as const)('refuses %s conflicts without partial map replacement', async kind => {
    const f = await fixture(); const first = f.row('first'); const second = f.row('second'); const third = f.row('third');
    const owner = f.create(catalog(first)); const before = owner.catalog();
    if (kind === 'id') second.id = first.id;
    if (kind === 'graph') second.graphId = first.graphId;
    if (kind === 'root') second.graphRoot = first.graphRoot;
    if (kind === 'controller') second.host.definition.id = first.host.definition.id;
    if (kind === 'project') second.projectId = 'missing';
    if (kind === 'account') f.save(f.runtimeFile, { ...f.runtime, root: join(root, 'foreign-ledger') });
    const bytes = tree(root);
    expect(() => owner.register(catalog(third, second))).toThrow(); expect(owner.catalog()).toEqual(before);
    expect(tree(root)).toEqual(bytes); expect(projections.run).not.toHaveBeenCalled();
  });
  it('revalidates existing pins and live project identity before replacing the catalog', async () => {
    const f = await fixture(); const first = f.row('first'); const second = f.row('second'); const owner = f.create(catalog(first)); const before = owner.catalog();
    projections.factory.mockReturnValue({ nodeInput: { bindingDigest: 'e'.repeat(64), requestDigest: 'c'.repeat(64) }, handler: {} });
    expect(() => owner.register(catalog(second))).toThrow('pins changed'); expect(owner.catalog()).toEqual(before);
    renameSync(f.project, `${f.project}-original`); mkdirSync(f.project, { mode: 0o700 });
    expect(() => owner.register(catalog(second))).toThrow('project identity changed'); expect(owner.catalog()).toEqual(before);
  });
  it('enforces 32 total enrollments including startup and does not discard accepted entries', async () => {
    const f = await fixture(); const rows = Array.from({ length: 33 }, (_, index) => f.row(`entry-${index}`)); const owner = f.create(catalog(rows[0]!));
    expect(owner.register(catalog(...rows.slice(1, 32)))).toHaveLength(32); const before = owner.catalog();
    expect(() => owner.register(catalog(rows[32]!))).toThrow('capacity'); expect(owner.catalog()).toEqual(before);
  });
  it('exposes readiness and explicit launch/cancel for a registered entry without scheduling it during registration', async () => {
    const f = await fixture(); const row = f.row('first'); const owner = f.create();
    vi.spyOn(policy, 'readKillSwitch').mockReturnValue({ state: 'inactive', sourceState: 'healthy', reason: 'missing', path: '/fixture/KILL' });
    vi.spyOn(provenance, 'loadExistingProvenanceKeyReadOnly').mockReturnValue(Buffer.alloc(32, 1));
    const [entry] = owner.register(catalog(row)); expect(projections.run).not.toHaveBeenCalled();
    expect(owner.readiness(row.id)).toMatchObject({ status: 'ready', action: 'launch' });
    let finish!: () => void; projections.run.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    expect(owner.launch({ enrollmentId: row.id, expectedEnrollmentDigest: entry!.enrollmentDigest })).toMatchObject({ state: 'running', launched: true });
    await vi.waitFor(() => expect(projections.run).toHaveBeenCalledOnce());
    expect(owner.cancel(row.id)).toMatchObject({ cancelled: true }); finish(); await owner.awaitSettlement(row.id);
    expect(owner.snapshot(row.id)).toMatchObject({ state: 'stopped', cancelled: true });
  });
});
