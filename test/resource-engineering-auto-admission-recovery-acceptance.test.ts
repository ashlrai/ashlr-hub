/** Actual HTTP/owner restart across a durable registration-to-admission gap.
 * Fault injection refuses queue append only; preparation and subsequent delivery are real.
 * A normal stopped-owner restart models the persisted crash gap, not SIGKILL recovery. */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { resourcePoolStatus, setResourcePoolAllocation, setResourceWorkerAccess } from '../src/core/resources/pool-runtime.js';
import { createResourcePoolSupervisor, ResourceSupervisorError } from '../src/core/resources/pool-supervisor.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import type { ResourceEngineeringRecipe } from '../src/core/resources/engineering-preparation-types.js';
import type { ResourceConsoleEngineeringSupervisionSnapshot as Supervision } from '../src/core/resources/console-engineering-supervisor-types.js';
import { startResourceConsoleServer, type ResourceConsoleServerHandle } from '../src/core/web/resource-console-server.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import * as automatic from '../src/core/resources/console-engineering-supervisor.js';
import * as evaluator from '../src/core/universe/fixed-evaluator.js';
import * as deliveryGit from '../src/core/universe/delivery-git.js';
import type { ResourceConsoleEngineeringPreparationConfig, ResourceConsoleEngineeringObjective,
  ResourceConsoleEngineeringObjectivePlan, ResourceConsoleEngineeringObjectivePrepared } from '../src/core/resources/console-engineering-preparation-types.js';

