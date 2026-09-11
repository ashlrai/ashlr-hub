/** Same-console objective preparation with a fixed evaluator and test-owned loopback worker only. */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { resourcePoolStatus, setResourcePoolAllocation, setResourceWorkerAccess } from '../src/core/resources/pool-runtime.js';
import { createResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import type { ResourceEngineeringRecipe } from '../src/core/resources/engineering-preparation-types.js';
import type { ResourceConsoleEngineeringSupervisionSnapshot as Supervision } from '../src/core/resources/console-engineering-supervisor-types.js';
import { startResourceConsoleServer, type ResourceConsoleServerHandle } from '../src/core/web/resource-console-server.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import * as evaluator from '../src/core/universe/fixed-evaluator.js';
import * as deliveryGit from '../src/core/universe/delivery-git.js';
import type { ResourceConsoleEngineeringPreparationConfig, ResourceConsoleEngineeringObjective,
  ResourceConsoleEngineeringObjectivePlan, ResourceConsoleEngineeringObjectivePrepared } from '../src/core/resources/console-engineering-preparation-types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); } finally { vi.restoreAllMocks(); } });
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
const member = (prepared: ResourceConsoleEngineeringObjectivePrepared) => ({
  enrollmentId: prepared.enrollment.id, expectedEnrollmentDigest: prepared.enrollment.enrollmentDigest,
});
async function prepare(server: ResourceConsoleServerHandle, id: string) {
  const input = objective(id);
  const plan = await jsonResponse<ResourceConsoleEngineeringObjectivePlan>(await api(server, 'engineering/prepare/check', input));
  return jsonResponse<ResourceConsoleEngineeringObjectivePrepared>(await api(server, 'engineering/prepare', { ...input, expectedPlanDigest: plan.planDigest }));
}
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

describe.runIf(process.platform === 'darwin')('dynamic resident engineering admission over the actual console', () => {
  it('automatically admits newly prepared objectives under the host policy without a per-objective Run or admission request', async () => {
    const f = await configured(true); const server = await start(f); const initial = await readSupervision(server);
    expect(await jsonResponse(await api(server, 'console', undefined, server.readToken))).toMatchObject({ engineeringPreparationAutoAdmission: true });
    const input = objective('automatic-first');
    const plan = await jsonResponse<ResourceConsoleEngineeringObjectivePlan>(await api(server, 'engineering/prepare/check', input));
    noExecution(f); expect((await readSupervision(server)).entries).toEqual([]);
    const first = await jsonResponse<ResourceConsoleEngineeringObjectivePrepared & { automaticAdmission: { state: string; supervisionId: string } }>(
      await api(server, 'engineering/prepare', { ...input, expectedPlanDigest: plan.planDigest }));
    expect(first.automaticAdmission).toEqual({ state: 'admitted', supervisionId: 'resident-queue' });
    await completed(server, first.enrollment.id); delivered(f, first.enrollment.id);
    const second = await prepare(server, 'automatic-second');
    expect(second).toMatchObject({ automaticAdmission: { state: 'admitted', supervisionId: 'resident-queue' } });
    await completed(server, second.enrollment.id); delivered(f, second.enrollment.id);
    expect(f.requests).toHaveLength(2); expect(f.evaluations).toHaveBeenCalledTimes(4); expect(f.publications()).toBe(2);
    expect(f.protocolErrors).toEqual([]);
    const final = await readSupervision(server); const receipts = f.ledger().attempts;
    expect(final).toMatchObject({ deadlineAt: initial.deadlineAt, admission: { maxEnrollments: 3, remainingEnrollments: 1 } });
    expect(final.entries.every(row => row.state === 'completed' && row.attempts === 1)).toBe(true);
    await server.close(); const restarted = await start(f);
    expect(await readSupervision(restarted)).toMatchObject({ deadlineAt: initial.deadlineAt, entries: final.entries, revision: final.revision });
    expect(await prepare(restarted, input.id)).toMatchObject({ disposition: 'replayed', automaticAdmission: { state: 'admitted', supervisionId: 'resident-queue' } });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(f.ledger().attempts).toEqual(receipts); expect(f.requests).toHaveLength(2); expect(f.evaluations).toHaveBeenCalledTimes(4); expect(f.publications()).toBe(2);
    expect(f.ledger()).toMatchObject({ allocation: f.allocation, workerAccess: f.workerAccess });
  }, 120_000);

  it('waits empty, executes only admitted prepared objectives, wakes after completion, and preserves replay/restart accounting', async () => {
    const f = await configured(); const server = await start(f);
    const initial = await readSupervision(server);
    expect(initial).toMatchObject({ entries: [], revision: 0, admission: { maxEnrollments: 3, remainingEnrollments: 3 } });
    const first = await prepare(server, 'first-correction'); const second = await prepare(server, 'second-correction');
    noExecution(f); expect((await readSupervision(server)).entries).toEqual([]);
    const admitted = await jsonResponse<Supervision>(await api(server, 'engineering-supervision/admit', { enrollments: [member(first)], expectedRevision: initial.revision }));
    expect(admitted).toMatchObject({ revision: 1, deadlineAt: initial.deadlineAt, admission: { maxEnrollments: 3, remainingEnrollments: 2 } });
    await completed(server, first.enrollment.id);
    expect(f.requests).toHaveLength(1); expect(f.evaluations).toHaveBeenCalledTimes(2); expect(f.publications()).toBe(1);
    delivered(f, first.enrollment.id);
    expect((await readSupervision(server)).entries.map(row => row.enrollmentId)).toEqual([first.enrollment.id]);
    const settledState = inventory(join(f.root, 'engineering-supervision'));
    const replay = await jsonResponse<Supervision>(await api(server, 'engineering-supervision/admit', { enrollments: [member(first)], expectedRevision: initial.revision }));
    expect(replay.revision).toBe(1); expect(inventory(join(f.root, 'engineering-supervision'))).toEqual(settledState);
    expect((await api(server, 'engineering-supervision/admit', { enrollments: [member(second)], expectedRevision: initial.revision })).status).toBe(409);
    expect(f.requests).toHaveLength(1);
    const next = await jsonResponse<Supervision>(await api(server, 'engineering-supervision/admit', { enrollments: [member(second)], expectedRevision: replay.revision }));
    expect(next).toMatchObject({ revision: 2, deadlineAt: initial.deadlineAt, admission: { maxEnrollments: 3, remainingEnrollments: 1 } });
    await completed(server, second.enrollment.id); delivered(f, second.enrollment.id);
    expect(f.requests).toHaveLength(2); expect(f.evaluations).toHaveBeenCalledTimes(4); expect(f.publications()).toBe(2); expect(f.protocolErrors).toEqual([]);
    const final = await readSupervision(server); const receipts = f.ledger().attempts;
    expect(final.entries.every(row => row.state === 'completed' && row.attempts === 1)).toBe(true);
    expect(receipts).toHaveLength(2); expect(receipts.every(row => row.workerId === 'repair' && row.status === 'completed')).toBe(true);
    expect(f.ledger()).toMatchObject({ allocation: f.allocation, workerAccess: f.workerAccess });
    await server.close(); const restarted = await start(f); const resumed = await readSupervision(restarted);
    expect(resumed).toMatchObject({ deadlineAt: initial.deadlineAt, revision: final.revision, entries: final.entries, admission: final.admission });
    const replayed = await jsonResponse<Supervision>(await api(restarted, 'engineering-supervision/admit', { enrollments: [member(first), member(second)], expectedRevision: 0 }));
    expect(replayed.revision).toBe(final.revision);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(f.ledger().attempts).toEqual(receipts); expect(f.requests).toHaveLength(2); expect(f.evaluations).toHaveBeenCalledTimes(4); expect(f.publications()).toBe(2);
    expect(f.ledger()).toMatchObject({ allocation: f.allocation, workerAccess: f.workerAccess });
  }, 120_000);

  it('admits while paused but waits for explicit resume, and refuses unauthenticated, foreign, stale and expired additions', async () => {
    const f = await configured(); const server = await start(f);
    const initial = await readSupervision(server);
    const paused = await jsonResponse<Supervision>(await api(server, 'engineering-supervision', { paused: true, expectedRevision: initial.revision }));
    const first = await prepare(server, 'paused-correction'); const second = await prepare(server, 'not-admitted');
    const input = { enrollments: [member(first)], expectedRevision: paused.revision };
    const before = inventory(join(f.root, 'engineering-supervision'));
    expect((await api(server, 'engineering-supervision/admit', input, server.readToken)).status).toBe(401);
    expect((await api(server, 'engineering-supervision/admit', input, server.controlToken!, null)).status).toBe(403);
    expect((await api(server, 'engineering-supervision/admit', input, server.controlToken!, 'http://localhost:1')).status).toBe(403);
    expect((await api(server, 'engineering-supervision/admit', { ...input, unexpected: true })).status).toBe(400);
    expect((await api(server, 'engineering-supervision/admit', { enrollments: [{ enrollmentId: 'foreign', expectedEnrollmentDigest: 'f'.repeat(64) }], expectedRevision: paused.revision })).status).toBe(409);
    expect(inventory(join(f.root, 'engineering-supervision'))).toEqual(before); noExecution(f);
    const admitted = await jsonResponse<Supervision>(await api(server, 'engineering-supervision/admit', input));
    expect(admitted).toMatchObject({ paused: true, revision: paused.revision + 1, deadlineAt: initial.deadlineAt });
    await new Promise(resolve => setTimeout(resolve, 300)); noExecution(f);
    await server.close(); const restarted = await start(f);
    const resumed = await readSupervision(restarted); expect(resumed).toMatchObject({ paused: true, revision: admitted.revision, deadlineAt: initial.deadlineAt });
    noExecution(f);
    expect((await api(restarted, 'engineering-supervision', { paused: false, expectedRevision: paused.revision })).status).toBe(409);
    await jsonResponse(await api(restarted, 'engineering-supervision', { paused: false, expectedRevision: admitted.revision }));
    await completed(restarted, first.enrollment.id); delivered(f, first.enrollment.id);
    expect(f.requests).toHaveLength(1); expect(f.evaluations).toHaveBeenCalledTimes(2);
    const current = await readSupervision(restarted); const checkpoint = inventory(join(f.root, 'engineering-supervision'));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(initial.deadlineAt) + 1);
    try {
      const response = await api(restarted, 'engineering-supervision/admit', { enrollments: [member(second)], expectedRevision: current.revision });
      expect([409, 503]).toContain(response.status);
    } finally { clock.mockRestore(); }
    expect(inventory(join(f.root, 'engineering-supervision'))).toEqual(checkpoint);
    expect(f.requests).toHaveLength(1); expect(f.publications()).toBe(1);
    expect(f.ledger()).toMatchObject({ allocation: f.allocation, workerAccess: f.workerAccess });
  }, 100_000);
});
