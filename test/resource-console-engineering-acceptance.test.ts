/** Real HTTP, Git, confined evaluation and shared-account ledger acceptance.
 * Every model request terminates at this test's loopback listener.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { resourcePoolStatus } from '../src/core/resources/pool-runtime.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import type { ResourceConsoleEngineeringEnrollment, ResourceConsoleEngineeringJob, ResourceConsoleEngineeringReadiness } from '../src/core/resources/console-engineering-types.js';
import { killSwitchPath } from '../src/core/sandbox/policy.js';
import * as privateRecords from '../src/core/util/immutable-private-record-store.js';
import { startResourceConsoleServer, type ResourceConsoleServerHandle, type ResourceConsoleServerOptions } from '../src/core/web/resource-console-server.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { readControlGraph, runControlGraph } from '../src/core/universe/control-graph.js';
import { readUniversePortfolioController } from '../src/core/universe/portfolio-controller.js';
import { createFirmEngineeringControlHandler, type FirmEngineeringControlHost } from '../src/core/universe/firm-engineering-control-handler.js';
import { initUniverse, initUniverseCampaign, readUniverseDeliveries, readUniverseOverview, type UniverseManifest } from '../src/core/universe/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { vi.restoreAllMocks(); }
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
async function readiness(handle: ResourceConsoleServerHandle, row: ResourceConsoleEngineeringEnrollment) {
  const response = await http(handle, `${engineeringPath}/${row.id}/readiness`);
  expect(response.status, response.text).toBe(200); expect(response.noStore).toBe(true);
  const value = JSON.parse(response.text) as ResourceConsoleEngineeringReadiness;
  expect(Object.keys(value).sort()).toEqual(['schemaVersion', 'enrollmentId', 'enrollmentDigest', 'sampledAt', 'status', 'action',
    'reasons', 'scope', 'effectsExecuted', 'providerContacted'].sort());
  expect(value).toMatchObject({ schemaVersion: 1, enrollmentId: row.id, enrollmentDigest: row.enrollmentDigest,
    scope: 'local-admission-check-only', effectsExecuted: false, providerContacted: false });
  expect(new Date(value.sampledAt).toISOString()).toBe(value.sampledAt);
  expect(value.reasons.length).toBeLessThanOrEqual(24);
  return value;
}
const launchInput = (row: ResourceConsoleEngineeringEnrollment) => ({ enrollmentId: row.id, expectedEnrollmentDigest: row.enrollmentDigest });
async function fixture(options: { holdEngineering?: boolean; maxConcurrent?: number } = {}) {
  expect(homedir()).not.toBe(process.env.ASHLR_VITEST_REAL_HOME);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-http-acceptance-')));
  const repo = join(base, 'project'); const second = join(base, 'second'); const transport = join(base, 'sterile-transport');
  const universeRoot = join(base, 'universe'); const graphRoot = join(base, 'graph');
  for (const path of [repo, second, transport, graphRoot]) mkdirSync(path, { mode: 0o700 });
  git(repo, 'init', '-q', '--template=', '--initial-branch=main'); git(transport, 'init', '-q', '--template=', '--initial-branch=main');
  writeFileSync(join(repo, 'value.json'), '0\n'); writeFileSync(join(repo, 'private.txt'), 'PRIVATE_ENGINEERING_CONTENT');
  writeFileSync(join(repo, 'evaluate.mjs'), `import {readFileSync} from 'node:fs';import {join} from 'node:path';
const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));
console.log(JSON.stringify({passed:Number.isInteger(value)&&value>=0&&value<=100,score:value,metrics:{value},
diagnostics:value<0?[{code:'NONNEGATIVE',message:'Value must be nonnegative',path:'value.json',line:1}]:[]}));`);
  git(repo, 'add', '.'); git(repo, '-c', 'user.name=HTTP Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixed evaluator');
  const revision = git(repo, 'rev-parse', 'HEAD');
  const requests: Array<{ kind: 'ordinary' | 'engineering'; generation?: number; feedback?: { status: string; score: number } }> = [];
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
        requests.push({ kind: 'engineering', generation: generation.generation, feedback: generation.feedback });
        if (options.holdEngineering) return;
        const value = [-1, 2, 3][generation.generation - 1]; if (value === undefined) throw new Error('Unexpected generation');
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
  initUniverseCampaign({ schemaVersion: 1, id: campaignId, universeId: manifest.id, feedback: true,
    budget: { maxGenerations: 3, maxDurationMs: 45_000, maxModelRequests: 3, maxStagnantGenerations: 3, maxReportedTokens: null } }, { root: universeRoot });
  const branch = 'codex/http-engineering';
  const host: FirmEngineeringControlHost = { nodeId: 'deliver-http', root: universeRoot, constitutionVersion: 'fixture-v1', policyEpoch: 1,
    definition: { schemaVersion: 1, id: 'http-controller', tasks: [{ campaignId, dependsOn: [] }], maxParallel: 1, maxDurationMs: 60_000 },
    deliveryPlan: { schemaVersion: 1, deliveries: [{ campaignId, branch, baseCommit: revision }] }, resourceRuntime,
    expectedRuntimeDigest: digest(canonical(runtime)) };
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
  const start = async () => { const handle = await startResourceConsoleServer(serverOptions); handles.push(handle); return handle; };
  const ledger = () => resourcePoolStatus(serverOptions.root, pool, bindings, observations).attempts;
  return { base, repo, second, revision, transport, universeRoot, graphRoot, branch, campaignId, host, serverOptions, catalog, requests, errors,
    start, ledger, peak: () => peak, active: () => active,
    releaseOrdinary: () => { expect(ordinary).toBeDefined(); reply(ordinary!, 'ordinary-completed'); } };
}

describe.runIf(process.platform === 'darwin')('independent Workspace engineering HTTP acceptance', () => {
  it('inspects a checked enrollment without graph writes and rejects unconfirmed launch authority', async () => {
    const f = await fixture(); const handle = await f.start(); expect(handle.scope.engineeringSupported).toBe(true);
    const rows = await enrollments(handle); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'engineering-default', projectId: 'default', acceptanceScope: 'fixed-evaluator-and-local-branch-only' });
    expect(await readiness(handle, rows[0]!)).toMatchObject({ status: 'ready', action: 'launch', reasons: [] });
    expect((await http(handle, `${engineeringPath}/${rows[0]!.id}/readiness`, undefined, {})).status).toBe(401);
    expect((await http(handle, `${engineeringPath}/${rows[0]!.id}/readiness?ignored=true`)).status).toBe(400);
    expect(await status(handle)).toMatchObject({ state: 'ready', launched: false, cancelled: false });
    const input = launchInput(rows[0]!);
    for (const headers of [{}, { 'x-ashlr-token': handle.readToken, origin: handle.url }, { 'x-ashlr-token': handle.controlToken! }]) {
      expect((await http(handle, `${engineeringPath}/start`, input, headers)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await http(handle, `${engineeringPath}/start`, { ...input, expectedEnrollmentDigest: 'f'.repeat(64) })).status).toBe(409);
    expect((await http(handle, `${engineeringPath}/start`, { ...input, projectId: 'second' })).status).toBe(400);
    expect((await http(handle, '/api/resources/queue', { paused: true })).status).toBe(200);
    expect((await http(handle, `${engineeringPath}/start`, input)).status).toBe(503);
    expect(JSON.stringify(rows)).not.toContain(f.base); expect(JSON.stringify(rows)).not.toContain('PRIVATE_ENGINEERING_CONTENT');
    expect(readdirSync(f.graphRoot)).toEqual([]); expect(f.requests).toEqual([]); expect(f.ledger()).toEqual([]);
    expect(existsSync(join(f.universeRoot, 'portfolios', f.host.definition.id))).toBe(false);
  });

  it.each([
    ['graph KILL', 'graph-kill-active'], ['isolated global KILL', 'global-kill-active'], ['queue pause', 'queue-paused'],
    ['graph ownership', 'graph-ownership-unavailable'],
    ['runtime drift', 'runtime-pin-changed'], ['pool drift', 'enrollment-pin-changed'], ['bindings drift', 'enrollment-pin-changed'],
  ] as const)('does not consume an enrollment under %s and admits the same identity after the condition clears', async (condition, reason) => {
    const f = await fixture({ holdEngineering: true }); const handle = await f.start(); const row = (await enrollments(handle))[0]!;
    const input = launchInput(row); let restore: () => Promise<void>;
    if (condition === 'graph KILL' || condition === 'isolated global KILL') {
      const sentinel = condition === 'graph KILL' ? join(f.graphRoot, 'KILL') : killSwitchPath();
      if (condition === 'isolated global KILL') {
        // This test never calls setKill or touches the developer's authority tree.
        expect(homedir()).not.toBe(process.env.ASHLR_VITEST_REAL_HOME);
        expect(sentinel).toBe(join(homedir(), '.ashlr', 'KILL'));
      }
      expect(existsSync(sentinel)).toBe(false); mkdirSync(dirname(sentinel), { recursive: true, mode: 0o700 });
      writeFileSync(sentinel, 'isolated admission fixture\n', { mode: 0o600 });
      restore = async () => { rmSync(sentinel, { force: true }); };
    } else if (condition === 'graph ownership') {
      const acquired = acquireLocalStoreLockWithOutcome(join(f.graphRoot, '.control-execution.lock'), 0,
        { anchorPath: f.graphRoot, exactPrivateStorage: true });
      expect(acquired.state).toBe('acquired'); if (acquired.state !== 'acquired') throw new Error('Fixture graph lock was not acquired');
      restore = async () => { expect(releaseLocalStoreLock(acquired.lock)).toBe(true); };
    } else if (condition === 'queue pause') {
      expect((await http(handle, '/api/resources/queue', { paused: true })).status).toBe(200);
      restore = async () => { expect((await http(handle, '/api/resources/queue', { paused: false })).status).toBe(200); };
    } else {
      const file = condition === 'runtime drift' ? f.host.resourceRuntime
        : condition === 'pool drift' ? f.serverOptions.poolFile : f.serverOptions.bindingsFile;
      const original = readFileSync(file); const changed = JSON.parse(original.toString('utf8'));
      if (condition === 'runtime drift') changed.capacityWaitMs = 14_000;
      else if (condition === 'pool drift') changed.workers[0].priority += 1;
      else changed[0].capacityKey = 'changed-fixture-account';
      save(file, changed); restore = async () => { writeFileSync(file, original); };
    }
    const writes = vi.spyOn(privateRecords, 'writeImmutablePrivateRecord');
    try {
      const rootNames = readdirSync(f.graphRoot);
      for (let check = 0; check < 2; check++) {
        expect(await readiness(handle, row)).toMatchObject({ status: 'blocked', action: 'none', reasons: expect.arrayContaining([reason]) });
        expect((await http(handle, `${engineeringPath}/start`, input)).status).toBe(503);
      }
      expect(readdirSync(f.graphRoot)).toEqual(rootNames); expect(readControlGraph(f.graphRoot).sourceState).toBe('missing');
      expect((await status(handle)).launched).toBe(false); expect(f.requests).toEqual([]); expect(f.ledger()).toEqual([]);
      expect(existsSync(join(f.universeRoot, 'portfolios', f.host.definition.id))).toBe(false);
      expect(writes.mock.calls.filter(([configuration]) => configuration.anchorPath === f.graphRoot)).toEqual([]);
    } finally { writes.mockRestore(); await restore(); }
    expect(await readiness(handle, row)).toMatchObject({ status: 'ready', action: 'launch', reasons: [] });
    expect((await http(handle, `${engineeringPath}/start`, input)).status).toBe(202);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1), { timeout: 15_000 });
    expect((await status(handle)).enrollmentDigest).toBe(row.enrollmentDigest);
    expect((await http(handle, `${engineeringPath}/${row.id}/cancel`, {})).status).toBe(200);
    await vi.waitFor(() => expect(f.ledger()[0]?.status).toBe('cancelled'), { timeout: 10_000 });
    expect(f.requests[0]).toMatchObject({ kind: 'engineering', generation: 1 });
    expect(readFileSync(join(f.repo, 'value.json'), 'utf8')).toBe('0\n'); expect(git(f.repo, 'branch', '--list', f.branch)).toBe('');
  });

  it('shares an occupied account with ordinary project tasks, then evaluates correction and delivers only the enrolled branch', async () => {
    const f = await fixture(); const handle = await f.start(); const enrollment = (await enrollments(handle))[0]!;
    writeFileSync(join(f.repo, 'value.json'), 'owner staged work\n'); git(f.repo, 'add', 'value.json');
    writeFileSync(join(f.repo, 'value.json'), 'owner unstaged work\n');
    const index = readFileSync(join(f.repo, '.git', 'index')); const checkout = git(f.repo, 'status', '--porcelain=v1');
    const ordinary = await http(handle, '/api/resources/tasks', { id: 'ordinary-second', projectId: 'second', prompt: 'ordinary-held',
      allowedWorkerIds: ['local-worker'], mode: 'read-only', timeoutMs: 30_000, maxOutputTokens: 100 });
    expect(ordinary.status, ordinary.text).toBe(202); await vi.waitFor(() => expect(f.requests).toEqual([{ kind: 'ordinary' }]), { timeout: 10_000 });
    const started = await http(handle, `${engineeringPath}/start`, launchInput(enrollment)); expect(started.status, started.text).toBe(202);
    await vi.waitFor(() => expect(readUniversePortfolioController(f.host.definition.id, { root: f.universeRoot }).sourceState).toBe('healthy'), { timeout: 10_000 });
    expect(f.requests).toEqual([{ kind: 'ordinary' }]); expect(f.ledger()).toHaveLength(1);
    // Pausing new queue admission is not cancellation of an owned engineering run.
    expect((await http(handle, '/api/resources/queue', { paused: true })).status).toBe(200); f.releaseOrdinary();
    await vi.waitFor(async () => expect((await status(handle)).state).toBe('completed'), { timeout: 45_000, interval: 250 });
    expect(f.errors).toEqual([]); expect(f.peak()).toBe(1);
    expect(f.requests.filter((row) => row.kind === 'engineering').map((row) => row.generation)).toEqual([1, 2, 3]);
    expect(f.requests[2]!.feedback).toMatchObject({ status: 'failed', score: -1 });
    expect(f.requests[3]!.feedback).toMatchObject({ status: 'passed', score: 2 });
    const universe = readUniverseOverview({ root: f.universeRoot }).universes[0]!;
    expect(universe.runs.map((run) => run.trials[0]!.status)).toEqual(['failed', 'passed', 'passed']);
    const receipts = f.ledger(); expect(receipts).toHaveLength(4);
    expect(receipts.every((row) => row.capacityKey === 'shared-account' && row.status === 'completed')).toBe(true);
    expect(receipts.find((row) => row.id === 'ordinary-second')).toBeDefined();
    const deliveries = readUniverseDeliveries(universe.manifest.id, { root: f.universeRoot }); expect(deliveries.deliveries).toHaveLength(1);
    expect(git(f.repo, 'show', `${f.branch}:value.json`)).toBe('3');
    expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/codex/')).toBe(`refs/heads/${f.branch}`);
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.revision); expect(git(f.repo, 'status', '--porcelain=v1')).toBe(checkout);
    expect(readFileSync(join(f.repo, '.git', 'index'))).toEqual(index); expect(readdirSync(f.transport)).toEqual(['.git']);
    expect(git(f.repo, 'remote')).toBe(''); const graph = readControlGraph(f.graphRoot);
    expect((await http(handle, '/api/resources/queue', { paused: false })).status).toBe(200);
    await handle.close(); const restarted = await f.start();
    expect((await status(restarted)).state).toBe('completed');
    expect((await http(restarted, `${engineeringPath}/start`, launchInput(enrollment))).status).toBe(202);
    expect(readControlGraph(f.graphRoot)).toEqual(graph); expect(f.requests).toHaveLength(4); expect(f.ledger()).toEqual(receipts);
    expect(readUniverseDeliveries(universe.manifest.id, { root: f.universeRoot })).toEqual(deliveries);
  });

  it('persists cancellation of an actual pending generation and never resumes it after server restart', async () => {
    const f = await fixture({ holdEngineering: true }); const handle = await f.start(); const enrollment = (await enrollments(handle))[0]!;
    expect((await http(handle, `${engineeringPath}/start`, launchInput(enrollment))).status).toBe(202);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1), { timeout: 15_000 });
    const cancelled = await http(handle, `${engineeringPath}/${enrollment.id}/cancel`, {}); expect(cancelled.status, cancelled.text).toBe(200);
    await vi.waitFor(() => expect(f.ledger()[0]?.status).toBe('cancelled'), { timeout: 10_000 });
    await handle.close(); const before = f.ledger(); const restarted = await f.start();
    expect(await status(restarted)).toMatchObject({ cancelled: true, cancellable: false });
    const retried = await http(restarted, `${engineeringPath}/start`, launchInput(enrollment));
    expect(retried.status, retried.text).toBe(409);
    expect(await status(restarted)).toMatchObject({ cancelled: true, cancellable: false });
    expect(f.requests).toHaveLength(1); expect(f.ledger()).toEqual(before); expect(git(f.repo, 'branch', '--list', f.branch)).toBe('');
  });

  it('closes concurrent ordinary and engineering work only after both shared-ledger reservations settle', async () => {
    const f = await fixture({ holdEngineering: true, maxConcurrent: 2 }); const handle = await f.start();
    const enrollment = (await enrollments(handle))[0]!;
    const ordinary = await http(handle, '/api/resources/tasks', { id: 'ordinary-concurrent', projectId: 'second', prompt: 'ordinary-held',
      allowedWorkerIds: ['local-worker'], mode: 'read-only', timeoutMs: 30_000, maxOutputTokens: 100 });
    expect(ordinary.status).toBe(202);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1), { timeout: 10_000 });
    expect((await http(handle, `${engineeringPath}/start`, launchInput(enrollment))).status).toBe(202);
    await vi.waitFor(() => expect(f.requests).toHaveLength(2), { timeout: 15_000 });
    expect(f.ledger().map((receipt) => receipt.status)).toEqual(['reserved', 'reserved']); expect(f.peak()).toBe(2);
    await expect(handle.close()).resolves.toBeUndefined();
    expect(f.ledger().map((receipt) => receipt.status)).toEqual(['cancelled', 'cancelled']);
    await vi.waitFor(() => expect(f.active()).toBe(0)); expect(f.requests).toHaveLength(2);
    expect(git(f.repo, 'branch', '--list', f.branch)).toBe('');
  });

  it('holds a replaced project without disabling ordinary tasks in another registered project', async () => {
    const f = await fixture(); const handle = await f.start(); const enrollment = (await enrollments(handle))[0]!;
    const original = join(f.base, 'original-project'); renameSync(f.repo, original); mkdirSync(f.repo, { mode: 0o700 });
    try {
      expect((await http(handle, `${engineeringPath}/start`, launchInput(enrollment))).status).toBe(503);
      expect(readdirSync(f.graphRoot)).toEqual([]); expect(f.requests).toEqual([]);
      const response = await http(handle, '/api/resources/tasks', { id: 'unrelated-second', projectId: 'second', prompt: 'ordinary-fast',
        allowedWorkerIds: ['local-worker'], mode: 'read-only', timeoutMs: 5000, maxOutputTokens: 100 });
      expect(response.status).toBe(202);
      await vi.waitFor(() => expect(f.ledger().find((row) => row.id === 'unrelated-second')?.status).toBe('completed'), { timeout: 10_000 });
      expect(f.requests).toEqual([{ kind: 'ordinary' }]);
    } finally { rmSync(f.repo, { recursive: true }); renameSync(original, f.repo); }
  });

  it.each(['missing', 'pending'] as const)('holds a prior launch with %s graph rather than beginning execution on retry', async (state) => {
    const f = await fixture(); const first = await f.start(); const enrollment = (await enrollments(first))[0]!;
    const kill = join(f.graphRoot, 'KILL'); const write = privateRecords.writeImmutablePrivateRecord;
    // Preserve the production write, then introduce the stop in the genuine
    // accepted-binding / first-graph-intent race window. Pre-existing KILL must
    // now be rejected before acceptance and must not create this held state.
    let injected = false;
    const publication = vi.spyOn(privateRecords, 'writeImmutablePrivateRecord').mockImplementation((config, record, options) => {
      const result = write(config, record, options);
      if (config.rootPath === join(f.graphRoot, 'console-engineering') && (record as { kind?: string }).kind === 'launch' && result === 'recorded') {
        writeFileSync(kill, 'stop after accepted launch publication\n', { mode: 0o600 }); injected = true;
      }
      return result;
    });
    expect((await http(first, `${engineeringPath}/start`, launchInput(enrollment))).status).toBe(202);
    publication.mockRestore(); expect(injected).toBe(true);
    await vi.waitFor(async () => { const current = await status(first); expect(current.launched).toBe(true); expect(current.state).not.toBe('running'); });
    expect(readControlGraph(f.graphRoot).sourceState).toBe('missing'); rmSync(kill);
    if (state === 'pending') {
      // Build the signed created-only boundary through the real graph API, not
      // by editing records. No handler means no intent or worker can dispatch.
      const binding = createFirmEngineeringControlHandler(f.host);
      const pending = await runControlGraph({ schemaVersion: 1, id: enrollment.graphId,
        hostEnrollmentDigest: enrollment.enrollmentDigest, maxConcurrent: 1, maxDurationMs: f.host.definition.maxDurationMs,
        nodes: [{ id: f.host.nodeId, kind: 'deliver', requires: [], input: binding.nodeInput }] }, { root: f.graphRoot, handlers: {} });
      expect(pending.nodes[0]?.state).toBe('pending'); expect(pending.traces).toHaveLength(1);
    }
    const graph = readControlGraph(f.graphRoot);
    const launchRecord = join(f.graphRoot, 'console-engineering', 'records', 'launch.json'); const accepted = readFileSync(launchRecord, 'utf8');
    expect(await readiness(first, enrollment)).toMatchObject({ status: 'blocked', action: 'none', reasons: expect.arrayContaining(['launch-unresolved']) });
    expect((await http(first, `${engineeringPath}/start`, launchInput(enrollment))).status).toBe(409);
    await first.close(); const restarted = await f.start();
    expect((await status(restarted)).launched).toBe(true);
    expect(await readiness(restarted, enrollment)).toMatchObject({ status: 'blocked', action: 'none', reasons: expect.arrayContaining(['launch-unresolved']) });
    expect((await http(restarted, `${engineeringPath}/start`, launchInput(enrollment))).status).toBe(409);
    expect(readControlGraph(f.graphRoot)).toEqual(graph); expect(readFileSync(launchRecord, 'utf8')).toBe(accepted);
    expect(f.requests).toEqual([]); expect(f.ledger()).toEqual([]);
    expect(existsSync(join(f.universeRoot, 'portfolios', f.host.definition.id))).toBe(false);
  });
});
