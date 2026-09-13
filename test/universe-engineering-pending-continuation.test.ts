/** Real confined measurement and local Git publication; only the subsequent read is faulted. */
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
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
import { readControlGraph, runControlGraph, type ControlGraphDefinition, type ControlGraphReport } from '../src/core/universe/control-graph.js';
import { createFirmEngineeringControlHandler } from '../src/core/universe/firm-engineering-control-handler.js';
import { requestUniversePortfolioControllerControl } from '../src/core/universe/portfolio-controller-store.js';
import * as evaluator from '../src/core/universe/fixed-evaluator.js';

import * as campaignRuntime from '../src/core/universe/campaign.js';
import * as controllerRuntime from '../src/core/universe/portfolio-controller.js';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import * as poolPolicy from '../src/core/resources/pool-policy.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const save = (path: string, value: unknown) => writeFileSync(path, canonical(value) + '\n', { mode: 0o600 });

async function fixture(allowPendingContinuation = true, capacity = 2) {
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
    maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: capacity, taskWindowMs: 60_000, priority: 1 }] });
  const bindings = validateResourceBindings([{ workerId: 'local', capacityKey: 'shared-fixture-account', kind: 'local-chat',
    endpoint: `http://127.0.0.1:${address.port}/v1` }], pool);
  const observations = [{ workerId: 'local', health: 'ready' as const, windows: [], retryAfter: null,
    observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString() }];
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
    maxDurationMs: 120_000, tasks: [{ campaignId, dependsOn: [] }] };
  const options = { root, resourceRuntime: runtimeFile, expectedResourceRuntimeDigest: digest(canonical(runtime)),
    deliveryPlan: { schemaVersion: 1 as const, deliveries: [{ campaignId, branch: 'codex/handoff-proof', baseCommit: revision, allowInitialRepair: true as const }] } };
  const child = 'pending-child'; const childUniverse = 'pending-universe';
  initUniverse({ ...manifest, id: childUniverse }, { root });
  initUniverseCampaign({ schemaVersion: 1, id: child, universeId: childUniverse, feedback: true, measureSeed: true,
    budget: { maxGenerations: 1, maxDurationMs: 30_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: 15 } }, { root });
  const controllerDefinition = { ...definition, tasks: [...definition.tasks, { campaignId: child, dependsOn: [campaignId] }] };
  const deliveryPlan = { ...options.deliveryPlan, deliveries: [...options.deliveryPlan.deliveries,
    { campaignId: child, branch: 'codex/pending-child', baseCommit: revision, allowInitialRepair: true as const }] };
  const graphRoot = join(base, 'graph'); mkdirSync(graphRoot, { mode: 0o700 });
  const host = { nodeId: 'deliver', root, constitutionVersion: 'fixture-v1', policyEpoch: 1, definition: controllerDefinition,
    deliveryPlan, resourceRuntime: runtimeFile, expectedRuntimeDigest: options.expectedResourceRuntimeDigest,
    ...(allowPendingContinuation ? { allowPendingContinuation: true as const } : {}) };
  const binding = createFirmEngineeringControlHandler(host);
  const graph: ControlGraphDefinition = { schemaVersion: 1, id: 'continuation-graph', maxConcurrent: 1, maxDurationMs: 180_000,
    nodes: [{ id: 'deliver', kind: 'deliver', requires: [], input: binding.nodeInput }] };
  const graphOptions = { root: graphRoot, traceKeys: { testKey: Buffer.alloc(32, 88) }, handlers: { deliver: binding.handler } };
  const evaluations = vi.spyOn(evaluator, 'runFixedUniverseEvaluator');
  const actualGit = deliveryGit.deliveryGit; let publications = 0;
  vi.spyOn(deliveryGit, 'deliveryGit').mockImplementation((...args) => {
    const api = actualGit(...args);
    return { ...api, createRef: async (...createArgs) => { publications++; await api.createRef(...createArgs); } };
  });
  return { root, repo, workspace, git, revision, campaignId, requests, failures, runtime, pool, bindings, observations, manifest,
    definition: controllerDefinition, options: { ...options, deliveryPlan }, child, childUniverse, graphRoot, graph, graphOptions,
    host, evaluations, publications: () => publications };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function interrupted(f: Fixture): Promise<ControlGraphReport> {
  const actualRead = delivery.readUniverseDeliveries; let injected = false;
  const confirmation = vi.spyOn(delivery, 'readUniverseDeliveries').mockImplementation((...args) => {
    const report = actualRead(...args);
    if (!injected && args[0] === f.manifest.id && report.sourceState === 'healthy' && report.deliveries.some(row => row.status === 'delivered')) {
      injected = true; return { ...report, sourceState: 'degraded', reasons: ['fixture confirmation unavailable'] };
    }
    return report;
  });
  let result: ControlGraphReport;
  try { result = await runControlGraph(f.graph, f.graphOptions); }
  finally { confirmation.mockRestore(); }
  expect(injected).toBe(true); expect(result.nodes[0]!.state).toBe('unresolved');
  expect(f.requests).toHaveLength(1); expect(f.failures).toEqual([]);
  expect(f.evaluations).toHaveBeenCalledTimes(2); expect(f.publications()).toBe(1);
  expect(readUniverseCampaign(f.child, f.options).progress.attempts).toBe(0);
  return result;
}
function upstream(f: Fixture) {
  return { campaign: readUniverseCampaign(f.campaignId, f.options),
    runs: readUniverseOverview(f.options).universes.find(row => row.manifest.id === f.manifest.id)!.runs,
    deliveries: delivery.readUniverseDeliveries(f.manifest.id, f.options).deliveries };
}
const controllerEvents = (f: Fixture) => readPortfolioControllerEvents(portfolioControllerDirectory(f.definition.id, f.options));
const graphIntent = (f: Fixture) => readFileSync(join(f.graphRoot, 'control-graph', 'records', '00000001.json'));

