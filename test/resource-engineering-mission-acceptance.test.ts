/** Actual mission -> console -> local transport -> evaluated Git delivery, with a stopped/restarted owner. */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import { canonical } from '../src/core/universe/artifacts.js';
import { writePrivateFileAtomically } from '../src/core/util/private-file-write.js';
import { createResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import * as supervisorModule from '../src/core/resources/pool-supervisor.js';
import { startResourceConsoleServer } from '../src/core/web/resource-console-server.js';
import { resourcePoolStatus, setResourcePoolAllocation, setResourceWorkerAccess } from '../src/core/resources/pool-runtime.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { checkResourceEngineeringAutonomousSetup, prepareResourceEngineeringAutonomousSetup } from '../src/core/resources/engineering-autonomous-setup.js';
import { runResourceEngineeringMission } from '../src/core/resources/engineering-mission.js';
import * as missionProof from '../src/core/resources/engineering-mission-proof.js';
import * as missionConsole from '../src/core/resources/engineering-mission-console.js';
import { readEngineeringMissionRecords, type ResourceEngineeringMissionConfig } from '../src/core/resources/engineering-mission-store.js';
import { readEngineeringMissionInvocations } from '../src/core/resources/engineering-mission-invocations.js';
import type { ResourceEngineeringRecipe } from '../src/core/resources/engineering-preparation-types.js';

const cleanup: Array<() => Promise<void>> = [];
let retainFailedFixture = false;
afterEach(async ({ task }) => {
  retainFailedFixture = task.result?.state === 'fail';
  for (const close of cleanup.splice(0).reverse()) await close();
  retainFailedFixture = false;
});
const save = (file: string, value: unknown) => writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } }).trim();
}
async function fixture() {
  expect(homedir()).not.toBe(process.env.ASHLR_VITEST_REAL_HOME);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-mission-')));
  const project = join(base, 'project'), transport = join(base, 'transport'), root = join(base, 'ledger');
  const output = join(base, 'initial'), missionRoot = join(base, 'mission');
  for (const dir of [project, transport, output, missionRoot]) mkdirSync(dir, { mode: 0o700 });
  for (const dir of [project, transport]) git(dir, 'init', '-q', '--template=', '--initial-branch=main');
  writeFileSync(join(project, 'value.json'), '0\n');
  writeFileSync(join(project, 'evaluate.mjs'), "import{readFileSync}from'node:fs';import{join}from'node:path';const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));console.log(JSON.stringify({passed:Number.isInteger(value)&&value>=0&&value<=3,score:value,metrics:{value},diagnostics:[]}));");
  git(project, 'add', '.'); git(project, '-c', 'user.name=Mission Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixed evaluator');
  const revision = git(project, 'rev-parse', 'HEAD');
  const calls = { generation: 0, successor: 0, mission: 0 }; const errors: string[] = [];
  const humanResponses: ServerResponse[] = [];
  const worker = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk)); req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); const raw = JSON.parse(body.messages[0].content);
        const context = Array.isArray(raw) ? JSON.parse(raw.find(row => row.role === 'user').content) : raw;
        if (context.kind === 'human-hold') { humanResponses.push(res); return; }
        let content: unknown;
        if (context.seedContext) {
          calls.generation++; const value = JSON.parse(context.files.find((row: { path: string }) => row.path === 'value.json').content);
          expect(value).toBe(calls.generation - 1);
          content = { operations: [{ op: 'replace', path: 'value.json', content: `${value + 1}\n` }] };
        } else if (context.kind === 'engineering-successor-proposal') {
          calls.successor++;
          content = calls.successor === 1 ? { action: 'propose', name: 'Second value', objective: 'Improve the measured result to two.' } : { action: 'stop' };
        } else {
          expect(context.kind).toBe('engineering-mission-proposal'); expect(calls.generation).toBe(2); calls.mission++;
          content = { action: 'propose', name: 'Third value', objective: 'Improve the delivered value to three.' };
        }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
      } catch { errors.push('Fixture protocol mismatch'); res.writeHead(500); res.end('Fixture refused'); }
    });
  });
  await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    worker.closeAllConnections(); await new Promise<void>(resolve => worker.close(() => resolve()));
    const writable = (file: string): void => { if (!lstatSync(file).isDirectory()) return; chmodSync(file, 0o700); for (const child of readdirSync(file)) writable(join(file, child)); };
    if (retainFailedFixture) console.log('MISSION_FAILURE_FIXTURE', base);
    else { writable(base); rmSync(base, { recursive: true, force: true }); }
  });
  const address = worker.address(); if (!address || typeof address === 'string') throw Error('Missing fixture listener');
  const pool = validateResourcePool({ schemaVersion: 1, id: 'mission-fixture', workers: ['repair', 'spare', 'human'].map(id => ({
    id, provider: 'local', model: 'fixture', maxConcurrent: 1, maxTasksPerWindow: 12, taskWindowMs: 3600_000, reservePercent: 25, priority: 1 })) });
  const bindings = validateResourceBindings(pool.workers.map(row => ({ workerId: row.id, capacityKey: row.id, kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` })), pool);
  const observations = pool.workers.map(row => ({ workerId: row.id, health: 'ready' as const, windows: [], retryAfter: null,
    observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 290_000).toISOString() }));
  const paths = { pool: join(base, 'pool.json'), bindings: join(base, 'bindings.json'), observations: join(base, 'observations.json'), projects: join(base, 'projects.json'), runtime: join(base, 'runtime.json') };
  save(paths.pool, pool); save(paths.bindings, bindings); save(paths.observations, observations); save(paths.projects, { schemaVersion: 1, projects: [] });
  // The fixture owns a live local transport, so refresh its health observation
  // instead of inventing a quota observation longer than the five-minute bound.
  const refresh = setInterval(() => {
    if (!worker.listening) return;
    for (const observation of observations) {
      observation.observedAt = new Date(Date.now() - 1000).toISOString();
      observation.expiresAt = new Date(Date.now() + 290_000).toISOString();
    }
    writePrivateFileAtomically(join(base, 'observations-next.json'), paths.observations, canonical(observations) + '\n',
      { anchorPath: base, label: 'Mission fixture observations' });
  }, 60_000);
  cleanup.push(async () => { clearInterval(refresh); });
  save(paths.runtime, { schemaVersion: 1, root, workspace: transport, poolPath: paths.pool, bindingsPath: paths.bindings, observationsPath: paths.observations, capacityWaitMs: 1000 });
  const prior = await createResourcePoolSupervisor({ root, pool, bindings, workspace: project, projects: [], readObservations: () => observations }); await prior.close();
  const allocation = setResourcePoolAllocation(root, pool, bindings, 75, 0); const access = setResourceWorkerAccess(root, pool, bindings, ['spare'], 0); loadOrCreateKey();
  const recipe: ResourceEngineeringRecipe = { schemaVersion: 1, id: 'first', name: 'First value', objective: 'Improve the fixed integer score.', projectId: 'default',
    seedRevision: revision, metric: { name: 'value', direction: 'maximize', minImprovement: 1 }, evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3000 },
    trialBudget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 30_000, trialTimeoutMs: 15_000 },
    campaignBudget: { maxGenerations: 1, maxDurationMs: 90_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: 30 },
    generation: { files: ['value.json'], contextFiles: [], allowedWorkerIds: ['repair'], maxOutputTokens: 256,
      hypotheses: [{ id: 'improve', niche: 'value', hypothesis: 'Increase the integer by one' }] }, delivery: { branch: 'codex/first' },
    execution: { maxDurationMs: 120_000, constitutionVersion: 'fixture-v1', policyEpoch: 1 },
    supervision: { maxDurationMs: 600_000, pollIntervalMs: 100, maxAttemptsPerEnrollment: 3 } };
  const setup = { recipe, policy: { schemaVersion: 1, id: 'initial-queue', registrationScope: 'initial-scope', profileId: 'fixed', label: 'Fixed integer',
    acceptance: 'Only the declared integer may change; the evaluator is fixed.', maxEnrollments: 2, maxConcurrent: 1,
    successors: { allowedWorkerIds: ['repair'], maxOutputTokens: 256, proposalTimeoutMs: 60_000, maxSuccessors: 1, pollIntervalMs: 100 } },
  output, resourceRuntime: paths.runtime, workspace: project, projectsFile: paths.projects };
  const plan = checkResourceEngineeringAutonomousSetup(setup); prepareResourceEngineeringAutonomousSetup({ ...setup, expectedPlanDigest: plan.planDigest });
  const config: ResourceEngineeringMissionConfig = { schemaVersion: 1, id: 'measured-mission', root: missionRoot,
    initial: { setup, expectedPlanDigest: plan.planDigest }, deadlineAt: new Date(Date.now() + 1800_000).toISOString(), maxScopes: 2, pollIntervalMs: 100 };
  return { base, project, root, config, allocation, access, pool, bindings, observations, paths, calls, errors, revision, humanResponses };
}

describe.runIf(process.platform === 'darwin')('actual standing engineering mission', () => {
  it('reconciles scope one after owner restart, proposes and executes scope two on the same ledger, then honors stop', async () => {
    const f = await fixture(); const stop = new AbortController(); const phases: string[] = [];
    const proofFailures: string[] = []; const readProof = missionProof.readEngineeringMissionProof;
    const observeProof = vi.spyOn(missionProof, 'readEngineeringMissionProof').mockImplementation(async (request, host) => {
      try {
        const result = await readProof(request, host);
        if (result.status === 'held') proofFailures.push(`${request.kind}:held:${result.reasons.join(',')}`);
        return result;
      }
      catch (error) { proofFailures.push(`${request.kind}:${error instanceof Error ? error.message : 'unavailable'}`); throw error; }
    });
    cleanup.push(async () => { observeProof.mockRestore(); });
    const consoleFailures: string[] = []; const requestConsole = missionConsole.requestEngineeringMissionConsole;
    const observeConsole = vi.spyOn(missionConsole, 'requestEngineeringMissionConsole').mockImplementation(async options => {
      try { return await requestConsole(options); }
      catch (error) { consoleFailures.push(`${options.path}:${error instanceof Error ? error.name : 'unavailable'}`); throw error; }
    });
    cleanup.push(async () => { observeConsole.mockRestore(); });
    const first = await runResourceEngineeringMission(f.config, { signal: stop.signal, onProgress(value) {
      phases.push(`${value.scope}:${value.phase}`); if (value.scope === 1 && value.phase === 'verifying') stop.abort();
    } });
    expect(first, JSON.stringify({ first, phases, calls: f.calls, errors: f.errors, proofFailures, consoleFailures, fixture: f.base })).toMatchObject({ state: 'stopped', scopesReserved: 1, deadlineAt: f.config.deadlineAt });
    expect(f.calls).toEqual({ generation: 2, successor: 1, mission: 0 });
    expect(readEngineeringMissionInvocations(f.config)).toMatchObject({ count: 1, unfinishedCount: 0,
      latest: { outcome: { state: 'stopped', reason: first.reason } } });
    const firstRows = readEngineeringMissionRecords(f.config); expect(firstRows.some(row => row.kind === 'settled')).toBe(true);
    let interruptedOwner!: Awaited<ReturnType<typeof createResourcePoolSupervisor>>;
    const createOwner = supervisorModule.createResourcePoolSupervisor;
    const captureOwner = vi.spyOn(supervisorModule, 'createResourcePoolSupervisor').mockImplementation(async options => {
      interruptedOwner = await createOwner(options); return interruptedOwner;
    });
    const interruptedWorkspace = await startResourceConsoleServer({ root: f.root, workspace: f.project, poolFile: f.paths.pool,
      bindingsFile: f.paths.bindings, observationsFile: f.paths.observations, projectsFile: f.paths.projects, execute: true, port: 0 })
      .finally(() => captureOwner.mockRestore());
    cleanup.push(() => interruptedWorkspace.close());
    const admit = interruptedWorkspace.recoverTask;
    interruptedWorkspace.recoverTask = (task, lifetime) => {
      admit(task, lifetime);
      // Lose the real owner after atomic job publication and before any timer
      // can dispatch. This models the crash boundary, not a provider failure.
      // Workspace.close alone is graceful: it defers queue close to a microtask,
      // allowing the mission to cancel its task first. Lose queue custody now.
      void interruptedOwner.close();
      void interruptedWorkspace.close(); throw Error('Fixture owner interrupted after admission');
    };
    const interrupted = await runResourceEngineeringMission(f.config, { workspace: { handle: interruptedWorkspace, expectedAttachment: null } });
    expect(interrupted, JSON.stringify({ interrupted, calls: f.calls, errors: f.errors, proofFailures, consoleFailures }))
      .toMatchObject({ state: 'held', reason: 'shutdown-unresolved', deadlineAt: f.config.deadlineAt });
    await interruptedWorkspace.close();
    expect(f.calls).toEqual({ generation: 2, successor: 1, mission: 0 });
    const abandoned = json(join(f.root, 'resource-console-state.json')).jobs.find((job: { id: string }) => job.id.startsWith('mission-proposal-'));
    expect(abandoned).toMatchObject({ state: 'queued', executionDeadlineAt: f.config.deadlineAt });
    const workspace = await startResourceConsoleServer({ root: f.root, workspace: f.project, poolFile: f.paths.pool,
      bindingsFile: f.paths.bindings, observationsFile: f.paths.observations, projectsFile: f.paths.projects, execute: true, port: 0 });
    cleanup.push(() => workspace.close());
    // A deliberately unavailable human task must stay queued, not be cancelled
    // or consume a disabled worker, while the mission advances on the same owner.
    workspace.submitTask({ id: 'human-queued', prompt: 'Keep my private human work', allowedWorkerIds: ['spare'],
      mode: 'read-only', timeoutMs: 1000, maxOutputTokens: 128, retainHistory: true });
    workspace.submitTask({ id: 'human-running', prompt: canonical({ kind: 'human-hold' }), allowedWorkerIds: ['human'],
      mode: 'read-only', timeoutMs: 900_000, maxOutputTokens: 128, retainHistory: true });
    await vi.waitFor(() => expect(f.humanResponses).toHaveLength(1));
    const sharedUrls: Array<string | null> = [];
    const second = await runResourceEngineeringMission(f.config, { workspace: { handle: workspace, expectedAttachment: null },
      onProgress(value) { phases.push(`${value.scope}:${value.phase}`); sharedUrls.push(value.consoleUrl); } });
    expect(second, JSON.stringify({ second, phases, calls: f.calls, errors: f.errors, proofFailures, consoleFailures, fixture: f.base })).toMatchObject({ state: 'completed', reason: 'stop-requested', scopesReserved: 2, deadlineAt: f.config.deadlineAt });
    expect(second.tip).not.toBeNull(); expect(git(f.project, 'show', `${second.tip!.commit}:value.json`)).toBe('3');
    expect(git(f.project, 'rev-parse', 'HEAD')).toBe(f.revision); expect(git(f.project, 'status', '--porcelain=v1')).toBe('');
    expect(f.calls).toEqual({ generation: 3, successor: 2, mission: 1 }); expect(f.errors).toEqual([]);
    const recovered = json(join(f.root, 'resource-console-state.json')).jobs.find((job: { recoveryOf?: string }) => job.recoveryOf === abandoned.id);
    expect(recovered).toMatchObject({ state: 'settled', outcome: 'completed', executionDeadlineAt: f.config.deadlineAt });
    expect(resourcePoolStatus(f.root, f.pool, f.bindings, []).attempts.some(row => row.id === abandoned.id)).toBe(false);
    const ledger = resourcePoolStatus(f.root, f.pool, f.bindings, f.observations);
    expect(ledger.attempts).toHaveLength(7);
    expect(ledger.attempts.filter(row => row.id !== 'human-running').every(row => row.status === 'completed' && row.workerId === 'repair')).toBe(true);
    expect(ledger.attempts.find(row => row.id === 'human-running')).toMatchObject({ status: 'reserved', workerId: 'human' });
    expect(ledger.allocation).toEqual(f.allocation); expect(ledger.workerAccess).toEqual(f.access);
    const final = readEngineeringMissionRecords(f.config);
    for (const row of firstRows) expect(final.find(item => item.id === row.id)).toEqual(row);
    const scopes = final.filter(row => row.kind === 'reserved'); expect(scopes).toHaveLength(2);
    const next = scopes[1]!.payload as { setup: { recipe: ResourceEngineeringRecipe } };
    const prior = firstRows.find(row => row.kind === 'settled')!.payload as { tip: { commit: string } };
    expect(next.setup.recipe.seedRevision).toBe(prior.tip.commit);
    expect(phases).toContain('1:reconciling'); expect(phases).toContain('2:executing');
    expect(existsSync(join(f.config.root, '.mission.lock'))).toBe(false);
    expect(existsSync(join(f.root, '.resource-console.lock'))).toBe(true);
    expect(sharedUrls.length).toBeGreaterThan(0); expect(sharedUrls.every(url => url === workspace.consoleUrl)).toBe(true);
    expect(workspace.engineeringAttachment()?.state()).toBe('closed');
    expect(json(join(f.root, 'resource-console-state.json')).jobs.find((job: { id: string }) => job.id === 'human-queued')).toMatchObject({ state: 'queued' });
    expect(json(join(f.root, 'resource-console-state.json')).jobs.find((job: { id: string }) => job.id === 'human-running')).toMatchObject({ state: 'dispatching' });
    expect((await fetch(`${workspace.url}/api/resources/console`, { headers: { 'x-ashlr-token': workspace.readToken } })).status).toBe(200);
    f.humanResponses[0]!.end(JSON.stringify({ choices: [{ message: { content: 'Human work survived the mission' }, finish_reason: 'stop' }] }));
    await vi.waitFor(() => expect(resourcePoolStatus(f.root, f.pool, f.bindings, []).attempts.find(row => row.id === 'human-running')?.status).toBe('completed'));
    // Closing a human workspace deliberately retains its queued work. The
    // human fixture must withdraw that job explicitly before asking the stopped
    // (ownerless) predecessor reader to establish fully resolved accounting.
    const queued = json(join(f.root, 'resource-console-state.json')).jobs.find((job: { id: string }) => job.id === 'human-queued');
    await workspace.cancelTaskAndDrain(queued.id, queued.taskDigest);
    await workspace.close();
    expect(existsSync(join(f.root, '.resource-console.lock'))).toBe(false);
    expect(json(join(f.root, 'resource-console-state.json')).paused).toBe(false);
    // Completed history remains inspectable under an explicit stop; replay must
    // neither restart a console nor propose a replacement task on any scope.
    const stopped = new AbortController(); stopped.abort(); const replayPhases: string[] = []; const replayUrls: Array<string | null> = [];
    const replay = await runResourceEngineeringMission(f.config, { signal: stopped.signal,
      onProgress(value) { replayPhases.push(`${value.scope}:${value.phase}`); replayUrls.push(value.consoleUrl); } });
    expect(replay, JSON.stringify({ replay, second, replayPhases })).toEqual(second); expect(replayPhases).toContain('2:reconciling');
    // Observer exceptions are intentionally isolated by the runner, so assertions
    // belong outside that callback where a regression can actually fail the test.
    expect(replayUrls.every(url => url === null)).toBe(true);
    expect(f.calls).toEqual({ generation: 3, successor: 2, mission: 1 });
    expect(readEngineeringMissionRecords(f.config)).toEqual(final);
    const invocations = readEngineeringMissionInvocations(f.config);
    expect(invocations).toMatchObject({ count: 4, unfinishedCount: 0,
      latest: { index: 4, outcome: { state: 'completed', reason: 'stop-requested', scopesReserved: 2 } } });
    expect(invocations.latest!.timings.some(row => row.phase === 'reconciling')).toBe(true);
  }, 1800_000);
});
