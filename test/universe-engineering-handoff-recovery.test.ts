/** Real confined measurement and local Git publication; only the subsequent read is faulted. */
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { resourcePoolStatus } from '../src/core/resources/pool-runtime.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, readUniverseOverview, type UniverseManifest } from '../src/core/universe/index.js';
import { readUniversePortfolioController } from '../src/core/universe/portfolio-controller.js';
import { portfolioControllerDirectory, readPortfolioControllerEvents } from '../src/core/universe/portfolio-controller-store.js';
import type { UniversePortfolioDefinition } from '../src/core/universe/portfolio-types.js';
import * as delivery from '../src/core/universe/delivery.js';
import * as deliveryGit from '../src/core/universe/delivery-git.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { runControlGraph, type ControlGraphDefinition, type ControlHandlerContext } from '../src/core/universe/control-graph.js';
import { createFirmEngineeringControlHandler, firmEngineeringControlRecovery } from '../src/core/universe/firm-engineering-control-handler.js';
import { requestUniversePortfolioControllerControl } from '../src/core/universe/portfolio-controller-store.js';
import * as evaluator from '../src/core/universe/fixed-evaluator.js';
import * as controllerStore from '../src/core/universe/portfolio-controller-store.js';
import * as reconciliation from '../src/core/universe/graph-controller-reconciliation.js';
import * as locks from '../src/core/fleet/local-store-lock.js';
import * as controllers from '../src/core/universe/portfolio-controller.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const save = (path: string, value: unknown) => writeFileSync(path, canonical(value) + '\n', { mode: 0o600 });

async function fixture() {
  expect(homedir()).not.toBe(process.env.ASHLR_VITEST_REAL_HOME);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'controller-handoff-acceptance-')));
  const root = join(base, 'universe'); const repo = join(base, 'repo'); const workspace = join(base, 'transport');
  for (const path of [repo, workspace]) mkdirSync(path, { mode: 0o700 });
  let stopWorker = async () => {};
  cleanups.push(async () => {
    await stopWorker();
    const writable = (path: string): void => {
      const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name));
    };
    writable(base); rmSync(base, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgsign=false', '-C', cwd, ...args], { encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' } }).trim();
  for (const path of [repo, workspace]) git(path, 'init', '-q', '--template=', '--initial-branch=main');
  writeFileSync(join(repo, 'value.json'), '0\n');
  writeFileSync(join(repo, 'evaluate.mjs'), "import {readFileSync} from 'node:fs';import {join} from 'node:path';" +
    "const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));" +
    "console.log(JSON.stringify({passed:value===1,score:value,metrics:{value},diagnostics:value===0?" +
    "[{code:'INCREASE_VALUE',message:'Increase the declared value.',path:'value.json'}]:[]}));\n");
  git(repo, 'add', '.'); git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixed seed');
  const revision = git(repo, 'rev-parse', 'HEAD'); const campaignId = 'handoff-campaign';
  const requests: unknown[] = []; const failures: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const messages = JSON.parse(body.messages[0].content) as Array<{ role: string; content: string }>;
        const input = JSON.parse(messages.find(row => row.role === 'user')!.content); requests.push(input);
        expect(input.seedContext).toMatchObject({ measurement: { passed: false, score: 0, metrics: { value: 0 },
          diagnostics: [{ code: 'INCREASE_VALUE', message: 'Increase the declared value.', path: 'value.json' }] } });
        expect(input.files).toMatchObject([{ path: 'value.json', content: '0\n' }]);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({
          operations: [{ op: 'replace', path: 'value.json', content: `${input.seedContext.measurement.metrics.value + 1}\n` }] }) },
        finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
      } catch (error) { failures.push(String(error)); res.writeHead(500); res.end('Fixture protocol failure'); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  stopWorker = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
  const pool = validateResourcePool({ schemaVersion: 1, id: 'handoff-pool', workers: [{ id: 'local', provider: 'local', model: 'fixture',
    maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 1, taskWindowMs: 60_000, priority: 1 }] });
  const bindings = validateResourceBindings([{ workerId: 'local', capacityKey: 'shared-fixture-account', kind: 'local-chat',
    endpoint: `http://127.0.0.1:${address.port}/v1` }], pool);
  const observations = [{ workerId: 'local', health: 'ready' as const, windows: [], retryAfter: null,
    observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }];
  const runtime = { schemaVersion: 1, root: join(base, 'ledger'), workspace, poolPath: join(base, 'pool.json'),
    bindingsPath: join(base, 'bindings.json'), observationsPath: join(base, 'observations.json') };
  save(runtime.poolPath, pool); save(runtime.bindingsPath, bindings); save(runtime.observationsPath, observations);
  const runtimeFile = join(base, 'runtime.json'); save(runtimeFile, runtime);
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'handoff-universe', name: 'Measured handoff', objective: 'Pass the fixed evaluator',
    seed: { repo, revision }, metric: { name: 'quality', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 10_000, trialTimeoutMs: 5000 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 2000 }, variants: [{ id: 'repair', niche: 'quality', hypothesis: 'Repair value',
      generation: { kind: 'resource-pool', poolId: pool.id, poolDigest: digest(canonical({ pool, bindings })), allowedWorkerIds: ['local'],
        files: ['value.json'], maxOutputTokens: 256, fileOperations: { schemaVersion: 1, contextFiles: [] } } }] };
  initUniverse(manifest, { root });
  initUniverseCampaign({ schemaVersion: 1, id: campaignId, universeId: manifest.id, feedback: true, measureSeed: true,
    budget: { maxGenerations: 1, maxDurationMs: 30_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: 15 } }, { root });
  const definition: UniversePortfolioDefinition = { schemaVersion: 1, id: 'handoff-controller', maxParallel: 1,
    maxDurationMs: 30_000, tasks: [{ campaignId, dependsOn: [] }] };
  const options = { root, resourceRuntime: runtimeFile, expectedResourceRuntimeDigest: digest(canonical(runtime)),
    deliveryPlan: { schemaVersion: 1 as const, deliveries: [{ campaignId, branch: 'codex/handoff-proof', baseCommit: revision, allowInitialRepair: true as const }] } };
  return { root, repo, workspace, git, revision, campaignId, requests, failures, runtime, pool, bindings, observations, manifest, definition, options };
}

