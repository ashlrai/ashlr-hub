/** Actual mission -> console -> local transport -> evaluated Git delivery, with a stopped/restarted owner. */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import { canonical } from '../src/core/universe/artifacts.js';
import { writePrivateFileAtomically } from '../src/core/util/private-file-write.js';
import { createResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import { resourcePoolStatus, setResourcePoolAllocation, setResourceWorkerAccess } from '../src/core/resources/pool-runtime.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { checkResourceEngineeringAutonomousSetup, prepareResourceEngineeringAutonomousSetup } from '../src/core/resources/engineering-autonomous-setup.js';
import { runResourceEngineeringMission } from '../src/core/resources/engineering-mission.js';
import { readEngineeringMissionRecords, type ResourceEngineeringMissionConfig } from '../src/core/resources/engineering-mission-store.js';
import type { ResourceEngineeringRecipe } from '../src/core/resources/engineering-preparation-types.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
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
  const worker = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk)); req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); const raw = JSON.parse(body.messages[0].content);
        const context = Array.isArray(raw) ? JSON.parse(raw.find(row => row.role === 'user').content) : raw;
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
    writable(base); rmSync(base, { recursive: true, force: true });
  });
  const address = worker.address(); if (!address || typeof address === 'string') throw Error('Missing fixture listener');
  const pool = validateResourcePool({ schemaVersion: 1, id: 'mission-fixture', workers: ['repair', 'spare'].map(id => ({
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
  return { base, project, root, config, allocation, access, pool, bindings, observations, calls, errors, revision };
}

describe.runIf(process.platform === 'darwin')('actual standing engineering mission', () => {
  it('reconciles scope one after owner restart, proposes and executes scope two on the same ledger, then honors stop', async () => {
    const f = await fixture(); const stop = new AbortController(); const phases: string[] = [];
    const first = await runResourceEngineeringMission(f.config, { signal: stop.signal, onProgress(value) {
      phases.push(`${value.scope}:${value.phase}`); if (value.scope === 1 && value.phase === 'verifying') stop.abort();
    } });
    expect(first, JSON.stringify({ first, phases, calls: f.calls, errors: f.errors })).toMatchObject({ state: 'stopped', scopesReserved: 1, deadlineAt: f.config.deadlineAt });
    expect(f.calls).toEqual({ generation: 2, successor: 1, mission: 0 });
    const firstRows = readEngineeringMissionRecords(f.config); expect(firstRows.some(row => row.kind === 'settled')).toBe(true);
    const second = await runResourceEngineeringMission(f.config, { onProgress(value) { phases.push(`${value.scope}:${value.phase}`); } });
    expect(second, JSON.stringify({ second, phases, calls: f.calls, errors: f.errors })).toMatchObject({ state: 'completed', reason: 'stop-requested', scopesReserved: 2, deadlineAt: f.config.deadlineAt });
    expect(second.tip).not.toBeNull(); expect(git(f.project, 'show', `${second.tip!.commit}:value.json`)).toBe('3');
    expect(git(f.project, 'rev-parse', 'HEAD')).toBe(f.revision); expect(git(f.project, 'status', '--porcelain=v1')).toBe('');
    expect(f.calls).toEqual({ generation: 3, successor: 2, mission: 1 }); expect(f.errors).toEqual([]);
    const ledger = resourcePoolStatus(f.root, f.pool, f.bindings, f.observations);
    expect(ledger.attempts).toHaveLength(6); expect(ledger.attempts.every(row => row.status === 'completed' && row.workerId === 'repair')).toBe(true);
    expect(ledger.allocation).toEqual(f.allocation); expect(ledger.workerAccess).toEqual(f.access);
    const final = readEngineeringMissionRecords(f.config);
    for (const row of firstRows) expect(final.find(item => item.id === row.id)).toEqual(row);
    const scopes = final.filter(row => row.kind === 'reserved'); expect(scopes).toHaveLength(2);
    const next = scopes[1]!.payload as { setup: { recipe: ResourceEngineeringRecipe } };
    const prior = firstRows.find(row => row.kind === 'settled')!.payload as { tip: { commit: string } };
    expect(next.setup.recipe.seedRevision).toBe(prior.tip.commit);
    expect(phases).toContain('1:reconciling'); expect(phases).toContain('2:executing');
    expect(existsSync(join(f.config.root, '.mission.lock'))).toBe(false);
    expect(existsSync(join(f.root, '.resource-console.lock'))).toBe(false);
    expect(json(join(f.root, 'resource-console-state.json')).paused).toBe(false);
    // Completed history remains inspectable under an explicit stop; replay must
    // neither restart a console nor propose a replacement task on any scope.
    const stopped = new AbortController(); stopped.abort(); const replayPhases: string[] = []; const replayUrls: Array<string | null> = [];
    const replay = await runResourceEngineeringMission(f.config, { signal: stopped.signal,
      onProgress(value) { replayPhases.push(`${value.scope}:${value.phase}`); replayUrls.push(value.consoleUrl); } });
    expect(replay).toEqual(second); expect(replayPhases).toContain('2:reconciling');
    // Observer exceptions are intentionally isolated by the runner, so assertions
    // belong outside that callback where a regression can actually fail the test.
    expect(replayUrls.every(url => url === null)).toBe(true);
    expect(f.calls).toEqual({ generation: 3, successor: 2, mission: 1 });
    expect(readEngineeringMissionRecords(f.config)).toEqual(final);
  }, 1800_000);
});
