/** Real signed graph storage; all handlers are inert fixture callbacks. */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const projections = vi.hoisted(() => ({ factory: vi.fn(), campaign: vi.fn(), universe: vi.fn() }));
vi.mock('../src/core/universe/firm-engineering-control-handler.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/firm-engineering-control-handler.js')>(), createFirmEngineeringControlHandler: projections.factory,
}));
vi.mock('../src/core/universe/campaign-store.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/campaign-store.js')>(),
  readUniverseCampaign: projections.campaign, campaignUniverse: projections.universe,
}));
import { createResourceConsoleEngineeringOwner, validateResourceConsoleEngineeringCatalog,
  type ResourceConsoleEngineeringCatalog } from '../src/core/resources/console-engineering.js';
import { createResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import * as workerTransport from '../src/core/resources/worker.js';
import { runResourceTask, resourcePoolStatus } from '../src/core/resources/pool-runtime.js';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
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
describe('owned console engineering evidence', () => {
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
