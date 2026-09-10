/** One real Hub source campaign. The worker is deterministic loopback, never a provider. */
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { resourcePoolStatus } from '../src/core/resources/pool-runtime.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { artifactDigest, canonical, digest } from '../src/core/universe/artifacts.js';
import { initUniverse, initUniverseCampaign, readUniverseDeliveries, readUniverseOverview, readUniversePortfolioController, type UniverseManifest } from '../src/core/universe/index.js';
import { manifestRecord, universePath } from '../src/core/universe/store.js';

const SOURCE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// The evaluator seed was committed independently before the reviewed candidate.
const HUB_SEED_REVISION = '9bf75b598fbfc6a5b7ec289a2d3419b1a18469b8';
const HUB_CANDIDATE_REVISION = 'e2e4e33d588a63d36d81ed23e50adb18b197b8df';
const TARGET = 'src/core/portfolio/value-filter.ts';
const EVALUATOR = 'scripts/evaluators/backlog-marker-paths.mjs';
const exec = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const save = (file: string, value: unknown) => writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args],
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } }).trim();
}
async function fixture() {
  expect(homedir()).not.toBe(process.env.ASHLR_VITEST_REAL_HOME);
  expect(HUB_SEED_REVISION).toMatch(/^[a-f0-9]{40}$/);
  expect(HUB_CANDIDATE_REVISION).toMatch(/^[a-f0-9]{40}$/);
  // Candidate bytes come from the independently reviewed immutable commit,
  // never an alternate regex implementation authored inside this acceptance.
  const candidate = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', SOURCE_ROOT,
    'show', `${HUB_CANDIDATE_REVISION}:${TARGET}`], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } });
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'hub-marker-campaign-')));
  const repo = join(base, 'hub'); const home = join(base, 'home'); const transport = join(base, 'transport');
  const root = join(base, 'universe'); const graphRoot = join(base, 'graph'); const ledgerRoot = join(base, 'ledger');
  for (const directory of [repo, home, transport, graphRoot]) mkdirSync(directory, { mode: 0o700 });
  let stopWorker = async () => {};
  cleanups.push(async () => {
    await stopWorker();
    const writable = (file: string): void => { const stat = lstatSync(file); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      chmodSync(file, 0o700); for (const child of readdirSync(file)) writable(join(file, child)); };
    writable(base); rmSync(base, { recursive: true, force: true });
  });
  git(repo, 'init', '-q', '--template=', '--initial-branch=main');
  // Local immutable fetch, without remote enrollment, shared object alternates,
  // hooks, provider contact, or writes to the original Hub repository.
  git(repo, '-c', 'protocol.file.allow=always', 'fetch', '--quiet', '--depth=1', '--no-tags', SOURCE_ROOT, HUB_SEED_REVISION);
  git(repo, 'checkout', '--quiet', '--detach', HUB_SEED_REVISION);
  git(transport, 'init', '-q', '--template=', '--initial-branch=main');
  expect(git(repo, 'remote')).toBe(''); expect(git(repo, 'rev-parse', 'HEAD')).toBe(HUB_SEED_REVISION);
  const baseline = readFileSync(join(repo, TARGET), 'utf8'); const evaluatorBytes = readFileSync(join(repo, EVALUATOR));
  expect(git(repo, 'hash-object', TARGET)).toBe(git(SOURCE_ROOT, 'rev-parse', `${HUB_SEED_REVISION}:${TARGET}`));
  const requests: number[] = []; const errors: string[] = [];
  const worker = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const messages = JSON.parse(body.messages[0].content) as Array<{ role: string; content: string }>;
        const input = JSON.parse(messages.find(message => message.role === 'user')!.content);
        const generation = input.generation as number; requests.push(generation);
        const operation = generation === 1 ? { op: 'replace', path: TARGET, content: baseline }
          : generation === 2 ? { op: 'replace', path: EVALUATOR, content: 'console.log(JSON.stringify({passed:true,score:1,metrics:{}}));\n' }
            : generation === 3 ? { op: 'replace', path: TARGET, content: candidate } : null;
        if (!operation) throw new Error('Unexpected campaign generation');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ operations: [operation] }) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }));
      } catch (error) { errors.push(String(error)); res.writeHead(500); res.end('Fixture rejected unexpected request'); }
    });
  });
  await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
  stopWorker = async () => { worker.closeAllConnections(); await new Promise<void>(resolve => worker.close(() => resolve())); };
  const address = worker.address(); if (!address || typeof address === 'string') throw new Error('Fixture worker unavailable');
  const pool = validateResourcePool({ schemaVersion: 1, id: 'hub-marker-pool', workers: [{ id: 'local-worker', provider: 'local', model: 'deterministic-candidate',
    maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 3, taskWindowMs: 240_000, priority: 1 }] });
  const bindings = validateResourceBindings([{ workerId: 'local-worker', capacityKey: 'fixture-shared-account', kind: 'local-chat',
    endpoint: `http://127.0.0.1:${address.port}/v1` }], pool);
  const observations = [{ workerId: 'local-worker', health: 'ready' as const, windows: [], retryAfter: null,
    observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString() }];
  const runtime = { schemaVersion: 1, root: ledgerRoot, workspace: transport, poolPath: join(base, 'pool.json'),
    bindingsPath: join(base, 'bindings.json'), observationsPath: join(base, 'observations.json'), capacityWaitMs: 1000 };
  save(runtime.poolPath, pool); save(runtime.bindingsPath, bindings); save(runtime.observationsPath, observations);
  const runtimeFile = join(base, 'runtime.json'); save(runtimeFile, runtime);
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'hub-marker-paths', name: 'Hub backlog marker paths',
    objective: 'Normalize marker file paths without dropping substantive Hub backlog work', seed: { repo, revision: HUB_SEED_REVISION },
    metric: { name: 'fixed-cases', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 60_000, trialTimeoutMs: 45_000 },
    evaluation: { command: [process.execPath, '--experimental-vm-modules', '--no-warnings', join(repo, EVALUATOR)], timeoutMs: 5000 },
    variants: [{ id: 'marker-paths', niche: 'backlog', hypothesis: 'Preserve complete normalized paths before classifying marker work',
      generation: { kind: 'resource-pool', poolId: pool.id, poolDigest: digest(canonical({ pool, bindings })), allowedWorkerIds: ['local-worker'],
        files: [TARGET], maxOutputTokens: 8192, fileOperations: { schemaVersion: 1, contextFiles: [EVALUATOR] } } }] };
  initUniverse(manifest, { root });
  const campaignId = 'hub-marker-campaign'; const branch = 'codex/hub-marker-acceptance';
  initUniverseCampaign({ schemaVersion: 1, id: campaignId, universeId: manifest.id, feedback: true,
    budget: { maxGenerations: 3, maxDurationMs: 150_000, maxModelRequests: 3, maxStagnantGenerations: 3, maxReportedTokens: null } }, { root });
  const host = { nodeId: 'deliver-hub-marker', root, constitutionVersion: 'fixture-v1', policyEpoch: 1,
    definition: { schemaVersion: 1, id: 'hub-marker-controller', tasks: [{ campaignId, dependsOn: [] }], maxParallel: 1, maxDurationMs: 180_000 },
    deliveryPlan: { schemaVersion: 1, deliveries: [{ campaignId, branch, baseCommit: HUB_SEED_REVISION, allowInitialRepair: true }] },
    resourceRuntime: runtimeFile, expectedRuntimeDigest: digest(canonical(runtime)) };
  const enrollment = join(base, 'enrollment.json'); save(enrollment, { schemaVersion: 1, graphId: 'hub-marker-graph', host });
  const env = { ...process.env, HOME: home, USERPROFILE: home, ASHLR_HOME: join(home, '.ashlr'), TSX_DISABLE_CACHE: '1', NODE_DISABLE_COMPILE_CACHE: '1' };
  await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
    "const {loadOrCreateKey}=await import('./src/core/foundry/provenance.ts');loadOrCreateKey();"], { cwd: SOURCE_ROOT, env, timeout: 20_000 });
  const invoke = async (args: string[]) => {
    const result = await exec(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'universe', 'firm', 'engineer',
      '--root', graphRoot, '--enrollment', enrollment, '--json', ...args], { cwd: SOURCE_ROOT, env, timeout: 190_000, maxBuffer: 1024 * 1024 });
    return JSON.parse(result.stdout);
  };
  return { repo, root, graphRoot, ledgerRoot, transport, pool, bindings, observations, manifest, campaignId, branch,
    baseline, candidate, evaluatorBytes, requests, errors, invoke };
}

