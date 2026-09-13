/** Real private accounting/config files; controlled evidence-reader projections, no workers/evaluators. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import * as campaignStore from '../src/core/universe/campaign-store.js';
import * as universeStore from '../src/core/universe/store.js';
import * as controllerStore from '../src/core/universe/portfolio-controller-store.js';
import * as delivery from '../src/core/universe/delivery.js';
import * as recovery from '../src/core/universe/campaign-delivery-recovery.js';
import * as custody from '../src/core/universe/builtin-trial-custody.js';
import { resourceGenerationTaskId } from '../src/core/universe/generation.js';
import { readResourceEngineeringOutcomes, type ResourceEngineeringOutcomesOptions } from '../src/core/resources/engineering-outcomes.js';
import type { ResourcePool, ResourceObservation } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';
import type { ResourcePoolState, ResourceTaskReceipt } from '../src/core/resources/pool-runtime.js';
import type { UniverseCampaignSummary, UniverseSummary, UniverseRun, UniverseTrial } from '../src/core/universe/types.js';

const roots: string[] = [];
const hash = (character: string) => character.repeat(64);
const at = '2026-09-10T00:00:00.000Z';
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function tree(root: string): string {
  return canonical(readdirSync(root, { recursive: true, withFileTypes: true }).map(row => {
    const path = join(row.parentPath, row.name); return [path, row.isFile() ? readFileSync(path).toString('base64') : null];
  }));
}
function fixture(secondWorker = false) {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-phase-'))); roots.push(outer);
  const root = join(outer, 'ledger'); const world = join(outer, 'world');
  mkdirSync(root, { mode: 0o700 }); mkdirSync(world, { mode: 0o700 });
  mkdirSync(join(world, 'universes', 'universe'), { recursive: true, mode: 0o700 });
  mkdirSync(join(world, 'portfolios', 'controller'), { recursive: true, mode: 0o700 });
  const save = (path: string, value: unknown) => writeFileSync(path, canonical(value) + '\n', { mode: 0o600 });
  const pool: ResourcePool = { schemaVersion: 1, id: 'pool', workers: [{ id: 'worker', provider: 'local', model: 'model',
    maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1 }] };
  const bindings: ResourceBinding[] = [{ workerId: 'worker', capacityKey: 'capacity', kind: 'local-chat', endpoint: 'http://127.0.0.1:9/v1' }];
  if (secondWorker) { pool.workers.push({ ...pool.workers[0]!, id: 'second' }); bindings.push({ ...bindings[0]!, workerId: 'second' }); }
  const poolFile = join(outer, 'pool.json'); const bindingsFile = join(outer, 'bindings.json'); const resourceRuntime = join(outer, 'runtime.json');
  const poolDigest = digest(canonical({ pool, bindings })); save(poolFile, pool); save(bindingsFile, bindings);
  const runtime = { schemaVersion: 1, root, poolPath: poolFile, bindingsPath: bindingsFile, observationsPath: join(outer, 'observations.json'), workspace: join(outer, 'transport') };
  save(resourceRuntime, runtime);
  const budget = { maxTrials: 1, maxDurationMs: 1000, trialTimeoutMs: 1000, maxParallel: 1 };
  const campaignBudget = { maxGenerations: 3, maxDurationMs: 10_000, maxModelRequests: 3, maxStagnantGenerations: 3, maxReportedTokens: null };
  const campaign = { definition: { schemaVersion: 1, id: 'campaign', universeId: 'universe', feedback: true, measureSeed: true, budget: campaignBudget },
    definitionDigest: hash('d'), manifestDigest: hash('a'), comparatorDigest: hash('b'), sourceState: 'healthy', state: 'completed', reasons: [],
    steps: [], progress: {}, createdAt: at, startedAt: at, finishedAt: at, deadlineAt: '2026-09-10T00:00:10.000Z', reason: null, owner: null } as unknown as UniverseCampaignSummary;
  const universe = { manifest: { schemaVersion: 1, id: 'universe', name: 'private name', objective: 'private objective',
    seed: { repo: '/private/source', revision: 'f'.repeat(40) }, metric: { name: 'score', direction: 'maximize', minImprovement: 0 }, budget,
    evaluation: { command: ['private evaluator'] }, variants: [{ id: 'variant', niche: 'quality', hypothesis: 'private hypothesis',
      generation: { kind: 'resource-pool', poolId: 'pool', poolDigest, allowedWorkerIds: pool.workers.map(worker => worker.id), fileOperations: { schemaVersion: 1 } } }] },
    manifestDigest: hash('a'), comparatorDigest: hash('b'), runs: [], elites: [], sourceState: 'healthy', reasons: [] } as unknown as UniverseSummary;
  const options: ResourceEngineeringOutcomesOptions = { root, poolFile, bindingsFile,
    enrollment: { id: 'enrollment', projectId: 'default', graphId: 'graph', enrollmentDigest: hash('e'), objective: 'private objective',
      acceptanceScope: 'fixed-evaluator-and-local-branch-only', budget: { maxParallel: 1, maxDurationMs: 10_000 },
      campaigns: [{ id: 'campaign', dependsOn: [], objective: 'private objective', branch: 'codex/result', budget, campaignBudget }] },
    host: { root: world, nodeId: 'deliver', constitutionVersion: 'fixture', policyEpoch: 1,
      definition: { schemaVersion: 1, id: 'controller', tasks: [{ campaignId: 'campaign', dependsOn: [] }], maxParallel: 1, maxDurationMs: 10_000 },
      deliveryPlan: { schemaVersion: 1, deliveries: [{ campaignId: 'campaign', branch: 'codex/result', baseCommit: 'f'.repeat(40), allowInitialRepair: true }] },
      resourceRuntime, expectedRuntimeDigest: digest(canonical(runtime)) } };
  const state: ResourcePoolState = { schemaVersion: 1, poolDigest, observations: [] as ResourceObservation[], attempts: [] };
  const write = () => save(join(root, 'pool-state.json'), state);
  const controller = { first: { enrollment: { definition: options.host.definition, deliveryPlan: options.host.deliveryPlan,
    graphDispatch: { graphId: 'graph', nodeId: 'deliver' }, pins: [{ campaignId: 'campaign', universeId: 'universe',
      definitionDigest: campaign.definitionDigest, manifestDigest: campaign.manifestDigest, comparatorDigest: campaign.comparatorDigest }] } } };
  vi.spyOn(controllerStore, 'readPortfolioControllerEvents').mockReturnValue([]);
  vi.spyOn(controllerStore, 'foldPortfolioController').mockImplementation(() => controller as unknown as ReturnType<typeof controllerStore.foldPortfolioController>);
  vi.spyOn(campaignStore, 'readCampaignEvents').mockReturnValue([]);
  vi.spyOn(campaignStore, 'foldCampaignEvents').mockImplementation(() => ({ created: { definition: campaign.definition } }) as ReturnType<typeof campaignStore.foldCampaignEvents>);
  vi.spyOn(campaignStore, 'projectCampaign').mockImplementation(() => campaign);
  vi.spyOn(universeStore, 'readRecords').mockReturnValue([]);
  vi.spyOn(universeStore, 'manifestRecord').mockImplementation(() => ({ manifest: universe.manifest,
    manifestDigest: universe.manifestDigest, comparatorDigest: universe.comparatorDigest,
    evaluationBuiltinDigest: hash('8'), seedArtifact: { digest: hash('0') } }) as ReturnType<typeof universeStore.manifestRecord>);
  vi.spyOn(universeStore, 'projectUniverse').mockImplementation(() => universe);
  vi.spyOn(delivery, 'readUniverseDeliveries').mockReturnValue({ sourceState: 'missing', deliveries: [], reasons: [] });
  vi.spyOn(recovery, 'readCompletedCampaignDelivery').mockReturnValue(null);
  function add(score: number, selected: boolean, status: 'passed' | 'failed' = 'passed', workerId = 'worker') {
    const ordinal = universe.runs.length + 1; const runId = `run-${ordinal}`;
    const receipt: ResourceTaskReceipt = { schemaVersion: 1, id: resourceGenerationTaskId({ universeId: 'universe', runId, variantId: 'variant' }),
      taskDigest: hash('c'), poolDigest, workerId, capacityKey: 'capacity', status: 'completed', startedAt: at, finishedAt: at,
      outputDigest: hash('6'), inputTokens: 20, outputTokens: 10, reason: 'worker-completed', verifiedAccepted: false,
      execution: { schemaVersion: 1, scope: 'worker-execution', durationMs: 1, usageScope: 'local-chat-completion' } };
    const trial: UniverseTrial = { id: `trial-${ordinal}`, variantId: 'variant', niche: 'quality', parentTrialId: null, status, score,
      metrics: { score }, artifact: { path: '/private/artifact', digest: hash(String(ordinal)), revision: 'f'.repeat(40) }, durationMs: 1,
      delta: selected && ordinal > 1 ? 1 : null, selected, ...(status === 'failed' ? { error: 'Fixed evaluator rejected the candidate' } : {}),
      generation: { schemaVersion: 1, provider: 'resource-pool', endpoint: null, model: null, status: 'succeeded', requestStarted: true,
        promptDigest: hash('2'), responseDigest: hash('6'), durationMs: 1, usage: { state: 'reported', inputTokens: 20, outputTokens: 10 }, changedFiles: ['private.ts'],
        resource: { schemaVersion: 1, poolId: 'pool', poolDigest, allowedWorkerIds: pool.workers.map(worker => worker.id), taskId: receipt.id, taskDigest: receipt.taskDigest,
          workerId, workerProvider: 'local', workerModel: 'model', receiptDigest: digest(canonical(receipt)), dispatch: 'settled',
          taskStatus: 'completed', usageScope: 'local-chat-completion' } } };
    const run: UniverseRun = { id: runId, universeId: 'universe', generation: ordinal, manifestDigest: hash('a'), comparatorDigest: hash('b'),
      startedAt: at, finishedAt: at, status: 'completed', trials: [trial], durationMs: 1, tokensUsed: 30, costUsd: null,
      campaign: { id: 'campaign', definitionDigest: hash('d'), ordinal } };
    universe.runs.push(run); campaign.steps.push({ ordinal, runId, generation: ordinal, variantIds: ['variant'], reservedModelRequests: 1,
      createdAt: at, state: 'completed', trialCount: 1, passedTrials: status === 'passed' ? 1 : 0, admissions: selected ? 1 : 0, improvements: 0, tokensUsed: 30 });
    state.attempts.push(receipt); write(); return { run, trial, receipt };
  }
  write(); return { options, outer, root, runtime, pool, bindings, poolDigest, campaign, universe, state, controller, save, write, add,
    read: () => readResourceEngineeringOutcomes(options) };
}

function pendingRun(f: ReturnType<typeof fixture>, ordinal = 1) {
  const runId = `${String(ordinal).padStart(8, '0')}-1111-4111-8111-111111111111`;
  const trialId = `${String(ordinal).padStart(8, '0')}-2222-4222-8222-222222222222`;
  f.universe.manifest.evaluation = { builtin: 'preparation-process-score-v1' };
  const added = f.add(2, false);
  added.run.id = runId; added.run.status = 'running'; added.run.finishedAt = null; added.run.trials = [];
  added.trial.id = trialId;
  const step = f.campaign.steps.at(-1)!; step.runId = runId; step.state = 'running';
  step.trialCount = 0; step.passedTrials = 0; step.admissions = 0;
  added.receipt.id = resourceGenerationTaskId({ universeId: 'universe', runId, variantId: 'variant' });
  added.receipt.origin = { kind: 'universe-generation', universeId: 'universe', runId, variantId: 'variant' };
  added.trial.generation!.resource!.taskId = added.receipt.id;
  added.trial.generation!.resource!.receiptDigest = digest(canonical(added.receipt));
  f.write();
  const directory = universeStore.universePath(f.options.host.root, 'universe');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const intent: custody.BuiltinTrialIntent = { schemaVersion: 1, universeId: 'universe', runId, trialId, startedAt: at,
    manifestDigest: hash('a'), comparatorDigest: hash('b'), evaluatorId: 'preparation-process-score-v1', evaluatorDigest: hash('8'),
    artifactPath: join(directory, 'artifacts', runId, trialId), artifactDigest: added.trial.artifact!.digest,
    scratchPath: join(directory, 'scratch', runId, trialId) };
  const record: custody.BuiltinTrialCustodyRecord = { id: `${trialId}.intent`, kind: 'intent', intent, settlement: null };
  const publishIntent = () => custody.writeBuiltinTrialCustody(directory, record, () => {});
  const publishSettlement = (state: 'not-started' | 'group-exit-confirmed' = 'group-exit-confirmed') =>
    custody.writeBuiltinTrialCustody(directory, { ...record, id: `${trialId}.settlement`, kind: 'settlement',
      settlement: { intentDigest: digest(canonical(intent)), finishedAt: at, state } }, () => {});
  return { ...added, runId, trialId, directory, intent, record, publishIntent, publishSettlement };
}

function seedIntent(f: ReturnType<typeof fixture>) {
  f.campaign.seedEvaluation = { intent: { schemaVersion: 1, id: '33333333-3333-4333-8333-333333333333', sessionSequence: 1,
    definitionDigest: hash('d'), manifestDigest: hash('a'), comparatorDigest: hash('b'), seedArtifactDigest: hash('0'),
    context: 'campaign-seed-v1', startedAt: at, deadlineAt: '2026-09-10T00:00:10.000Z' }, result: null };
  return f.campaign.seedEvaluation;
}

function nonPhase(report: ReturnType<typeof readResourceEngineeringOutcomes>) {
  return { ...report, sampledAt: '', campaigns: report.campaigns.map(({ phaseEvidence: _phase, ...row }) => row) };
}

describe('observation-only engineering phase evidence', () => {
  it('keeps missing custody and an unattributed legacy receipt distinct from evaluator intent', () => {
    const f = fixture(); const task = pendingRun(f); delete task.receipt.origin; f.write();
    const report = f.read();
    expect(report.campaigns[0]!.phaseEvidence).toMatchObject({ sourceState: 'available',
      seed: { state: 'unmeasured', startedAt: null, finishedAt: null },
      runs: [{ workers: [{ state: 'unverified', startedAt: null, finishedAt: null }], evaluators: [] }] });
    expect(report.campaigns[0]!.stages.evaluated).toBe(0);
    // The additive field is optional; legacy projections retain schema-v1.
    const legacy = nonPhase(report);
    expect(legacy.schemaVersion).toBe(1); expect(legacy.campaigns[0]).not.toHaveProperty('phaseEvidence');
  });
  it('distinguishes seed intent from measured evidence without inventing usage or evaluator liveness', () => {
    const f = fixture(); seedIntent(f);
    const before = tree(f.outer); const pending = f.read();
    expect(pending.campaigns[0]).toMatchObject({ seed: { status: 'pending', score: null },
      phaseEvidence: { schemaVersion: 1, scope: 'recorded-execution-phases', liveness: 'not-attested', sourceState: 'available',
        seed: { state: 'intent-recorded', startedAt: at, finishedAt: null }, runs: [] } });
    expect(pending.usage.totalTokens).toBeNull(); expect(pending.timing.totalDurationMs).toBeNull();
    const seed = f.campaign.seedEvaluation!;
    seed.result = { schemaVersion: 1, intentDigest: digest(canonical(seed.intent)), status: 'measured', finishedAt: at,
      durationMs: 1, processGroupSettlement: 'group-exit-confirmed', measurement: { passed: true, score: 1, metrics: { score: 1 } }, reason: null };
    expect(f.read().campaigns[0]).toMatchObject({ seed: { status: 'measured', score: 1 },
      phaseEvidence: { seed: { state: 'result-recorded', startedAt: at, finishedAt: at } } });
    expect(tree(f.outer)).toBe(before);
  });

  it.each(['reserved', 'completed'] as const)('reports %s worker evidence without claiming evaluator intent or acceptance', state => {
    const f = fixture(); const task = pendingRun(f);
    if (state === 'reserved') {
      Object.assign(task.receipt, { status: state, finishedAt: null, outputDigest: null, inputTokens: null, outputTokens: null, reason: 'task-reserved' });
      delete task.receipt.execution; f.write();
    }
    const before = tree(f.outer); const report = f.read();
    expect(report.campaigns[0]).toMatchObject({ stages: { trials: 0, evaluated: 0, passed: 0, selected: 0 },
      phaseEvidence: { sourceState: 'available', runs: [{ runId: task.runId, state: 'running',
        workers: [{ variantId: 'variant', taskId: task.receipt.id, state }], evaluators: [] }] } });
    expect(report.productionAccepted).toBeNull(); expect(report.routingChanged).toBe(false);
    expect(report.usage.totalTokens).toBeNull(); expect(tree(f.outer)).toBe(before);
  });

  it('shows native intent and settlement before a trial exists, without upgrading any outcome', () => {
    const f = fixture(); const task = pendingRun(f); const initial = f.read();
    task.publishIntent(); const pending = f.read();
    expect(pending.campaigns[0]!.phaseEvidence).toMatchObject({ sourceState: 'available', runs: [{
      evaluators: [{ trialId: task.trialId, variantId: null, state: 'intent-recorded', startedAt: at, finishedAt: null }] }] });
    expect(nonPhase(pending)).toEqual(nonPhase(initial));
    task.publishSettlement(); const before = tree(f.outer); const settled = f.read();
    expect(settled.campaigns[0]!.phaseEvidence).toMatchObject({ runs: [{ evaluators: [{ trialId: task.trialId,
      variantId: null, state: 'group-exit-confirmed', finishedAt: at }] }] });
    expect(nonPhase(settled)).toEqual(nonPhase(initial)); expect(tree(f.outer)).toBe(before);
    expect(JSON.stringify(settled.campaigns[0]!.phaseEvidence)).not.toMatch(/artifactPath|scratchPath|private|worker-completed/);
  });

  it.each(['foreign-run', 'comparator', 'evaluator', 'artifact'] as const)('refuses %s custody association without changing accounting authority', mismatch => {
    const f = fixture(); const task = pendingRun(f);
    if (mismatch === 'foreign-run') {
      task.intent.runId = '99999999-9999-4999-8999-999999999999';
      task.intent.artifactPath = join(task.directory, 'artifacts', task.intent.runId, task.trialId);
      task.intent.scratchPath = join(task.directory, 'scratch', task.intent.runId, task.trialId);
    }
    if (mismatch === 'comparator') task.intent.comparatorDigest = hash('f');
    if (mismatch === 'evaluator') task.intent.evaluatorDigest = hash('f');
    if (mismatch === 'artifact') { task.run.trials = [task.trial]; task.intent.artifactDigest = hash('f'); }
    const initial = f.read(); task.publishIntent();
    const report = f.read();
    expect(report.campaigns[0]!.phaseEvidence).toMatchObject({ sourceState: 'unavailable', reason: 'phase-evidence-unavailable', seed: null, runs: [] });
    expect(nonPhase(report)).toEqual(nonPhase(initial));
  });

  it.each(['orphan', 'reader-unavailable'] as const)('keeps %s custody observation unavailable and does not mutate receipts', failure => {
    const f = fixture(); const task = pendingRun(f); const initial = f.read();
    task.publishIntent(); task.publishSettlement();
    if (failure === 'orphan') unlinkSync(join(task.directory, 'builtin-trial-custody', 'records', `${task.trialId}.intent.json`));
    else vi.spyOn(custody, 'readBuiltinTrialCustody').mockImplementation(() => { throw new Error('private diagnostics must not escape'); });
    const before = tree(f.outer); const report = f.read();
    expect(report.campaigns[0]!.phaseEvidence).toMatchObject({ sourceState: 'unavailable', seed: null, runs: [] });
    expect(nonPhase(report)).toEqual(nonPhase(initial)); expect(tree(f.outer)).toBe(before);
    expect(JSON.stringify(report)).not.toContain('private diagnostics');
  });

  it('marks only phase evidence unavailable when custody changes between samples', () => {
    const f = fixture(); const task = pendingRun(f); const initial = f.read(); task.publishIntent();
    const nativeRead = custody.readBuiltinTrialCustody; let reads = 0;
    vi.spyOn(custody, 'readBuiltinTrialCustody').mockImplementation(directory => {
      const rows = nativeRead(directory); reads++;
      return reads === 1 ? [] : rows;
    });
    const report = f.read();
    expect(reads).toBe(2);
    expect(report.campaigns[0]!.phaseEvidence).toMatchObject({ sourceState: 'unavailable', reason: 'phase-evidence-changed', seed: null, runs: [] });
    expect(nonPhase(report)).toEqual(nonPhase(initial));
  });

  it('keeps parallel trial identities separate and leaves unpublished variant association unknown', () => {
    const f = fixture(); const task = pendingRun(f); task.publishIntent();
    const trialId = '44444444-4444-4444-8444-444444444444';
    const intent = { ...task.intent, trialId, artifactPath: join(task.directory, 'artifacts', task.runId, trialId),
      scratchPath: join(task.directory, 'scratch', task.runId, trialId) };
    custody.writeBuiltinTrialCustody(task.directory, { id: `${trialId}.intent`, kind: 'intent', intent, settlement: null }, () => {});
    task.publishSettlement('not-started');
    const evaluators = f.read().campaigns[0]!.phaseEvidence!.runs[0]!.evaluators;
    expect(evaluators).toHaveLength(2);
    expect(evaluators).toEqual(expect.arrayContaining([
      expect.objectContaining({ trialId: task.trialId, variantId: null, state: 'not-started' }),
      expect.objectContaining({ trialId, variantId: null, state: 'intent-recorded' }),
    ]));
  });

  it('preserves independently unknown tokens and timing for an evaluated trial', () => {
    const f = fixture(); const task = pendingRun(f); task.run.trials = [task.trial];
    task.receipt.inputTokens = null; task.receipt.outputTokens = null; task.receipt.execution!.durationMs = null;
    task.receipt.execution!.usageScope = null;
    task.trial.generation!.usage = { state: 'unavailable', inputTokens: null, outputTokens: null };
    task.trial.generation!.resource!.receiptDigest = digest(canonical(task.receipt)); f.write();
    const initial = f.read(); task.publishIntent(); task.publishSettlement(); const report = f.read();
    expect(report.campaigns[0]!.phaseEvidence).toMatchObject({ sourceState: 'available', runs: [{
      evaluators: [{ trialId: task.trialId, variantId: 'variant', state: 'group-exit-confirmed' }] }] });
    expect(report.usage).toMatchObject({ joinedAttempts: 1, totalTokens: null });
    expect(report.timing).toMatchObject({ measuredAttempts: 0, totalDurationMs: null });
    expect(nonPhase(report)).toEqual(nonPhase(initial));
  });

  it.each(['tokens', 'timing'] as const)('does not infer unknown %s from complete phase records or the other measurement', unknown => {
    const f = fixture(); const task = pendingRun(f); task.run.trials = [task.trial];
    if (unknown === 'tokens') {
      task.receipt.inputTokens = null; task.receipt.outputTokens = null; task.receipt.execution!.usageScope = null;
      task.trial.generation!.usage = { state: 'unavailable', inputTokens: null, outputTokens: null };
    } else task.receipt.execution!.durationMs = null;
    task.trial.generation!.resource!.receiptDigest = digest(canonical(task.receipt)); f.write();
    const initial = f.read(); task.publishIntent(); task.publishSettlement(); const report = f.read();
    expect(report.campaigns[0]!.phaseEvidence!.sourceState).toBe('available');
    expect(report.usage.totalTokens).toBe(unknown === 'tokens' ? null : 30);
    expect(report.timing.totalDurationMs).toBe(unknown === 'timing' ? null : 1);
    expect(nonPhase(report)).toEqual(nonPhase(initial));
  });
});
