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
import { runUniversePortfolioController, readUniversePortfolioController } from '../src/core/universe/portfolio-controller.js';
import { portfolioControllerDirectory, readPortfolioControllerEvents } from '../src/core/universe/portfolio-controller-store.js';
import type { UniversePortfolioDefinition } from '../src/core/universe/portfolio-types.js';
import * as delivery from '../src/core/universe/delivery.js';
import * as deliveryGit from '../src/core/universe/delivery-git.js';
import * as evaluator from '../src/core/universe/fixed-evaluator.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
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

describe.runIf(process.platform === 'darwin')('controller handoff diagnostic real acceptance', () => {
  it('records a post-publication confirmation failure and reconciles exact receipts without repeating effects', async () => {
    const f = await fixture(); const index = readFileSync(join(f.repo, '.git', 'index'));
    const evaluations = vi.spyOn(evaluator, 'runFixedUniverseEvaluator');
    const actualGit = deliveryGit.deliveryGit; let publications = 0;
    vi.spyOn(deliveryGit, 'deliveryGit').mockImplementation((...args) => {
      const api = actualGit(...args);
      return { ...api, createRef: async (...createArgs) => { publications++; await api.createRef(...createArgs); } };
    });
    const actualRead = delivery.readUniverseDeliveries; let injected = false;
    const confirmation = vi.spyOn(delivery, 'readUniverseDeliveries').mockImplementation((...args) => {
      const report = actualRead(...args);
      if (!injected && report.sourceState === 'healthy' && report.deliveries.some(row => row.status === 'delivered')) {
        injected = true;
        return { ...report, sourceState: 'degraded' as const, reasons: ['private-fixture-detail-must-not-be-persisted'] };
      }
      return report;
    });
    const first = await runUniversePortfolioController(f.definition, f.options);
    expect(injected).toBe(true); expect(f.failures).toEqual([]); expect(f.requests).toHaveLength(1);
    expect(evaluations).toHaveBeenCalledTimes(2); expect(publications).toBe(1);
    expect(first, JSON.stringify(first)).toMatchObject({ sourceState: 'healthy', status: 'incomplete', outcomes: [{
      campaignId: f.campaignId, state: 'in-flight', attempted: true, reasonCode: 'reconciliation-required', deliveryDigest: null }] });
    const directory = portfolioControllerDirectory(f.definition.id, f.options);
    const events = readPortfolioControllerEvents(directory);
    const intent = events.find(event => event.kind === 'intent'); expect(intent).toBeDefined();
    const diagnostic = { campaignId: f.campaignId, intentDigest: digest(canonical(intent)), phase: 'delivery-verification',
      code: 'delivery-receipt-unverified', at: expect.any(String) };
    expect(first.diagnostics).toEqual([diagnostic]);
    expect(events.filter(event => event.kind === 'dispatch-diagnostic')).toEqual([
      { ...diagnostic, kind: 'dispatch-diagnostic', id: expect.any(String), sequence: expect.any(Number) }]);
    expect(canonical(events)).not.toContain('private-fixture-detail');
    expect(readUniversePortfolioController(f.definition.id, f.options).diagnostics).toEqual(first.diagnostics);
    confirmation.mockRestore();
    const receipts = actualRead(f.manifest.id, f.options);
    expect(receipts.sourceState).toBe('healthy'); expect(receipts.deliveries).toHaveLength(1);
    const receipt = receipts.deliveries[0]!; expect(receipt.status).toBe('delivered');
    expect(f.git(f.repo, 'rev-parse', receipt.branch)).toBe(receipt.commit);
    expect(f.git(f.repo, 'show', `${receipt.branch}:value.json`)).toBe('1');
    const campaign = readUniverseCampaign(f.campaignId, f.options);
    expect(campaign).toMatchObject({ state: 'completed', seedEvaluation: { result: { status: 'measured', measurement: { passed: false, score: 0 } } } });
    const runs = readUniverseOverview(f.options).universes[0]!.runs;
    const ledger = resourcePoolStatus(f.runtime.root, f.pool, f.bindings, f.observations);
    expect(ledger.attempts).toHaveLength(1);
    const resumed = await runUniversePortfolioController(f.definition, f.options);
    expect(resumed, JSON.stringify(resumed)).toMatchObject({ sourceState: 'healthy', status: 'completed',
      createdAt: first.createdAt, deadlineAt: first.deadlineAt, diagnostics: first.diagnostics,
      outcomes: [{ state: 'completed', deliveryDigest: digest(canonical(receipt)) }] });
    const replay = await runUniversePortfolioController(f.definition, f.options);
    expect(replay.status).toBe('completed'); expect(replay.diagnostics).toEqual(first.diagnostics);
    expect(f.requests).toHaveLength(1); expect(evaluations).toHaveBeenCalledTimes(2); expect(publications).toBe(1);
    expect(actualRead(f.manifest.id, f.options).deliveries).toEqual(receipts.deliveries);
    expect(readUniverseCampaign(f.campaignId, f.options)).toEqual(campaign);
    expect(readUniverseOverview(f.options).universes[0]!.runs).toEqual(runs);
    expect(resourcePoolStatus(f.runtime.root, f.pool, f.bindings, f.observations).attempts).toEqual(ledger.attempts);
    expect(f.git(f.repo, 'rev-parse', receipt.branch)).toBe(receipt.commit);
    expect(readFileSync(join(f.repo, 'value.json'), 'utf8')).toBe('0\n');
    expect(readFileSync(join(f.repo, '.git', 'index'))).toEqual(index); expect(f.git(f.repo, 'rev-parse', 'HEAD')).toBe(f.revision);
    expect(f.git(f.repo, 'status', '--porcelain=v1')).toBe(''); expect(readdirSync(f.workspace)).toEqual(['.git']);
  }, 45_000);
});
