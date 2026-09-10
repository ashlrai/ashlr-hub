/** Pure orchestration tests: all filesystem/evidence projections are inert, explicit fixtures. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const seams = vi.hoisted(() => ({ read: vi.fn(), stat: vi.fn(), poolStatus: vi.fn(), preview: vi.fn(), decode: vi.fn(),
  prepare: vi.fn(), catalog: vi.fn(), runtime: vi.fn(), graph: vi.fn(), campaign: vi.fn(), universe: vi.fn(), readiness: vi.fn(),
  key: vi.fn(), kill: vi.fn(), matches: vi.fn(), forbidden: vi.fn(() => { throw new Error('Execution is forbidden'); }) }));
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), lstatSync: seams.stat }));
vi.mock('../src/core/resources/pool-runtime.js', () => ({ readResourceJson: seams.read, resourcePoolStatus: seams.poolStatus,
  runResourceTask: seams.forbidden }));
vi.mock('../src/core/resources/pool-supervisor.js', () => ({ decodeResourceConsoleState: seams.decode,
  previewResourceConsoleProjects: seams.preview, createResourcePoolSupervisor: seams.forbidden }));
vi.mock('../src/core/resources/console-engineering.js', () => ({ prepareResourceConsoleEngineeringEnrollments: seams.prepare,
  validateResourceConsoleEngineeringCatalog: seams.catalog, createResourceConsoleEngineeringOwner: seams.forbidden }));
vi.mock('../src/core/resources/console-projects.js', async original => ({ ...await original<typeof import('../src/core/resources/console-projects.js')>(),
  matchesResourceConsoleProject: seams.matches }));
vi.mock('../src/core/universe/resource-runtime-check.js', () => ({ checkResourceGenerationRuntime: seams.runtime }));
vi.mock('../src/core/universe/control-graph.js', () => ({ readControlGraph: seams.graph, runControlGraph: seams.forbidden }));
vi.mock('../src/core/universe/campaign-store.js', () => ({ readUniverseCampaign: seams.campaign, campaignUniverse: seams.universe }));
vi.mock('../src/core/universe/campaign-readiness.js', () => ({ readUniverseCampaignReadiness: seams.readiness }));
vi.mock('../src/core/universe/portfolio-controller-store.js', () => ({ portfolioControllerDirectory: () => '/fixture/universe/controller' }));
vi.mock('../src/core/foundry/provenance.js', async original => ({ ...await original<typeof import('../src/core/foundry/provenance.js')>(),
  loadExistingProvenanceKeyReadOnly: seams.key, loadOrCreateKey: seams.forbidden }));
vi.mock('../src/core/sandbox/policy.js', () => ({ readKillSwitch: seams.kill }));
import { checkResourceConsoleEngineering, type ResourceConsoleEngineeringCheckOptions } from '../src/core/resources/console-engineering-check.js';

const options: ResourceConsoleEngineeringCheckOptions = { root: '/fixture/ledger', poolFile: '/fixture/pool.json',
  bindingsFile: '/fixture/bindings.json', observationsFile: '/fixture/observations.json', workspace: '/fixture/project',
  projectsFile: '/fixture/projects.json', engineeringFile: '/fixture/engineering.json' };
const runtimeFile = '/fixture/runtime.json';
const pool = { schemaVersion: 1, id: 'fixture', workers: [{ id: 'local', provider: 'local', model: 'fixture',
  maxConcurrent: 1, maxTasksPerWindow: 4, taskWindowMs: 60_000, reservePercent: 10, priority: 1 }] };
const binding = { id: 'default', label: 'Default workspace', workspace: options.workspace, dev: '1', ino: '2' };
let files: Map<string, unknown>;
const enrollment = (id = 'first', expectedRuntimeDigest = 'a'.repeat(64)) => ({ row: { id, projectId: 'default', graphId: id,
  graphRoot: `/fixture/graphs/${id}`, host: { resourceRuntime: runtimeFile, expectedRuntimeDigest, root: '/fixture/universe',
    definition: { id: `${id}-controller`, tasks: [{ campaignId: 'campaign', dependsOn: [] }] } } },
  definitionDigest: 'b'.repeat(64), summary: { enrollmentDigest: 'c'.repeat(64) } });
const validRuntime = () => ({ schemaVersion: 1, status: 'valid', evidenceScope: 'local-configuration-only', providerContacted: false,
  checks: [{ code: 'runtime', status: 'passed' }], workers: [{ workerId: 'local', policyHolds: [], eligibility: 'excluded',
    exclusionReasons: ['concurrency-exhausted'] }], warnings: ['execution-and-account-identity-unverified'] });
beforeEach(() => {
  vi.resetAllMocks();
  files = new Map<string, unknown>([[options.poolFile, pool], [options.bindingsFile, [{ workerId: 'local', capacityKey: 'local', kind: 'local-chat',
    endpoint: 'http://127.0.0.1:1/v1' }]], [options.observationsFile, []], [options.projectsFile, { schemaVersion: 1, projects: [] }],
  [options.engineeringFile, { schemaVersion: 1, enrollments: [] }], [runtimeFile, { schemaVersion: 1, fixture: true }]]);
  seams.read.mockImplementation((file: string) => {
    if (!files.has(file)) throw new Error('Fixture file missing'); return structuredClone(files.get(file));
  });
  seams.stat.mockImplementation((file: string) => {
    if (files.has(file)) return {}; throw Object.assign(new Error('Fixture absent'), { code: 'ENOENT' });
  });
  seams.preview.mockReturnValue({ bindings: [binding], projects: [{ id: binding.id, label: binding.label,
    workspace: binding.workspace, enabled: true }], registration: 'would-register', changed: true });
  seams.catalog.mockImplementation(value => value); seams.prepare.mockReturnValue([enrollment()]);
  seams.runtime.mockImplementation(validRuntime); seams.graph.mockReturnValue({ sourceState: 'missing', status: 'missing', definitionDigest: null });
  seams.matches.mockReturnValue(true); seams.key.mockReturnValue(Buffer.alloc(32));
  seams.kill.mockReturnValue({ state: 'inactive', sourceState: 'healthy' });
  seams.readiness.mockReturnValue({ sourceState: 'healthy', automaticAction: 'run', observedState: 'ready', disposition: 'startable' });
  seams.universe.mockReturnValue({ manifest: { variants: [{ generation: { kind: 'resource-pool', allowedWorkerIds: ['local'] } }] } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('No network permitted'); });
});
afterEach(() => { expect(seams.forbidden).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

describe('standalone commissioning check orchestration', () => {
  it.each([null, {}, [], { ...options, execute: true }, { ...options, root: '/' }, { ...options, workspace: 'relative' },
    { ...options, quotaConfigFile: undefined }])('rejects malformed input before any evidence read %#', input => {
    const report = checkResourceConsoleEngineering(input as ResourceConsoleEngineeringCheckOptions);
    expect(report).toMatchObject({ status: 'unavailable', reasons: ['commissioning-inputs-unavailable'], enrollments: [],
      effectsExecuted: false, providerContacted: false, admission: 'not-attested' });
    expect(seams.read).not.toHaveBeenCalled(); expect(seams.stat).not.toHaveBeenCalled(); expect(seams.prepare).not.toHaveBeenCalled();
  });
  it('does not invoke input getters or inherit implicit configuration', () => {
    let called = false;
    const input = { ...options, get root() { called = true; return options.root; } };
    expect(checkResourceConsoleEngineering(input).status).toBe('unavailable'); expect(called).toBe(false);
    expect(checkResourceConsoleEngineering(Object.create(options)).status).toBe('unavailable');
    expect(seams.read).not.toHaveBeenCalled();
  });
  it('keeps local configuration separate from presently exhausted capacity', () => {
    const report = checkResourceConsoleEngineering(options);
    expect(report).toMatchObject({ status: 'configured', admission: 'not-attested', effectsExecuted: false, providerContacted: false });
    expect(report.enrollments[0]).toMatchObject({ projectRegistration: 'would-register', status: 'configured',
      runtime: { workers: [{ eligibility: 'excluded', exclusionReasons: ['concurrency-exhausted'] }] } });
    expect(report.checks.every(check => check.status === 'passed')).toBe(true);
  });
  it('rejects captured configuration drift at the final snapshot stage without partial rows', () => {
    let reads = 0;
    seams.read.mockImplementation((file: string) => file === options.poolFile && ++reads > 1
      ? { ...pool, id: 'changed-fixture' } : structuredClone(files.get(file)));
    const report = checkResourceConsoleEngineering(options);
    expect(report).toMatchObject({ status: 'unavailable', reasons: ['commissioning-snapshot-stability-unavailable'], enrollments: [] });
    expect(report.checks.find(check => check.code === 'snapshot-stability')?.status).toBe('failed');
  });
  it('does not reuse a runtime result across distinct expected digests on the same path', () => {
    seams.prepare.mockReturnValue([enrollment(), enrollment('second', 'd'.repeat(64))]);
    seams.runtime.mockImplementation(({ expectedRuntimeDigest }: { expectedRuntimeDigest: string }) =>
      expectedRuntimeDigest === 'a'.repeat(64) ? validRuntime() : { ...validRuntime(), status: 'invalid',
        checks: [{ code: 'runtime', status: 'failed' }] });
    const report = checkResourceConsoleEngineering(options);
    expect(seams.runtime).toHaveBeenCalledTimes(2);
    expect(seams.runtime).toHaveBeenNthCalledWith(2, { resourceRuntime: runtimeFile, expectedRuntimeDigest: 'd'.repeat(64) });
    expect(report.status).toBe('unavailable'); expect(report.reasons).toContain('commissioning-runtime-runtime-unavailable');
    expect(report.enrollments).toEqual([]);
  });
  it('reuses an exact runtime pin without changing enrollment attribution', () => {
    seams.prepare.mockReturnValue([enrollment(), enrollment('second')]);
    const report = checkResourceConsoleEngineering(options);
    expect(report.status).toBe('configured'); expect(seams.runtime).toHaveBeenCalledOnce();
    expect(report.enrollments.map(row => row.id)).toEqual(['first', 'second']);
  });
  it.each(['workspace', 'quota-refresh', 'ledger'])('reports invalid runtime %s as an actionable stage without private diagnostics', code => {
    seams.runtime.mockReturnValue({ ...validRuntime(), status: 'invalid', checks: [{ code, status: 'failed' }] });
    const report = checkResourceConsoleEngineering(options);
    expect(report.status).toBe('unavailable'); expect(report.reasons).toContain(`commissioning-runtime-${code}-unavailable`);
    expect(report.enrollments).toEqual([]); expect(JSON.stringify(report)).not.toContain('/fixture');
  });
});
