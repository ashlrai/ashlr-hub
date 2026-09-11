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
import type { ResourceEngineeringOutcomes } from '../src/core/resources/engineering-outcomes-types.js';
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
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'console-preparation-acceptance-')));
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
    projectsFile: join(base, 'projects.json'), runtimeFile: join(base, 'runtime.json'), engineeringPreparationFile: join(base, 'preparation.json') };
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
    engineeringPreparationFile: f.files.engineeringPreparationFile });
  cleanups.push(() => server.close()); return server;
}
async function configured() {
  const f = await fixture();
  const config: ResourceConsoleEngineeringPreparationConfig = { schemaVersion: 1, outputRoot: f.outputRoot,
    resourceRuntime: f.files.runtimeFile, profiles: [{ id: 'value-profile', label: 'Pinned value repair',
      acceptance: 'Fixed evaluator requires value.json to contain one; evaluator is not mutable.', recipe: f.recipe }] };
  save(f.files.engineeringPreparationFile, config);
  return { ...f, config };
}
async function jsonResponse<T>(response: Response, status = 200): Promise<T> {
  const value = await response.json(); expect(response.status, JSON.stringify(value)).toBe(status);
  expect(response.headers.get('cache-control')).toContain('no-store'); return value as T;
}

describe.runIf(process.platform === 'darwin')('same-console objective preparation and explicit engineering execution', () => {
  it('checks without effects, registers without execution, runs only on explicit request, and reloads the durable enrollment without replay', async () => {
    const f = await configured(); const server = await start(f); const input = objective();
    const beforeCheck = inventory(f.base); const home = inventory(homedir());
    const profiles = await jsonResponse<{ profiles: Array<{ id: string; projectId: string }> }>(await api(server, 'engineering/profiles', { projectId: 'default' }));
    expect(profiles.profiles).toMatchObject([{ id: 'value-profile', projectId: 'default' }]);
    expect(await jsonResponse(await api(server, 'engineering/profiles', { projectId: 'other' }))).toEqual({ profiles: [] });
    const plan = await jsonResponse<ResourceConsoleEngineeringObjectivePlan>(await api(server, 'engineering/prepare/check', input));
    expect(plan).toMatchObject({ status: 'planned', id: input.id, profileId: input.profileId, branch: `codex/${input.id}`,
      projectId: 'default', seedRevision: f.revision, files: ['value.json'], allowedWorkerIds: ['repair'], executionStarted: false, providerContacted: false });
    expect(inventory(f.base)).toEqual(beforeCheck); expect(inventory(homedir())).toEqual(home); noExecution(f);
    const prepared = await jsonResponse<ResourceConsoleEngineeringObjectivePrepared>(await api(server, 'engineering/prepare', { ...input, expectedPlanDigest: plan.planDigest }));
    expect(prepared).toMatchObject({ disposition: 'created', plan, enrollment: { id: input.id, projectId: 'default' } });
    noExecution(f); expect(f.ledger().attempts).toEqual([]); expect(f.ledger()).toMatchObject({ allocation: f.allocation, workerAccess: f.workerAccess });
    expect(inventory(homedir())).toEqual(home);
    const catalog = await jsonResponse<Array<{ id: string; enrollmentDigest: string }>>(await api(server, 'engineering', undefined, server.readToken));
    expect(catalog).toContainEqual(expect.objectContaining({ id: input.id, enrollmentDigest: prepared.enrollment.enrollmentDigest }));
    const readOutcomes = (handle = server) => api(handle, `engineering/${input.id}/outcomes`, undefined, handle.readToken);
    expect(await jsonResponse(await api(server, 'console', undefined, server.readToken))).toMatchObject({ engineeringOutcomesSupported: true });
    const beforeOutcomes = inventory(f.base);
    const empty = await jsonResponse<ResourceEngineeringOutcomes>(await readOutcomes());
    expect(empty).toMatchObject({ enrollmentId: input.id, enrollmentDigest: prepared.enrollment.enrollmentDigest,
      authority: 'observation-only', productionAccepted: null, routingChanged: false, usage: { attempts: 0, totalTokens: null } });
    expect(inventory(f.base)).toEqual(beforeOutcomes); noExecution(f);
    expect((await api(server, `engineering/${input.id}/outcomes`, undefined, '')).status).toBe(401);
    expect((await api(server, 'engineering/foreign/outcomes', undefined, server.readToken)).status).toBe(404);
    expect((await api(server, 'engineering/start', { enrollmentId: input.id, expectedEnrollmentDigest: prepared.enrollment.enrollmentDigest })).status).toBe(202);
    await vi.waitFor(async () => {
      const job = await jsonResponse<{ state: string }>(await api(server, `engineering/${input.id}`, undefined, server.readToken));
      expect(job.state).toBe('completed');
    }, { timeout: 45_000, interval: 100 });
    expect(f.protocolErrors).toEqual([]); expect(f.requests).toHaveLength(1); expect(f.evaluations).toHaveBeenCalledTimes(2); expect(f.publications()).toBe(1);
    expect(f.ledger().attempts).toHaveLength(1); expect(f.ledger().attempts[0]).toMatchObject({ workerId: 'repair', status: 'completed' });
    expect(f.ledger()).toMatchObject({ allocation: f.allocation, workerAccess: f.workerAccess });
    expect(git(f.repo, 'show', `codex/${input.id}:value.json`)).toBe('1');
    expect(git(f.repo, 'diff', '--name-only', f.revision, `codex/${input.id}`)).toBe('value.json');
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.revision); expect(git(f.repo, 'status', '--porcelain=v1')).toBe('');
    const measured = await jsonResponse<ResourceEngineeringOutcomes>(await readOutcomes());
    expect(measured).toMatchObject({ sourceState: 'healthy', complete: true, enrollmentId: input.id,
      usage: { attempts: 1, joinedAttempts: 1, reportedAttempts: 1, unknownAttempts: 0, recordedInputTokens: 20,
        recordedOutputTokens: 10, totalTokens: 30, complete: true }, campaigns: [{ campaignId: input.id,
        seed: { status: 'measured', score: 0, passed: false }, stages: { trials: 1, evaluated: 1, passed: 1,
          rejected: 0, selected: 1, verifiedLocalDeliveries: 1 }, workers: [{ workerId: 'repair', provider: 'local', model: 'fixture' }] }] });
    expect(measured.campaigns[0]!.niches[0]).toMatchObject({ score: 1, deltaFromSeed: 1 });
    expect(measured.timing).toMatchObject({ scope: 'summed-worker-execution', attempts: 1,
      measuredAttempts: 1, complete: true, totalDurationMs: expect.any(Number) });
    expect(measured.timing.totalDurationMs).toBe(f.ledger().attempts[0]!.execution!.durationMs);
    expect(measured.campaigns[0]!.timing).toEqual(measured.timing);
    expect(measured.campaigns[0]!.workers[0]!.timing).toEqual(measured.timing);
    expect(JSON.stringify(measured)).not.toContain(f.base);
    await server.close(); const receipts = f.ledger().attempts; const restarted = await start(f);
    expect(await jsonResponse(await api(restarted, 'engineering', undefined, restarted.readToken))).toContainEqual(expect.objectContaining({ id: input.id, enrollmentDigest: prepared.enrollment.enrollmentDigest }));
    expect(await jsonResponse(await api(restarted, `engineering/${input.id}`, undefined, restarted.readToken))).toMatchObject({ state: 'completed' });
    const beforeReplay = inventory(f.base);
    const reloaded = await jsonResponse<ResourceEngineeringOutcomes>(await readOutcomes(restarted));
    expect({ ...reloaded, sampledAt: measured.sampledAt }).toEqual(measured);
    expect(await jsonResponse(await api(restarted, 'engineering/prepare', { ...input, expectedPlanDigest: plan.planDigest }))).toMatchObject({ disposition: 'replayed', plan,
      enrollment: { enrollmentDigest: prepared.enrollment.enrollmentDigest } });
    expect(inventory(f.base)).toEqual(beforeReplay);
    expect((await api(restarted, 'engineering/start', { enrollmentId: input.id, expectedEnrollmentDigest: prepared.enrollment.enrollmentDigest })).status).toBe(202);
    expect(f.ledger().attempts).toEqual(receipts); expect(f.requests).toHaveLength(1); expect(f.evaluations).toHaveBeenCalledTimes(2); expect(f.publications()).toBe(1);
    git(f.repo, 'update-ref', `refs/heads/codex/${input.id}`, f.revision);
    const drifted = await jsonResponse<ResourceEngineeringOutcomes>(await readOutcomes(restarted));
    expect(drifted.campaigns[0]!.stages.verifiedLocalDeliveries).toBeNull();
    expect(drifted.complete).toBe(false);
    expect(f.ledger().attempts).toEqual(receipts); expect(f.requests).toHaveLength(1); expect(f.evaluations).toHaveBeenCalledTimes(2);
  }, 75_000);

  it('rejects missing authority, cross-project overrides and extra recipe fields before any registration', async () => {
    const f = await configured(); const server = await start(f); const input = objective(); const before = inventory(f.base);
    expect((await api(server, 'engineering/profiles', { projectId: 'default' }, server.readToken)).status).toBe(401);
    expect((await api(server, 'engineering/profiles', { projectId: 'default' }, server.controlToken!, null)).status).toBe(403);
    expect((await api(server, 'engineering/prepare/check', input, '')).status).toBe(401);
    expect((await api(server, 'engineering/prepare/check', input, server.controlToken!, 'https://example.invalid')).status).toBe(403);
    expect((await api(server, 'engineering/prepare/check', { ...input, projectId: 'other' })).status).toBe(400);
    expect((await api(server, 'engineering/prepare/check', { ...input, generation: { allowedWorkerIds: ['spare'] } })).status).toBe(400);
    expect((await api(server, 'engineering/prepare/check', { ...input, profileId: 'unknown-profile' })).status).toBe(404);
    expect((await api(server, 'engineering/prepare', { ...input, expectedPlanDigest: 'a'.repeat(64) })).status).toBe(409);
    expect(inventory(f.base)).toEqual(before); noExecution(f); expect(readdirSync(f.outputRoot)).toEqual([]);
  });

  it('refuses stale reviewed input and host-profile drift instead of publishing a changed objective', async () => {
    const f = await configured(); const server = await start(f); const input = objective();
    const plan = await jsonResponse<ResourceConsoleEngineeringObjectivePlan>(await api(server, 'engineering/prepare/check', input));
    const before = inventory(f.base);
    expect((await api(server, 'engineering/prepare', { ...input, objective: 'Changed after review', expectedPlanDigest: plan.planDigest })).status).toBe(409);
    expect(inventory(f.base)).toEqual(before); noExecution(f);
    save(f.files.engineeringPreparationFile, { ...f.config, profiles: [{ ...f.config.profiles[0], acceptance: 'Changed host description' }] });
    const changed = inventory(f.base);
    const response = await api(server, 'engineering/prepare', { ...input, expectedPlanDigest: plan.planDigest });
    expect([409, 503]).toContain(response.status); expect(inventory(f.base)).toEqual(changed); noExecution(f);
  });
  it('restores a registered objective after unrelated profile additions but refuses changes to its selected profile', async () => {
    const f = await configured(); const server = await start(f); const input = objective();
    const plan = await jsonResponse<ResourceConsoleEngineeringObjectivePlan>(await api(server, 'engineering/prepare/check', input));
    const prepared = await jsonResponse<ResourceConsoleEngineeringObjectivePrepared>(await api(server, 'engineering/prepare', { ...input, expectedPlanDigest: plan.planDigest }));
    await server.close(); noExecution(f);
    const expanded: ResourceConsoleEngineeringPreparationConfig = { ...f.config, profiles: [...f.config.profiles,
      { ...f.config.profiles[0]!, id: 'another-profile', label: 'Another separately selectable profile',
        recipe: { ...f.recipe, id: 'another-template', name: 'Another template', delivery: { ...f.recipe.delivery, branch: 'codex/another-template' } } }] };
    save(f.files.engineeringPreparationFile, expanded); const restarted = await start(f);
    expect(await jsonResponse(await api(restarted, 'engineering', undefined, restarted.readToken))).toContainEqual(expect.objectContaining({
      id: input.id, enrollmentDigest: prepared.enrollment.enrollmentDigest }));
    const before = inventory(f.base);
    expect(await jsonResponse(await api(restarted, 'engineering/prepare', { ...input, expectedPlanDigest: plan.planDigest }))).toMatchObject({ disposition: 'replayed', plan });
    expect(inventory(f.base)).toEqual(before); noExecution(f); await restarted.close();
    save(f.files.engineeringPreparationFile, { ...expanded, profiles: expanded.profiles.map(profile => profile.id === input.profileId
      ? { ...profile, acceptance: 'Selected fixed acceptance description changed' } : profile) });
    const bundle = inventory(join(f.outputRoot, input.id)); const receipts = f.ledger().attempts;
    await expect(start(f)).rejects.toThrow();
    expect(inventory(join(f.outputRoot, input.id))).toEqual(bundle); expect(f.ledger().attempts).toEqual(receipts); noExecution(f);
  });
});
