/** Real signed graph storage; all handlers are inert fixture callbacks. */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const projections = vi.hoisted(() => ({ factory: vi.fn(), campaign: vi.fn(), universe: vi.fn(), readiness: vi.fn() }));
vi.mock('../src/core/universe/campaign-readiness.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/campaign-readiness.js')>(), readUniverseCampaignReadiness: projections.readiness,
}));
vi.mock('../src/core/universe/firm-engineering-control-handler.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/firm-engineering-control-handler.js')>(), createFirmEngineeringControlHandler: projections.factory,
}));
vi.mock('../src/core/universe/campaign-store.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/campaign-store.js')>(),
  readUniverseCampaign: projections.campaign, campaignUniverse: projections.universe,
}));
import { createResourceConsoleEngineeringOwner, validateResourceConsoleEngineeringCatalog, prepareResourceConsoleEngineeringEnrollments,
  type ResourceConsoleEngineeringCatalog } from '../src/core/resources/console-engineering.js';
import { createResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import * as workerTransport from '../src/core/resources/worker.js';
import { runResourceTask, resourcePoolStatus } from '../src/core/resources/pool-runtime.js';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import * as provenance from '../src/core/foundry/provenance.js';
import * as policy from '../src/core/sandbox/policy.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { signDecisionTraceV1 } from '../src/core/universe/decision-trace.js';
import { readControlGraph, runControlGraph, validateControlGraph, type ControlGraphDefinition } from '../src/core/universe/control-graph.js';

let root: string;
const traceKeys = { testKey: randomBytes(32) };
const definition = (): ControlGraphDefinition => ({ schemaVersion: 1, id: 'console-fixture', maxConcurrent: 1,
  maxDurationMs: 60_000, nodes: [{ id: 'inspect', kind: 'explore', requires: [], input: {} }] });
const emit = () => Promise.resolve({ artifact: { observation: 'inert fixture' } });
beforeEach(() => { vi.resetAllMocks(); root = realpathSync(mkdtempSync(join(tmpdir(), 'console-engineering-core-'))); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('console engineering graph attribution', () => {
  it('preserves the exact legacy definition and its existing resume behavior', async () => {
    const graph = definition(); const run = vi.fn(emit);
    expect(validateControlGraph(graph)).toEqual(graph);
    const first = await runControlGraph(graph, { root, traceKeys, handlers: { explore: run } });
    expect(first.status).toBe('completed');
    expect(await runControlGraph(graph, { root, traceKeys, handlers: { explore: run } })).toEqual(first);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it.each(['', 'A'.repeat(64), 'a'.repeat(63), null, 1, {}])('refuses malformed signed association %# before storage', (hostEnrollmentDigest) => {
    expect(() => validateControlGraph({ ...definition(), hostEnrollmentDigest })).toThrow();
    expect(readdirSync(root)).toEqual([]);
  });
  it('binds the console digest in signed definition identity and refuses changed or omitted association', async () => {
    const graph = { ...definition(), hostEnrollmentDigest: 'a'.repeat(64) }; const run = vi.fn(emit);
    const first = await runControlGraph(graph, { root, traceKeys, handlers: { explore: run } });
    expect(first.status).toBe('completed'); const saved = canonical(readControlGraph(root, traceKeys));
    for (const next of [definition(), { ...graph, hostEnrollmentDigest: 'b'.repeat(64) }]) {
      expect((await runControlGraph(next, { root, traceKeys, handlers: { explore: run } })).status).toBe('unavailable');
      expect(canonical(readControlGraph(root, traceKeys))).toBe(saved);
    }
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('cannot adopt an ordinary graph as an enrolled console graph', async () => {
    const run = vi.fn(emit);
    await runControlGraph(definition(), { root, traceKeys, handlers: { explore: run } });
    const saved = canonical(readControlGraph(root, traceKeys));
    const result = await runControlGraph({ ...definition(), hostEnrollmentDigest: 'a'.repeat(64) },
      { root, traceKeys, handlers: { explore: run } });
    expect(result.status).toBe('unavailable'); expect(canonical(readControlGraph(root, traceKeys))).toBe(saved);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('checks first-launch freshness under ownership even when the exact graph raced in', async () => {
    const graph = { ...definition(), hostEnrollmentDigest: 'a'.repeat(64) }; const run = vi.fn(emit);
    await runControlGraph(graph, { root, traceKeys, handlers: {} });
    const saved = canonical(readControlGraph(root, traceKeys));
    expect((await runControlGraph(graph, { root, traceKeys, handlers: { explore: run }, requireNewGraph: true })).status).toBe('unavailable');
    expect(canonical(readControlGraph(root, traceKeys))).toBe(saved); expect(run).not.toHaveBeenCalled();
    expect((await runControlGraph(graph, { root, traceKeys, handlers: { explore: run } })).status).toBe('completed');
  });
  it.each(['stop', 'throw'])('honors enclosing %s before graph creation or handlers', async (kind) => {
    const run = vi.fn(emit);
    const result = await runControlGraph(definition(), { root, traceKeys, handlers: { explore: run },
      isExecutionStopped: () => { if (kind === 'throw') throw new Error('private owner failure'); return true; } });
    expect(result.status).toBe('stopped'); expect(result.reasons).toEqual(['enclosing-execution-stopped']);
    expect(readdirSync(root)).toEqual([]); expect(run).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private owner failure');
  });
  it('carries the synchronous enclosing guard into a handler after dispatch', async () => {
    let stopped = false;
    const result = await runControlGraph(definition(), { root, traceKeys, isExecutionStopped: () => stopped,
      handlers: { explore: async (context) => {
        stopped = true; expect(context.isExecutionStopped?.()).toBe(true);
        expect(context.signal.aborted).toBe(true); return { artifact: {} };
      } } });
    expect(result.status).toBe('stopped');
  });
});

describe('closed engineering catalog boundary', () => {
  it.each([null, {}, [], { schemaVersion: 1, enrollments: [] }, { schemaVersion: 2, enrollments: [] },
    { schemaVersion: 1, enrollments: [], activate: true }])('rejects invalid catalogs without graph writes %#', (value) => {
    expect(() => validateResourceConsoleEngineeringCatalog(value)).toThrow();
    expect(readdirSync(root)).toEqual([]);
  });
  it('does not invoke catalog accessors or accept executable object shapes', () => {
    let called = false;
    expect(() => validateResourceConsoleEngineeringCatalog({ schemaVersion: 1,
      get enrollments() { called = true; return []; } })).toThrow();
    expect(called).toBe(false); expect(readdirSync(root)).toEqual([]);
  });
});

// This fixture mocks campaign projections and uses an UNBRANDED inert adapter,
// deliberately leaving the deliver node pending. Supervisor/graph/ownership
// records are real. Real generation/evaluation/delivery has separate HTTP tests.
async function ownerFixture() {
  loadOrCreateKey();
  const project = join(root, 'project'); const graphRoot = join(root, 'graph');
  const universeRoot = join(root, 'universe'); const transport = join(root, 'transport');
  for (const path of [project, graphRoot, universeRoot, transport]) mkdirSync(path, { mode: 0o700 });
  const pool = validateResourcePool({ schemaVersion: 1, id: 'fixture', workers: [{ id: 'worker', provider: 'local', model: 'fixture',
    maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 4, taskWindowMs: 60_000, priority: 1 }] });
  const bindings = validateResourceBindings([{ workerId: 'worker', capacityKey: 'account', kind: 'local-chat', endpoint: 'http://127.0.0.1:1/v1' }], pool);
  const control = { root: join(root, 'accounting'), poolFile: join(root, 'pool.json'),
    bindingsFile: join(root, 'bindings.json'), observationsFile: join(root, 'observations.json') };
  const save = (path: string, value: unknown) => writeFileSync(path, canonical(value) + '\n', { mode: 0o600 });
  save(control.poolFile, pool); save(control.bindingsFile, bindings); save(control.observationsFile, []);
  const runtime = { schemaVersion: 1, root: control.root, poolPath: control.poolFile, bindingsPath: control.bindingsFile,
    observationsPath: control.observationsFile, workspace: transport };
  const runtimeFile = join(root, 'runtime.json'); save(runtimeFile, runtime);
  const campaignBudget = { maxGenerations: 3, maxDurationMs: 60_000, maxModelRequests: 3, maxStagnantGenerations: 2, maxReportedTokens: null };
  projections.readiness.mockReturnValue({ sourceState: 'healthy', automaticAction: 'run', observedState: 'ready', disposition: 'startable' });
  projections.campaign.mockReturnValue({ definition: { budget: campaignBudget } });
  projections.universe.mockReturnValue({ manifest: { seed: { repo: project }, objective: 'Fixed fixture objective',
    budget: { maxTrials: 1, maxDurationMs: 1000, trialTimeoutMs: 500, maxParallel: 1 } } });
  const run = vi.fn(emit);
  projections.factory.mockReturnValue({ nodeInput: { bindingDigest: 'b'.repeat(64), requestDigest: 'c'.repeat(64) },
    handler: { effectClass: 'resource-completion', constitutionVersion: 'fixture', policyEpoch: 0, bindingDigest: 'b'.repeat(64), run } });
  const catalog: ResourceConsoleEngineeringCatalog = { schemaVersion: 1, enrollments: [{ id: 'engineering', projectId: 'default',
    graphId: 'fixture', graphRoot, host: { root: universeRoot, nodeId: 'deliver', constitutionVersion: 'fixture', policyEpoch: 0,
      definition: { schemaVersion: 1, id: 'controller', tasks: [{ campaignId: 'campaign', dependsOn: [] }], maxParallel: 1, maxDurationMs: 60_000 },
      deliveryPlan: { schemaVersion: 1, deliveries: [{ campaignId: 'campaign', branch: 'codex/fixture', baseCommit: 'a'.repeat(40) }] },
      resourceRuntime: runtimeFile, expectedRuntimeDigest: digest(canonical(runtime)) } }] };
  const supervisor = await createResourcePoolSupervisor({ root: control.root, pool, bindings, workspace: project,
    projects: [], readObservations: () => [], pollIntervalMs: 60_000 });
  const options = { catalog, supervisor, ...control };
  return { options, supervisor, graphRoot, run, pool, bindings, project, create: () => createResourceConsoleEngineeringOwner(options) };
}
// The inert unbranded fixture cannot execute delivery. This signed intent models
// an already accepted unresolved graph for console policy reads, not effect proof.
function recordUnresolvedConsoleFixture(graphRoot: string): void {
  const directory = join(graphRoot, 'control-graph', 'records');
  const created = JSON.parse(readFileSync(join(directory, '00000000.json'), 'utf8'));
  const execution = { effectClass: 'resource-completion', constitutionVersion: 'fixture', policyEpoch: 0, bindingDigest: 'b'.repeat(64) };
  const body = { sequence: 1, previousDigest: digest(canonical(created)), kind: 'intent', nodeId: 'deliver',
    definitionDigest: created.definitionDigest, data: { inputDigests: [], execution } };
  const trace = signDecisionTraceV1({ id: 'fixture:1', ts: new Date().toISOString(), entities: ['graph:fixture', 'node:deliver'],
    action: 'graph-intent', constitutionVersion: 'fixture', policyEpoch: 0, inputsDigest: digest(canonical(body)),
    verifier: { id: 'pending', verdict: 'unavailable', independent: false },
    authority: { effectClass: 'resource-completion' }, spend: { unknown: true }, conflicts: [] });
  expect(trace).not.toBeNull();
  writeFileSync(join(directory, '00000001.json'), canonical({ ...body, trace }) + '\n', { mode: 0o600, flag: 'wx' });
}
describe('owned console engineering evidence', () => {
  it.each([false, true])('projects continuation policy %s and observes its owned unresolved action without dispatch', async enabled => {
    const f = await ownerFixture();
    if (enabled) f.options.catalog.enrollments[0]!.host.allowPendingContinuation = true;
    const transport = vi.spyOn(workerTransport, 'executeResourceWorker');
    const owner = f.create();
    try {
      const selected = owner.catalog()[0]!;
      if (enabled) expect(selected.allowPendingContinuation).toBe(true);
      else expect(selected).not.toHaveProperty('allowPendingContinuation');
      expect(owner.readiness(selected.id)).toMatchObject({ status: 'ready', action: 'launch', effectsExecuted: false, providerContacted: false });
      owner.launch({ enrollmentId: selected.id, expectedEnrollmentDigest: selected.enrollmentDigest });
      const deadline = Date.now() + 5_000;
      while (owner.snapshot(selected.id).state === 'running' && Date.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve));
      expect(owner.snapshot(selected.id).nodes[0]?.state).toBe('pending'); recordUnresolvedConsoleFixture(f.graphRoot);
      expect(owner.snapshot(selected.id)).toMatchObject({ state: 'incomplete', launched: true, nodes: [{ state: 'unresolved' }] });
      const saved = canonical(readControlGraph(f.graphRoot)); const files = readdirSync(f.graphRoot);
      for (let read = 0; read < 3; read++) expect(owner.readiness(selected.id)).toMatchObject({
        status: 'ready', action: enabled ? 'continue' : 'reconcile', effectsExecuted: false, providerContacted: false, reasons: [],
      });
      expect(canonical(readControlGraph(f.graphRoot))).toBe(saved); expect(readdirSync(f.graphRoot)).toEqual(files);
      expect(f.run).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
    } finally { await owner.close(); await f.supervisor.close(); }
  });

  it('cannot upgrade an accepted legacy binding to continuation by changing the startup catalog', async () => {
    const f = await ownerFixture();
    const owner = f.create(); let upgraded: ReturnType<typeof f.create> | undefined;
    try {
      const original = owner.catalog()[0]!;
      owner.launch({ enrollmentId: original.id, expectedEnrollmentDigest: original.enrollmentDigest });
      const deadline = Date.now() + 5_000;
      while (owner.snapshot(original.id).state === 'running' && Date.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve));
      expect(owner.snapshot(original.id).nodes[0]?.state).toBe('pending'); recordUnresolvedConsoleFixture(f.graphRoot);
      expect(owner.snapshot(original.id).nodes[0]?.state).toBe('unresolved');
      await owner.close(); const saved = canonical(readControlGraph(f.graphRoot));
      f.options.catalog.enrollments[0]!.host.allowPendingContinuation = true;
      upgraded = f.create(); const next = upgraded.catalog()[0]!;
      expect(next.allowPendingContinuation).toBe(true); expect(next.enrollmentDigest).not.toBe(original.enrollmentDigest);
      expect(upgraded.readiness(next.id)).toMatchObject({ status: 'blocked', action: 'none', reasons: ['graph-evidence-unavailable'] });
      expect(() => upgraded!.launch({ enrollmentId: next.id, expectedEnrollmentDigest: original.enrollmentDigest })).toThrow('enrollment changed');
      expect(() => upgraded!.launch({ enrollmentId: next.id, expectedEnrollmentDigest: next.enrollmentDigest })).toThrow('graph-evidence-unavailable');
      expect(canonical(readControlGraph(f.graphRoot))).toBe(saved); expect(f.run).not.toHaveBeenCalled();
    } finally { await upgraded?.close(); await owner.close(); await f.supervisor.close(); }
  });

  it('shares the exact prepared enrollment identity with startup without publishing graph records', async () => {
    const f = await ownerFixture(); const owner = f.create();
    try {
      const projects = f.supervisor.projects()!;
      const prepared = prepareResourceConsoleEngineeringEnrollments({ ...f.options, projects,
        projectBindings: projects.map((project) => f.supervisor.engineeringBinding(project.id).project) });
      expect(prepared.map((entry) => entry.summary)).toEqual(owner.catalog());
      expect(prepared[0]!.definition.hostEnrollmentDigest).toBe(owner.catalog()[0]!.enrollmentDigest);
      expect(readdirSync(f.graphRoot)).toEqual([]); expect(f.run).not.toHaveBeenCalled();
    } finally { await owner.close(); await f.supervisor.close(); }
  });
  it('keeps startup/catalog/status read-only and exposes separate experiment/campaign budgets', async () => {
    const f = await ownerFixture(); const owner = f.create();
    try {
      expect(owner.snapshot('engineering')).toMatchObject({ state: 'ready', launched: false, cancellable: false });
      expect(owner.catalog()[0]!.campaigns[0]).toMatchObject({ budget: { maxTrials: 1 }, campaignBudget: { maxModelRequests: 3 } });
      expect(JSON.stringify(owner.catalog())).not.toContain(root);
      expect(readdirSync(f.graphRoot)).toEqual([]); expect(f.run).not.toHaveBeenCalled();
    } finally { await owner.close(); await f.supervisor.close(); }
  });
  it('persists cancel-before-intent and refuses identical launch after owner restart', async () => {
    const f = await ownerFixture(); const owner = f.create();
    const request = { enrollmentId: 'engineering', expectedEnrollmentDigest: owner.catalog()[0]!.enrollmentDigest };
    try {
      expect(owner.launch(request).state).toBe('running');
      expect(owner.cancel('engineering').cancelled).toBe(true);
      await owner.close();
      const restarted = f.create();
      try {
        expect(restarted.snapshot('engineering')).toMatchObject({ state: 'stopped', cancelled: true, launched: true });
        expect(() => restarted.launch(request)).toThrow('cancelled');
        expect(readControlGraph(f.graphRoot).sourceState).toBe('missing'); expect(f.run).not.toHaveBeenCalled();
      } finally { await restarted.close(); }
    } finally { await owner.close(); await f.supervisor.close(); }
  });
  it('holds accepted pending/no-intent graphs after restart instead of dispatching them', async () => {
    const f = await ownerFixture(); const owner = f.create();
    const request = { enrollmentId: 'engineering', expectedEnrollmentDigest: owner.catalog()[0]!.enrollmentDigest };
    try {
      owner.launch(request);
      // Two microtask turns let the real graph reach its guarded, pending node.
      await Promise.resolve(); await Promise.resolve();
      await owner.close();
      expect(readControlGraph(f.graphRoot).nodes).toMatchObject([{ state: 'pending' }]);
      const restarted = f.create();
      try {
        expect(restarted.snapshot('engineering').reasons).toEqual(['engineering-launch-unresolved']);
        expect(() => restarted.launch(request)).toThrow('unresolved'); expect(f.run).not.toHaveBeenCalled();
      } finally { await restarted.close(); }
    } finally { await owner.close(); await f.supervisor.close(); }
  });
  it.each(['reserved', 'uncertain', 'completed', 'cancelled'] as const)('checks real shared-ledger %s receipts after graph work without claiming attribution', async (status) => {
    const f = await ownerFixture(); const owner = f.create();
    let release!: (value: workerTransport.ResourceWorkerResult) => void;
    const result: workerTransport.ResourceWorkerResult = { status: status === 'reserved' ? 'cancelled' : status,
      output: status === 'completed' ? 'fixture completed' : '', inputTokens: null, outputTokens: null,
      reason: status === 'uncertain' ? 'worker-termination-uncertain' : 'fixture-settled' };
    vi.spyOn(workerTransport, 'executeResourceWorker').mockImplementation(() => status === 'reserved'
      ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(result));
    // This task is deliberately not attributed to the graph. The production
    // runtime writes/validates its receipt; only its worker result is synthetic.
    const task = runResourceTask({ root: f.options.root, pool: f.pool, bindings: f.bindings,
      observations: [{ workerId: 'worker', health: 'ready', windows: [], retryAfter: null,
        observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }],
      task: { schemaVersion: 1, id: 'shared-fixture', allowedWorkerIds: ['worker'], prompt: 'inert fixture',
        cwd: f.project, timeoutMs: 1000, maxOutputTokens: 16, mode: 'read-only' } });
    try {
      if (status !== 'reserved') expect((await task).receipt?.status).toBe(status);
      expect(resourcePoolStatus(f.options.root, f.pool, f.bindings, []).attempts[0]!.status).toBe(status);
      owner.launch({ enrollmentId: 'engineering', expectedEnrollmentDigest: owner.catalog()[0]!.enrollmentDigest });
      await Promise.resolve(); await Promise.resolve();
      if (status === 'reserved' || status === 'uncertain') {
        await expect(owner.close()).rejects.toThrow('Shared resource pool termination evidence unavailable');
      } else await expect(owner.close()).resolves.toBeUndefined();
    } finally {
      release?.(result); await task;
      await owner.close().catch(() => {}); await f.supervisor.close();
    }
  });
  it('does not apply the shared-pool shutdown fence to a catalog-only owner', async () => {
    const f = await ownerFixture(); const owner = f.create();
    // Unknown unrelated storage cannot become this never-launched owner's
    // asserted termination failure. Startup and observation remain read-only.
    writeFileSync(join(f.options.root, 'pool-state.json'), 'invalid fixture state', { mode: 0o600 });
    try { await expect(owner.close()).resolves.toBeUndefined(); }
    finally { await f.supervisor.close(); }
  });
  it('withholds clean shutdown when shared termination evidence becomes unreadable after graph work', async () => {
    const f = await ownerFixture(); const owner = f.create();
    try {
      owner.launch({ enrollmentId: 'engineering', expectedEnrollmentDigest: owner.catalog()[0]!.enrollmentDigest });
      await Promise.resolve(); await Promise.resolve();
      writeFileSync(join(f.options.root, 'pool-state.json'), 'invalid fixture state', { mode: 0o600 });
      await expect(owner.close()).rejects.toThrow('Shared resource pool termination evidence unavailable');
    } finally { await owner.close().catch(() => {}); await f.supervisor.close(); }
  });
  it('awaits the captured peer drain once before fencing a real reserved receipt', async () => {
    const f = await ownerFixture();
    let release!: (value: workerTransport.ResourceWorkerResult) => void;
    const result: workerTransport.ResourceWorkerResult = { status: 'cancelled', output: '', inputTokens: null,
      outputTokens: null, reason: 'fixture-cancelled' };
    vi.spyOn(workerTransport, 'executeResourceWorker').mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const task = runResourceTask({ root: f.options.root, pool: f.pool, bindings: f.bindings,
      observations: [{ workerId: 'worker', health: 'ready', windows: [], retryAfter: null,
        observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }],
      task: { schemaVersion: 1, id: 'peer-drain', allowedWorkerIds: ['worker'], prompt: 'inert fixture',
        cwd: f.project, timeoutMs: 1000, maxOutputTokens: 16, mode: 'read-only' } });
    const waitForResourceDrain = vi.fn(async () => { await task; });
    const options = { ...f.options, waitForResourceDrain };
    const owner = createResourceConsoleEngineeringOwner(options);
    options.waitForResourceDrain = vi.fn(async () => { throw new Error('mutated callback must never execute'); });
    try {
      owner.launch({ enrollmentId: 'engineering', expectedEnrollmentDigest: owner.catalog()[0]!.enrollmentDigest });
      await Promise.resolve(); await Promise.resolve();
      expect(resourcePoolStatus(f.options.root, f.pool, f.bindings, []).attempts[0]!.status).toBe('reserved');
      let closed = false;
      const closing = owner.close(); expect(owner.close()).toBe(closing);
      void closing.then(() => { closed = true; });
      await vi.waitFor(() => expect(waitForResourceDrain).toHaveBeenCalledTimes(1), { timeout: 1000, interval: 10 });
      expect(closed).toBe(false);
      release(result); await expect(closing).resolves.toBeUndefined();
      expect(resourcePoolStatus(f.options.root, f.pool, f.bindings, []).attempts[0]!.status).toBe('cancelled');
      expect(options.waitForResourceDrain).not.toHaveBeenCalled();
    } finally { release(result); await task; await owner.close(); await f.supervisor.close(); }
  });
  it('keeps a rejected peer drain unclean with bounded diagnostics', async () => {
    const f = await ownerFixture(); const hook = vi.fn(async () => { throw new Error('private peer diagnostic'); });
    const owner = createResourceConsoleEngineeringOwner({ ...f.options, waitForResourceDrain: hook });
    try {
      await expect(owner.close()).rejects.toThrow('Resource peer drain did not confirm termination');
      await expect(owner.close()).rejects.not.toThrow('private peer diagnostic');
      expect(hook).toHaveBeenCalledTimes(1);
    } finally { await f.supervisor.close(); }
  });
  it('rejects nonfunction and getter peer hooks without invoking accessors or inspecting graph enrollment', async () => {
    const f = await ownerFixture(); let called = false;
    try {
      const invalid = { ...f.options, waitForResourceDrain: 'not-a-function' };
      expect(() => createResourceConsoleEngineeringOwner(invalid as unknown as Parameters<typeof createResourceConsoleEngineeringOwner>[0])).toThrow('shutdown coordinator');
      const accessor = { ...f.options, get waitForResourceDrain() { called = true; return async () => {}; } };
      expect(() => createResourceConsoleEngineeringOwner(accessor)).toThrow('shutdown coordinator');
      expect(called).toBe(false); expect(projections.factory).not.toHaveBeenCalled();
      expect(readdirSync(f.graphRoot)).toEqual([]);
    } finally { await f.supervisor.close(); }
  });
});

describe('nonexecuting engineering admission readiness', () => {
  it('holds fresh graph ownership without probing, acquiring or deleting the existing execution lock', async () => {
    const f = await ownerFixture(); const owner = f.create();
    const lockPath = join(f.graphRoot, '.control-execution.lock');
    const acquired = acquireLocalStoreLockWithOutcome(lockPath, 0, { anchorPath: f.graphRoot, exactPrivateStorage: true });
    if (acquired.state !== 'acquired') throw new Error('Fixture lock unavailable');
    const before = readFileSync(lockPath);
    try {
      expect(owner.readiness('engineering').reasons).toContain('graph-ownership-unavailable');
      expect(() => owner.launch({ enrollmentId: 'engineering', expectedEnrollmentDigest: owner.catalog()[0]!.enrollmentDigest })).toThrow('graph-ownership-unavailable');
      expect(readFileSync(lockPath)).toEqual(before); expect(readdirSync(f.graphRoot)).toEqual(['.control-execution.lock']);
      expect(releaseLocalStoreLock(acquired.lock)).toBe(true);
      expect(owner.readiness('engineering')).toMatchObject({ status: 'ready', action: 'launch' });
    } finally { releaseLocalStoreLock(acquired.lock); await owner.close(); await f.supervisor.close(); }
  });
  it('blocks a preexisting graph stop without consuming the fixed launch, then admits the same digest', async () => {
    const f = await ownerFixture(); const owner = f.create(); const stop = join(f.graphRoot, 'KILL');
    const input = { enrollmentId: 'engineering', expectedEnrollmentDigest: owner.catalog()[0]!.enrollmentDigest };
    try {
      writeFileSync(stop, 'fixture stop\n', { mode: 0o600 });
      const before = readdirSync(f.graphRoot);
      expect(owner.readiness('engineering')).toMatchObject({ status: 'blocked', action: 'none', reasons: ['graph-kill-active'],
        scope: 'local-admission-check-only', providerContacted: false, effectsExecuted: false });
      expect(() => owner.launch(input)).toThrow('graph-kill-active'); expect(readdirSync(f.graphRoot)).toEqual(before);
      expect(owner.snapshot('engineering').launched).toBe(false);
      unlinkSync(stop); expect(owner.readiness('engineering')).toMatchObject({ status: 'ready', action: 'launch', reasons: [] });
      expect(owner.launch(input).state).toBe('running'); owner.cancel('engineering');
      expect(f.run).not.toHaveBeenCalled();
    } finally { await owner.close(); await f.supervisor.close(); }
  });
  it.each(['active', 'unknown'] as const)('fails closed on a %s global stop observation without writes', async (state) => {
    const f = await ownerFixture(); const owner = f.create();
    vi.spyOn(policy, 'readKillSwitch').mockReturnValue(state === 'active'
      ? { state, sourceState: 'healthy', reason: 'present', path: '/fixture-private-stop' }
      : { state, sourceState: 'degraded', reason: 'uninspectable', path: '/fixture-private-stop', errorCode: 'EACCES' });
    try {
      const readiness = owner.readiness('engineering');
      expect(readiness.reasons).toContain(state === 'active' ? 'global-kill-active' : 'global-kill-unavailable');
      expect(JSON.stringify(readiness)).not.toContain('/fixture-private-stop');
      expect(() => owner.launch({ enrollmentId: 'engineering', expectedEnrollmentDigest: owner.catalog()[0]!.enrollmentDigest })).toThrow('global-kill');
      expect(readdirSync(f.graphRoot)).toEqual([]);
    } finally { await owner.close(); await f.supervisor.close(); }
  });
  it('blocks missing provenance without creating or repairing a key', async () => {
    const f = await ownerFixture(); const owner = f.create();
    vi.spyOn(provenance, 'loadExistingProvenanceKeyReadOnly').mockReturnValue(null);
    try {
      expect(owner.readiness('engineering').reasons).toContain('provenance-unavailable');
      expect(() => owner.launch({ enrollmentId: 'engineering', expectedEnrollmentDigest: owner.catalog()[0]!.enrollmentDigest })).toThrow('provenance-unavailable');
      expect(readdirSync(f.graphRoot)).toEqual([]);
    } finally { await owner.close(); await f.supervisor.close(); }
  });
  it('detects runtime and captured factory pin drift before launch and permits restored input', async () => {
    const f = await ownerFixture(); const owner = f.create(); const file = f.options.catalog.enrollments[0]!.host.resourceRuntime;
    const saved = readFileSync(file); const originalBinding = projections.factory.mock.results[0]!.value;
    try {
      writeFileSync(file, '{}\n'); expect(owner.readiness('engineering').reasons).toContain('runtime-pin-changed');
      expect(() => owner.launch({ enrollmentId: 'engineering', expectedEnrollmentDigest: owner.catalog()[0]!.enrollmentDigest })).toThrow('runtime-pin-changed');
      writeFileSync(file, saved);
      projections.factory.mockReturnValue({ ...originalBinding, nodeInput: { ...originalBinding.nodeInput, bindingDigest: 'd'.repeat(64) } });
      expect(owner.readiness('engineering').reasons).toContain('enrollment-pin-changed');
      expect(readdirSync(f.graphRoot)).toEqual([]);
      projections.factory.mockReturnValue(originalBinding);
      expect(owner.readiness('engineering')).toMatchObject({ status: 'ready', action: 'launch' });
    } finally { await owner.close(); await f.supervisor.close(); }
  });
  it('reports queue pause and recorded campaign hard holds without gating transient ready ownership', async () => {
    const f = await ownerFixture(); const owner = f.create();
    try {
      f.supervisor.setPaused(true); expect(owner.readiness('engineering').reasons).toContain('queue-paused');
      f.supervisor.setPaused(false);
      projections.readiness.mockReturnValue({ sourceState: 'healthy', automaticAction: 'none', observedState: 'paused', disposition: 'owner-held' });
      expect(owner.readiness('engineering').reasons).toContain('campaign-not-startable');
      projections.readiness.mockReturnValue({ sourceState: 'healthy', automaticAction: 'none', observedState: 'ready', disposition: 'owned' });
      expect(owner.readiness('engineering').status).toBe('ready'); expect(readdirSync(f.graphRoot)).toEqual([]);
    } finally { await owner.close(); await f.supervisor.close(); }
  });
  it('rechecks known stops under ownership before publishing the launch binding', async () => {
    const f = await ownerFixture(); const owner = f.create(); let reads = 0;
    const read = policy.readKillSwitch;
    vi.spyOn(policy, 'readKillSwitch').mockImplementation(() => ++reads === 1 ? read()
      : { state: 'active', sourceState: 'healthy', reason: 'present', path: '/fixture-private-stop' });
    try {
      expect(() => owner.launch({ enrollmentId: 'engineering', expectedEnrollmentDigest: owner.catalog()[0]!.enrollmentDigest })).toThrow('global-kill-active');
      expect(owner.snapshot('engineering').launched).toBe(false); expect(readdirSync(f.graphRoot)).toEqual([]);
    } finally { await owner.close(); await f.supervisor.close(); }
  });
});