describe.runIf(process.platform === 'darwin')('graph-owned engineering handoff recovery', () => {
  it('keeps projected pending descendants unresolved without admitting their campaign', async () => {
    const f = await fixture(); const child = 'pending-child';
    const childUniverse = 'pending-universe'; initUniverse({ ...f.manifest, id: childUniverse }, f.options);
    initUniverseCampaign({ schemaVersion: 1, id: child, universeId: childUniverse, feedback: true, measureSeed: true,
      budget: { maxGenerations: 1, maxDurationMs: 30_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: 15 } }, f.options);
    const controllerDefinition = { ...f.definition, tasks: [...f.definition.tasks, { campaignId: child, dependsOn: [f.campaignId] }] };
    const deliveryPlan = { ...f.options.deliveryPlan, deliveries: [...f.options.deliveryPlan.deliveries,
      { campaignId: child, branch: 'codex/pending-child', baseCommit: f.revision, allowInitialRepair: true as const }] };
    const graphRoot = join(f.root, '..', 'graph'); mkdirSync(graphRoot, { mode: 0o700 });
    const binding = createFirmEngineeringControlHandler({ nodeId: 'deliver', root: f.root, constitutionVersion: 'fixture-v1', policyEpoch: 1,
      definition: controllerDefinition, deliveryPlan, resourceRuntime: f.options.resourceRuntime,
      expectedRuntimeDigest: f.options.expectedResourceRuntimeDigest });
    const definition: ControlGraphDefinition = { schemaVersion: 1, id: 'pending-graph', maxConcurrent: 1, maxDurationMs: 90_000,
      nodes: [{ id: 'deliver', kind: 'deliver', requires: [], input: binding.nodeInput }] };
    const options = { root: graphRoot, traceKeys: { testKey: Buffer.alloc(32, 87) }, handlers: { deliver: binding.handler } };
    const actualRead = delivery.readUniverseDeliveries; let injected = false;
    const confirmation = vi.spyOn(delivery, 'readUniverseDeliveries').mockImplementation((...args) => {
      const report = actualRead(...args);
      if (!injected && report.sourceState === 'healthy' && report.deliveries.some(row => row.status === 'delivered')) {
        injected = true; return { ...report, sourceState: 'degraded', reasons: ['fixture confirmation unavailable'] };
      }
      return report;
    });
    const first = await runControlGraph(definition, options); confirmation.mockRestore();
    expect(injected).toBe(true); expect(first.nodes[0]!.state).toBe('unresolved');
    const report = readUniversePortfolioController(f.definition.id, f.options);
    expect(report.outcomes).toMatchObject([{ state: 'in-flight' }, { state: 'pending', reasonCode: 'waiting-for-dependencies' }]);
    const directory = portfolioControllerDirectory(f.definition.id, f.options);
    const events = readPortfolioControllerEvents(directory);
    expect((await runControlGraph(definition, options)).nodes[0]!.state).toBe('unresolved');
    expect(readPortfolioControllerEvents(directory)).toEqual(events);
    expect(readUniverseCampaign(child, f.options).progress.attempts).toBe(0);
    expect(f.requests).toHaveLength(1); expect(f.failures).toEqual([]);
    expect(resourcePoolStatus(f.runtime.root, f.pool, f.bindings, f.observations).attempts).toHaveLength(1);
  }, 45_000);

  it.each(['committed-lock-cleanup', 'transient-return'] as const)('preserves completed settlement after %s without duplicating effects', async mode => {
    const f = await fixture(); const index = readFileSync(join(f.repo, '.git', 'index'));
    const graphRoot = join(f.root, '..', 'graph'); mkdirSync(graphRoot, { mode: 0o700 });
    const binding = createFirmEngineeringControlHandler({ nodeId: 'deliver', root: f.root, constitutionVersion: 'fixture-v1',
      policyEpoch: 1, definition: f.definition, deliveryPlan: f.options.deliveryPlan, resourceRuntime: f.options.resourceRuntime,
      expectedRuntimeDigest: f.options.expectedResourceRuntimeDigest });
    const definition: ControlGraphDefinition = { schemaVersion: 1, id: 'handoff-graph', maxConcurrent: 1, maxDurationMs: 90_000,
      nodes: [{ id: 'deliver', kind: 'deliver', requires: [], input: binding.nodeInput }] };
    const graphOptions = { root: graphRoot, traceKeys: { testKey: Buffer.alloc(32, 87) }, handlers: { deliver: binding.handler } };
    const evaluations = vi.spyOn(evaluator, 'runFixedUniverseEvaluator');
    const actualGit = deliveryGit.deliveryGit; let publications = 0;
    vi.spyOn(deliveryGit, 'deliveryGit').mockImplementation((...args) => {
      const api = actualGit(...args);
      return { ...api, createRef: async (...createArgs) => { publications++; await api.createRef(...createArgs); } };
    });
    const directory = portfolioControllerDirectory(f.definition.id, f.options);
    let injected = false;
    const actualRelease = locks.releaseLocalStoreLock;
    const release = vi.spyOn(locks, 'releaseLocalStoreLock').mockImplementation(lock => {
      const released = actualRelease(lock);
      // The actual mutex has been released and the immutable settlement exists.
      // Only its cleanup acknowledgment is faulted; no receipt is fabricated.
      if (mode === 'committed-lock-cleanup' && !injected && publications > 0 && lock?.path === join(directory, '.control.lock') && released &&
          readPortfolioControllerEvents(directory).some(event => event.kind === 'settled' && event.outcome.state === 'completed')) {
        injected = true; return false;
      }
      return released;
    });
    const actualRun = controllers.runUniversePortfolioController;
    const calls = vi.spyOn(controllers, 'runUniversePortfolioController').mockImplementation(async (...args) => {
      const report = await actualRun(...args);
      if (mode === 'transient-return') {
        expect(report.status).toBe('completed'); injected = true;
        return { ...report, status: 'unavailable', reasons: ['fixture-post-settlement-cleanup'] };
      }
      return report;
    });
    const first = await runControlGraph(definition, graphOptions);
    expect(injected).toBe(true); release.mockRestore();
    expect(first, JSON.stringify(first)).toMatchObject({ sourceState: 'healthy', status: 'incomplete', nodes: [{ state: 'unresolved' }] });
    const completed = readUniversePortfolioController(f.definition.id, f.options);
    expect(completed, JSON.stringify(completed)).toMatchObject({ sourceState: 'healthy', status: 'completed', reasons: [], outcomes: [{ state: 'completed' }] });
    const events = readPortfolioControllerEvents(directory);
    expect(events.filter(event => event.kind === 'settled')).toHaveLength(1);
    expect(events.some(event => event.kind === 'dispatch-diagnostic')).toBe(false);
    const receipts = delivery.readUniverseDeliveries(f.manifest.id, f.options).deliveries;
    expect(receipts).toHaveLength(1); const receipt = receipts[0]!;
    expect(receipt.status).toBe('delivered'); expect(f.git(f.repo, 'rev-parse', receipt.branch)).toBe(receipt.commit);
    const campaign = readUniverseCampaign(f.campaignId, f.options);
    const runs = readUniverseOverview(f.options).universes[0]!.runs;
    const ledger = resourcePoolStatus(f.runtime.root, f.pool, f.bindings, f.observations);
    expect(ledger.attempts).toHaveLength(1);
    const recovered = await runControlGraph(definition, graphOptions);
    expect(recovered, JSON.stringify(recovered)).toMatchObject({ sourceState: 'healthy', status: 'completed', deadlineAt: first.deadlineAt,
      nodes: [{ state: 'completed' }] });
    expect(await runControlGraph(definition, graphOptions)).toEqual(recovered);
    expect(calls).toHaveBeenCalledTimes(1); expect(f.failures).toEqual([]); expect(f.requests).toHaveLength(1);
    expect(evaluations).toHaveBeenCalledTimes(2); expect(publications).toBe(1);
    expect(readPortfolioControllerEvents(directory)).toEqual(events);
    expect(delivery.readUniverseDeliveries(f.manifest.id, f.options).deliveries).toEqual(receipts);
    expect(readUniverseCampaign(f.campaignId, f.options)).toEqual(campaign);
    expect(readUniverseOverview(f.options).universes[0]!.runs).toEqual(runs);
    expect(resourcePoolStatus(f.runtime.root, f.pool, f.bindings, f.observations).attempts).toEqual(ledger.attempts);
    expect(f.git(f.repo, 'rev-parse', receipt.branch)).toBe(receipt.commit);
    expect(readFileSync(join(f.repo, 'value.json'), 'utf8')).toBe('0\n');
    expect(readFileSync(join(f.repo, '.git', 'index'))).toEqual(index); expect(f.git(f.repo, 'rev-parse', 'HEAD')).toBe(f.revision);
    expect(f.git(f.repo, 'status', '--porcelain=v1')).toBe('');
  }, 45_000);

  it('keeps an actual delivered effect unresolved, then reconciles only exact proof with no repeated effects', async () => {
    const f = await fixture(); const index = readFileSync(join(f.repo, '.git', 'index'));
    const graphRoot = join(f.root, '..', 'graph'); mkdirSync(graphRoot, { mode: 0o700 });
    const binding = createFirmEngineeringControlHandler({ nodeId: 'deliver', root: f.root, constitutionVersion: 'fixture-v1',
      policyEpoch: 1, definition: f.definition, deliveryPlan: f.options.deliveryPlan, resourceRuntime: f.options.resourceRuntime,
      expectedRuntimeDigest: f.options.expectedResourceRuntimeDigest });
    const definition: ControlGraphDefinition = { schemaVersion: 1, id: 'handoff-graph', maxConcurrent: 1, maxDurationMs: 90_000,
      nodes: [{ id: 'deliver', kind: 'deliver', requires: [], input: binding.nodeInput }] };
    const graphOptions = { root: graphRoot, traceKeys: { testKey: Buffer.alloc(32, 87) }, handlers: { deliver: binding.handler } };
    const evaluations = vi.spyOn(evaluator, 'runFixedUniverseEvaluator');
    const actualGit = deliveryGit.deliveryGit; let publications = 0;
    vi.spyOn(deliveryGit, 'deliveryGit').mockImplementation((...args) => {
      const api = actualGit(...args);
      return { ...api, createRef: async (...createArgs) => { publications++; await api.createRef(...createArgs); } };
    });
    const actualRead = delivery.readUniverseDeliveries; let injected = false;
    const publicationErrors: string[] = [];
    const append = controllerStore.appendPortfolioControllerEvent;
    vi.spyOn(controllerStore, 'appendPortfolioControllerEvent').mockImplementation((...args) => {
      try { return append(...args); }
      catch (error) { publicationErrors.push(error instanceof Error ? error.message : 'unknown'); throw error; }
    });
    const reconciliationResults: Array<{ elapsedMs: number; status: string | null }> = [];
    const reconcile = reconciliation.reconcileGraphControllerDispatch;
    vi.spyOn(reconciliation, 'reconcileGraphControllerDispatch').mockImplementation(options => {
      const started = performance.now(); const result = reconcile(options);
      reconciliationResults.push({ elapsedMs: performance.now() - started, status: result?.status ?? null }); return result;
    });
    const confirmation = vi.spyOn(delivery, 'readUniverseDeliveries').mockImplementation((...args) => {
      const report = actualRead(...args);
      if (!injected && report.sourceState === 'healthy' && report.deliveries.some(row => row.status === 'delivered')) {
        injected = true; return { ...report, sourceState: 'degraded' as const, reasons: ['fixture confirmation unavailable'] };
      }
      return report;
    });
    const first = await runControlGraph(definition, graphOptions);
    expect(injected).toBe(true); confirmation.mockRestore();
    expect(first, JSON.stringify(first)).toMatchObject({ sourceState: 'healthy', status: 'incomplete',
      nodes: [{ id: 'deliver', state: 'unresolved' }] });
    expect(f.failures).toEqual([]); expect(f.requests).toHaveLength(1);
    expect(evaluations).toHaveBeenCalledTimes(2); expect(publications).toBe(1);
    const directory = portfolioControllerDirectory(f.definition.id, f.options);
    const controller = readUniversePortfolioController(f.definition.id, f.options);
    expect(controller).toMatchObject({ sourceState: 'healthy', status: 'incomplete',
      diagnostics: [{ phase: 'delivery-verification', code: 'delivery-receipt-unverified' }] });
    const originalEvents = readPortfolioControllerEvents(directory);
    const created = originalEvents.find(event => event.kind === 'created');
    if (!created || created.kind !== 'created' || !created.enrollment.graphDispatch) throw new Error('Missing exact graph link');
    const graphDispatch = created.enrollment.graphDispatch;
    const recover = firmEngineeringControlRecovery(binding.handler)!;
    const context: ControlHandlerContext = { node: definition.nodes[0]!, artifacts: [], signal: new AbortController().signal,
      graphDispatch, deadlineMonotonicMs: performance.now() + 60_000, isExecutionStopped: () => false };
    const receipt = actualRead(f.manifest.id, f.options).deliveries[0]!;
    expect(receipt.status).toBe('delivered'); expect(f.git(f.repo, 'rev-parse', receipt.branch)).toBe(receipt.commit);
    const campaign = readUniverseCampaign(f.campaignId, f.options);
    const runs = readUniverseOverview(f.options).universes[0]!.runs;
    const ledger = resourcePoolStatus(f.runtime.root, f.pool, f.bindings, f.observations);
    const unchanged = () => {
      expect(readPortfolioControllerEvents(directory)).toEqual(originalEvents);
      expect(f.requests).toHaveLength(1); expect(evaluations).toHaveBeenCalledTimes(2); expect(publications).toBe(1);
    };
    for (const field of ['graphRootDigest', 'graphId', 'definitionDigest', 'nodeId', 'intentDigest'] as const) {
      const value = field.endsWith('Digest') ? 'a'.repeat(64) : 'different';
      expect(recover({ ...context, graphDispatch: { ...graphDispatch, [field]: value } })).toBeNull(); unchanged();
    }
    expect(recover({ ...context, deadlineMonotonicMs: performance.now() - 1 })).toBeNull(); unchanged();
    expect(recover({ ...context, isExecutionStopped: () => true })).toBeNull(); unchanged();
    const ownership = acquireLocalStoreLockWithOutcome(join(directory, '.execution.lock'), 0,
      { anchorPath: directory, exactPrivateStorage: true });
    expect(ownership.state).toBe('acquired');
    try { expect(recover(context)).toBeNull(); unchanged(); }
    finally { if (ownership.state === 'acquired') releaseLocalStoreLock(ownership.lock); }
    // Deliberate fixture drift is restored exactly; no delivery writer runs.
    f.git(f.repo, 'update-ref', `refs/heads/${receipt.branch}`, f.revision, receipt.commit!);
    try { expect(recover(context)).toBeNull(); unchanged(); }
    finally { f.git(f.repo, 'update-ref', `refs/heads/${receipt.branch}`, receipt.commit!, f.revision); }
    const runtimeBytes = readFileSync(f.options.resourceRuntime);
    save(f.options.resourceRuntime, { ...f.runtime, workspace: f.repo });
    try { expect(recover(context)).toBeNull(); unchanged(); }
    finally { writeFileSync(f.options.resourceRuntime, runtimeBytes); }
    const graphRecords = readdirSync(join(graphRoot, 'control-graph', 'records')).map(name =>
      readFileSync(join(graphRoot, 'control-graph', 'records', name), 'utf8'));
    const kill = join(graphRoot, 'KILL'); writeFileSync(kill, 'fixture stop\n', { mode: 0o600 });
    try { expect((await runControlGraph(definition, graphOptions)).status).toBe('stopped'); unchanged(); }
    finally { rmSync(kill); }
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(first.deadlineAt!) + 1);
    try { expect((await runControlGraph(definition, graphOptions)).status).toBe('stopped'); unchanged(); }
    finally { vi.useRealTimers(); }
    expect(readdirSync(join(graphRoot, 'control-graph', 'records')).map(name =>
      readFileSync(join(graphRoot, 'control-graph', 'records', name), 'utf8'))).toEqual(graphRecords);
    // A drain is not new admission authority and cannot block acknowledgment.
    requestUniversePortfolioControllerControl(f.definition.id, 'drain', f.options);
    const drainedEvents = readPortfolioControllerEvents(directory);
    expect(drainedEvents.length).toBe(originalEvents.length + 1);
    // Date-only advancement proves expired child allowance is preserved, while
    // the original graph remains live. No actual wall-clock wait is claimed.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(controller.deadlineAt!) + 1);
    let resumed;
    try { resumed = await runControlGraph(definition, graphOptions); }
    finally { vi.useRealTimers(); }
    expect(resumed, JSON.stringify({ resumed, publicationErrors, reconciliationResults,
      controller: readUniversePortfolioController(f.definition.id, f.options),
      events: readPortfolioControllerEvents(directory).map(event => event.kind) })).toMatchObject({ sourceState: 'healthy', status: 'completed', deadlineAt: first.deadlineAt,
      nodes: [{ id: 'deliver', state: 'completed' }] });
    // Keep subsequent observations monotonic after the clock fixture.
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(controller.deadlineAt!) + 2);
    const after = readUniversePortfolioController(f.definition.id, f.options);
    expect(after).toMatchObject({ sourceState: 'healthy', status: 'completed', deadlineAt: controller.deadlineAt,
      diagnostics: controller.diagnostics, control: { mode: 'drain' } });
    const settledEvents = readPortfolioControllerEvents(directory);
    expect(settledEvents.slice(0, drainedEvents.length)).toEqual(drainedEvents);
    expect(settledEvents.slice(drainedEvents.length).map(event => event.kind)).toEqual(['settled']);
    const replay = await runControlGraph(definition, graphOptions);
    expect(replay).toEqual(resumed);
    expect(readPortfolioControllerEvents(directory)).toEqual(settledEvents);
    expect(f.requests).toHaveLength(1); expect(evaluations).toHaveBeenCalledTimes(2); expect(publications).toBe(1);
    expect(actualRead(f.manifest.id, f.options).deliveries).toEqual([receipt]);
    expect(readUniverseCampaign(f.campaignId, f.options)).toEqual(campaign);
    expect(readUniverseOverview(f.options).universes[0]!.runs).toEqual(runs);
    expect(resourcePoolStatus(f.runtime.root, f.pool, f.bindings, f.observations).attempts).toEqual(ledger.attempts);
    expect(f.git(f.repo, 'rev-parse', receipt.branch)).toBe(receipt.commit);
    expect(readFileSync(join(f.repo, 'value.json'), 'utf8')).toBe('0\n');
    expect(readFileSync(join(f.repo, '.git', 'index'))).toEqual(index); expect(f.git(f.repo, 'rev-parse', 'HEAD')).toBe(f.revision);
    expect(f.git(f.repo, 'status', '--porcelain=v1')).toBe(''); expect(readdirSync(f.workspace)).toEqual(['.git']);
  }, 45_000);
});
