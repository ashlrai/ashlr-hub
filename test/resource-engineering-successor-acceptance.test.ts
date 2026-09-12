/** Real confined evaluation/Git delivery; proposals use a test-owned loopback transport, never a real provider. */
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import { canonical } from '../src/core/universe/artifacts.js';
import * as evaluator from '../src/core/universe/fixed-evaluator.js';
import * as deliveryGit from '../src/core/universe/delivery-git.js';
import { readUniverseCampaign } from '../src/core/universe/campaign-store.js';
import { readCompletedCampaignDelivery } from '../src/core/universe/campaign-delivery-recovery.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { resourcePoolStatus, setResourcePoolAllocation, setResourceWorkerAccess } from '../src/core/resources/pool-runtime.js';
import { createResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import { createResourceConsoleEngineeringOwner } from '../src/core/resources/console-engineering.js';
import { createResourceConsoleEngineeringSupervisor } from '../src/core/resources/console-engineering-supervisor.js';
import type { ResourceEngineeringRecipe } from '../src/core/resources/engineering-preparation-types.js';
import { createResourceConsoleEngineeringPreparation } from '../src/core/resources/console-engineering-preparation.js';
import { createResourceConsoleEngineeringSuccessors } from '../src/core/resources/console-engineering-successors.js';
import type { ResourceConsoleEngineeringPreparationConfig } from '../src/core/resources/console-engineering-preparation-types.js';
import type { ResourceEngineeringSuccessorCoordinatorConfig, ResourceEngineeringSuccessorCoordinatorOptions } from '../src/core/resources/engineering-successor-coordinator-types.js';
import * as privateRecords from '../src/core/util/immutable-private-record-store.js';

const cleanups: Array<() => Promise<void>> = [];
const timing = process.env.ASHLR_ENGINEERING_SUCCESSOR_PHASE_TIMING === '1';
const measurements: Array<{ sourceCalls: number; sourceMs: number; prepareCalls: number; prepareMs: number; errors: string[] }> = [];
function point(phase: string) { if (timing) console.log('SUCCESSOR_PHASE ' + JSON.stringify({ phase, monotonicMs: performance.now() })); }
function timed<T>(phase: string, work: () => T): T {
  if (!timing) return work();
  const started = performance.now(); point(`${phase}.start`);
  const end = () => console.log('SUCCESSOR_PHASE ' + JSON.stringify({ phase, event: 'end', durationMs: performance.now() - started }));
  try { const value = work(); if (value instanceof Promise) return value.finally(end) as T; end(); return value; }
  catch (error) { end(); throw error; }
}
afterEach(async () => {
  try { await timed('cleanup', async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }); }
  finally { if (timing) console.log('SUCCESSOR_CALLS ' + JSON.stringify(measurements)); measurements.splice(0); vi.restoreAllMocks(); }
});
const save = (file: string, value: unknown) => writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
}
type Generation = { generation: number; parentTrialId: string | null; files: Array<{ path: string; content: string }>;
  seedContext: { source: { campaignId: string }; measurement: { passed: boolean; score: number; metrics: { value: number } } };
  feedback?: { source: { trialId: string } } };

