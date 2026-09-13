/** Real private owner launch records; subordinate campaign/graph projections are inert. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { createResourceConsoleEngineeringOwner, type ResourceConsoleEngineeringCatalog } from '../src/core/resources/console-engineering.js';
import { createResourceConsoleEngineeringSupervisor } from '../src/core/resources/console-engineering-supervisor.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { pinResourceConsoleProject } from '../src/core/resources/console-projects.js';
import type { ResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import * as graph from '../src/core/universe/control-graph.js';
import * as controllerStore from '../src/core/universe/portfolio-controller-store.js';
import * as provenance from '../src/core/foundry/provenance.js';
import * as policy from '../src/core/sandbox/policy.js';
const hooks = vi.hoisted(() => ({ factory: vi.fn(), campaign: vi.fn(), universe: vi.fn(), readiness: vi.fn(), receipt: vi.fn() }));
vi.mock('../src/core/universe/firm-engineering-control-handler.js', async original => ({
  ...await original<object>(), createFirmEngineeringControlHandler: hooks.factory,
}));
vi.mock('../src/core/universe/campaign-readiness.js', async original => ({ ...await original<object>(), readUniverseCampaignReadiness: hooks.readiness }));
vi.mock('../src/core/universe/campaign-store.js', async original => ({
  ...await original<object>(), readUniverseCampaign: hooks.campaign, campaignUniverse: hooks.universe,
}));
vi.mock('../src/core/universe/campaign-delivery-recovery.js', async original => ({ ...await original<object>(), readCompletedCampaignDelivery: hooks.receipt }));
let root: string;
const closers: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.resetAllMocks(); root = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-supervisor-owner-')));
  vi.spyOn(provenance, 'loadExistingProvenanceKeyReadOnly').mockReturnValue(Buffer.alloc(32, 3));
  vi.spyOn(policy, 'readKillSwitch').mockReturnValue({ state: 'inactive', sourceState: 'healthy' } as ReturnType<typeof policy.readKillSwitch>);
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => {});
  vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const project = join(root, 'project'), graphRoot = join(root, 'graph'), universeRoot = join(root, 'universe');
  const transport = join(root, 'transport'), accounting = join(root, 'accounting');
  for (const path of [project, graphRoot, universeRoot, transport, accounting]) mkdirSync(path, { mode: 0o700 });
  const pool = validateResourcePool({ schemaVersion: 1, id: 'pool', workers: [{ id: 'worker', provider: 'local', model: 'fixture',
    maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 4, taskWindowMs: 60_000, priority: 1 }] });
  const bindings = validateResourceBindings([{ workerId: 'worker', capacityKey: 'shared', kind: 'local-chat', endpoint: 'http://127.0.0.1:1/v1' }], pool);
  const control = { root: accounting, poolFile: join(root, 'pool.json'), bindingsFile: join(root, 'bindings.json'), observationsFile: join(root, 'observations.json') };
  const save = (path: string, value: unknown) => writeFileSync(path, canonical(value) + '\n', { mode: 0o600 });
  save(control.poolFile, pool); save(control.bindingsFile, bindings); save(control.observationsFile, []);
  const runtime = { schemaVersion: 1, root: accounting, poolPath: control.poolFile, bindingsPath: control.bindingsFile,
    observationsPath: control.observationsFile, workspace: transport };
  const runtimeFile = join(root, 'runtime.json'); save(runtimeFile, runtime);
  const budget = { maxGenerations: 1, maxDurationMs: 60_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: null };
  hooks.campaign.mockReturnValue({ definition: { budget } });
  hooks.universe.mockReturnValue({ manifest: { seed: { repo: project }, objective: 'Inert enrolled objective',
    budget: { maxTrials: 1, maxDurationMs: 60_000, trialTimeoutMs: 1_000, maxParallel: 1 } } });
  let observed = 0;
  const ready = { sourceState: 'healthy', automaticAction: 'run', observedState: 'ready', disposition: 'startable',
    recordsDigest: 'a'.repeat(64), expectedIdentity: { universeId: 'universe', definitionDigest: 'b'.repeat(64),
      manifestDigest: 'c'.repeat(64), comparatorDigest: 'd'.repeat(64), summaryDigest: 'e'.repeat(64) } };
  hooks.readiness.mockImplementation(() => ({ ...ready, sampledAt: new Date(++observed).toISOString() }));
  hooks.factory.mockReturnValue({ nodeInput: { bindingDigest: 'b'.repeat(64), requestDigest: 'c'.repeat(64) },
    handler: { effectClass: 'resource-completion', constitutionVersion: 'fixture', policyEpoch: 0, bindingDigest: 'b'.repeat(64), run: vi.fn() } });
  const projectBinding = pinResourceConsoleProject({ id: 'default', label: 'Default', workspace: project });
  const supervisor = { projects: () => [{ id: 'default', label: 'Default', workspace: project, enabled: true }],
    engineeringBinding: () => ({ root: accounting, poolDigest: digest(canonical({ pool, bindings })), project: projectBinding }),
    projectFileBinding: () => projectBinding, projectExecutionBinding: () => projectBinding,
    snapshot: () => ({ paused: false }) } as unknown as ResourcePoolSupervisor;
  const catalog: ResourceConsoleEngineeringCatalog = { schemaVersion: 1, enrollments: [{ id: 'engineering', projectId: 'default',
    graphId: 'graph', graphRoot, host: { root: universeRoot, nodeId: 'deliver', constitutionVersion: 'fixture', policyEpoch: 0,
      definition: { schemaVersion: 1, id: 'controller', tasks: [{ campaignId: 'campaign', dependsOn: [] }], maxParallel: 1, maxDurationMs: 60_000 },
      deliveryPlan: { schemaVersion: 1, deliveries: [{ campaignId: 'campaign', branch: 'codex/result', baseCommit: 'a'.repeat(40) }] },
      resourceRuntime: runtimeFile, expectedRuntimeDigest: digest(canonical(runtime)) } }] };
  const owner = createResourceConsoleEngineeringOwner({ catalog, supervisor, ...control }); closers.push(() => owner.close());
  const request = { enrollmentId: 'engineering', expectedEnrollmentDigest: owner.catalog()[0]!.enrollmentDigest };
  return { owner, request, graphRoot, universeRoot, accounting, ready };
}

describe('engineering owner seams for finite unattended supervision', () => {
  it('fingerprints durable campaign evidence but ignores sampled timestamps and readiness owner churn', () => {
    const f = fixture(); const initial = f.owner.evidenceFingerprint('engineering');
    expect(initial).toMatch(/^[a-f0-9]{64}$/);
    expect(f.owner.evidenceFingerprint('engineering')).toBe(initial);
    f.ready.disposition = 'owned'; expect(f.owner.evidenceFingerprint('engineering')).toBe(initial);
    f.ready.recordsDigest = 'f'.repeat(64); expect(f.owner.evidenceFingerprint('engineering')).not.toBe(initial);
    expect(readdirSync(f.graphRoot)).toEqual([]);
  });
  it('withholds a fingerprint while child evidence changes between samples', () => {
    const f = fixture(); let n = 0;
    hooks.readiness.mockImplementation(() => ({ ...f.ready, recordsDigest: String(++n).padStart(64, '0') }));
    expect(f.owner.evidenceFingerprint('engineering')).toBeNull(); expect(readdirSync(f.graphRoot)).toEqual([]);
  });
  it('includes controller history even when graph nodes have not changed', () => {
    const f = fixture(); const initial = f.owner.evidenceFingerprint('engineering');
    mkdirSync(join(f.universeRoot, 'portfolios'), { mode: 0o700 });
    mkdirSync(join(f.universeRoot, 'portfolios', 'controller'), { mode: 0o700 });
    const events = vi.spyOn(controllerStore, 'readPortfolioControllerEvents').mockReturnValue([]);
    const before = f.owner.evidenceFingerprint('engineering'); expect(before).not.toBe(initial);
    events.mockReturnValue([{ fixture: 'new durable controller record' }] as unknown as ReturnType<typeof controllerStore.readPortfolioControllerEvents>);
    expect(f.owner.evidenceFingerprint('engineering')).not.toBe(before);
  });
  it('includes exact completed delivery evidence and fails closed on unreadable stores', () => {
    const f = fixture(); f.ready.observedState = 'completed';
    hooks.receipt.mockReturnValue({ fixture: 'receipt-one' }); const first = f.owner.evidenceFingerprint('engineering');
    hooks.receipt.mockReturnValue({ fixture: 'receipt-two' }); expect(f.owner.evidenceFingerprint('engineering')).not.toBe(first);
    hooks.readiness.mockImplementation(() => { throw new Error('private diagnostic'); });
    expect(f.owner.evidenceFingerprint('engineering')).toBeNull();
  });
  it.each(['stopped', 'throw', 'aborted'] as const)('refuses %s enclosing execution before publishing launch', kind => {
    const f = fixture(); const abort = new AbortController(); if (kind === 'aborted') abort.abort();
    expect(() => f.owner.launch(f.request, { signal: abort.signal, isExecutionStopped: () => {
      if (kind === 'throw') throw new Error('private guard'); return kind === 'stopped';
    } })).toThrow('enclosing execution stopped');
    expect(readdirSync(f.graphRoot)).toEqual([]);
  });
  it('rejects launch-control getters without executing them', () => {
    const f = fixture(); const getter = vi.fn(() => () => false);
    expect(() => f.owner.launch(f.request, Object.defineProperty({}, 'isExecutionStopped', { enumerable: true, get: getter }))).toThrow('launch controls');
    expect(getter).not.toHaveBeenCalled(); expect(readdirSync(f.graphRoot)).toEqual([]);
  });
  it('passes the enclosing stop guard to the graph and awaits its exact active invocation', async () => {
    const f = fixture(); let finish!: () => void; let stopped = false;
    const entered = new Promise<void>(resolve => {
      vi.spyOn(graph, 'runControlGraph').mockImplementation(async (_input, options) => {
        expect(options.isExecutionStopped?.()).toBe(false); stopped = true;
        expect(options.isExecutionStopped?.()).toBe(true); resolve();
        await new Promise<void>(done => { finish = done; });
        return { ...graph.readControlGraph(f.graphRoot), status: 'stopped' };
      });
    });
    f.owner.launch(f.request, { isExecutionStopped: () => stopped }); await entered;
    let settled = false; const pending = f.owner.awaitSettlement('engineering').then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false); finish(); await pending; expect(settled).toBe(true);
  });
  it('fails closed on a changed private attempt checkpoint before contacting the owner', async () => {
    const f = fixture(); const launch = vi.spyOn(f.owner, 'launch');
    const driver = createResourceConsoleEngineeringSupervisor({ owner: f.owner, root: f.accounting,
      config: { schemaVersion: 1, id: 'driver', maxDurationMs: 60_000, pollIntervalMs: 100, maxConcurrent: 1,
        maxAttemptsPerEnrollment: 2, enrollments: [f.request] } });
    closers.push(() => driver.close());
    const stateFile = join(f.accounting, 'engineering-supervision', 'driver', 'state.json');
    const original = JSON.parse(readFileSync(stateFile, 'utf8')); writeFileSync(stateFile, canonical({ ...original, revision: 99 }) + '\n', { mode: 0o600 });
    driver.start();
    await new Promise(resolve => setImmediate(resolve));
    expect(driver.snapshot().state).toBe('unavailable'); expect(launch).not.toHaveBeenCalled();
    expect(readdirSync(f.graphRoot)).toEqual([]); await expect(driver.close()).rejects.toThrow('shutdown');
  });
});
