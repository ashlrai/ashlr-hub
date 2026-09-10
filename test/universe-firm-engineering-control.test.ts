/** Public adapter, signed graph, real Git/evaluator and loopback resource transport.
 * No campaign records, worker receipts, evaluator verdicts or delivery refs are fabricated.
 */
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { resourcePoolStatus } from '../src/core/resources/pool-runtime.js';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { artifactDigest, canonical, digest } from '../src/core/universe/artifacts.js';
import { readControlGraph, runControlGraph, type ControlGraphDefinition } from '../src/core/universe/control-graph.js';
import { verifyDecisionTraceV1 } from '../src/core/universe/decision-trace.js';
import { readUniversePortfolioController, runUniversePortfolioController } from '../src/core/universe/portfolio-controller.js';
import { portfolioControllerDirectory } from '../src/core/universe/portfolio-controller-store.js';
import { createFirmEngineeringControlHandler, type FirmEngineeringControlHost } from '../src/core/universe/firm-engineering-control-handler.js';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, readUniverseDeliveries, readUniverseOverview,
  type UniverseManifest } from '../src/core/universe/index.js';

let base: string;
const endpoints: Array<ReturnType<typeof createServer>> = [];
const traceKeys = { testKey: Buffer.alloc(32, 71) };
const exec = promisify(execFile);
const evaluator = [
  "import {readFileSync} from 'node:fs';import {join} from 'node:path';",
  "const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));",
  "console.log(JSON.stringify({passed:Number.isInteger(value)&&value>=0&&value<=100,score:value,metrics:{value},",
  "diagnostics:value<0?[{code:'NONNEGATIVE',message:'Value must be nonnegative',path:'value.json',line:1}]:[]}));",
].join('\n');
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
beforeEach(() => {
  // Global test/setup/home.ts isolates HOME and ASHLR_HOME before any imports.
  expect(homedir()).not.toBe(process.env.ASHLR_VITEST_REAL_HOME);
  base = realpathSync(mkdtempSync(join(tmpdir(), 'firm-engineering-control-')));
});
afterEach(async () => {
  vi.useRealTimers();
  for (const endpoint of endpoints.splice(0)) {
    endpoint.closeAllConnections(); await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  }
  const writable = (path: string): void => {
    const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name));
  };
  writable(base); rmSync(base, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', cwd, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
  }).trim();
}
async function fixture(options: { allInvalid?: boolean; graphDurationMs?: number; driftRuntimeAfterFirst?: boolean; hang?: boolean } = {}) {
  const root = join(base, 'universe'); const graphRoot = join(base, 'graph'); const repo = join(base, 'source');
  const workspace = join(base, 'sterile-transport');
  for (const path of [graphRoot, repo, workspace]) mkdirSync(path, { mode: 0o700 });
  git(repo, 'init', '-q', '--template=', '--initial-branch=main'); git(workspace, 'init', '-q', '--template=', '--initial-branch=main');
  writeFileSync(join(repo, 'value.json'), '0\n'); writeFileSync(join(repo, 'evaluate.mjs'), evaluator);
  writeFileSync(join(repo, 'private.txt'), 'UNDECLARED_SEED_DATA'); git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Engineering Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixed seed');
  const revision = git(repo, 'rev-parse', 'HEAD');
  const requests: Array<{ generation: number; feedback?: { status: string; score: number }; files: Array<{ path: string; content: string }> }> = [];
  const fixtureErrors: string[] = [];
  const endpoint = createServer((req, response) => {
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const transport = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const messages = JSON.parse(transport.messages[0].content) as Array<{ role: string; content: string }>;
        const prompt = messages.find((message) => message.role === 'user')!.content;
        if (prompt.includes('UNDECLARED_SEED_DATA') || prompt.includes('evaluate.mjs')) fixtureErrors.push('Undeclared seed content reached transport');
        const request = JSON.parse(prompt); requests.push(request);
        if (options.driftRuntimeAfterFirst && request.generation === 1) save(resourceRuntime, { ...runtime, root: join(base, 'redirected-ledger') });
        if (options.hang) return;
        const value = options.allInvalid ? -1 : [-1, 2, 3][request.generation - 1];
        if (value === undefined) throw new Error('Unexpected generation');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant',
          content: JSON.stringify({ operations: [{ op: 'replace', path: 'value.json', content: `${value}\n` }] }) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
      } catch (error) {
        fixtureErrors.push(error instanceof Error ? error.message : String(error));
        response.writeHead(500); response.end('Inert fixture refused unexpected protocol');
      }
    });
  });
  endpoints.push(endpoint); await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  const address = endpoint.address(); if (!address || typeof address === 'string') throw new Error('Fixture listener missing');
  const pool = validateResourcePool({ schemaVersion: 1, id: 'engineering-pool', workers: [{ id: 'local-worker', provider: 'local', model: 'inert-fixture',
    maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1 }] });
  const bindings = validateResourceBindings([{ workerId: 'local-worker', capacityKey: 'one-shared-account', kind: 'local-chat',
    endpoint: `http://127.0.0.1:${address.port}/v1` }], pool);
  const observations = [{ workerId: 'local-worker', observedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(), health: 'ready' as const, retryAfter: null, windows: [] }];
  const runtime = { schemaVersion: 1, poolPath: join(base, 'pool.json'), bindingsPath: join(base, 'bindings.json'),
    observationsPath: join(base, 'observations.json'), root: join(base, 'resource-ledger'), workspace };
  const resourceRuntime = join(base, 'runtime.json'); save(runtime.poolPath, pool); save(runtime.bindingsPath, bindings);
  save(runtime.observationsPath, observations); save(resourceRuntime, runtime);
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'engineering', name: 'Independent engineering acceptance',
    objective: 'Correct the measured integer under the fixed evaluator', seed: { repo, revision },
    metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: options.hang ? 30_000 : 15_000, trialTimeoutMs: options.hang ? 20_000 : 5000 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3000 },
    variants: [{ id: 'repair', niche: 'value', hypothesis: 'Use evaluator feedback to correct the value', generation: {
      kind: 'resource-pool', poolId: pool.id, poolDigest: digest(canonical({ pool, bindings })), allowedWorkerIds: ['local-worker'],
      files: ['value.json'], maxOutputTokens: 256, fileOperations: { schemaVersion: 1, contextFiles: [] } } }] };
  initUniverse(manifest, { root });
  const campaignId = 'engineering-campaign';
  initUniverseCampaign({ schemaVersion: 1, id: campaignId, universeId: manifest.id, feedback: true,
    budget: { maxGenerations: 3, maxDurationMs: 30_000, maxModelRequests: 3, maxStagnantGenerations: 3, maxReportedTokens: null } }, { root });
  const branch = 'codex/engineering-result';
  const host: FirmEngineeringControlHost = { nodeId: 'deliver-engineering', root, constitutionVersion: 'fixture-v1', policyEpoch: 4,
    definition: { schemaVersion: 1, id: 'engineering-controller', tasks: [{ campaignId, dependsOn: [] }], maxParallel: 1, maxDurationMs: 40_000 },
    deliveryPlan: { schemaVersion: 1, deliveries: [{ campaignId, branch, baseCommit: revision }] }, resourceRuntime,
    expectedRuntimeDigest: digest(canonical(runtime)) };
  const binding = createFirmEngineeringControlHandler(host);
  const definition: ControlGraphDefinition = { schemaVersion: 1, id: 'engineering-graph', maxConcurrent: 1,
    maxDurationMs: options.graphDurationMs ?? 50_000,
    nodes: [{ id: host.nodeId, kind: 'deliver', requires: [], input: binding.nodeInput }] };
  const run = (graph = definition) => runControlGraph(graph, { root: graphRoot, traceKeys, handlers: { deliver: binding.handler } });
  const status = () => resourcePoolStatus(runtime.root, pool, bindings, observations);
  return { root, graphRoot, repo, revision, workspace, manifest, campaignId, branch, runtime, resourceRuntime, host, binding,
    definition, run, status, requests, fixtureErrors };
}

