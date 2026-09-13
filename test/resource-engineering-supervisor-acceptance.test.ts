/** Real HTTP, Git, confined evaluation and shared-account ledger acceptance.
 * Every model request terminates at this test's loopback listener.
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { resourcePoolStatus } from '../src/core/resources/pool-runtime.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import type { ResourceConsoleEngineeringEnrollment, ResourceConsoleEngineeringJob } from '../src/core/resources/console-engineering-types.js';
import { startResourceConsoleServer, type ResourceConsoleServerHandle, type ResourceConsoleServerOptions } from '../src/core/web/resource-console-server.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { readControlGraph } from '../src/core/universe/control-graph.js';
import { portfolioControllerDirectory, readPortfolioControllerEvents } from '../src/core/universe/portfolio-controller-store.js';
import type { ResourceConsoleEngineeringSupervisionSnapshot } from '../src/core/resources/console-engineering-supervisor-types.js';
import { type FirmEngineeringControlHost } from '../src/core/universe/firm-engineering-control-handler.js';
import { initUniverse, initUniverseCampaign, readUniverseCampaign, readUniverseDeliveries, type UniverseManifest } from '../src/core/universe/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { vi.restoreAllMocks(); vi.useRealTimers(); }
});
const save = (path: string, value: unknown) => writeFileSync(path, `${canonical(value)}\n`, { mode: 0o600 });
function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
  }).trim();
}
function http(handle: ResourceConsoleServerHandle, path: string, body?: unknown, headers?: Record<string, string>) {
  return new Promise<{ status: number; text: string; noStore: boolean }>((resolve, reject) => {
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ hostname: '127.0.0.1', port: handle.port, path, method: bytes === undefined ? 'GET' : 'POST', agent: false,
      headers: { ...(bytes === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(bytes)) }),
        ...(headers ?? (bytes === undefined ? { 'x-ashlr-token': handle.readToken }
          : { 'x-ashlr-token': handle.controlToken!, origin: handle.url })) } }, (res) => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 2 * 1024 * 1024) req.destroy(new Error('Fixture response overflow')); else chunks.push(chunk); });
      res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString('utf8'),
        noStore: res.headers['cache-control'] === 'no-store' }));
    });
    req.on('error', reject); req.setTimeout(10_000, () => req.destroy(new Error('Fixture HTTP timeout'))); req.end(bytes);
  });
}
const engineeringPath = '/api/resources/engineering';
async function enrollments(handle: ResourceConsoleServerHandle) {
  const response = await http(handle, engineeringPath); expect(response.status, response.text).toBe(200);
  expect(response.noStore).toBe(true); return JSON.parse(response.text) as ResourceConsoleEngineeringEnrollment[];
}
async function status(handle: ResourceConsoleServerHandle, id = 'engineering-default') {
  const response = await http(handle, `${engineeringPath}/${id}`); expect(response.status, response.text).toBe(200);
  expect(response.noStore).toBe(true); return JSON.parse(response.text) as ResourceConsoleEngineeringJob;
}
async function fixture(options: { holdEngineering?: boolean; maxConcurrent?: number; twoCampaigns?: boolean } = {}) {
  expect(homedir()).not.toBe(process.env.ASHLR_VITEST_REAL_HOME);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-http-acceptance-')));
  const repo = join(base, 'project'); const second = join(base, 'second'); const transport = join(base, 'sterile-transport');
  const universeRoot = join(base, 'universe'); const graphRoot = join(base, 'graph');
  for (const path of [repo, second, transport, graphRoot]) mkdirSync(path, { mode: 0o700 });
  git(repo, 'init', '-q', '--template=', '--initial-branch=main'); git(transport, 'init', '-q', '--template=', '--initial-branch=main');
  writeFileSync(join(repo, 'value.json'), '0\n'); writeFileSync(join(repo, 'private.txt'), 'PRIVATE_ENGINEERING_CONTENT');
  writeFileSync(join(repo, 'evaluate.mjs'), `import {readFileSync} from 'node:fs';import {join} from 'node:path';
const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));
console.log(JSON.stringify({passed:Number.isInteger(value)&&value===1,score:value,metrics:{value},
diagnostics:value<0?[{code:'NONNEGATIVE',message:'Value must be nonnegative',path:'value.json',line:1}]:[]}));`);
  git(repo, 'add', '.'); git(repo, '-c', 'user.name=HTTP Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixed evaluator');
  const revision = git(repo, 'rev-parse', 'HEAD');
  const requests: Array<{ kind: 'ordinary' | 'engineering'; generation?: number; campaignId?: string; feedback?: { status: string; score: number } }> = [];
  const errors: string[] = []; let ordinary: ServerResponse | undefined; let active = 0; let peak = 0;
  const reply = (res: ServerResponse, content: string) => res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
  const worker = createServer((req, res) => {
    active++; peak = Math.max(peak, active); res.once('close', () => { active--; });
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8')); const prompt = input.messages[0].content;
        if (prompt === 'ordinary-held' || prompt === 'ordinary-fast') {
          requests.push({ kind: 'ordinary' }); if (prompt === 'ordinary-held') ordinary = res; else reply(res, 'ordinary-completed'); return;
        }
        expect(prompt).not.toContain('PRIVATE_ENGINEERING_CONTENT');
        const messages = JSON.parse(prompt) as Array<{ role: string; content: string }>;
        const generation = JSON.parse(messages.find((message) => message.role === 'user')!.content);
        requests.push({ kind: 'engineering', generation: generation.generation, campaignId: generation.seedContext?.source.campaignId, feedback: generation.feedback });
        if (options.holdEngineering) return;
        const value = 1; if (generation.generation !== 1) throw new Error('Unexpected generation');
        reply(res, JSON.stringify({ operations: [{ op: 'replace', path: 'value.json', content: `${value}\n` }] }));
      } catch (error) { errors.push(String(error)); res.writeHead(500); res.end('Fixture rejected unexpected protocol'); }
    });
  });
  await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve));
  const address = worker.address(); if (!address || typeof address === 'string') throw new Error('Fixture worker unavailable');
  const pool = validateResourcePool({ schemaVersion: 1, id: 'engineering-http', workers: [{ id: 'local-worker', provider: 'local', model: 'inert',
    maxConcurrent: options.maxConcurrent ?? 1, reservePercent: 10, maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1 }] });
  const bindings = validateResourceBindings([{ workerId: 'local-worker', capacityKey: 'shared-account', kind: 'local-chat',
    endpoint: `http://127.0.0.1:${address.port}/v1` }], pool);
  const observations = [{ workerId: 'local-worker', health: 'ready' as const, windows: [], retryAfter: null,
    observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 180_000).toISOString() }];
  const serverOptions: ResourceConsoleServerOptions = { root: join(base, 'shared-ledger'), workspace: repo, execute: true,
    projectsFile: join(base, 'projects.json'), engineeringFile: join(base, 'engineering.json'),
    poolFile: join(base, 'pool.json'), bindingsFile: join(base, 'bindings.json'), observationsFile: join(base, 'observations.json') };
  save(serverOptions.poolFile, pool); save(serverOptions.bindingsFile, bindings); save(serverOptions.observationsFile, observations);
  save(serverOptions.projectsFile!, { schemaVersion: 1, projects: [{ id: 'second', label: 'Second project', workspace: second }] });
  const runtime = { schemaVersion: 1, root: serverOptions.root, workspace: transport, poolPath: serverOptions.poolFile,
    bindingsPath: serverOptions.bindingsFile, observationsPath: serverOptions.observationsFile, capacityWaitMs: 15_000 };
  const resourceRuntime = join(base, 'runtime.json'); save(resourceRuntime, runtime);
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'engineering-http', name: 'Engineering HTTP fixture', objective: 'Improve a bounded integer',
    seed: { repo, revision }, metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 25_000, trialTimeoutMs: 20_000 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3000 },
    variants: [{ id: 'repair', niche: 'value', hypothesis: 'Correct the measured value', generation: { kind: 'resource-pool', poolId: pool.id,
      poolDigest: digest(canonical({ pool, bindings })), allowedWorkerIds: ['local-worker'], files: ['value.json'], maxOutputTokens: 256,
      fileOperations: { schemaVersion: 1, contextFiles: [] } } }] };
  initUniverse(manifest, { root: universeRoot }); const campaignId = 'http-campaign';
  initUniverseCampaign({ schemaVersion: 1, id: campaignId, universeId: manifest.id, feedback: true, measureSeed: true,
    budget: { maxGenerations: 1, maxDurationMs: 45_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: null } }, { root: universeRoot });
  const branch = 'codex/http-engineering';
  const host: FirmEngineeringControlHost = { nodeId: 'deliver-http', root: universeRoot, constitutionVersion: 'fixture-v1', policyEpoch: 1,
    definition: { schemaVersion: 1, id: 'http-controller', tasks: [{ campaignId, dependsOn: [] }], maxParallel: 1, maxDurationMs: 120_000 },
    deliveryPlan: { schemaVersion: 1, deliveries: [{ campaignId, branch, baseCommit: revision, allowInitialRepair: true }] }, resourceRuntime,
    expectedRuntimeDigest: digest(canonical(runtime)) };
  const child = 'second-campaign'; const childUniverse = 'second-universe';
  if (options.twoCampaigns) {
    initUniverse({ ...manifest, id: childUniverse }, { root: universeRoot });
    initUniverseCampaign({ schemaVersion: 1, id: child, universeId: childUniverse, feedback: true, measureSeed: true,
      budget: { maxGenerations: 1, maxDurationMs: 45_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: null } }, { root: universeRoot });
    host.allowPendingContinuation = true;
    host.definition.tasks.push({ campaignId: child, dependsOn: [campaignId] });
    host.deliveryPlan.deliveries.push({ campaignId: child, branch: 'codex/second-result', baseCommit: revision, allowInitialRepair: true });
  }
  const catalog = { schemaVersion: 1, enrollments: [{ id: 'engineering-default', projectId: 'default', graphId: 'http-graph', graphRoot, host }] };
  save(serverOptions.engineeringFile!, catalog); loadOrCreateKey();
  const handles: ResourceConsoleServerHandle[] = [];
  cleanups.push(async () => {
    for (const handle of handles) await handle.close();
    worker.closeAllConnections(); await new Promise<void>((resolve) => worker.close(() => resolve()));
    const writable = (path: string): void => { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name)); };
    writable(base); rmSync(base, { recursive: true, force: true });
  });
  const start = async (overrides: Partial<ResourceConsoleServerOptions> = {}) => { const handle = await startResourceConsoleServer({ ...serverOptions, ...overrides }); handles.push(handle); return handle; };
  const ledger = () => resourcePoolStatus(serverOptions.root, pool, bindings, observations).attempts;
  return { base, repo, second, revision, transport, universeRoot, graphRoot, branch, campaignId, child, childUniverse, host, serverOptions, catalog, requests, errors,
    start, ledger, peak: () => peak, active: () => active,
    releaseOrdinary: () => { expect(ordinary).toBeDefined(); reply(ordinary!, 'ordinary-completed'); } };
}


type Fixture = Awaited<ReturnType<typeof fixture>>;
const supervisionPath = '/api/resources/engineering-supervision';
async function supervision(handle: ResourceConsoleServerHandle) {
  const result = await http(handle, supervisionPath); expect(result.status, result.text).toBe(200); expect(result.noStore).toBe(true);
  return JSON.parse(result.text) as ResourceConsoleEngineeringSupervisionSnapshot;
}
async function pause(handle: ResourceConsoleServerHandle, paused: boolean) {
  const before = await supervision(handle);
  const result = await http(handle, supervisionPath, { paused, expectedRevision: before.revision });
  expect(result.status, result.text).toBe(200); return JSON.parse(result.text) as ResourceConsoleEngineeringSupervisionSnapshot;
}
async function configure(f: Fixture, pausedQueue = false) {
  const discovery = await f.start(); const rows = await enrollments(discovery);
  expect(f.requests).toEqual([]); expect((await status(discovery)).launched).toBe(false);
  expect(readdirSync(f.graphRoot)).toEqual([]);
  if (pausedQueue) expect((await http(discovery, '/api/resources/queue', { paused: true })).status).toBe(200);
  await discovery.close();
  const file = join(f.base, 'supervision.json');
  save(file, { schemaVersion: 1, id: 'fixture-supervision', maxDurationMs: 180_000, pollIntervalMs: 100,
    maxConcurrent: 1, maxAttemptsPerEnrollment: 4, enrollments: rows.map(row => ({ enrollmentId: row.id, expectedEnrollmentDigest: row.enrollmentDigest })) });
  return { engineeringSupervisionFile: file };
}
async function until(check: () => Promise<boolean>, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() >= deadline) throw new Error('Fixture condition not reached'); await new Promise(resolve => setTimeout(resolve, 100)); }
}

/** An actual foreground CLI process: no test-only execution entry or provider adapter. */
async function cli(f: Fixture, config: { engineeringSupervisionFile: string }, preload?: string) {
  const s = f.serverOptions;
  const args = [...(preload ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`] : []), '--import', 'tsx',
    'src/cli/index.ts', 'resources', 'pool', 'console', '--root', s.root, '--pool', s.poolFile,
    '--bindings', s.bindingsFile, '--observations', s.observationsFile, '--execute', '--workspace', s.workspace!,
    '--projects', s.projectsFile!, '--engineering', s.engineeringFile!, '--engineering-supervision', config.engineeringSupervisionFile,
    '--port', '0', '--json'];
  const child = spawn(process.execPath, args, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = ''; let exited = false;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); });
  });
  child.stdout.on('data', chunk => { output += String(chunk); if (output.length > 128 * 1024) child.kill('SIGKILL'); });
  child.stderr.on('data', chunk => { errors += String(chunk); if (errors.length > 128 * 1024) child.kill('SIGKILL'); });
  const close = async () => { if (!exited) child.kill('SIGTERM'); return exit; };
  cleanups.push(async () => { if (!exited) { child.kill('SIGKILL'); await exit; } });
  await until(async () => output.includes('\n') || exited, 15_000);
  // Startup tokens remain in memory and are never included in failure output.
  const startup = JSON.parse(output.split('\n')[0]!);
  if (!Number.isInteger(startup.port)) throw new Error(`Fixture CLI startup failed: ${startup.error ?? 'no startup metadata'}`);
  const handle = { ...startup, close: async () => { await close(); } } as ResourceConsoleServerHandle;
  return { handle, exit, close, kill: () => child.kill('SIGKILL') };
}

describe.runIf(process.platform === 'darwin')('console-owned engineering supervision actual acceptance', () => {
  it('automatically executes evaluated work over the ordinary shared ledger, then restarts without replay', async () => {
    const f = await fixture(); const config = await configure(f, true); const handle = await f.start(config);
    await pause(handle, true);
    expect((await http(handle, '/api/resources/queue', { paused: false })).status).toBe(200);
    expect((await http(handle, '/api/resources/tasks', { id: 'ordinary-shared', projectId: 'second', prompt: 'ordinary-held',
      allowedWorkerIds: ['local-worker'], mode: 'read-only', timeoutMs: 30_000, maxOutputTokens: 100 })).status).toBe(202);
    await until(async () => f.requests.length === 1);
    expect(f.requests).toEqual([{ kind: 'ordinary' }]); expect(f.ledger()).toHaveLength(1);
    const before = await pause(handle, false);
    // No /engineering/start request is made anywhere in this test.
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(f.requests).toEqual([{ kind: 'ordinary' }]);
    f.releaseOrdinary();
    await until(async () => (await status(handle)).state === 'completed');
    expect(f.errors).toEqual([]); expect(f.requests.map(row => row.kind)).toEqual(['ordinary', 'engineering']);
    expect(f.peak()).toBe(1); const receipts = f.ledger();
    expect(receipts).toHaveLength(2); expect(receipts.every(row => row.status === 'completed' && row.capacityKey === 'shared-account')).toBe(true);
    expect(receipts.some(row => row.id === 'ordinary-shared')).toBe(true);
    expect(git(f.repo, 'show', `${f.branch}:value.json`)).toBe('1');
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.revision); expect(git(f.repo, 'status', '--porcelain=v1')).toBe('');
    const graph = readControlGraph(f.graphRoot); const completed = await supervision(handle);
    expect(completed.deadlineAt).toBe(before.deadlineAt);
    await handle.close(); const restarted = await f.start(config);
    expect((await supervision(restarted)).deadlineAt).toBe(before.deadlineAt);
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(readControlGraph(f.graphRoot)).toEqual(graph); expect(f.ledger()).toEqual(receipts); expect(f.requests).toHaveLength(2);
    expect(readUniverseDeliveries('engineering-http', { root: f.universeRoot }).deliveries).toHaveLength(1);
  }, 75_000);

  it('persists pause and the original deadline, refuses a second owner, and leaves KILL-held work untouched', async () => {
    const f = await fixture(); const config = await configure(f, true); const handle = await f.start(config);
    const paused = await pause(handle, true);
    await expect(startResourceConsoleServer({ ...f.serverOptions, ...config })).rejects.toThrow();
    await handle.close(); const restarted = await f.start(config);
    const recovered = await supervision(restarted);
    expect(recovered).toMatchObject({ paused: true, revision: paused.revision, deadlineAt: paused.deadlineAt });
    expect(f.requests).toEqual([]); expect(readdirSync(f.graphRoot)).toEqual([]);
    const kill = join(f.graphRoot, 'KILL'); writeFileSync(kill, 'fixture stop\n', { mode: 0o600 });
    try {
      expect((await http(restarted, '/api/resources/queue', { paused: false })).status).toBe(200);
      await pause(restarted, false);
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(f.requests).toEqual([]); expect(readControlGraph(f.graphRoot).sourceState).toBe('missing');
    } finally { rmSync(kill); }
    await until(async () => (await status(restarted)).state === 'completed');
    expect(f.requests).toHaveLength(1); expect((await supervision(restarted)).deadlineAt).toBe(paused.deadlineAt);
  }, 60_000);

  it('restarts the actual foreground CLI after upstream settlement and automatically continues only the untouched child', async () => {
    const f = await fixture({ twoCampaigns: true }); const config = await configure(f);
    const directory = portfolioControllerDirectory(f.host.definition.id, { root: f.universeRoot });
    const records = join(directory, 'ledger', 'records');
    // Crash only after the real immutable settlement exists and its short lock has
    // physically been released. No graph, controller or resource receipt is forged.
    const preload = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const unlink=fs.unlinkSync;fs.unlinkSync=function(path,...rest){const result=unlink.call(this,path,...rest);
if(path===${JSON.stringify(join(directory, '.control.lock'))}&&fs.existsSync(${JSON.stringify(records)})&&
fs.readdirSync(${JSON.stringify(records)}).some(name=>{const row=JSON.parse(fs.readFileSync(${JSON.stringify(records)}+'/'+name,'utf8'));
return row.kind==='settled'&&row.outcome.campaignId===${JSON.stringify(f.campaignId)}&&row.outcome.state==='completed';}))process.kill(process.pid,'SIGKILL');
return result;};syncBuiltinESMExports();`;
    const first = await cli(f, config, preload); const initial = await supervision(first.handle);
    expect(await first.exit).toEqual({ code: null, signal: 'SIGKILL' });
    expect(f.errors).toEqual([]); expect(f.requests.map(row => row.campaignId)).toEqual([f.campaignId]);
    const upstream = readUniverseCampaign(f.campaignId, { root: f.universeRoot });
    const upstreamDelivery = readUniverseDeliveries('engineering-http', { root: f.universeRoot });
    const upstreamCommit = git(f.repo, 'rev-parse', f.branch);
    const interrupted = readControlGraph(f.graphRoot);
    const events = readPortfolioControllerEvents(directory);
    const graphRecords = join(f.graphRoot, 'control-graph', 'records');
    const intent = readdirSync(graphRecords).map(name => readFileSync(join(graphRecords, name), 'utf8'))
      .filter(text => JSON.parse(text).kind === 'intent');
    const restarted = await cli(f, config);
    await until(async () => (await status(restarted.handle)).state === 'completed', 60_000);
    expect((await supervision(restarted.handle)).deadlineAt).toBe(initial.deadlineAt);
    expect(f.requests.map(row => row.campaignId)).toEqual([f.campaignId, f.child]);
    expect(f.ledger()).toHaveLength(2); expect(f.ledger().every(row => row.status === 'completed')).toBe(true);
    expect(readUniverseCampaign(f.campaignId, { root: f.universeRoot })).toEqual(upstream);
    expect(readUniverseDeliveries('engineering-http', { root: f.universeRoot })).toEqual(upstreamDelivery);
    expect(git(f.repo, 'rev-parse', f.branch)).toBe(upstreamCommit);
    expect(git(f.repo, 'show', 'codex/second-result:value.json')).toBe('1');
    expect(readUniverseDeliveries(f.childUniverse, { root: f.universeRoot }).deliveries).toHaveLength(1);
    const completed = readControlGraph(f.graphRoot);
    expect(completed.deadlineAt).toBe(interrupted.deadlineAt);
    expect(readdirSync(graphRecords).map(name => readFileSync(join(graphRecords, name), 'utf8'))
      .filter(text => JSON.parse(text).kind === 'intent')).toEqual(intent);
    expect(readPortfolioControllerEvents(directory).slice(0, events.length)).toEqual(events);
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.revision); expect(git(f.repo, 'status', '--porcelain=v1')).toBe('');
    expect((await restarted.close()).code).toBe(0);
    const replay = await cli(f, config); await new Promise(resolve => setTimeout(resolve, 400));
    expect(f.requests).toHaveLength(2); expect(readControlGraph(f.graphRoot)).toEqual(completed);
    expect((await replay.close()).code).toBe(0);
  }, 100_000);

  it('does not busy-retry or replay a worker request whose foreground process died before settlement', async () => {
    const f = await fixture({ holdEngineering: true }); const config = await configure(f);
    const first = await cli(f, config); const original = await supervision(first.handle);
    await until(async () => f.requests.length === 1);
    first.kill(); expect(await first.exit).toEqual({ code: null, signal: 'SIGKILL' });
    const graph = readControlGraph(f.graphRoot); const receipts = f.ledger();
    expect(graph.nodes[0]!.state).toBe('unresolved'); expect(receipts).toHaveLength(1);
    const restarted = await cli(f, config);
    await new Promise(resolve => setTimeout(resolve, 1000));
    const held = await supervision(restarted.handle);
    await new Promise(resolve => setTimeout(resolve, 700));
    expect((await supervision(restarted.handle)).entries).toEqual(held.entries);
    expect(held.deadlineAt).toBe(original.deadlineAt);
    expect(f.requests).toHaveLength(1); expect(f.ledger()).toEqual(receipts);
    expect(readControlGraph(f.graphRoot)).toEqual(graph);
    expect(readUniverseDeliveries('engineering-http', { root: f.universeRoot }).deliveries).toHaveLength(0);
    // There is deliberately no success assertion for graceful shutdown: an
    // unconfirmed shared-account receipt remains unsafe and must stay visible.
    restarted.kill(); await restarted.exit;
  }, 45_000);

  it('does not renew an expired durable queue deadline on restart', async () => {
    const f = await fixture(); const config = await configure(f, true); const first = await f.start(config);
    const before = await pause(first, true); await first.close();
    // Deterministic clock advancement, not a claim of real elapsed wall time.
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(before.deadlineAt) + 1);
    const restarted = await f.start(config);
    await pause(restarted, false); await new Promise(resolve => setTimeout(resolve, 300));
    expect(await supervision(restarted)).toMatchObject({ state: 'timed-out', deadlineAt: before.deadlineAt,
      entries: [{ attempts: 0 }] });
    expect(f.requests).toEqual([]); expect(readdirSync(f.graphRoot)).toEqual([]); expect(f.ledger()).toHaveLength(0);
    await restarted.close(); vi.useRealTimers();
  }, 30_000);
});
