/** Actual confined evaluator, shared loopback resource ledger and local Git delivery. */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { resourcePoolStatus } from '../src/core/resources/pool-runtime.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { artifactDigest, canonical, digest } from '../src/core/universe/artifacts.js';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, readUniverseOverview, runUniverseCampaign,
  deliverCompletedUniverseCampaign, readUniverseDeliveries, type UniverseManifest } from '../src/core/universe/index.js';
import { readCompletedCampaignDelivery } from '../src/core/universe/campaign-delivery-recovery.js';
import { manifestRecord, universePath } from '../src/core/universe/store.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const save = (path: string, value: unknown) => writeFileSync(path, canonical(value) + '\n', { mode: 0o600 });
async function fixture() {
  expect(homedir()).not.toBe(process.env.ASHLR_VITEST_REAL_HOME);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'seed-measurement-acceptance-')));
  const root = join(base, 'universe'); const repo = join(base, 'repo'); const workspace = join(base, 'transport');
  for (const path of [repo, workspace]) mkdirSync(path, { mode: 0o700 });
  let stopWorker = async () => {};
  cleanups.push(async () => {
    await stopWorker();
    const writable = (path: string): void => { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name)); };
    writable(base); rmSync(base, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgsign=false', '-C', cwd, ...args], { encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' } }).trim();
  for (const path of [repo, workspace]) git(path, 'init', '-q', '--template=', '--initial-branch=main');
  writeFileSync(join(repo, 'value.json'), '0\n');
  // A real bounded delay leaves the durable intent observable before measurement
  // completes. This evaluator cannot write markers outside its confined scratch.
  writeFileSync(join(repo, 'evaluate.mjs'), "import {readFileSync} from 'node:fs';import {join} from 'node:path';\n" +
    "const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));\n" +
    "if(value===0)await new Promise(resolve=>setTimeout(resolve,700));\n" +
    "console.log(JSON.stringify({passed:value===1,score:value===1?1:0,metrics:{value}}));\n");
  git(repo, 'add', '.'); git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixed seed');
  const revision = git(repo, 'rev-parse', 'HEAD'); const campaignId = 'seed-campaign';
  const requests: unknown[] = []; const failures: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const messages = JSON.parse(body.messages[0].content) as Array<{ role: string; content: string }>;
        const input = JSON.parse(messages.find(row => row.role === 'user')!.content); requests.push(input);
        expect(input.generation).toBe(1);
        expect(readUniverseCampaign(campaignId, { root }).seedEvaluation?.result).toMatchObject({
          status: 'measured', measurement: { passed: false, score: 0 } });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({
          operations: [{ op: 'replace', path: 'value.json', content: '1\n' }] }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
      } catch (error) { failures.push(String(error)); res.writeHead(500); res.end('Fixture protocol failure'); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  stopWorker = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
  const pool = validateResourcePool({ schemaVersion: 1, id: 'seed-pool', workers: [{ id: 'local', provider: 'local', model: 'fixture',
    maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 1, taskWindowMs: 60_000, priority: 1 }] });
  const bindings = validateResourceBindings([{ workerId: 'local', capacityKey: 'shared-fixture-account', kind: 'local-chat',
    endpoint: `http://127.0.0.1:${address.port}/v1` }], pool);
  const observations = [{ workerId: 'local', health: 'ready' as const, windows: [], retryAfter: null,
    observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }];
  const runtime = { schemaVersion: 1, root: join(base, 'ledger'), workspace, poolPath: join(base, 'pool.json'),
    bindingsPath: join(base, 'bindings.json'), observationsPath: join(base, 'observations.json') };
  save(runtime.poolPath, pool); save(runtime.bindingsPath, bindings); save(runtime.observationsPath, observations);
  const runtimeFile = join(base, 'runtime.json'); save(runtimeFile, runtime);
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'seed-universe', name: 'Measured seed repair', objective: 'Pass the fixed evaluator',
    seed: { repo, revision }, metric: { name: 'quality', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 10_000, trialTimeoutMs: 5000 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 2000 }, variants: [{ id: 'repair', niche: 'quality', hypothesis: 'Repair value',
      generation: { kind: 'resource-pool', poolId: pool.id, poolDigest: digest(canonical({ pool, bindings })), allowedWorkerIds: ['local'],
        files: ['value.json'], maxOutputTokens: 256, fileOperations: { schemaVersion: 1, contextFiles: [] } } }] };
  initUniverse(manifest, { root });
  initUniverseCampaign({ schemaVersion: 1, id: campaignId, universeId: manifest.id, feedback: true, measureSeed: true,
    budget: { maxGenerations: 1, maxDurationMs: 20_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: 15 } }, { root });
  return { root, repo, workspace, git, revision, campaignId, requests, failures, runtime, runtimeFile, pool, bindings, observations, manifest };
}