async function fixture() {
  expect(process.env.ASHLR_VITEST_REAL_HOME).toBeTruthy(); expect(homedir()).not.toBe(process.env.ASHLR_VITEST_REAL_HOME);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'successor-acceptance-')));
  const repo = join(base, 'project'); const transport = join(base, 'transport'); const root = join(base, 'ledger');
  const outputRoot = join(base, 'bundles');
  for (const path of [repo, transport, outputRoot]) mkdirSync(path, { mode: 0o700 });
  git(repo, 'init', '-q', '--template=', '--initial-branch=main'); git(transport, 'init', '-q', '--template=', '--initial-branch=main');
  writeFileSync(join(repo, 'value.json'), '0\n');
  writeFileSync(join(repo, 'evaluate.mjs'), `import{readFileSync}from'node:fs';import{join}from'node:path';
const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));
const passed=Number.isInteger(value)&&value>=0&&value<=4;
console.log(JSON.stringify({passed,score:passed?value:0,metrics:{value},diagnostics:[]}));`);
  git(repo, 'add', '.'); git(repo, '-c', 'user.name=Successor Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'passing fixed seed');
  const revision = git(repo, 'rev-parse', 'HEAD'); const generations: Generation[] = []; const proposals: unknown[] = []; const errors: string[] = [];
  const hooks: { afterProposal?: () => void } = {};
  const worker = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk)); req.on('end', () => {
      try {
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const raw = JSON.parse(input.messages[0].content);
        const context = Array.isArray(raw) ? JSON.parse(raw.find((row: { role: string }) => row.role === 'user').content) : raw;
        let content: unknown;
        if (context.seedContext) {
          const generation = context as Generation; generations.push(generation);
          point(`generation-request-${generations.length}`);
          expect(generation.seedContext.measurement.passed).toBe(true);
          const value = JSON.parse(generation.files.find(row => row.path === 'value.json')!.content) as number;
          expect(value).toBe(generations.length - 1);
          expect(generation.seedContext.measurement.score).toBe(value < 2 ? 0 : 2);
          expect(generation.generation).toBe(value % 2 + 1);
          if (value % 2 === 0) expect(generation.parentTrialId).toBeNull();
          else { expect(generation.parentTrialId).toBeTruthy(); expect(generation.feedback).toBeDefined(); }
          content = { operations: [{ op: 'replace', path: 'value.json', content: `${value + 1}\n` }] };
        } else {
          proposals.push(context); expect(generations).toHaveLength(2);
          point('proposal-request');
          expect(context.kind).toBe('engineering-successor-proposal');
          expect(JSON.parse(context.source.context)).toMatchObject({ source: { seed: { passed: true, score: 0 },
            delivered: { score: 2, deltaFromParent: 1 }, files: [{ path: 'value.json', text: '2\n', truncated: false }] } });
          expect(readFileSync(join(repo, 'value.json'), 'utf8')).toBe('0\n');
          content = { action: 'propose', name: 'Improve the verified result again', objective: 'Increase the fixed measured value beyond the delivered score of two.' };
          hooks.afterProposal?.();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
      } catch (error) { errors.push(String(error)); res.writeHead(500); res.end('Unexpected fixture protocol'); }
    });
  });
  await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    worker.closeAllConnections(); await new Promise<void>(resolve => worker.close(() => resolve()));
    const writable = (path: string): void => { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name)); };
    writable(base); rmSync(base, { recursive: true, force: true });
  });
  const address = worker.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  const pool = validateResourcePool({ schemaVersion: 1, id: 'successor-fixture', workers: ['repair', 'spare'].map(id => ({
    id, provider: 'local', model: 'fixture', maxConcurrent: 1, maxTasksPerWindow: 8, taskWindowMs: 600_000, reservePercent: 0, priority: 1,
  })) });
  const bindings = validateResourceBindings(pool.workers.map(row => ({ workerId: row.id, capacityKey: `${row.id}-account`,
    kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` })), pool);
  const observations = pool.workers.map(row => ({ workerId: row.id, health: 'ready' as const, windows: [], retryAfter: null,
    observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 290_000).toISOString() }));
  const files = { poolFile: join(base, 'pool.json'), bindingsFile: join(base, 'bindings.json'), observationsFile: join(base, 'observations.json'),
    projectsFile: join(base, 'projects.json'), runtimeFile: join(base, 'runtime.json'), preparationFile: join(base, 'preparation.json'),
    successorsFile: join(base, 'successors.json') };
  save(files.poolFile, pool); save(files.bindingsFile, bindings); save(files.observationsFile, observations); save(files.projectsFile, { schemaVersion: 1, projects: [] });
  save(files.runtimeFile, { schemaVersion: 1, root, workspace: transport, poolPath: files.poolFile, bindingsPath: files.bindingsFile,
    observationsPath: files.observationsFile, capacityWaitMs: 1000 });
  const previous = await createResourcePoolSupervisor({ root, pool, bindings, workspace: repo, projects: [], readObservations: () => observations });
  await previous.close(); const allocation = setResourcePoolAllocation(root, pool, bindings, 70, 0);
  const workerAccess = setResourceWorkerAccess(root, pool, bindings, ['spare'], 0); loadOrCreateKey();
  const recipe: ResourceEngineeringRecipe = { schemaVersion: 1, id: 'campaign-a', name: 'First measured improvement',
    objective: 'Improve the fixed measured value twice', projectId: 'default', seedRevision: revision,
    metric: { name: 'value', direction: 'maximize', minImprovement: 1 }, evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3000 },
    trialBudget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 30_000, trialTimeoutMs: 15_000 },
    campaignBudget: { maxGenerations: 2, maxDurationMs: 90_000, maxModelRequests: 2, maxStagnantGenerations: 2, maxReportedTokens: 60 },
    generation: { files: ['value.json'], contextFiles: [], allowedWorkerIds: ['repair'], maxOutputTokens: 256,
      hypotheses: [{ id: 'improve', niche: 'value', hypothesis: 'Improve the fixed score by one' }] },
    delivery: { branch: 'codex/campaign-a' }, execution: { maxDurationMs: 100_000, constitutionVersion: 'fixture-v1', policyEpoch: 1 },
    supervision: { maxDurationMs: 240_000, pollIntervalMs: 100, maxAttemptsPerEnrollment: 3 } };
  const evaluations = vi.spyOn(evaluator, 'runFixedUniverseEvaluator'); const original = deliveryGit.deliveryGit; let publications = 0;
  vi.spyOn(deliveryGit, 'deliveryGit').mockImplementation((...args) => { const api = original(...args);
    return { ...api, createRef: async (...params) => { publications++; await api.createRef(...params); } }; });
  const config: ResourceConsoleEngineeringPreparationConfig = { schemaVersion: 1, outputRoot, resourceRuntime: files.runtimeFile,
    profiles: [{ id: 'successor-profile', label: 'Fixed value experiment', acceptance: 'Fixed passing integer score from zero through four', recipe }] };
  const successorConfig: ResourceEngineeringSuccessorCoordinatorConfig = { schemaVersion: 1, supervisionId: 'successor-queue',
    profileId: 'successor-profile', allowedWorkerIds: ['repair'], maxOutputTokens: 256, proposalTimeoutMs: 10_000, maxSuccessors: 1, pollIntervalMs: 100 };
  save(files.preparationFile, config); save(files.successorsFile, successorConfig);
  return { base, root, repo, transport, outputRoot, revision, files, pool, bindings, observations, recipe, allocation, workerAccess,
    generations, proposals, errors, hooks, config, successorConfig, evaluations, publications: () => publications,
    ledger: () => resourcePoolStatus(root, pool, bindings, observations) };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function owned(f: Fixture) {
  const supervisor = await createResourcePoolSupervisor({ root: f.root, pool: f.pool, bindings: f.bindings, workspace: f.repo,
    projects: [], readObservations: () => f.observations });
  cleanups.push(() => supervisor.close());
  const owner = createResourceConsoleEngineeringOwner({ supervisor, root: f.root, registrationEnabled: true,
    poolFile: f.files.poolFile, bindingsFile: f.files.bindingsFile, observationsFile: f.files.observationsFile,
    waitForResourceDrain: () => supervisor.close() });
  cleanups.push(async () => { await Promise.all([owner.close(), supervisor.close()]); });
  const preparation = createResourceConsoleEngineeringPreparation({ root: f.root, owner, workspace: f.repo,
    configFile: f.files.preparationFile, config: f.config, projectsFile: f.files.projectsFile,
    poolFile: f.files.poolFile, bindingsFile: f.files.bindingsFile, observationsFile: f.files.observationsFile });
  if (!owner.catalog().some(row => row.id === f.recipe.id)) {
    const request = { id: f.recipe.id, profileId: 'successor-profile', name: f.recipe.name, objective: f.recipe.objective };
    const plan = preparation.check(request); preparation.prepare({ ...request, expectedPlanDigest: plan.planDigest });
    expect(f.generations).toEqual([]); expect(f.proposals).toEqual([]); expect(f.evaluations).not.toHaveBeenCalled();
  }
  const supervision = createResourceConsoleEngineeringSupervisor({ root: f.root, owner,
    config: { schemaVersion: 1, id: 'successor-queue', maxDurationMs: 240_000, pollIntervalMs: 100, maxConcurrent: 1,
      maxAttemptsPerEnrollment: 3, maxEnrollments: 2, enrollments: [] } });
  if (supervision.snapshot().entries.length === 0) supervision.admit({ expectedRevision: 0,
    enrollments: [{ enrollmentId: f.recipe.id, expectedEnrollmentDigest: owner.catalog().find(row => row.id === f.recipe.id)!.enrollmentDigest }] });
  const close = async () => { await supervision.close(); await Promise.all([owner.close(), supervisor.close()]); };
  cleanups.push(close); return { supervisor, owner, preparation, supervision, close };
}
function proof(f: Fixture, id: string) {
  const root = join(f.outputRoot, id, 'universe'); const campaign = readUniverseCampaign(id, { root });
  const manifest = JSON.parse(readFileSync(join(f.outputRoot, id, 'manifest.json'), 'utf8'));
  const delivery = { campaignId: id, branch: `codex/${id}`, baseCommit: manifest.seed.revision as string };
  const receipt = readCompletedCampaignDelivery(campaign, delivery, { root });
  expect(receipt, JSON.stringify({ state: campaign.state, sourceState: campaign.sourceState })).not.toBeNull();
  return { root, campaign, delivery, receipt: receipt! };
}

function coordinate(f: Fixture, ownedState: Awaited<ReturnType<typeof owned>>,
  readAdmissionEvidence: ResourceEngineeringSuccessorCoordinatorOptions['readAdmissionEvidence'] = () =>
    ({ observations: f.observations, unavailableWorkerIds: [], quotaUnavailableWorkerIds: [] })) {
  // Install call-through spies before the adapter captures its private methods.
  // Measure existing calls only; do not add evidence reads for diagnostics.
  if (vi.isMockFunction(ownedState.preparation.successorSource)) vi.mocked(ownedState.preparation.successorSource).mockRestore();
  if (vi.isMockFunction(ownedState.preparation.prepareSuccessor)) vi.mocked(ownedState.preparation.prepareSuccessor).mockRestore();
  const stats = { sourceCalls: 0, sourceMs: 0, prepareCalls: 0, prepareMs: 0, errors: [] as string[] }; measurements.push(stats);
  const source = ownedState.preparation.successorSource.bind(ownedState.preparation);
  vi.spyOn(ownedState.preparation, 'successorSource').mockImplementation((...args) => {
    const started = performance.now(); stats.sourceCalls++;
    try { return source(...args); } finally { stats.sourceMs += performance.now() - started; }
  });
  const prepare = ownedState.preparation.prepareSuccessor.bind(ownedState.preparation);
  const prepared = vi.spyOn(ownedState.preparation, 'prepareSuccessor').mockImplementation(async (...args) => {
    const started = performance.now(); stats.prepareCalls++; point('prepare-successor.start');
    try { return await prepare(...args); }
    catch (error) { if (stats.errors.length < 3) stats.errors.push(String(error instanceof Error ? error.message : error).slice(0, 300)); throw error; }
    finally { stats.prepareMs += performance.now() - started; point('prepare-successor.end'); }
  });
  const coordinator = createResourceConsoleEngineeringSuccessors({ root: f.root, pool: f.pool, bindings: f.bindings,
    projectId: 'default', preparation: ownedState.preparation, supervisor: ownedState.supervisor,
    acceptance: f.config.profiles[0]!.acceptance,
    supervision: ownedState.supervision, config: f.successorConfig, configFile: f.files.successorsFile, isClosing: () => false,
    readAdmissionEvidence });
  cleanups.push(() => coordinator.close()); return { coordinator, stats, get preparedIds() { return prepared.mock.calls.map(([input]) => input.id); } };
}

describe.runIf(process.platform === 'darwin')('verified delivery to accounted automatic successor', () => {
  it('waits for eligible quota then automatically delivers B from A, retaining context, accounting and restart identity', async () => {
    const f = await timed('fixture', fixture); const state = await timed('owner-initial', () => owned(f));
    let eligible = false, admissionReads = 0;
    const driver = coordinate(f, state, () => {
      admissionReads++;
      return { observations: f.observations, unavailableWorkerIds: [], quotaUnavailableWorkerIds: eligible ? [] : ['repair'] };
    });
    const initial = state.supervision.snapshot();
    expect(driver.coordinator.snapshot().entries).toEqual([]); expect(f.generations).toEqual([]); expect(f.proposals).toEqual([]);
    const observationDeadline = performance.now() + 200_000;
    driver.coordinator.start(); state.supervision.start();
    await timed('quota-deferred', () => vi.waitFor(() => {
      expect(state.supervision.snapshot().entries[0]?.state).toBe('completed');
      expect(admissionReads).toBeGreaterThanOrEqual(2);
    }, { timeout: Math.max(1, observationDeadline - performance.now()), interval: 100 }));
    expect(driver.coordinator.snapshot().entries).toEqual([]);
    expect(driver.preparedIds).toEqual([]); expect(f.proposals).toEqual([]);
    expect(driver.stats.sourceCalls).toBe(0); // Known denial must not repeat expensive source proofs.
    expect(f.ledger().attempts).toHaveLength(2); // Only A's two completed generation requests.
    expect(f.ledger()).toMatchObject({ allocation: f.allocation, workerAccess: f.workerAccess });
    expect(state.supervision.snapshot().deadlineAt).toBe(initial.deadlineAt);
    // Change only test-owned quota evidence. No Run action, new coordinator,
    // new proposal identity or renewed observation/supervision allowance.
    eligible = true;
    await timed('both-deliveries', () => vi.waitFor(() => {
      const snapshot = state.supervision.snapshot();
      expect(snapshot.entries.length, JSON.stringify({ supervision: snapshot, successor: driver.coordinator.snapshot(), errors: f.errors, preparationErrors: driver.stats.errors })).toBe(2);
      expect(snapshot.entries.every(row => row.state === 'completed')).toBe(true);
    }, { timeout: Math.max(1, observationDeadline - performance.now()), interval: 300 }));
    expect(driver.preparedIds).toHaveLength(1); const bId = driver.preparedIds[0]!;
    const aProof = timed('proof-a', () => proof(f, f.recipe.id)); const bProof = timed('proof-b', () => proof(f, bId));
    expect(aProof.receipt.status).toBe('delivered'); expect(bProof.receipt.status).toBe('delivered');
    expect(git(f.repo, 'show', `${aProof.receipt.commit}:value.json`)).toBe('2');
    expect(git(f.repo, 'show', `${bProof.receipt.commit}:value.json`)).toBe('4');
    expect(bProof.receipt.baseCommit).toBe(aProof.receipt.commit);
    expect(git(f.repo, 'rev-parse', `${bProof.receipt.commit}^`)).toBe(aProof.receipt.commit);
    expect(git(f.repo, 'diff', '--name-only', f.revision, bProof.receipt.commit)).toBe('value.json');
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.revision); expect(git(f.repo, 'status', '--porcelain=v1')).toBe('');
    expect(f.errors).toEqual([]); expect(f.generations).toHaveLength(4); expect(f.proposals).toHaveLength(1);
    expect(f.evaluations).toHaveBeenCalledTimes(6); expect(f.publications()).toBe(2);
    expect(f.generations.map(row => row.seedContext.measurement.score)).toEqual([0, 0, 2, 2]);
    expect(f.generations.map(row => row.seedContext.source.campaignId)).toEqual([f.recipe.id, f.recipe.id, bId, bId]);
    const receipts = f.ledger().attempts;
    expect(receipts).toHaveLength(5); expect(receipts.every(row => row.workerId === 'repair' && row.status === 'completed')).toBe(true);
    expect(receipts.reduce((sum, row) => sum + row.inputTokens! + row.outputTokens!, 0)).toBe(150);
    expect(f.ledger()).toMatchObject({ allocation: f.allocation, workerAccess: f.workerAccess });
    const complete = state.supervision.snapshot(); const proposals = driver.coordinator.snapshot();
    expect(complete.deadlineAt).toBe(initial.deadlineAt); expect(complete.entries.every(row => row.attempts === 1)).toBe(true);
    await timed('owner-close', async () => { await driver.coordinator.close(); await state.close(); });
    const restarted = await timed('owner-restart', () => owned(f));
    const resumed = coordinate(f, restarted); resumed.coordinator.start(); restarted.supervision.start();
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(restarted.supervision.snapshot()).toMatchObject({ deadlineAt: initial.deadlineAt, entries: complete.entries, revision: complete.revision });
    expect(resumed.coordinator.snapshot()).toMatchObject({ deadlineAt: proposals.deadlineAt, entries: proposals.entries });
    expect(resumed.preparedIds).toEqual([]); expect(f.ledger().attempts).toEqual(receipts);
    expect(f.generations).toHaveLength(4); expect(f.proposals).toHaveLength(1); expect(f.evaluations).toHaveBeenCalledTimes(6); expect(f.publications()).toBe(2);
    expect(f.ledger()).toMatchObject({ allocation: f.allocation, workerAccess: f.workerAccess });
  }, 240_000);

  it.each(['source-drift', 'lost-proposal-output'] as const)('does not duplicate a charged proposal or prepare B after %s', async mode => {
    const f = await fixture(); const state = await owned(f);
    let intercepted = 0;
    if (mode === 'source-drift') f.hooks.afterProposal = () => { git(f.repo, 'update-ref', `refs/heads/${f.recipe.delivery.branch}`, f.revision); };
    else {
      const original = privateRecords.writeImmutablePrivateRecord;
      vi.spyOn(privateRecords, 'writeImmutablePrivateRecord').mockImplementation((...args) => {
        if (args[0].rootPath === join(f.root, 'engineering-successors', 'successor-queue', 'events') &&
          (args[1] as { kind?: string }).kind === 'result') { intercepted++; throw new Error('Fixture interrupted proposal publication'); }
        return original(...args);
      });
    }
    const driver = coordinate(f, state); driver.coordinator.start(); state.supervision.start();
    await vi.waitFor(() => {
      expect(f.proposals).toHaveLength(1);
      expect(f.ledger().attempts.filter(row => row.status === 'completed')).toHaveLength(3);
      if (mode === 'lost-proposal-output') expect(intercepted).toBe(1);
      expect(driver.coordinator.snapshot().entries.some(row => row.state === (mode === 'lost-proposal-output' ? 'held' : 'proposed')),
        JSON.stringify(driver.coordinator.snapshot())).toBe(true);
    }, { timeout: 150_000, interval: 300 });
    expect(driver.preparedIds).toEqual([]); expect(f.generations).toHaveLength(2); expect(f.evaluations).toHaveBeenCalledTimes(3);
    expect(f.publications()).toBe(1); expect(f.errors).toEqual([]);
    expect(intercepted).toBe(mode === 'lost-proposal-output' ? 1 : 0);
    const receipts = f.ledger().attempts; expect(receipts).toHaveLength(3); expect(receipts.every(row => row.status === 'completed')).toBe(true);
    await driver.coordinator.close(); const resumed = coordinate(f, state); resumed.coordinator.start();
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(resumed.preparedIds).toEqual([]); expect(f.proposals).toHaveLength(1); expect(f.ledger().attempts).toEqual(receipts);
    expect(state.supervision.snapshot().entries).toHaveLength(1); expect(f.ledger()).toMatchObject({ allocation: f.allocation, workerAccess: f.workerAccess });
  }, 180_000);
});