describe.runIf(process.platform === 'darwin')('real Hub marker-path engineering campaign', () => {
  it('fails unchanged Hub source and evaluator edits, then delivers only the measured source correction', async () => {
    const f = await fixture(); const index = readFileSync(join(f.repo, '.git', 'index'));
    const checked = await f.invoke(['--check']); expect(checked.enrollmentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(f.requests).toEqual([]); expect(readdirSync(f.graphRoot)).toEqual([]);
    let graph;
    try { graph = await f.invoke(['--expected-enrollment-digest', checked.enrollmentDigest]); }
    catch (error) {
      console.log(JSON.stringify({ requests: f.requests, errors: f.errors,
        controller: readUniversePortfolioController('hub-marker-controller', { root: f.root }),
        trials: readUniverseOverview({ root: f.root }).universes[0]?.runs.map(run => ({ generation: run.generation,
          trials: run.trials.map(trial => ({ status: trial.status, score: trial.score, metrics: trial.metrics, error: trial.error })) })) }));
      throw error;
    }
    expect(graph.status, JSON.stringify(graph)).toBe('completed'); expect(f.errors).toEqual([]); expect(f.requests).toEqual([1, 2, 3]);
    const universe = readUniverseOverview({ root: f.root }).universes[0]!;
    expect(universe.runs.map(run => run.trials[0]!.status)).toEqual(['failed', 'failed', 'passed']);
    expect(universe.runs.map(run => run.trials[0]!.selected)).toEqual([false, false, true]);
    expect(universe.runs[0]!.trials[0]!.score).toBe(0); expect(universe.runs[2]!.trials[0]!.score).toBe(1);
    expect(universe.runs[0]!.trials[0]!.metrics).toMatchObject({ cases: 142, passedCases: 82, failedCases: 60 });
    expect(universe.runs[2]!.trials[0]!.metrics).toMatchObject({ cases: 142, passedCases: 142, failedCases: 0 });
    const [baselineTrial, refusedTrial, correctedTrial] = universe.runs.map(run => run.trials[0]!);
    const seed = manifestRecord(universePath(f.root, f.manifest.id)).seedArtifact;
    expect(seed.revision).toBe(HUB_SEED_REVISION);
    expect(artifactDigest(seed.path)).toBe(seed.digest);
    expect(baselineTrial!.artifact?.digest).toBe(seed.digest);
    expect(artifactDigest(baselineTrial!.artifact!.path)).toBe(seed.digest);
    expect(baselineTrial!.generation?.changedFiles).toEqual([]);
    // Refusing an evaluator edit is generation failure, not a measured rejection.
    expect(refusedTrial).toMatchObject({ score: null, metrics: {}, artifact: null,
      error: 'Model file operations: each operation must target a unique declared mutable path',
      generation: { status: 'failed' }, diagnostics: [{ code: 'generation-failed' }] });
    expect(correctedTrial!.artifact?.digest).not.toBe(seed.digest);
    expect(correctedTrial!.generation?.changedFiles).toEqual([TARGET]);
    expect(readFileSync(join(correctedTrial!.artifact!.path, TARGET), 'utf8')).toBe(f.candidate);
    // Initial repair does not invent a passing parent or rewrite elite lineage.
    expect(correctedTrial).toMatchObject({ parentTrialId: null, delta: null });
    const ledger = resourcePoolStatus(f.ledgerRoot, f.pool, f.bindings, f.observations);
    expect(ledger.attempts).toHaveLength(3);
    expect(ledger.attempts.every(row => row.status === 'completed' && row.capacityKey === 'fixture-shared-account' && row.verifiedAccepted === false)).toBe(true);
    const deliveries = readUniverseDeliveries(f.manifest.id, { root: f.root }); expect(deliveries.deliveries).toHaveLength(1);
    const delivery = deliveries.deliveries[0]!; expect(delivery).toMatchObject({ status: 'delivered', branch: f.branch, baseCommit: HUB_SEED_REVISION });
    expect(git(f.repo, 'rev-parse', `refs/heads/${f.branch}`)).toBe(delivery.commit);
    expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/codex/')).toBe(`refs/heads/${f.branch}`);
    expect(git(f.repo, 'diff', '--name-only', HUB_SEED_REVISION, f.branch)).toBe(TARGET);
    expect(git(f.repo, 'show', `${f.branch}:${TARGET}`)).toBe(f.candidate.trimEnd());
    expect(git(f.repo, 'rev-parse', `${f.branch}:${TARGET}`)).toBe(git(SOURCE_ROOT, 'rev-parse', `${HUB_CANDIDATE_REVISION}:${TARGET}`));
    expect(readFileSync(join(f.repo, EVALUATOR))).toEqual(f.evaluatorBytes);
    expect(readFileSync(join(f.repo, TARGET), 'utf8')).toBe(f.baseline); expect(readFileSync(join(f.repo, '.git', 'index'))).toEqual(index);
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(HUB_SEED_REVISION); expect(git(f.repo, 'status', '--porcelain=v1')).toBe('');
    expect(git(f.repo, 'remote')).toBe(''); expect(readdirSync(f.transport)).toEqual(['.git']);
    for (const run of universe.runs) if (run.trials[0]!.artifact) {
      expect(readFileSync(join(run.trials[0]!.artifact!.path, EVALUATOR))).toEqual(f.evaluatorBytes);
    }
    const replay = await f.invoke(['--expected-enrollment-digest', checked.enrollmentDigest]);
    expect(replay).toMatchObject({ status: 'completed', definitionDigest: graph.definitionDigest, nodes: graph.nodes });
    expect(replay.traces).toEqual(graph.traces);
    expect(f.requests).toEqual([1, 2, 3]);
    expect(resourcePoolStatus(f.ledgerRoot, f.pool, f.bindings, f.observations).attempts).toEqual(ledger.attempts);
    expect(readUniverseDeliveries(f.manifest.id, { root: f.root }).deliveries).toEqual(deliveries.deliveries);
    expect(git(f.repo, 'rev-parse', `refs/heads/${f.branch}`)).toBe(delivery.commit);
    expect(readFileSync(join(f.repo, '.git', 'index'))).toEqual(index);
    expect(git(f.repo, 'status', '--porcelain=v1')).toBe('');
    // Deliberately path/key-free evidence for the handoff, not a new public API.
    console.log(JSON.stringify({ receipt: 'hub-marker-campaign-acceptance', seedCommit: HUB_SEED_REVISION,
      candidateCommit: HUB_CANDIDATE_REVISION, deliveredCommit: delivery.commit,
      targetBlob: git(f.repo, 'rev-parse', `${f.branch}:${TARGET}`), enrollmentDigest: checked.enrollmentDigest,
      graphStatus: graph.status, replayStatus: replay.status, seedArtifactDigest: seed.digest,
      trials: universe.runs.map(run => ({ status: run.trials[0]!.status,
        selected: run.trials[0]!.selected, score: run.trials[0]!.score, metrics: run.trials[0]!.metrics })),
      fixtureWorkerRequests: f.requests.length, ledgerAttempts: ledger.attempts.length,
      providerContacted: false, acceptanceScope: 'fixed-evaluator-and-local-branch-only' }));
  }, 240_000);
});