describe.runIf(process.platform === 'darwin')('opt-in graph-owned pending continuation real acceptance', () => {
  it('observes the existing exhausted task cap and cancels the bounded wait without another request', async () => {
    const f = await fixture(true, 1); await interrupted(f); const a = upstream(f); const intent = graphIntent(f);
    const abort = new AbortController(); const actualPlan = poolPolicy.planResourceAssignment; let denied = 0;
    const planning = vi.spyOn(poolPolicy, 'planResourceAssignment').mockImplementation(input => {
      const plan = actualPlan(input);
      if (plan.selectedWorkerId === null && plan.exclusions.some(row => row.reasons.includes('operator-task-cap-reached'))) {
        denied++; abort.abort();
      }
      return plan;
    });
    // Abort only after observing a real closed-cap plan, not by fabricating a
    // denial or resetting the existing quota/task-window ledger.
    const report = await runControlGraph(f.graph, { ...f.graphOptions, signal: abort.signal }); planning.mockRestore();
    expect(denied).toBeGreaterThan(0); expect(report.status).not.toBe('completed');
    expect(f.requests).toHaveLength(1); expect(f.publications()).toBe(1); expect(upstream(f)).toEqual(a);
    expect(graphIntent(f)).toEqual(intent);
    expect(resourcePoolStatus(f.runtime.root, f.pool, f.bindings, f.observations).attempts).toHaveLength(1);
    expect(readUniverseCampaign(f.child, f.options).progress.reservedModelRequests).toBe(0);
  }, 60_000);

  it('continues the same private CLI enrollment after actual child interruption without another graph intent', async () => {
    const f = await fixture(); const execute = promisify(execFile);
    const enrollment = join(f.root, '..', 'engineering-enrollment.json');
    save(enrollment, { schemaVersion: 1, graphId: f.graph.id, host: f.host });
    // Only test setup prepares provenance in the already-isolated test HOME.
    loadOrCreateKey();
    const invoke = async (args: string[], preload?: string) => {
      const result = await execute(process.execPath, [...(preload ? ['--import', preload] : []), '--import', 'tsx', 'src/cli/index.ts',
        'universe', 'firm', 'engineer', '--root', f.graphRoot, '--enrollment', enrollment, '--json', ...args],
      { timeout: 90_000, maxBuffer: 1024 * 1024 });
      return JSON.parse(result.stdout);
    };
    const checked = await invoke(['--check']);
    expect(checked.enrollmentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(readdirSync(f.graphRoot)).toEqual([]); expect(f.requests).toEqual([]);
    const directory = portfolioControllerDirectory(f.definition.id, f.options);
    // Kill only this synthetic child after A's actual immutable settlement and
    // physical short-lock release, before the existing scheduler can admit B.
    const preload = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const original=fs.unlinkSync;const records=${JSON.stringify(join(directory, 'ledger', 'records'))};
fs.unlinkSync=function(path,...args){const result=original.call(this,path,...args);
if(path===${JSON.stringify(join(directory, '.control.lock'))}&&fs.existsSync(records)&&fs.readdirSync(records).some(name=>{
const row=JSON.parse(fs.readFileSync(records+'/'+name,'utf8'));return row.kind==='settled'&&row.outcome.campaignId===${JSON.stringify(f.campaignId)}&&row.outcome.state==='completed';
}))process.kill(process.pid,'SIGKILL');return result;};syncBuiltinESMExports();`;
    await expect(invoke(['--expected-enrollment-digest', checked.enrollmentDigest], `data:text/javascript,${encodeURIComponent(preload)}`))
      .rejects.toMatchObject({ signal: 'SIGKILL' });
    const first = readControlGraph(f.graphRoot);
    expect(first).toMatchObject({ sourceState: 'healthy', status: 'incomplete', nodes: [{ state: 'unresolved' }] });
    expect(f.requests).toHaveLength(1); expect(readUniverseCampaign(f.child, f.options).progress.attempts).toBe(0);
    const a = upstream(f); const intent = graphIntent(f);
    const originalController = readUniversePortfolioController(f.definition.id, f.options);
    const completed = await invoke(['--expected-enrollment-digest', checked.enrollmentDigest]);
    expect(completed, JSON.stringify(completed)).toMatchObject({ sourceState: 'healthy', status: 'completed', deadlineAt: first.deadlineAt });
    expect(graphIntent(f)).toEqual(intent); expect(upstream(f)).toEqual(a); expect(f.requests).toHaveLength(2); expect(f.failures).toEqual([]);
    expect(readUniversePortfolioController(f.definition.id, f.options)).toMatchObject({ status: 'completed', deadlineAt: originalController.deadlineAt });
    const events = controllerEvents(f); const ledger = resourcePoolStatus(f.runtime.root, f.pool, f.bindings, f.observations);
    expect(events.filter(event => event.kind === 'intent')).toHaveLength(2); expect(ledger.attempts).toHaveLength(2);
    const overview = readUniverseOverview(f.options);
    for (const id of [f.manifest.id, f.childUniverse]) {
      const universe = overview.universes.find(row => row.manifest.id === id)!;
      expect(universe.runs).toHaveLength(1); expect(universe.runs[0]!.trials).toHaveLength(1);
      expect(universe.runs[0]!.trials[0]).toMatchObject({ status: 'passed', score: 1 });
      const receipt = delivery.readUniverseDeliveries(id, f.options).deliveries;
      expect(receipt).toHaveLength(1); expect(receipt[0]!.status).toBe('delivered');
      expect(f.git(f.repo, 'rev-parse', receipt[0]!.branch)).toBe(receipt[0]!.commit);
    }
    expect(await invoke(['--expected-enrollment-digest', checked.enrollmentDigest])).toEqual(completed);
    expect(f.requests).toHaveLength(2); expect(controllerEvents(f)).toEqual(events);
    expect(resourcePoolStatus(f.runtime.root, f.pool, f.bindings, f.observations).attempts).toEqual(ledger.attempts);
    expect(readUniverseOverview(f.options).universes.map(row => row.runs)).toEqual(overview.universes.map(row => row.runs));
    expect(f.git(f.repo, 'rev-parse', 'HEAD')).toBe(f.revision); expect(f.git(f.repo, 'status', '--porcelain=v1')).toBe('');
  }, 120_000);

  it('acknowledges A and admits untouched B once through the same ledger and graph intent', async () => {
    const f = await fixture(); const index = readFileSync(join(f.repo, '.git', 'index'));
    const reports: unknown[] = []; const actualContinue = controllerRuntime.continueGraphOwnedPortfolioController;
    vi.spyOn(controllerRuntime, 'continueGraphOwnedPortfolioController').mockImplementation(async (...args) => {
      try { const report = await actualContinue(...args); reports.push(report); return report; }
      catch (error) { reports.push({ error: error instanceof Error ? error.message : 'unknown' }); throw error; }
    });
    const first = await interrupted(f); const originalIntent = graphIntent(f);
    const a = upstream(f); const controller = readUniversePortfolioController(f.definition.id, f.options);
    const initialEvents = controllerEvents(f);
    const noDownstream = () => {
      expect(f.requests).toHaveLength(1); expect(f.publications()).toBe(1); expect(f.evaluations).toHaveBeenCalledTimes(2);
      expect(readUniverseCampaign(f.child, f.options).progress.attempts).toBe(0);
      expect(graphIntent(f)).toEqual(originalIntent);
    };
    const kill = join(f.graphRoot, 'KILL'); writeFileSync(kill, 'fixture stop\n', { mode: 0o600 });
    try { expect((await runControlGraph(f.graph, f.graphOptions)).status).toBe('stopped'); noDownstream(); }
    finally { rmSync(kill); }
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(first.deadlineAt!) + 1);
    try { expect((await runControlGraph(f.graph, f.graphOptions)).status).toBe('stopped'); noDownstream(); }
    finally { vi.useRealTimers(); }
    const directory = portfolioControllerDirectory(f.definition.id, f.options);
    const owned = acquireLocalStoreLockWithOutcome(join(directory, '.execution.lock'), 0, { anchorPath: directory, exactPrivateStorage: true });
    expect(owned.state).toBe('acquired');
    try { expect((await runControlGraph(f.graph, f.graphOptions)).nodes[0]!.state).toBe('unresolved'); noDownstream(); }
    finally { if (owned.state === 'acquired') releaseLocalStoreLock(owned.lock); }
    const runtimeBytes = readFileSync(f.options.resourceRuntime);
    save(f.options.resourceRuntime, { ...f.runtime, workspace: f.repo });
    try { expect((await runControlGraph(f.graph, f.graphOptions)).nodes[0]!.state).toBe('unresolved'); noDownstream(); }
    finally { writeFileSync(f.options.resourceRuntime, runtimeBytes); }
    const receipt = a.deliveries[0]!;
    f.git(f.repo, 'update-ref', `refs/heads/${receipt.branch}`, f.revision, receipt.commit!);
    try { expect((await runControlGraph(f.graph, f.graphOptions)).nodes[0]!.state).toBe('unresolved'); noDownstream(); }
    finally { f.git(f.repo, 'update-ref', `refs/heads/${receipt.branch}`, receipt.commit!, f.revision); }
    expect(controllerEvents(f)).toEqual(initialEvents);
    const drain = requestUniversePortfolioControllerControl(f.definition.id, 'drain', f.options);
    expect((await runControlGraph(f.graph, f.graphOptions)).nodes[0]!.state).toBe('unresolved'); noDownstream();
    requestUniversePortfolioControllerControl(f.definition.id, 'resume', { ...f.options, expectedDrainSequence: drain.sequence });
    const completed = await runControlGraph(f.graph, f.graphOptions);
    expect(completed, JSON.stringify({ completed, reports, requests: f.requests.length, failures: f.failures,
      controller: readUniversePortfolioController(f.definition.id, f.options), child: readUniverseCampaign(f.child, f.options),
      ledger: resourcePoolStatus(f.runtime.root, f.pool, f.bindings, f.observations).attempts })).toMatchObject({ sourceState: 'healthy', status: 'completed', deadlineAt: first.deadlineAt,
      nodes: [{ state: 'completed' }] });
    const after = readUniversePortfolioController(f.definition.id, f.options);
    expect(after).toMatchObject({ sourceState: 'healthy', status: 'completed', createdAt: controller.createdAt, deadlineAt: controller.deadlineAt });
    expect(upstream(f)).toEqual(a); expect(f.requests).toHaveLength(2); expect(f.failures).toEqual([]);
    expect(f.requests.map(row => (row as { seedContext: { source: { campaignId: string } } }).seedContext.source.campaignId)).toEqual([f.campaignId, f.child]);
    expect(f.evaluations).toHaveBeenCalledTimes(4); expect(f.publications()).toBe(2);
    expect(graphIntent(f)).toEqual(originalIntent);
    expect(readdirSync(join(f.graphRoot, 'control-graph', 'records'))).toHaveLength(3);
    const events = controllerEvents(f); const intents = events.filter(row => row.kind === 'intent');
    expect(intents).toHaveLength(2);
    expect(intents.filter(row => row.kind === 'intent' && row.campaignId === f.campaignId)).toHaveLength(1);
    expect(intents.filter(row => row.kind === 'intent' && row.campaignId === f.child)).toHaveLength(1);
    const ledger = resourcePoolStatus(f.runtime.root, f.pool, f.bindings, f.observations);
    expect(ledger.attempts).toHaveLength(2); expect(ledger.attempts.every(row => row.status === 'completed')).toBe(true);
    const child = readUniverseCampaign(f.child, f.options);
    expect(child).toMatchObject({ state: 'completed', progress: { attempts: 1, reservedModelRequests: 1 } });
    const bReceipts = delivery.readUniverseDeliveries(f.childUniverse, f.options).deliveries;
    expect(bReceipts).toHaveLength(1); expect(bReceipts[0]!.status).toBe('delivered');
    expect(await runControlGraph(f.graph, f.graphOptions)).toEqual(completed);
    expect(controllerEvents(f)).toEqual(events); expect(upstream(f)).toEqual(a);
    expect(readUniverseCampaign(f.child, f.options)).toEqual(child);
    expect(resourcePoolStatus(f.runtime.root, f.pool, f.bindings, f.observations).attempts).toEqual(ledger.attempts);
    expect(f.requests).toHaveLength(2); expect(f.evaluations).toHaveBeenCalledTimes(4); expect(f.publications()).toBe(2);
    expect(readFileSync(join(f.repo, 'value.json'), 'utf8')).toBe('0\n');
    expect(readFileSync(join(f.repo, '.git', 'index'))).toEqual(index); expect(f.git(f.repo, 'rev-parse', 'HEAD')).toBe(f.revision);
    expect(f.git(f.repo, 'status', '--porcelain=v1')).toBe(''); expect(readdirSync(f.workspace)).toEqual(['.git']);
  }, 90_000);

  it('keeps the absent-flag enrollment receipt-only with no downstream execution', async () => {
    const f = await fixture(false); const first = await interrupted(f); const events = controllerEvents(f);
    const a = upstream(f); const intent = graphIntent(f);
    const retry = await runControlGraph(f.graph, f.graphOptions);
    expect(retry).toMatchObject({ status: 'incomplete', deadlineAt: first.deadlineAt, nodes: [{ state: 'unresolved' }] });
    expect(controllerEvents(f)).toEqual(events); expect(upstream(f)).toEqual(a); expect(graphIntent(f)).toEqual(intent);
    expect(f.requests).toHaveLength(1); expect(f.evaluations).toHaveBeenCalledTimes(2); expect(f.publications()).toBe(1);
    expect(readUniverseCampaign(f.child, f.options).progress.attempts).toBe(0);
  }, 45_000);

  it('does not replay B after its durable controller intent but before a known campaign result', async () => {
    const f = await fixture(); await interrupted(f); const a = upstream(f); const intent = graphIntent(f);
    const actualRun = campaignRuntime.runUniverseCampaignOwned; let interruptedChild = 0;
    const fault = vi.spyOn(campaignRuntime, 'runUniverseCampaignOwned').mockImplementation(async (...args) => {
      if (args[0] === f.child) { interruptedChild++; throw new Error('Fixture interruption after controller intent'); }
      return actualRun(...args);
    });
    let uncertain;
    try { uncertain = await runControlGraph(f.graph, f.graphOptions); }
    finally { fault.mockRestore(); }
    expect(interruptedChild).toBe(1); expect(uncertain.nodes[0]!.state).toBe('unresolved');
    const events = controllerEvents(f);
    expect(events.filter(row => row.kind === 'intent' && row.campaignId === f.child)).toHaveLength(1);
    expect(readUniverseCampaign(f.child, f.options).progress.attempts).toBe(0);
    expect((await runControlGraph(f.graph, f.graphOptions)).nodes[0]!.state).toBe('unresolved');
    expect(controllerEvents(f)).toEqual(events); expect(upstream(f)).toEqual(a); expect(graphIntent(f)).toEqual(intent);
    expect(f.requests).toHaveLength(1); expect(f.evaluations).toHaveBeenCalledTimes(2); expect(f.publications()).toBe(1);
    expect(resourcePoolStatus(f.runtime.root, f.pool, f.bindings, f.observations).attempts).toHaveLength(1);
  }, 60_000);
});