function crashControllerReleasePreload(f: Awaited<ReturnType<typeof fixture>>) {
  const lockPath = join(portfolioControllerDirectory(f.host.definition.id, { root: f.root }), '.execution.lock');
  // Instrument one physical release in this child only. Effects and durable
  // records remain real; graph publication has not started yet.
  const code = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const original=fs.unlinkSync;fs.unlinkSync=function(path,...args){const result=original.call(this,path,...args);
if(path===${JSON.stringify(lockPath)})process.kill(process.pid,'SIGKILL');return result;};syncBuiltinESMExports();`;
  return `data:text/javascript,${encodeURIComponent(code)}`;
}
function engineeringCli(f: Awaited<ReturnType<typeof fixture>>) {
  const enrollment = join(base, 'engineering-enrollment.json');
  save(enrollment, { schemaVersion: 1, graphId: f.definition.id, host: f.host });
  // Only fixture setup creates provenance. The actual CLI inherits the isolated
  // test HOME and must use an existing key, never a test-key CLI option.
  loadOrCreateKey();
  const invoke = async (args: string[], crashAfterControllerRelease = false) => {
    const result = await exec(process.execPath, [
      ...(crashAfterControllerRelease ? ['--import', crashControllerReleasePreload(f)] : []),
      '--import', 'tsx', 'src/cli/index.ts', 'universe', 'firm', 'engineer',
      '--root', f.graphRoot, '--enrollment', enrollment, '--json', ...args], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    return JSON.parse(result.stdout);
  };
  return { invoke };
}

function treeEvidence(root: string): unknown {
  const files: Record<string, unknown> = {};
  const visit = (path: string, name: string) => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) { for (const entry of readdirSync(path).sort()) visit(join(path, entry), `${name}/${entry}`); }
    else { expect(stat.isFile()).toBe(true); files[name] = { digest: digest(readFileSync(path)), mode: stat.mode, nlink: stat.nlink }; }
  };
  visit(root, ''); return files;
}
function durableEngineeringEvidence(f: Awaited<ReturnType<typeof fixture>>) {
  return { universe: treeEvidence(f.root), ledger: treeEvidence(f.runtime.root),
    refs: git(f.repo, 'for-each-ref', '--format=%(refname) %(objectname)'), head: git(f.repo, 'rev-parse', 'HEAD'),
    index: digest(readFileSync(join(f.repo, '.git', 'index'))), checkout: git(f.repo, 'status', '--porcelain=v1') };
}
async function crashedEngineering(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options); const child = engineeringCli(f); const checked = await child.invoke(['--check']);
  await expect(child.invoke(['--expected-enrollment-digest', checked.enrollmentDigest], true)).rejects.toMatchObject({ signal: 'SIGKILL' });
  expect(f.fixtureErrors).toEqual([]); expect(f.requests).toHaveLength(3);
  const graph = readControlGraph(f.graphRoot);
  expect(graph.sourceState).toBe('healthy'); expect(graph.nodes[0]!.state).toBe('unresolved');
  expect(graph.traces.map((trace) => trace.action)).toEqual(['graph-created', 'graph-intent']);
  const definition = { ...f.definition, maxDurationMs: f.host.definition.maxDurationMs };
  const resume = (handler = f.binding.handler, root = f.graphRoot) => runControlGraph(definition, { root, handlers: { deliver: handler } });
  return { f, child, checked, graph, resume };
}

// The existing evaluated Universe engine requires real macOS confinement; these
// tests intentionally do not replace its evaluator or sandbox with a mock.
describe.runIf(process.platform === 'darwin')('firm engineering adapter integration', () => {
  it('rejects an incorrect candidate, measures correction and improvement, and delivers only an explicit local branch', async () => {
    const f = await fixture();
    writeFileSync(join(f.repo, 'value.json'), 'owner staged work\n'); git(f.repo, 'add', 'value.json');
    writeFileSync(join(f.repo, 'value.json'), 'owner unstaged work\n');
    const index = readFileSync(join(f.repo, '.git', 'index')); const checkout = git(f.repo, 'status', '--porcelain=v1');
    const result = await f.run(); expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(f.fixtureErrors).toEqual([]); expect(f.requests.map((request) => request.generation)).toEqual([1, 2, 3]);
    expect(f.requests[1]!.feedback).toMatchObject({ status: 'failed', score: -1 });
    expect(f.requests[2]!.feedback).toMatchObject({ status: 'passed', score: 2 });
    const universe = readUniverseOverview({ root: f.root }).universes[0]!;
    expect(universe.runs.map((run) => run.trials[0]!.score)).toEqual([-1, 2, 3]);
    expect(universe.runs.map((run) => run.trials[0]!.status)).toEqual(['failed', 'passed', 'passed']);
    expect(universe.runs.map((run) => run.trials[0]!.selected)).toEqual([false, true, true]);
    const ledger = f.status(); expect(ledger.attempts).toHaveLength(3);
    for (const run of universe.runs) {
      const trial = run.trials[0]!; const resource = trial.generation!.resource!;
      const receipt = ledger.attempts.find((attempt) => attempt.id === resource.taskId)!;
      expect(receipt).toMatchObject({ status: 'completed', capacityKey: 'one-shared-account', inputTokens: 20, outputTokens: 10, verifiedAccepted: false });
      expect(resource.receiptDigest).toBe(digest(canonical(receipt))); expect(resource.taskDigest).toBe(receipt.taskDigest);
      expect(artifactDigest(trial.artifact!.path)).toBe(trial.artifact!.digest);
      expect(readFileSync(join(trial.artifact!.path, 'evaluate.mjs'), 'utf8')).toBe(evaluator);
    }
    expect(readUniverseCampaign(f.campaignId, { root: f.root }).progress).toMatchObject({ attempts: 3, admissions: 1, improvements: 1, reportedTokens: 90 });
    const deliveries = readUniverseDeliveries(f.manifest.id, { root: f.root }); expect(deliveries.sourceState).toBe('healthy');
    expect(deliveries.deliveries).toHaveLength(1); const delivery = deliveries.deliveries[0]!;
    expect(delivery).toMatchObject({ status: 'delivered', branch: f.branch, baseCommit: f.revision });
    expect(git(f.repo, 'show', `${delivery.commit}:value.json`)).toBe('3');
    expect(git(f.repo, 'rev-parse', `refs/heads/${f.branch}`)).toBe(delivery.commit);
    expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/codex/')).toBe(`refs/heads/${f.branch}`);
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.revision); expect(git(f.repo, 'status', '--porcelain=v1')).toBe(checkout);
    expect(readFileSync(join(f.repo, '.git', 'index'))).toEqual(index); expect(readFileSync(join(f.repo, 'value.json'), 'utf8')).toBe('owner unstaged work\n');
    expect(git(f.repo, 'remote')).toBe(''); expect(readdirSync(f.workspace)).toEqual(['.git']);
    expect(result.traces.every((trace) => verifyDecisionTraceV1(trace, traceKeys))).toBe(true);
    expect(result.traces.find((trace) => trace.action === 'graph-settled')?.verifier).toMatchObject({ verdict: 'pass', independent: true });
    const replay = await f.run(); expect(replay).toEqual(result); expect(f.requests).toHaveLength(3); expect(f.status().attempts).toEqual(ledger.attempts);
    expect(readUniverseDeliveries(f.manifest.id, { root: f.root })).toEqual(deliveries);
  });

  it('never equates successful worker completion with evaluator acceptance or local delivery', async () => {
    const f = await fixture({ allInvalid: true }); const result = await f.run();
    expect(result.nodes[0]!.state).toBe('rejected'); expect(f.requests).toHaveLength(3); expect(f.fixtureErrors).toEqual([]);
    expect(f.status().attempts.every((attempt) => attempt.status === 'completed' && !attempt.verifiedAccepted)).toBe(true);
    const universe = readUniverseOverview({ root: f.root }).universes[0]!;
    expect(universe.runs.every((run) => run.trials.every((trial) => trial.status === 'failed' && !trial.selected))).toBe(true);
    expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/codex/')).toBe('');
    expect(result.traces.find((trace) => trace.action === 'graph-settled')?.verifier?.verdict).not.toBe('pass');
    await f.run(); expect(f.requests).toHaveLength(3);
  });

  it.each([
    { kind: 'deliver' as const, copied: true }, { kind: 'explore' as const, copied: true },
    { kind: 'explore' as const, copied: false },
  ])('reserves engineering metadata for the branded deliver path ($kind, copied=$copied)', async ({ kind, copied }) => {
    const f = await fixture(); let invoked = 0;
    const forged = { ...f.binding.handler, run: async () => { invoked++; return { artifact: { verifiedAccepted: true },
      outcome: 'completed' as const, verifier: { id: 'synthetic', verdict: 'pass' as const, independent: true } }; } };
    const graph = structuredClone(f.definition); graph.nodes[0]!.kind = kind;
    const result = await runControlGraph(graph, { root: f.graphRoot, traceKeys, handlers: { [kind]: copied ? forged : f.binding.handler } });
    expect(invoked).toBe(0); expect(result.nodes[0]!.state).toBe('pending'); expect(f.requests).toEqual([]);
    expect(result.reasons).toContain(`${f.host.nodeId}:existing-effect-gate-required`);
    expect(result.traces.some((trace) => trace.authority.effectClass === 'engineering-portfolio-local-delivery')).toBe(false);
    expect(existsSync(f.runtime.root)).toBe(false); expect(git(f.repo, 'branch', '--list', f.branch)).toBe('');
  });

  it.each(['digest', 'command', 'node'] as const)('rejects graph %s drift before invoking the resource transport', async (mode) => {
    const f = await fixture(); const graph = structuredClone(f.definition); const node = graph.nodes[0]!;
    if (mode === 'digest') node.input = { ...f.binding.nodeInput, requestDigest: 'a'.repeat(64) };
    if (mode === 'command') node.input = { ...f.binding.nodeInput, command: 'arbitrary', resourceRuntime: f.resourceRuntime };
    if (mode === 'node') node.id = 'not-enrolled';
    const result = await f.run(graph); expect(result.nodes[0]!.state).toBe('rejected');
    expect(f.requests).toEqual([]); expect(existsSync(f.runtime.root)).toBe(false);
    expect(git(f.repo, 'branch', '--list', f.branch)).toBe('');
  });

  it('rejects a changed runtime ledger pin before any resource attempt', async () => {
    const f = await fixture(); const changedRoot = join(base, 'different-ledger');
    save(f.resourceRuntime, { ...f.runtime, root: changedRoot });
    const result = await f.run(); expect(result.nodes[0]!.state).toBe('rejected'); expect(f.requests).toEqual([]);
    expect(existsSync(f.runtime.root)).toBe(false); expect(existsSync(changedRoot)).toBe(false);
  });

  it.each([false, true])('refuses to attribute a previously completed controller with held execution lock=%s to a new graph intent', async (held) => {
    const f = await fixture();
    const prior = await runUniversePortfolioController(f.host.definition, { root: f.root, resourceRuntime: f.resourceRuntime,
      expectedResourceRuntimeDigest: f.host.expectedRuntimeDigest, deliveryPlan: f.host.deliveryPlan });
    expect(prior.status, JSON.stringify(prior)).toBe('completed'); expect(f.requests).toHaveLength(3);
    const ledger = f.status(); const deliveries = readUniverseDeliveries(f.manifest.id, { root: f.root });
    const directory = portfolioControllerDirectory(f.host.definition.id, { root: f.root });
    const lock = held ? acquireLocalStoreLockWithOutcome(join(directory, '.execution.lock'), 0,
      { anchorPath: directory, exactPrivateStorage: true }) : null;
    if (held) expect(lock?.state).toBe('acquired');
    try {
      const result = await f.run(); expect(result.nodes[0]!.state).toBe('rejected');
    } finally { if (lock?.state === 'acquired') expect(releaseLocalStoreLock(lock.lock)).toBe(true); }
    expect(f.requests).toHaveLength(3); expect(f.status().attempts).toEqual(ledger.attempts);
    expect(readUniverseDeliveries(f.manifest.id, { root: f.root })).toEqual(deliveries);
  });

  it('rechecks the enrolled runtime between measured generations instead of switching ledgers', async () => {
    const f = await fixture({ driftRuntimeAfterFirst: true }); const result = await f.run();
    expect(result.nodes[0]!.state).toBe('rejected'); expect(f.fixtureErrors).toEqual([]); expect(f.requests).toHaveLength(1);
    expect(f.status().attempts).toHaveLength(1); expect(existsSync(join(base, 'redirected-ledger'))).toBe(false);
    expect(git(f.repo, 'branch', '--list', f.branch)).toBe('');
  });

  it('stops a live resource request at the shorter graph deadline and never retries the interrupted execution', async () => {
    const f = await fixture({ graphDurationMs: 10_000, hang: true }); const result = await f.run();
    expect(f.requests).toHaveLength(1); expect(result.status).not.toBe('completed');
    expect(git(f.repo, 'branch', '--list', f.branch)).toBe('');
    const controller = readUniversePortfolioController(f.host.definition.id, { root: f.root });
    expect(controller.deadlineAt).not.toBeNull();
    // The durable controller allowance is immutable; the graph only shortens
    // effective execution, including the already pending worker request.
    expect(Date.parse(controller.deadlineAt!)).toBeGreaterThan(Date.parse(result.deadlineAt!));
    expect(controller.status).not.toBe('completed');
    const ledger = f.status(); expect(ledger.attempts).toHaveLength(1);
    expect(['cancelled', 'timed-out']).toContain(ledger.attempts[0]!.status);
    expect(Date.parse(ledger.attempts[0]!.finishedAt!)).toBeLessThan(Date.parse(controller.deadlineAt!));
    // Allow bounded settlement grace, but not the worker's independent 20s timeout.
    expect(Date.parse(ledger.attempts[0]!.finishedAt!)).toBeLessThanOrEqual(Date.parse(result.deadlineAt!) + 5000);
    const resumed = await f.run(); expect(resumed.deadlineAt).toBe(result.deadlineAt);
    expect(f.requests).toHaveLength(1); expect(f.status().attempts).toEqual(ledger.attempts);
  });

  it('checks, executes and replays the real CLI using existing isolated-home provenance', async () => {
    const f = await fixture(); const child = engineeringCli(f);
    const cli = (...args: string[]) => child.invoke(args);
    const checked = await cli('--check');
    expect(checked).toMatchObject({ status: 'validated-enrollment', effectsExecuted: false, providerContacted: false });
    expect(checked.enrollmentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(readdirSync(f.graphRoot)).toEqual([]); expect(f.requests).toEqual([]); expect(existsSync(f.runtime.root)).toBe(false);
    const completed = await cli('--expected-enrollment-digest', checked.enrollmentDigest);
    expect(completed.status).toBe('completed'); expect(completed.sourceState).toBe('healthy');
    expect(f.requests).toHaveLength(3); expect(f.fixtureErrors).toEqual([]);
    const ledger = f.status(); expect(ledger.attempts).toHaveLength(3);
    expect(git(f.repo, 'show', `${f.branch}:value.json`)).toBe('3');
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.revision); expect(git(f.repo, 'status', '--porcelain=v1')).toBe('');
    const deliveries = readUniverseDeliveries(f.manifest.id, { root: f.root });
    expect(await cli('--expected-enrollment-digest', checked.enrollmentDigest)).toEqual(completed);
    expect(f.requests).toHaveLength(3); expect(f.status().attempts).toEqual(ledger.attempts);
    expect(readUniverseDeliveries(f.manifest.id, { root: f.root })).toEqual(deliveries);
  });

  it('reconciles authentic completed evidence after a child crash before graph settlement without replaying any effect', async () => {
    const { f, child, checked, graph } = await crashedEngineering();
    expect(graph.traces.every((trace) => verifyDecisionTraceV1(trace))).toBe(true);
    expect(readUniversePortfolioController(f.host.definition.id, { root: f.root })).toMatchObject({ sourceState: 'healthy', status: 'completed' });
    expect(f.status().attempts).toHaveLength(3); expect(git(f.repo, 'show', `${f.branch}:value.json`)).toBe('3');
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.revision); expect(git(f.repo, 'status', '--porcelain=v1')).toBe('');
    expect(readdirSync(join(f.graphRoot, 'control-graph', 'staging'))).toEqual([]);
    expect(existsSync(join(f.graphRoot, 'control-graph', '.records.lock'))).toBe(false);
    const before = durableEngineeringEvidence(f);
    const recovered = await child.invoke(['--expected-enrollment-digest', checked.enrollmentDigest]);
    expect(recovered).toMatchObject({ status: 'completed', sourceState: 'healthy', deadlineAt: graph.deadlineAt });
    expect(recovered.traces).toHaveLength(3); expect(recovered.traces.slice(0, 2)).toEqual(graph.traces);
    expect(recovered.traces.every((trace: Parameters<typeof verifyDecisionTraceV1>[0]) => verifyDecisionTraceV1(trace))).toBe(true);
    const settlement = JSON.parse(readFileSync(join(f.graphRoot, 'control-graph', 'records', '00000002.json'), 'utf8'));
    expect(settlement.data.artifact).toMatchObject({ reason: 'engineering-reconciled', verifiedAccepted: true });
    const created = JSON.parse(readFileSync(join(portfolioControllerDirectory(f.host.definition.id, { root: f.root }), 'ledger', 'records', '00000000.json'), 'utf8'));
    const intent = JSON.parse(readFileSync(join(f.graphRoot, 'control-graph', 'records', '00000001.json'), 'utf8'));
    expect(settlement.data.artifact.graphDispatch).toEqual(created.enrollment.graphDispatch);
    expect(created.enrollment.graphDispatch).toEqual({ schemaVersion: 1, graphRootDigest: digest(canonical(f.graphRoot)),
      graphId: f.definition.id, definitionDigest: graph.definitionDigest, nodeId: f.host.nodeId, intentDigest: digest(canonical(intent)) });
    expect(durableEngineeringEvidence(f)).toEqual(before); expect(f.requests).toHaveLength(3);
    expect(await child.invoke(['--expected-enrollment-digest', checked.enrollmentDigest])).toEqual(recovered);
    expect(durableEngineeringEvidence(f)).toEqual(before); expect(f.requests).toHaveLength(3);
  });

  it('withholds recovery for missing or mismatched attribution, copied authority, relocated graph and drifted branch', async () => {
    const { f, graph, resume } = await crashedEngineering();
    const controllerFile = join(portfolioControllerDirectory(f.host.definition.id, { root: f.root }), 'ledger', 'records', '00000000.json');
    const original = readFileSync(controllerFile, 'utf8'); const created = JSON.parse(original);
    const graphRecords = treeEvidence(join(f.graphRoot, 'control-graph'));
    const unchanged = async (operation: () => ReturnType<typeof resume>) => {
      const before = durableEngineeringEvidence(f); const result = await operation();
      expect(result.nodes[0]?.state, JSON.stringify(result)).toBe('unresolved'); expect(result.deadlineAt).toBe(graph.deadlineAt);
      expect(treeEvidence(join(f.graphRoot, 'control-graph'))).toEqual(graphRecords);
      expect(durableEngineeringEvidence(f)).toEqual(before); expect(f.requests).toHaveLength(3);
    };
    await unchanged(() => resume({ ...f.binding.handler }));
    const owner = acquireLocalStoreLockWithOutcome(join(f.graphRoot, '.control-execution.lock'), 0,
      { anchorPath: f.graphRoot, exactPrivateStorage: true });
    expect(owner.state).toBe('acquired');
    try { await unchanged(() => resume()); }
    finally { if (owner.state === 'acquired') expect(releaseLocalStoreLock(owner.lock)).toBe(true); }
    for (const field of ['missing', 'graphRootDigest', 'graphId', 'definitionDigest', 'nodeId', 'intentDigest']) {
      const changed = structuredClone(created);
      if (field === 'missing') delete changed.enrollment.graphDispatch;
      else changed.enrollment.graphDispatch[field] = field.endsWith('Id') ? 'different-fixture-id' : 'f'.repeat(64);
      try {
        writeFileSync(controllerFile, `${canonical(changed)}\n`);
        expect(readUniversePortfolioController(f.host.definition.id, { root: f.root }).sourceState, field).toBe('healthy');
        await unchanged(() => resume());
      } finally { writeFileSync(controllerFile, original); }
    }
    const relocated = join(base, 'relocated-graph'); mkdirSync(relocated, { mode: 0o700 });
    cpSync(join(f.graphRoot, 'control-graph'), join(relocated, 'control-graph'), { recursive: true });
    for (const path of ['control-graph', 'control-graph/records', 'control-graph/staging']) chmodSync(join(relocated, path), 0o700);
    expect(readControlGraph(relocated).sourceState, JSON.stringify(readControlGraph(relocated))).toBe('healthy');
    const relocatedBefore = treeEvidence(join(relocated, 'control-graph'));
    await unchanged(() => resume(f.binding.handler, relocated));
    expect(treeEvidence(join(relocated, 'control-graph'))).toEqual(relocatedBefore);
    const delivered = git(f.repo, 'rev-parse', `refs/heads/${f.branch}`);
    try {
      git(f.repo, 'update-ref', `refs/heads/${f.branch}`, f.revision, delivered);
      await unchanged(() => resume());
    } finally { git(f.repo, 'update-ref', `refs/heads/${f.branch}`, delivered, f.revision); }
    expect((await resume()).status).toBe('completed'); expect(f.requests).toHaveLength(3);
  });

  it('withholds crash recovery under KILL and deterministic clock advancement without renewing the original deadline', async () => {
    const { f, graph, resume } = await crashedEngineering(); const before = durableEngineeringEvidence(f);
    const graphRecords = treeEvidence(join(f.graphRoot, 'control-graph')); const kill = join(f.graphRoot, 'KILL');
    writeFileSync(kill, 'isolated fixture stop\n', { mode: 0o600 });
    try { expect(await resume()).toMatchObject({ status: 'stopped', reasons: ['kill-switch'] }); }
    finally { rmSync(kill); }
    // Clock advancement only: native crash/evaluation above uses real time.
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(graph.deadlineAt!) + 1);
    try {
      expect(await resume()).toMatchObject({ status: 'stopped', deadlineAt: graph.deadlineAt, reasons: ['duration-exhausted'] });
    } finally { vi.useRealTimers(); }
    expect(treeEvidence(join(f.graphRoot, 'control-graph'))).toEqual(graphRecords);
    expect(durableEngineeringEvidence(f)).toEqual(before); expect(f.requests).toHaveLength(3);
  });

  it('never recovers an incomplete controller even when every worker request has a completed receipt', async () => {
    const { f, resume } = await crashedEngineering({ allInvalid: true });
    expect(readUniversePortfolioController(f.host.definition.id, { root: f.root }).status).not.toBe('completed');
    expect(f.status().attempts.every((row) => row.status === 'completed')).toBe(true);
    const before = durableEngineeringEvidence(f); const graphRecords = treeEvidence(join(f.graphRoot, 'control-graph'));
    expect((await resume()).nodes[0]!.state).toBe('unresolved');
    expect(durableEngineeringEvidence(f)).toEqual(before); expect(treeEvidence(join(f.graphRoot, 'control-graph'))).toEqual(graphRecords);
    expect(f.requests).toHaveLength(3); expect(git(f.repo, 'branch', '--list', f.branch)).toBe('');
  });

  it('unlocks a dependent consumer once from recovered engineering evidence without another worker request', async () => {
    const f = await fixture(); loadOrCreateKey();
    const graph: ControlGraphDefinition = { ...f.definition, nodes: [...f.definition.nodes,
      { id: 'consume-delivery', kind: 'plan', requires: [f.host.nodeId], input: {} }] };
    const graphModule = pathToFileURL(join(process.cwd(), 'src/core/universe/control-graph.ts')).href;
    const adapterModule = pathToFileURL(join(process.cwd(), 'src/core/universe/firm-engineering-control-handler.ts')).href;
    const script = `import {runControlGraph} from ${JSON.stringify(graphModule)};
import {createFirmEngineeringControlHandler} from ${JSON.stringify(adapterModule)};
const binding=createFirmEngineeringControlHandler(${JSON.stringify(f.host)});
await runControlGraph(${JSON.stringify(graph)},{root:${JSON.stringify(f.graphRoot)},handlers:{deliver:binding.handler,
plan:async()=>{throw new Error('Consumer must not run before the injected crash');}}});`;
    await expect(exec(process.execPath, ['--import', crashControllerReleasePreload(f), '--import', 'tsx',
      '--input-type=module', '--eval', script], { timeout: 60_000, maxBuffer: 1024 * 1024 })).rejects.toMatchObject({ signal: 'SIGKILL' });
    const interrupted = readControlGraph(f.graphRoot);
    expect(interrupted.nodes.map((node) => node.state)).toEqual(['unresolved', 'pending']);
    const before = durableEngineeringEvidence(f); let consumed = 0;
    const resume = () => runControlGraph(graph, { root: f.graphRoot, handlers: { deliver: f.binding.handler, plan: async ({ artifacts }) => {
      consumed++; expect(artifacts).toHaveLength(1);
      expect(artifacts[0]!.value).toMatchObject({ reason: 'engineering-reconciled', verifiedAccepted: true });
      return { artifact: { consumedDigest: artifacts[0]!.digest } };
    } } });
    const recovered = await resume(); expect(recovered.status).toBe('completed'); expect(consumed).toBe(1);
    expect(recovered.deadlineAt).toBe(interrupted.deadlineAt); expect(recovered.traces).toHaveLength(5);
    expect(durableEngineeringEvidence(f)).toEqual(before); expect(f.requests).toHaveLength(3);
    expect(await resume()).toEqual(recovered); expect(consumed).toBe(1);
    expect(durableEngineeringEvidence(f)).toEqual(before); expect(f.requests).toHaveLength(3);
  });

  it('honors graph-local KILL without changing the host kill switch or creating a worker ledger', async () => {
    const f = await fixture(); writeFileSync(join(f.graphRoot, 'KILL'), 'fixture stop\n', { mode: 0o600 });
    const result = await f.run(); expect(result.status).toBe('stopped'); expect(result.reasons).toContain('kill-switch');
    expect(f.requests).toEqual([]); expect(existsSync(f.runtime.root)).toBe(false); expect(git(f.repo, 'branch', '--list', f.branch)).toBe('');
  });

  it('resuming an unhandled graph does not renew its original fixed deadline', async () => {
    const f = await fixture({ graphDurationMs: 80 });
    const initial = await runControlGraph(f.definition, { root: f.graphRoot, traceKeys, handlers: {} });
    expect(initial.deadlineAt).not.toBeNull(); expect(initial.nodes[0]!.state).toBe('pending');
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, Date.parse(initial.deadlineAt!) - Date.now() + 20)));
    const resumed = await f.run(); expect(resumed.deadlineAt).toBe(initial.deadlineAt); expect(resumed.status).toBe('stopped');
    expect(resumed.reasons).toContain('duration-exhausted'); expect(f.requests).toEqual([]); expect(existsSync(f.runtime.root)).toBe(false);
  });
});
