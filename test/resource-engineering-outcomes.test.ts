/** Real private accounting/config files; controlled evidence-reader projections, no workers/evaluators. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import * as campaignStore from '../src/core/universe/campaign-store.js';
import * as universeStore from '../src/core/universe/store.js';
import * as controllerStore from '../src/core/universe/portfolio-controller-store.js';
import * as delivery from '../src/core/universe/delivery.js';
import * as recovery from '../src/core/universe/campaign-delivery-recovery.js';
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
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-outcomes-'))); roots.push(outer);
  const root = join(outer, 'ledger'); const world = join(outer, 'world');
  mkdirSync(root, { mode: 0o700 }); mkdirSync(world, { mode: 0o700 });
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
  vi.spyOn(universeStore, 'manifestRecord').mockImplementation(() => ({ seedArtifact: { digest: hash('0') } }) as ReturnType<typeof universeStore.manifestRecord>);
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

describe('engineering outcomes receipt joins', () => {
  it('reads idle evidence without writes or fabricated measured zero usage', () => {
    const f = fixture(); const before = tree(f.outer); const result = f.read();
    expect(result).toMatchObject({ sourceState: 'healthy', complete: true, productionAccepted: null, routingChanged: false,
      usage: { attempts: 0, totalTokens: null }, campaigns: [{ stages: { evaluated: 0 }, seed: { status: 'unmeasured' } }] });
    expect(tree(f.outer)).toBe(before);
  });
  it('includes rejected-attempt tokens and reports independent evaluation/archive stages', () => {
    const f = fixture(); f.add(0, false, 'failed'); f.add(1, true); const before = tree(f.outer); const report = f.read();
    expect(report).toMatchObject({ sourceState: 'healthy', complete: true, usage: { attempts: 2, joinedAttempts: 2, reportedAttempts: 2, totalTokens: 60 },
      campaigns: [{ stages: { trials: 2, evaluated: 2, passed: 1, rejected: 1, selected: 1, verifiedLocalDeliveries: 0 },
        workers: [{ workerId: 'worker', evaluated: 2, rejected: 1, passed: 1, usage: { totalTokens: 60 } }] }] });
    expect(JSON.stringify(report)).not.toMatch(/private|127\.0\.0\.1|capacity|taskDigest|receiptDigest/); expect(tree(f.outer)).toBe(before);
    expect(report.timing).toEqual({ scope: 'summed-worker-execution', attempts: 2, measuredAttempts: 2,
      recordedDurationMs: 2, totalDurationMs: 2, complete: true });
  });
  it('keeps partial timing separate from complete token usage and never invents wall time', () => {
    const f = fixture(); f.add(0, false, 'failed'); const { trial, receipt } = f.add(1, true);
    receipt.execution!.durationMs = null; trial.generation!.resource!.receiptDigest = digest(canonical(receipt)); f.write();
    expect(f.read()).toMatchObject({ complete: false, usage: { totalTokens: 60, complete: true },
      timing: { attempts: 2, measuredAttempts: 1, recordedDurationMs: 1, totalDurationMs: null, complete: false },
      campaigns: [{ workers: [{ timing: { measuredAttempts: 1, totalDurationMs: null } }] }] });
  });
  it('keeps both workers costs without giving the final worker all campaign credit', () => {
    const f = fixture(true); f.add(0, false, 'failed', 'worker'); f.add(1, true, 'passed', 'second');
    expect(f.read()).toMatchObject({ usage: { totalTokens: 60 }, campaigns: [{ workers: [
      { workerId: 'second', evaluated: 1, passed: 1, rejected: 0, usage: { totalTokens: 30 }, timing: { totalDurationMs: 1 } },
      { workerId: 'worker', evaluated: 1, passed: 0, rejected: 1, usage: { totalTokens: 30 }, timing: { totalDurationMs: 1 } },
    ] }] });
  });
  it('preserves measured zero counts and zero adapter duration distinctly from missing samples', () => {
    const f = fixture(); const { receipt, trial } = f.add(1, true);
    receipt.inputTokens = 0; receipt.outputTokens = 0; receipt.execution!.durationMs = 0;
    trial.generation!.usage.inputTokens = 0; trial.generation!.usage.outputTokens = 0;
    trial.generation!.resource!.receiptDigest = digest(canonical(receipt)); f.write();
    expect(f.read()).toMatchObject({ complete: true, usage: { reportedAttempts: 1, totalTokens: 0 }, timing: { measuredAttempts: 1, totalDurationMs: 0 } });
  });
  it('withholds unsafe aggregate token arithmetic without emitting rounded subtotals', () => {
    const f = fixture(); const first = f.add(0, false, 'failed'); const second = f.add(1, true);
    for (const { receipt, trial } of [first, second]) {
      receipt.inputTokens = Number.MAX_SAFE_INTEGER; receipt.outputTokens = 0;
      trial.generation!.usage.inputTokens = receipt.inputTokens; trial.generation!.usage.outputTokens = 0;
      trial.generation!.resource!.receiptDigest = digest(canonical(receipt));
    }
    f.write(); expect(f.read()).toMatchObject({ sourceState: 'unavailable', complete: false, reasons: ['usage-accounting-overflow'],
      usage: { complete: false, totalTokens: null, recordedInputTokens: 0, recordedOutputTokens: 0 }, campaigns: [] });
  });
  it('retains exact failed transport costs without calling transport completion evaluator success', () => {
    const f = fixture(); const { trial, receipt } = f.add(0, false, 'failed');
    receipt.status = 'failed'; receipt.outputDigest = null; f.write();
    trial.generation!.status = 'failed'; trial.generation!.resource!.taskStatus = 'failed';
    trial.generation!.resource!.receiptDigest = digest(canonical(receipt)); trial.score = null; trial.artifact = null;
    trial.error = 'private transport error';
    expect(f.read()).toMatchObject({ usage: { totalTokens: 30 }, timing: { totalDurationMs: 1 }, campaigns: [{
      stages: { trials: 1, evaluated: 0, passed: 0, rejected: 0 }, workers: [{ evaluated: 0, usage: { totalTokens: 30 } }] }] });
  });
  it.each(['taskDigest', 'receiptDigest', 'workerModel', 'poolDigest', 'workerId', 'taskId', 'taskStatus'] as const)('does not credit a mismatching %s', key => {
    const f = fixture(); const { trial } = f.add(1, true); Object.assign(trial.generation!.resource!, { [key]: 'wrong' });
    expect(f.read()).toMatchObject({ complete: false, usage: { totalTokens: null, joinedAttempts: 0 },
      campaigns: [{ reasons: ['worker-receipt-unverified'], workers: [] }] });
  });
  it('does not trust generation tokens that differ from the ledger', () => {
    const f = fixture(); const { trial } = f.add(1, true); trial.generation!.usage.inputTokens = 100;
    expect(f.read().usage).toMatchObject({ joinedAttempts: 1, reportedAttempts: 0, unknownAttempts: 1, totalTokens: null });
  });
  it('keeps legacy usage scope and replayed output consumption unknown', () => {
    const f = fixture(); const { trial, receipt } = f.add(1, true); delete receipt.execution; f.write();
    trial.generation!.resource!.receiptDigest = digest(canonical(receipt));
    expect(f.read().usage.totalTokens).toBeNull();
    trial.generation!.resource!.dispatch = 'replayed'; expect(f.read().usage).toMatchObject({ attempts: 1, reportedAttempts: 0 });
  });
  it('does not treat a missing receipt or unfinished reserved slot as zero cost', () => {
    const f = fixture(); f.add(1, true); f.state.attempts = []; f.write();
    expect(f.read().usage).toMatchObject({ attempts: 1, joinedAttempts: 0, unknownAttempts: 1, totalTokens: null });
    f.universe.runs = []; expect(f.read().usage.totalTokens).toBeNull();
  });
  it('de-duplicates task identities rather than crediting a repeated step', () => {
    const f = fixture(); f.add(1, true); f.campaign.steps.push(f.campaign.steps[0]!);
    expect(f.read()).toMatchObject({ complete: false, usage: { totalTokens: null }, campaigns: [{ sourceState: 'unavailable' }] });
  });
  it('separates measured seed score from retained-parent lineage', () => {
    const f = fixture(); f.add(2, true);
    const intent = { schemaVersion: 1, definitionDigest: hash('d'), manifestDigest: hash('a'), comparatorDigest: hash('b'), seedArtifactDigest: hash('0') };
    f.campaign.seedEvaluation = { intent, result: { status: 'measured', reason: null, processGroupSettlement: 'group-exit-confirmed',
      intentDigest: digest(canonical(intent)), measurement: { passed: false, score: 0, metrics: {} } } } as UniverseCampaignSummary['seedEvaluation'];
    expect(f.read().campaigns[0]).toMatchObject({ seed: { status: 'measured', score: 0, passed: false }, niches: [{ score: 2, deltaFromSeed: 2 }], stages: { strictImprovements: 0 } });
    f.universe.manifest.metric.direction = 'minimize'; expect(f.read().campaigns[0]?.niches[0]?.deltaFromSeed).toBe(-2);
  });
  it('supports exact historical receipt epochs without reinterpreting their origin', () => {
    const f = fixture(); f.add(1, true);
    const nextPool = structuredClone(f.pool); nextPool.workers.push({ ...nextPool.workers[0]!, id: 'second' });
    const nextBindings = [...f.bindings, { ...f.bindings[0]!, workerId: 'second' }];
    const nextDigest = digest(canonical({ pool: nextPool, bindings: nextBindings }));
    Object.assign(f.state, { schemaVersion: 2, poolDigest: nextDigest, configurationHistory: [
      { pool: f.pool, bindings: f.bindings, poolDigest: f.poolDigest }, { pool: nextPool, bindings: nextBindings, poolDigest: nextDigest }] });
    f.save(f.options.poolFile, nextPool); f.save(f.options.bindingsFile, nextBindings); f.write();
    expect(f.read()).toMatchObject({ sourceState: 'healthy', usage: { totalTokens: 30 } });
  });
  it('refuses a pending evolution barrier and a modified immutable runtime', () => {
    const f = fixture(); f.add(1, true); f.state.pendingEvolution = { planDigest: hash('9') }; f.write();
    expect(f.read()).toMatchObject({ sourceState: 'unavailable', complete: false, usage: { totalTokens: null } });
    delete f.state.pendingEvolution; f.write(); f.save(f.options.host.resourceRuntime, { ...f.runtime, root: join(f.outer, 'other') });
    expect(f.read()).toMatchObject({ sourceState: 'unavailable', complete: false, usage: { totalTokens: null } });
  });
  it('refuses foreign controller/campaign scope and replaced comparator pins', () => {
    const f = fixture(); f.add(1, true); f.controller.first.enrollment.graphDispatch.graphId = 'other';
    expect(f.read().sourceState).toBe('unavailable');
    f.controller.first.enrollment.graphDispatch.graphId = 'graph'; f.campaign.comparatorDigest = hash('9');
    expect(f.read().campaigns[0]?.sourceState).toBe('unavailable');
  });
  it('retains unknown delivery proof rather than mapping a degraded branch to zero', () => {
    const f = fixture(); f.add(1, true); vi.mocked(delivery.readUniverseDeliveries).mockReturnValue({ sourceState: 'degraded', reasons: ['private error'], deliveries: [] });
    expect(f.read()).toMatchObject({ complete: false, campaigns: [{ stages: { verifiedLocalDeliveries: null }, reasons: ['delivery-evidence-unavailable'] }] });
  });
  it('detects changes across samples without overwriting or repairing evidence', () => {
    const f = fixture(); f.add(1, true); let call = 0;
    vi.mocked(delivery.readUniverseDeliveries).mockImplementation(() => ({ sourceState: ++call === 1 ? 'missing' : 'degraded', deliveries: [], reasons: [] }));
    const before = tree(f.outer); expect(f.read()).toMatchObject({ sourceState: 'degraded', reasons: ['evidence-changed-during-sampling'], usage: { totalTokens: null } });
    expect(tree(f.outer)).toBe(before);
  });
  it('rejects getters and extra options before invoking accessors or reading sources', () => {
    const f = fixture(); const getter = vi.fn(() => f.options.host);
    expect(() => readResourceEngineeringOutcomes({ ...f.options, get host() { return getter(); } })).toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(() => readResourceEngineeringOutcomes({ ...f.options, extra: true } as ResourceEngineeringOutcomesOptions)).toThrow();
  });
});
