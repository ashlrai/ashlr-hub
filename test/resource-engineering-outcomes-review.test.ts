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
function fixture() {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-outcomes-'))); roots.push(outer);
  const root = join(outer, 'ledger'); const world = join(outer, 'world');
  mkdirSync(root, { mode: 0o700 }); mkdirSync(world, { mode: 0o700 });
  mkdirSync(join(world, 'portfolios', 'controller'), { recursive: true, mode: 0o700 });
  const save = (path: string, value: unknown) => writeFileSync(path, canonical(value) + '\n', { mode: 0o600 });
  const pool: ResourcePool = { schemaVersion: 1, id: 'pool', workers: [{ id: 'worker', provider: 'local', model: 'model',
    maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1 }] };
  const bindings: ResourceBinding[] = [{ workerId: 'worker', capacityKey: 'capacity', kind: 'local-chat', endpoint: 'http://127.0.0.1:9/v1' }];
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
      generation: { kind: 'resource-pool', poolId: 'pool', poolDigest, allowedWorkerIds: ['worker'], fileOperations: { schemaVersion: 1 } } }] },
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
  function add(score: number, selected: boolean, status: 'passed' | 'failed' = 'passed') {
    const ordinal = universe.runs.length + 1; const runId = `run-${ordinal}`;
    const receipt: ResourceTaskReceipt = { schemaVersion: 1, id: resourceGenerationTaskId({ universeId: 'universe', runId, variantId: 'variant' }),
      taskDigest: hash('c'), poolDigest, workerId: 'worker', capacityKey: 'capacity', status: 'completed', startedAt: at, finishedAt: at,
      outputDigest: hash('6'), inputTokens: 20, outputTokens: 10, reason: 'worker-completed', verifiedAccepted: false,
      execution: { schemaVersion: 1, scope: 'worker-execution', durationMs: 1, usageScope: 'local-chat-completion' } };
    const trial: UniverseTrial = { id: `trial-${ordinal}`, variantId: 'variant', niche: 'quality', parentTrialId: null, status, score,
      metrics: { score }, artifact: { path: '/private/artifact', digest: hash(String(ordinal)), revision: 'f'.repeat(40) }, durationMs: 1,
      delta: selected && ordinal > 1 ? 1 : null, selected, ...(status === 'failed' ? { error: 'Fixed evaluator rejected the candidate' } : {}),
      generation: { schemaVersion: 1, provider: 'resource-pool', endpoint: null, model: null, status: 'succeeded', requestStarted: true,
        promptDigest: hash('2'), responseDigest: hash('6'), durationMs: 1, usage: { state: 'reported', inputTokens: 20, outputTokens: 10 }, changedFiles: ['private.ts'],
        resource: { schemaVersion: 1, poolId: 'pool', poolDigest, allowedWorkerIds: ['worker'], taskId: receipt.id, taskDigest: receipt.taskDigest,
          workerId: 'worker', workerProvider: 'local', workerModel: 'model', receiptDigest: digest(canonical(receipt)), dispatch: 'settled',
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


describe('independent engineering outcome observation boundaries', () => {
  it('never emits unsafe token subtotals from individually valid ledger receipts', () => {
    const f = fixture();
    for (const score of [0, 1]) {
      const { receipt, trial } = f.add(score, score > 0, score > 0 ? 'passed' : 'failed');
      receipt.inputTokens = Number.MAX_SAFE_INTEGER; receipt.outputTokens = 0;
      trial.generation!.usage = { state: 'reported', inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 };
      trial.generation!.resource!.receiptDigest = digest(canonical(receipt));
    }
    f.write(); const before = tree(f.outer); const report = f.read();
    expect(report.complete).toBe(false); expect(report.sourceState).not.toBe('healthy');
    expect(report.reasons).toEqual(['usage-accounting-overflow']);
    expect(report.usage.totalTokens).toBeNull();
    for (const total of [report.usage, ...report.campaigns.flatMap(row => [row.usage, ...row.workers.map(worker => worker.usage)])]) {
      expect(Number.isSafeInteger(total.recordedInputTokens)).toBe(true);
      expect(Number.isSafeInteger(total.recordedOutputTokens)).toBe(true);
    }
    expect(tree(f.outer)).toBe(before);
  });
  it('does not carry first-sample timing or usage authority across changing evidence', () => {
    const f = fixture(); f.add(1, true); let sampled = 0;
    vi.mocked(delivery.readUniverseDeliveries).mockImplementation(() => ({
      sourceState: ++sampled === 1 ? 'missing' : 'degraded', deliveries: [], reasons: [] }));
    const before = tree(f.outer); const report = f.read();
    expect(report).toMatchObject({ sourceState: 'degraded', complete: false,
      reasons: ['evidence-changed-during-sampling'], usage: { complete: false, totalTokens: null },
      timing: { complete: false, totalDurationMs: null } });
    for (const row of report.campaigns) for (const worker of row.workers) {
      expect(worker.usage.complete).toBe(false); expect(worker.timing.complete).toBe(false);
      expect(worker.timing.totalDurationMs).toBeNull();
    }
    expect(tree(f.outer)).toBe(before);
  });
  it('retains incomplete admitted work as unknown rather than a zero-attempt completed observation', () => {
    const f = fixture(); f.add(1, true);
    f.universe.runs = []; f.campaign.steps[0]!.state = 'interrupted'; f.state.attempts = []; f.write();
    const report = f.read();
    expect(report).toMatchObject({ complete: false, sourceState: 'degraded',
      usage: { attempts: 1, unknownAttempts: 1, joinedAttempts: 0, totalTokens: null },
      timing: { attempts: 1, measuredAttempts: 0, totalDurationMs: null } });
    expect(report.campaigns[0]!.workers).toEqual([]);
  });
  it('will not promote an existing delivered marker without independent campaign delivery proof', () => {
    const f = fixture(); f.add(1, true);
    vi.mocked(delivery.readUniverseDeliveries).mockReturnValue({
      sourceState: 'healthy', reasons: [], deliveries: [{ branch: 'codex/result', status: 'delivered' }] as never });
    const report = f.read();
    expect(report).toMatchObject({ complete: false, campaigns: [{
      stages: { verifiedLocalDeliveries: null }, reasons: ['delivery-evidence-unverified'] }] });
    expect(report.productionAccepted).toBeNull(); expect(report.routingChanged).toBe(false);
  });
});