describe.runIf(process.platform === 'darwin')('automatic seed measurement real runtime acceptance', () => {
  it('measures without resource effects, then delivers the first response and replays without another measurement or request', async () => {
    const f = await fixture(); const index = readFileSync(join(f.repo, '.git', 'index'));
    const pending = runUniverseCampaign(f.campaignId, { root: f.root, resourceRuntime: f.runtimeFile,
      expectedResourceRuntimeDigest: digest(canonical(f.runtime)) });
    let observedIntent = false;
    try {
      const cutoff = Date.now() + 5000;
      while (Date.now() < cutoff) {
        const current = readUniverseCampaign(f.campaignId, { root: f.root });
        if (current.seedEvaluation?.intent && current.seedEvaluation.result === null) {
          expect(f.requests).toEqual([]); expect(existsSync(f.runtime.root)).toBe(false);
          expect(current.steps).toEqual([]);
          expect(current.progress).toMatchObject({ attempts: 0, reservedModelRequests: 0, reportedTokens: 0 });
          expect(readUniverseOverview({ root: f.root }).universes[0]!.runs).toEqual([]);
          observedIntent = true; break;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally { await pending; }
    expect(observedIntent).toBe(true);
    const summary = readUniverseCampaign(f.campaignId, { root: f.root });
    const seed = manifestRecord(universePath(f.root, f.manifest.id)).seedArtifact;
    expect(summary).toMatchObject({ sourceState: 'healthy', state: 'completed', seedEvaluation: {
      intent: { seedArtifactDigest: seed.digest }, result: { status: 'measured', processGroupSettlement: 'group-exit-confirmed',
        measurement: { passed: false, score: 0, metrics: { value: 0 } } } },
    progress: { attempts: 1, reservedModelRequests: 1, reportedTokens: 15 } });
    expect(summary.seedEvaluation!.result!.intentDigest).toBe(digest(canonical(summary.seedEvaluation!.intent)));
    expect(artifactDigest(seed.path)).toBe(seed.digest); expect(f.requests).toHaveLength(1); expect(f.failures).toEqual([]);
    const universe = readUniverseOverview({ root: f.root }).universes[0]!;
    expect(universe.runs).toHaveLength(1); expect(universe.runs[0]!.generation).toBe(1);
    expect(universe.runs[0]!.trials).toHaveLength(1);
    expect(universe.runs[0]!.trials[0]).toMatchObject({ status: 'passed', selected: true, score: 1, parentTrialId: null, delta: null });
    const ledger = resourcePoolStatus(f.runtime.root, f.pool, f.bindings, f.observations);
    expect(ledger.attempts).toHaveLength(1);
    expect(ledger.attempts[0]).toMatchObject({ status: 'completed', capacityKey: 'shared-fixture-account', verifiedAccepted: false });
    const delivery = { branch: 'codex/first-response', baseCommit: f.revision, allowInitialRepair: true as const };
    const result = await deliverCompletedUniverseCampaign(f.campaignId, { root: f.root, delivery });
    expect(result.delivery.status).toBe('delivered');
    if (result.delivery.status !== 'delivered') throw new Error('Expected actual local delivery');
    expect(f.git(f.repo, 'show', `${delivery.branch}:value.json`)).toBe('1');
    expect(f.git(f.repo, 'diff', '--name-only', f.revision, delivery.branch)).toBe('value.json');
    expect(readCompletedCampaignDelivery(summary, delivery, { root: f.root })).toEqual(result.delivery.receipt);
    expect(await runUniverseCampaign(f.campaignId, { root: f.root, resourceRuntime: f.runtimeFile })).toEqual(summary);
    expect(await deliverCompletedUniverseCampaign(f.campaignId, { root: f.root, delivery })).toEqual(result);
    expect(f.requests).toHaveLength(1); expect(readUniverseCampaign(f.campaignId, { root: f.root })).toEqual(summary);
    expect(resourcePoolStatus(f.runtime.root, f.pool, f.bindings, f.observations).attempts).toEqual(ledger.attempts);
    expect(readUniverseDeliveries(f.manifest.id, { root: f.root }).deliveries).toHaveLength(1);
    expect(readFileSync(join(f.repo, 'value.json'), 'utf8')).toBe('0\n');
    expect(readFileSync(join(f.repo, '.git', 'index'))).toEqual(index); expect(f.git(f.repo, 'rev-parse', 'HEAD')).toBe(f.revision);
    expect(f.git(f.repo, 'status', '--porcelain=v1')).toBe(''); expect(f.git(f.repo, 'remote')).toBe('');
    expect(readdirSync(f.workspace)).toEqual(['.git']);
  }, 30_000);
});