const cleanups: Array<() => Promise<void>> = [];
const phaseTiming = process.env.ASHLR_ENGINEERING_ADMISSION_PHASE_TIMING === '1';
let phaseSequence = 0;
/** Optional bounded diagnostics: phase names/timing only, never fixture data or tokens. */
function phase<T>(name: string, work: () => T): T {
  if (!phaseTiming) return work();
  const id = ++phaseSequence; const started = performance.now();
  console.log('ADMISSION_PHASE ' + JSON.stringify({ id, name, event: 'start', monotonicMs: started }));
  const ended = () => console.log('ADMISSION_PHASE ' + JSON.stringify({ id, name, event: 'end',
    monotonicMs: performance.now(), durationMs: performance.now() - started }));
  try {
    const result = work();
    if (result instanceof Promise) return result.finally(ended) as T;
    ended(); return result;
  } catch (error) { ended(); throw error; }
}
afterEach(async () => { try { for (const [index, cleanup] of cleanups.splice(0).reverse().entries()) await phase(`cleanup.${index}`, cleanup); } finally { vi.restoreAllMocks(); } });
const save = (file: string, value: unknown) => writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
}
function inventory(root: string): Record<string, unknown> | null {
  if (!existsSync(root)) return null;
  const result: Record<string, unknown> = {};
  const visit = (file: string, name: string): void => {
    const stat = lstatSync(file, { bigint: true }); expect(stat.isSymbolicLink()).toBe(false);
    result[name] = { mode: String(stat.mode), dev: String(stat.dev), ino: String(stat.ino), links: String(stat.nlink),
      mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs), ...(stat.isFile() ? { digest: digest(readFileSync(file)) } : {}) };
    if (stat.isDirectory()) for (const child of readdirSync(file).sort()) visit(join(file, child), `${name}/${child}`);
  };
  visit(root, ''); return result;
}
async function fixture() {
  expect(process.env.ASHLR_VITEST_REAL_HOME).toBeTruthy(); expect(homedir()).not.toBe(process.env.ASHLR_VITEST_REAL_HOME);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'supervisor-admission-acceptance-')));
  const repo = join(base, 'project'); const otherProject = join(base, 'other-project'); const transport = join(base, 'transport');
  const root = join(base, 'ledger'); const outputRoot = join(base, 'bundles');
  for (const directory of [repo, otherProject, transport, outputRoot]) mkdirSync(directory, { mode: 0o700 });
  git(repo, 'init', '-q', '--template=', '--initial-branch=main'); git(transport, 'init', '-q', '--template=', '--initial-branch=main');
  writeFileSync(join(repo, 'value.json'), '0\n');
  writeFileSync(join(repo, 'evaluate.mjs'), `import{readFileSync}from'node:fs';import{join}from'node:path';
const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));
console.log(JSON.stringify({passed:value===1,score:value===1?1:0,metrics:{value},diagnostics:value===1?[]:[{code:'EXPECTED_ONE',message:'The declared value must equal one.',path:'value.json'}]}));`);
  git(repo, 'add', '.'); git(repo, '-c', 'user.name=Console Preparation Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixed failing seed');
  const revision = git(repo, 'rev-parse', 'HEAD'); const requests: unknown[] = []; const protocolErrors: string[] = [];
  const worker = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk)); request.on('end', () => {
      try {
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const messages = JSON.parse(input.messages[0].content) as Array<{ role: string; content: string }>;
        const context = JSON.parse(messages.find(row => row.role === 'user')!.content); requests.push(context);
        expect(context.seedContext.measurement).toMatchObject({ passed: false, score: 0, metrics: { value: 0 } });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ operations: [
          { op: 'replace', path: 'value.json', content: `${context.seedContext.measurement.metrics.value + 1}\n` },
        ] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
      } catch (error) { protocolErrors.push(String(error)); response.writeHead(500); response.end('Unexpected fixture protocol'); }
    });
  });
  await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    worker.closeAllConnections(); await new Promise<void>(resolve => worker.close(() => resolve()));
    const writable = (file: string): void => { const stat = lstatSync(file); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      chmodSync(file, 0o700); for (const child of readdirSync(file)) writable(join(file, child)); };
    writable(base); rmSync(base, { recursive: true, force: true });
  });
  const address = worker.address(); if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
  const pool = validateResourcePool({ schemaVersion: 1, id: 'console-preparation', workers: ['repair', 'spare'].map(id => ({
    id, provider: 'local', model: 'fixture', maxConcurrent: 1, maxTasksPerWindow: 4, taskWindowMs: 60_000, reservePercent: 0, priority: 1,
  })) });
  const bindings = validateResourceBindings(pool.workers.map(row => ({ workerId: row.id, capacityKey: `${row.id}-account`,
    kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` })), pool);
  const observations = pool.workers.map(row => ({ workerId: row.id, health: 'ready' as const, windows: [], retryAfter: null,
    observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 240_000).toISOString() }));
  const files = { poolFile: join(base, 'pool.json'), bindingsFile: join(base, 'bindings.json'), observationsFile: join(base, 'observations.json'),
    projectsFile: join(base, 'projects.json'), runtimeFile: join(base, 'runtime.json'), engineeringPreparationFile: join(base, 'preparation.json'), engineeringSupervisionFile: join(base, 'supervision.json') };
  save(files.poolFile, pool); save(files.bindingsFile, bindings); save(files.observationsFile, observations);
  const projects = [{ id: 'other', label: 'Other project', workspace: otherProject }]; save(files.projectsFile, { schemaVersion: 1, projects });
  const runtime = { schemaVersion: 1, root, workspace: transport, poolPath: files.poolFile, bindingsPath: files.bindingsFile,
    observationsPath: files.observationsFile, capacityWaitMs: 1000 }; save(files.runtimeFile, runtime);
  const previous = await createResourcePoolSupervisor({ root, pool, bindings, workspace: repo, projects, readObservations: () => observations });
  await previous.close(); const allocation = setResourcePoolAllocation(root, pool, bindings, 70, 0);
  const workerAccess = setResourceWorkerAccess(root, pool, bindings, ['spare'], 0); loadOrCreateKey();
  const recipe: ResourceEngineeringRecipe = { schemaVersion: 1, id: 'profile-recipe', name: 'Pinned profile recipe',
    objective: 'Repair the fixed measured value', projectId: 'default', seedRevision: revision,
    metric: { name: 'value', direction: 'maximize', minImprovement: 0 }, evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3000 },
    trialBudget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 30_000, trialTimeoutMs: 15_000 },
    campaignBudget: { maxGenerations: 1, maxDurationMs: 45_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: 30 },
    generation: { files: ['value.json'], contextFiles: [], allowedWorkerIds: ['repair'], maxOutputTokens: 256,
      hypotheses: [{ id: 'repair', niche: 'value', hypothesis: 'Repair the declared measured defect' }] },
    delivery: { branch: 'codex/profile-recipe', allowInitialRepair: true },
    execution: { maxDurationMs: 60_000, constitutionVersion: 'fixture-v1', policyEpoch: 1 },
    supervision: { maxDurationMs: 90_000, pollIntervalMs: 100, maxAttemptsPerEnrollment: 3 } };
  const evaluations = vi.spyOn(evaluator, 'runFixedUniverseEvaluator'); const originalGit = deliveryGit.deliveryGit; let publications = 0;
  vi.spyOn(deliveryGit, 'deliveryGit').mockImplementation((...args) => { const api = originalGit(...args);
    return { ...api, createRef: async (...createArgs) => { publications++; await api.createRef(...createArgs); } }; });
  return { base, root, repo, revision, outputRoot, files, runtime, recipe, requests, protocolErrors, evaluations, allocation, workerAccess,
    publications: () => publications, ledger: () => resourcePoolStatus(root, pool, bindings, observations) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function noExecution(f: Fixture) {
  expect(f.requests).toEqual([]); expect(f.evaluations).not.toHaveBeenCalled(); expect(f.publications()).toBe(0);
  expect(f.ledger().attempts).toEqual([]);
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.revision); expect(git(f.repo, 'status', '--porcelain=v1')).toBe('');
}
async function api(server: ResourceConsoleServerHandle, path: string, body?: unknown, token = server.controlToken ?? '', origin: string | null = server.url) {
  return fetch(`${server.url}/api/resources/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Ashlr-Token': token, ...(origin === null ? {} : { Origin: origin }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function objective(id = 'fresh-correction'): ResourceConsoleEngineeringObjective {
  return { id, profileId: 'value-profile', name: 'Correct measured value', objective: 'Make the independently evaluated value equal one.' };
}
async function start(f: Fixture) {
  const server = await startResourceConsoleServer({ root: f.root, poolFile: f.files.poolFile, bindingsFile: f.files.bindingsFile,
    observationsFile: f.files.observationsFile, workspace: f.repo, projectsFile: f.files.projectsFile, execute: true,
    engineeringPreparationFile: f.files.engineeringPreparationFile, engineeringSupervisionFile: f.files.engineeringSupervisionFile });
  cleanups.push(() => server.close()); return server;
}
async function configured(automatic = false) {
  const f = await fixture();
  const config: ResourceConsoleEngineeringPreparationConfig = { schemaVersion: 1, outputRoot: f.outputRoot,
    resourceRuntime: f.files.runtimeFile, profiles: [{ id: 'value-profile', label: 'Pinned value repair',
      acceptance: 'Fixed evaluator requires value.json to contain one; evaluator is not mutable.', recipe: f.recipe }] };
  save(f.files.engineeringPreparationFile, config);
  save(f.files.engineeringSupervisionFile, { schemaVersion: 1, id: 'resident-queue', maxDurationMs: 180_000,
    pollIntervalMs: 100, maxConcurrent: 1, maxAttemptsPerEnrollment: 3, maxEnrollments: 3, enrollments: [],
    ...(automatic ? { autoAdmitPrepared: true } : {}) });
  return { ...f, config };
}
async function jsonResponse<T>(response: Response, status = 200): Promise<T> {
  const value = await response.json(); expect(response.status, JSON.stringify(value)).toBe(status);
  expect(response.headers.get('cache-control')).toContain('no-store'); return value as T;
}


const readSupervision = (server: ResourceConsoleServerHandle) => api(server, 'engineering-supervision', undefined, server.readToken).then(response => jsonResponse<Supervision>(response));
async function completed(server: ResourceConsoleServerHandle, id: string) {
  await vi.waitFor(async () => {
    const current = await readSupervision(server);
    expect(current.entries.find(row => row.enrollmentId === id)?.state, JSON.stringify(current)).toBe('completed');
  }, { timeout: 45_000, interval: 200 });
}
function delivered(f: Fixture, id: string) {
  expect(git(f.repo, 'show', `codex/${id}:value.json`)).toBe('1');
  expect(git(f.repo, 'diff', '--name-only', f.revision, `codex/${id}`)).toBe('value.json');
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.revision); expect(git(f.repo, 'status', '--porcelain=v1')).toBe('');
}

describe.runIf(process.platform === 'darwin')('automatic admission durable-gap recovery over actual HTTP', () => {
  it('recovers a registered objective after restart without another prepare request, then executes exactly once', async () => {
    const f = await configured(true);
    const original = automatic.createResourceConsoleEngineeringSupervisor;
    let denyAdmission = true, denied = 0, appended = 0;
    vi.spyOn(automatic, 'createResourceConsoleEngineeringSupervisor').mockImplementation(options => {
      const supervisor = original(options);
      return { ...supervisor, admit(input) {
        if (denyAdmission) { denied++; throw new ResourceSupervisorError('UNAVAILABLE', 'Fixture admission gap'); }
        const before = supervisor.snapshot().entries.length;
        const result = supervisor.admit(input);
        if (result.entries.length > before) appended++;
        return result;
      } };
    });
    const server = await start(f);
    const initial = await readSupervision(server);
    const paused = await jsonResponse<Supervision>(await api(server, 'engineering-supervision',
      { paused: true, expectedRevision: initial.revision }));
    const input = objective('recover-without-repost');
    const plan = await jsonResponse<ResourceConsoleEngineeringObjectivePlan>(await api(server, 'engineering/prepare/check', input));
    noExecution(f);
    const prepared = await jsonResponse<ResourceConsoleEngineeringObjectivePrepared & {
      automaticAdmission: { state: string; supervisionId: string } }>(await api(server, 'engineering/prepare',
      { ...input, expectedPlanDigest: plan.planDigest }));
    expect(prepared.automaticAdmission).toEqual({ state: 'unavailable', supervisionId: 'resident-queue' });
    expect(denied).toBeGreaterThan(0); expect(appended).toBe(0);
    expect((await readSupervision(server)).entries).toEqual([]);
    const registrationFile = join(f.root, 'console-engineering-preparations', 'records', input.id + '.json');
    const registrationBytes = readFileSync(registrationFile);
    expect(JSON.parse(registrationBytes.toString())).toMatchObject({ request: input,
      enrollmentDigest: prepared.enrollment.enrollmentDigest,
      automaticAdmission: { schemaVersion: 1, supervisionId: 'resident-queue',
        configDigest: initial.configDigest, deadlineAt: initial.deadlineAt } });
    const bundleBefore = inventory(f.outputRoot);
    noExecution(f);
    await server.close();
    denyAdmission = false;
    const restarted = await start(f);
    // No second check/prepare or explicit admission request: startup/timer must
    // recover from verified private registration and the original queue identity.
    await vi.waitFor(async () => {
      const current = await readSupervision(restarted);
      expect(current).toMatchObject({ paused: true, deadlineAt: initial.deadlineAt,
        configDigest: initial.configDigest, revision: paused.revision + 1 });
      expect(current.entries.map(row => row.enrollmentId)).toEqual([input.id]);
    }, { timeout: 10_000, interval: 100 });
    expect(appended).toBe(1);
    expect(readFileSync(registrationFile)).toEqual(registrationBytes);
    expect(inventory(f.outputRoot)).toEqual(bundleBefore);
    noExecution(f);
    const recovered = await readSupervision(restarted);
    await jsonResponse(await api(restarted, 'engineering-supervision',
      { paused: false, expectedRevision: recovered.revision }));
    await completed(restarted, input.id); delivered(f, input.id);
    expect(f.requests).toHaveLength(1); expect(f.evaluations).toHaveBeenCalledTimes(2);
    expect(f.publications()).toBe(1); expect(f.protocolErrors).toEqual([]);
    const receipts = f.ledger().attempts; expect(receipts).toHaveLength(1);
    const terminal = await readSupervision(restarted);
    await restarted.close();
    const again = await start(f);
    expect(await readSupervision(again)).toMatchObject({ deadlineAt: initial.deadlineAt,
      revision: terminal.revision, entries: terminal.entries });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(appended).toBe(1); expect(f.ledger().attempts).toEqual(receipts);
    expect(f.requests).toHaveLength(1); expect(f.evaluations).toHaveBeenCalledTimes(2); expect(f.publications()).toBe(1);
    expect(readFileSync(registrationFile)).toEqual(registrationBytes);
    expect(f.ledger()).toMatchObject({ allocation: f.allocation, workerAccess: f.workerAccess });
  }, 180_000);
});
