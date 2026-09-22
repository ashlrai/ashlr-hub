/** Actual worker, coordinator tick catch and independent journal reader. No mocked
 * worker messages or provider adapters; the sole fault is a parent domain refusal. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { canonical } from '../src/core/universe/artifacts.js';
import { createResourcePoolSupervisor, ResourceSupervisorError } from '../src/core/resources/pool-supervisor.js';
import { createResourceConsoleEngineeringOwner } from '../src/core/resources/console-engineering.js';
import { createEngineeringBackground } from '../src/core/resources/engineering-background.js';
import type { EngineeringBackground } from '../src/core/resources/engineering-background-types.js';
import type { ResourceConsoleEngineeringSupervisor } from '../src/core/resources/console-engineering-supervisor.js';
import type { ResourceConsoleEngineeringSupervisionSnapshot } from '../src/core/resources/console-engineering-supervisor-types.js';
import type { ResourceConsoleEngineeringPreparationConfig } from '../src/core/resources/console-engineering-preparation-types.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const save = (path: string, value: unknown) => writeFileSync(path, canonical(value) + '\n', { mode: 0o600 });
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
}

it('reports an actual caught coordinator loop fault while its worker and immutable journal remain available', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-lifecycle-')));
  cleanup.push(async () => { rmSync(base, { recursive: true, force: true }); });
  const workspace = join(base, 'repo'), transport = join(base, 'transport'), root = join(base, 'ledger'), outputRoot = join(base, 'prepared');
  for (const path of [workspace, transport, outputRoot]) mkdirSync(path, { mode: 0o700 });
  for (const path of [workspace, transport]) git(path, 'init', '-q', '--template=', '--initial-branch=main');
  writeFileSync(join(workspace, 'value.json'), '0\n');
  writeFileSync(join(workspace, 'evaluate.mjs'), 'throw Error("Evaluator must remain unexecuted");\n');
  git(workspace, 'add', '.'); git(workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed');
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.writeHead(500); response.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Fixture listener unavailable');
  const pool = validateResourcePool({ schemaVersion: 1, id: 'pool', workers: [{ id: 'worker', provider: 'local', model: 'inert', maxConcurrent: 1,
    reservePercent: 25, maxTasksPerWindow: 3, taskWindowMs: 60_000, priority: 1 }] });
  const bindings = validateResourceBindings([{ workerId: 'worker', capacityKey: 'shared', kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` }], pool);
  const poolFile = join(base, 'pool.json'), bindingsFile = join(base, 'bindings.json'), observationsFile = join(base, 'observations.json');
  save(poolFile, pool); save(bindingsFile, bindings); save(observationsFile, []);
  const projectsFile = join(base, 'projects.json'); save(projectsFile, { schemaVersion: 1, projects: [] });
  const resourceRuntime = join(base, 'runtime.json'); save(resourceRuntime, { schemaVersion: 1, root, workspace: transport,
    poolPath: poolFile, bindingsPath: bindingsFile, observationsPath: observationsFile });
  const config: ResourceConsoleEngineeringPreparationConfig = { schemaVersion: 1, outputRoot, resourceRuntime, profiles: [{
    id: 'pinned', label: 'Fixed checks', acceptance: 'Fixed evaluator and local delivery only.', recipe: {
      schemaVersion: 1, id: 'template', name: 'Pinned template', objective: 'Improve value', projectId: 'default', seedRevision: git(workspace, 'rev-parse', 'HEAD'),
      metric: { name: 'value', direction: 'maximize', minImprovement: 0 }, evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 1000 },
      trialBudget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 10_000, trialTimeoutMs: 5000 },
      campaignBudget: { maxGenerations: 1, maxDurationMs: 20_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: null },
      generation: { files: ['value.json'], contextFiles: ['evaluate.mjs'], allowedWorkerIds: ['worker'], maxOutputTokens: 128,
        hypotheses: [{ id: 'repair', niche: 'value', hypothesis: 'Improve value' }] }, delivery: { branch: 'codex/template', allowInitialRepair: true },
      execution: { maxDurationMs: 30_000, constitutionVersion: 'fixture', policyEpoch: 1 },
      supervision: { maxDurationMs: 60_000, pollIntervalMs: 1000, maxAttemptsPerEnrollment: 2 },
    } }] };
  const configFile = join(base, 'preparation.json'); save(configFile, config);
  const supervisor = await createResourcePoolSupervisor({ root, pool, bindings, workspace, projects: [], readObservations: () => [], pollIntervalMs: 60_000 });
  cleanup.push(() => supervisor.close());
  const owner = createResourceConsoleEngineeringOwner({ root, poolFile, bindingsFile, observationsFile, supervisor, registrationEnabled: true });
  cleanup.push(() => owner.close());
  const register = vi.spyOn(owner, 'register'), checkRegistration = vi.spyOn(owner, 'checkRegistration'), onFault = vi.fn();
  const background = await createEngineeringBackground({ preparation: { configFile, config, root, workspace, projectsFile, poolFile, bindingsFile, observationsFile },
    owner, supervisor, isClosing: () => false, onFault });
  cleanup.push(() => background.close());
  const successorConfig = { schemaVersion: 1 as const, supervisionId: 'queue', profileId: 'pinned', allowedWorkerIds: ['worker'],
    maxOutputTokens: 128, proposalTimeoutMs: 5000, maxSuccessors: 1, pollIntervalMs: 100 };
  const successorFile = join(base, 'successors.json'); save(successorFile, successorConfig);
  const state: ResourceConsoleEngineeringSupervisionSnapshot = { schemaVersion: 1, configId: 'queue', configDigest: 'a'.repeat(64), sourceState: 'healthy',
    state: 'running', deadlineAt: new Date(Date.now() + 60_000).toISOString(), paused: false, revision: 0,
    admission: { maxEnrollments: 2, remainingEnrollments: 2, autoAdmitPrepared: false }, entries: [] };
  let refuse = false; const sentinel = '/private/lifecycle-sentinel-secret';
  const snapshot = vi.fn(() => { if (refuse) throw new ResourceSupervisorError('UNAVAILABLE', sentinel); return structuredClone(state); });
  const admit = vi.fn(), admissionEvidence = vi.fn(() => ({ observations: [], unavailableWorkerIds: [] }));
  const supervision = { snapshot, admit, isExecutionStopped: () => false } as unknown as ResourceConsoleEngineeringSupervisor;
  await background.configureSuccessors({ root, configFile: successorFile, config: successorConfig, projectId: 'default', acceptance: 'Fixed checks', pool, bindings }, supervision, admissionEvidence);
  const initial = await background.snapshot(); const records = join(root, 'engineering-successors', 'queue', 'events', 'records');
  expect(initial.observation?.coordinator).toMatchObject({ state: 'idle', reason: null });
  const saved = readdirSync(records).map(name => [name, readFileSync(join(records, name), 'utf8')]);
  const beforeCalls = snapshot.mock.calls.length; refuse = true; await background.start();
  let observed: Awaited<ReturnType<EngineeringBackground['snapshot']>> | undefined;
  await vi.waitFor(async () => { observed = await background.snapshot(); expect(observed.observation?.coordinator).toMatchObject({ state: 'faulted', reason: 'coordinator-loop-failed' }); }, { timeout: 10_000, interval: 50 });
  expect(snapshot.mock.calls.length).toBeGreaterThan(beforeCalls);
  expect(observed).toMatchObject({ state: 'observing', deadlineAt: state.deadlineAt, entries: [], observation: { workerState: 'connected',
    recordsDigest: initial.observation!.recordsDigest, coordinator: { schemaVersion: 1, supervisionId: 'queue', configDigest: initial.configDigest, deadlineAt: state.deadlineAt } } });
  expect(observed!.observation!.coordinator!.sequence).toBeGreaterThan(initial.observation!.coordinator!.sequence);
  const report = observed!.observation!.coordinator!;
  expect(new Date(report.reportedAt).toISOString()).toBe(report.reportedAt);
  expect((await background.snapshot()).observation?.coordinator).toEqual(report);
  expect(JSON.stringify(observed)).not.toContain(sentinel); expect(onFault).not.toHaveBeenCalled();
  expect(readdirSync(records).map(name => [name, readFileSync(join(records, name), 'utf8')])).toEqual(saved);
  expect(await background.profiles('default')).toHaveLength(1);
  expect(requests).toBe(0); expect(admissionEvidence).not.toHaveBeenCalled(); expect(admit).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled(); expect(checkRegistration).not.toHaveBeenCalled(); expect(owner.catalog()).toEqual([]);
  expect(existsSync(join(root, 'pool-state.json'))).toBe(false); expect(readdirSync(outputRoot)).toEqual([]);
}, 30_000);
