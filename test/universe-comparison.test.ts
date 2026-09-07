import { describe, expect, it } from 'vitest';
import { buildUniverseCampaignComparison } from '../src/core/universe/comparison.js';
import type { UniverseComparisonArmSource } from '../src/core/universe/comparison-types.js';
import type { UniverseDeliveryReceipt } from '../src/core/universe/delivery.js';
import type { UniverseRun, UniverseTrial } from '../src/core/universe/types.js';

const SEED = '0'.repeat(64);
const COMPARATOR = 'c'.repeat(64);
const SAMPLE = '2026-09-07T12:00:00.000Z';

/** Pure validated-history fixtures: no files, providers, Git or evaluator execution. */
function fixture(id: string, scores = [1, 1, 2], feedback = false, direction: 'maximize' | 'minimize' = 'maximize'): UniverseComparisonArmSource {
  const source: UniverseComparisonArmSource = { campaignId: `campaign-${id}`, sourceState: 'healthy', seedDigest: SEED, reasons: [],
    deliveryReport: { sourceState: 'missing', deliveries: [], reasons: [] },
    universe: { manifest: { schemaVersion: 1, id, name: id, objective: 'private objective', seed: { repo: '/private/seed', revision: 'f'.repeat(40) },
      metric: { name: 'score', direction, minImprovement: 0 }, budget: { maxTrials: 1, maxDurationMs: 10000, maxParallel: 1, trialTimeoutMs: 1000 },
      evaluation: { command: ['/private/node', 'evaluate.mjs'], timeoutMs: 1000 }, variants: [{ id: 'candidate', niche: 'quality',
        hypothesis: 'private hypothesis', generation: { kind: 'local-chat', endpoint: 'http://127.0.0.1:11434/v1', model: 'fixture',
          files: ['private-file.txt'], maxOutputTokens: 64 } }] },
    manifestDigest: (id === 'a' ? 'a' : 'b').repeat(64), comparatorDigest: COMPARATOR, runs: [], elites: [], activeRun: null, sourceState: 'healthy', reasons: [] },
    campaign: { definition: { schemaVersion: 1, id: `campaign-${id}`, universeId: id, feedback,
      budget: { maxGenerations: 4, maxDurationMs: 100000, maxModelRequests: 4, maxStagnantGenerations: 4, maxReportedTokens: null } },
    definitionDigest: (id === 'a' ? 'd' : 'e').repeat(64), manifestDigest: (id === 'a' ? 'a' : 'b').repeat(64), comparatorDigest: COMPARATOR,
    createdAt: '2026-09-07T00:00:00.000Z', state: 'completed', reason: 'max-generations', startedAt: '2026-09-07T00:00:00.000Z',
    deadlineAt: '2026-09-07T00:01:40.000Z', finishedAt: '2026-09-07T00:00:10.000Z', steps: [],
    progress: { attempts: 0, completedRuns: 0, interruptedRuns: 0, reservedModelRequests: 0, reportedTokens: 0, recordedTokens: 0,
      usageComplete: true, admissions: 0, improvements: 0, stagnantGenerations: 0 }, owner: null, sourceState: 'healthy', reasons: [] } };
  let parent: UniverseTrial | undefined;
  for (const [index, score] of scores.entries()) {
    const generation = index + 1;
    const delta = parent ? (score - parent.score!) * (direction === 'maximize' ? 1 : -1) : null;
    const selected = delta === null || delta > 0;
    const artifact = score === scores[0] ? '1'.repeat(64) : '2'.repeat(64);
    const trial: UniverseTrial = { id: `trial-${generation}`, variantId: 'candidate', niche: 'quality', parentTrialId: parent?.id ?? null,
      status: 'passed', score, metrics: {}, artifact: { path: '/private/archive', digest: artifact, revision: 'f'.repeat(40) },
      durationMs: 500, delta, selected, generation: { schemaVersion: 1, provider: 'local-openai-compatible',
        endpoint: 'http://127.0.0.1:11434/v1', model: 'fixture', status: 'succeeded', requestStarted: true,
        promptDigest: '3'.repeat(64), responseDigest: '4'.repeat(64), durationMs: 250, usage: { state: 'reported', inputTokens: 20, outputTokens: 10 },
        changedFiles: ['private-file.txt'], ...(feedback ? { search: { schemaVersion: 2 as const, digest: '5'.repeat(64) } } : {}) } };
    const run: UniverseRun = { id: `${id}-run-${generation}`, universeId: id, generation, manifestDigest: source.universe!.manifestDigest,
      comparatorDigest: COMPARATOR, startedAt: `2026-09-07T00:00:0${index}.000Z`, finishedAt: `2026-09-07T00:00:0${generation}.000Z`,
      status: 'completed', trials: [trial], durationMs: 1000, tokensUsed: 30, costUsd: null,
      campaign: { id: source.campaignId, ordinal: generation, definitionDigest: source.campaign!.definitionDigest },
      ...(feedback ? { feedbackEnabled: true as const, feedbackVersion: 2 as const } : {}) };
    source.universe!.runs.push(run);
    if (selected) parent = trial;
  }
  refresh(source);
  return source;
}

function refresh(source: UniverseComparisonArmSource): void {
  const campaign = source.campaign!;
  campaign.steps = source.universe!.runs.filter((run) => run.campaign?.id === source.campaignId).map((run) => ({
    ordinal: run.campaign!.ordinal, runId: run.id, generation: run.generation, variantIds: run.trials.map((trial) => trial.variantId),
    reservedModelRequests: run.trials.filter((trial) => trial.generation).length, createdAt: run.startedAt, state: run.status,
    trialCount: run.trials.length, passedTrials: run.trials.filter((trial) => trial.status === 'passed').length,
    admissions: run.status === 'completed' ? run.trials.filter((trial) => trial.selected && trial.delta === null).length : 0,
    improvements: run.status === 'completed' ? run.trials.filter((trial) => trial.selected && trial.delta !== null && trial.delta > 0).length : 0,
    tokensUsed: run.tokensUsed }));
  const runs = source.universe!.runs.filter((run) => campaign.steps.some((step) => step.runId === run.id));
  const receipts = runs.flatMap((run) => run.trials.flatMap((trial) => trial.generation ? [trial.generation] : []));
  const recorded = receipts.filter((receipt) => receipt.usage.state === 'reported').reduce((sum, receipt) => sum + receipt.usage.inputTokens! + receipt.usage.outputTokens!, 0);
  const complete = runs.every((run) => run.status === 'completed' || !run.trials.some((trial) => trial.generation)) &&
    receipts.every((receipt) => !receipt.requestStarted || receipt.usage.state === 'reported');
  campaign.progress = { attempts: campaign.steps.length, completedRuns: runs.filter((run) => run.status === 'completed').length,
    interruptedRuns: runs.filter((run) => run.status === 'interrupted').length,
    reservedModelRequests: campaign.steps.reduce((sum, step) => sum + step.reservedModelRequests, 0),
    reportedTokens: complete ? recorded : null, recordedTokens: recorded, usageComplete: complete,
    admissions: campaign.steps.reduce((sum, step) => sum + step.admissions, 0),
    improvements: campaign.steps.reduce((sum, step) => sum + step.improvements, 0), stagnantGenerations: 0 };
}
function delivery(source: UniverseComparisonArmSource, branch: string): UniverseDeliveryReceipt {
  const run = source.universe!.runs[0]; const trial = run.trials[0];
  return { schemaVersion: 1, id: '9'.repeat(64), universeId: run.universeId, runId: run.id, trialId: trial.id,
    niche: trial.niche, manifestDigest: run.manifestDigest, comparatorDigest: run.comparatorDigest, artifactDigest: trial.artifact!.digest,
    repo: source.universe!.manifest.seed.repo, branch, baseCommit: source.universe!.manifest.seed.revision,
    commit: '9'.repeat(40), tree: '8'.repeat(40), changedFiles: ['private-file.txt'], status: 'delivered', createdAt: SAMPLE, completedAt: SAMPLE };
}
const compare = (a = fixture('a', [1, 1, 1]), b = fixture('b', [1, 1, 2], true)) => buildUniverseCampaignComparison(a, b, SAMPLE);

describe('pure campaign comparison observations', () => {
  it.each(['maximize', 'minimize'] as const)('compares matching %s arms without claiming accepted work or a causal winner', (direction) => {
    const first = direction === 'maximize' ? 1 : 9;
    const report = compare(fixture('a', [first, first, first], false, direction), fixture('b', [first, first, first + (direction === 'maximize' ? 1 : -1)], true, direction));
    expect(report).toMatchObject({ schemaVersion: 1, sampledAt: SAMPLE, sourceState: 'healthy', authority: 'observation-only',
      measurementScope: 'local-experiment', matching: { comparator: true, configuration: true, workload: true, comparable: true },
      feedbackContrast: 'feedback-bundle-v2', acceptedChanges: null });
    expect(report.challenger).toMatchObject({ fresh: true, completed: true, fullyAttributed: true, acceptedChanges: null,
      counts: { attempts: 3, passedTrials: 3, admissions: 1, improvements: 1, distinctSelectedArtifacts: 2,
        modelRequestsStarted: 3, reportedModelRequests: 3, reservedModelRequests: 3, verifiedDeliveryBranches: 0 },
      usage: { reportedTokens: 90, recordedTokens: 90, complete: true }, timing: { recordedRunDurationMs: 3000, wallSpanMs: 10000 } });
    expect(report.scoreDeltas[0].directionAdjustedDelta).toBe(1);
    expect(report.challenger.rates.improvementsPerMillionTokens).toBeCloseTo(1_000_000 / 90);
    expect(report.challenger.rates.improvementsPerHour).toBe(1200);
    expect(report).not.toHaveProperty('winner');
  });

  it.each([
    ['model', (s: UniverseComparisonArmSource) => { s.universe!.manifest.variants[0].generation!.model = 'other'; }],
    ['endpoint', (s: UniverseComparisonArmSource) => { s.universe!.manifest.variants[0].generation!.endpoint = 'http://127.0.0.1:9999/v1'; }],
    ['output cap', (s: UniverseComparisonArmSource) => { s.universe!.manifest.variants[0].generation!.maxOutputTokens++; }],
    ['hypothesis', (s: UniverseComparisonArmSource) => { s.universe!.manifest.variants[0].hypothesis = 'different'; }],
    ['run budget', (s: UniverseComparisonArmSource) => { s.universe!.manifest.budget.maxDurationMs++; }],
    ['campaign budget', (s: UniverseComparisonArmSource) => { s.campaign!.definition.budget.maxDurationMs++; }],
  ])('retains descriptive results but suppresses deltas for changed %s', (_name, mutate) => {
    const b = fixture('b', [1, 1, 2], true); mutate(b);
    const report = compare(undefined, b);
    expect(report.matching).toMatchObject({ comparator: true, configuration: false, comparable: false });
    expect(report.challenger.counts.improvements).toBe(1); expect(report.challenger.rates.improvementsPerHour).toBe(1200);
    expect(report.scoreDeltas[0].directionAdjustedDelta).toBeNull();
  });

  it('requires literal comparator equality independently of all other controls', () => {
    const b = fixture('b', [1, 1, 2], true); b.universe!.comparatorDigest = 'f'.repeat(64); b.campaign!.comparatorDigest = 'f'.repeat(64);
    b.universe!.runs.forEach((run) => { run.comparatorDigest = 'f'.repeat(64); });
    const report = compare(undefined, b);
    expect(report.sourceState).toBe('healthy'); expect(report.matching).toMatchObject({ comparator: false, configuration: true, comparable: false });
    expect(report.scoreDeltas[0].directionAdjustedDelta).toBeNull();
  });

  it('separates matching allocation from unequal executed work', () => {
    const report = compare(undefined, fixture('b', [1, 2], true));
    expect(report.matching).toMatchObject({ configuration: true, workload: false, comparable: false });
    expect(report.challenger.rates.improvementsPerHour).toBe(1800);
  });

  it('requires distinct campaign and Universe identities', () => {
    const a = fixture('a'); const same = structuredClone(a);
    expect(compare(a, same).matching.reasons).toContain('distinct-campaigns-and-universes-required');
  });

  it('uses only enrolled outcomes, never later global elites or unrelated runs', () => {
    const b = fixture('b', [1, 1, 2], true);
    const foreign = structuredClone(b.universe!.runs[2]); foreign.id = 'foreign'; foreign.generation = 4; delete foreign.campaign;
    foreign.trials[0].score = 999; b.universe!.runs.push(foreign);
    b.universe!.elites = [{ niche: 'quality', variantId: 'candidate', trialId: 'foreign-trial', runId: 'foreign', generation: 4,
      score: 999, metrics: {}, artifact: foreign.trials[0].artifact!, comparatorDigest: COMPARATOR }];
    const report = compare(undefined, b);
    expect(report.challenger.niches[0].score).toBe(2); expect(report.challenger.counts.attempts).toBe(3);
    expect(report.challenger.fullyAttributed).toBe(false); expect(report.matching.comparable).toBe(false);
    expect(report.challenger.rates.improvementsPerHour).toBeNull();
  });

  it('does not call generation-two enrollment a fresh seed comparison', () => {
    const b = fixture('b'); b.universe!.runs.forEach((run) => { run.generation++; }); refresh(b);
    const report = compare(undefined, b); expect(report.challenger.fresh).toBe(false);
    expect(report.challenger.rates.improvementsPerMillionTokens).toBeNull();
  });

  it('excludes the seed and de-duplicates repeated selected content, without erasing admissions', () => {
    const b = fixture('b', [1, 2, 3], true);
    b.universe!.runs[0].trials[0].artifact!.digest = SEED;
    b.universe!.runs[1].trials[0].artifact!.digest = '7'.repeat(64);
    b.universe!.runs[2].trials[0].artifact!.digest = '7'.repeat(64);
    const arm = compare(undefined, b).challenger;
    expect(arm.counts).toMatchObject({ admissions: 1, improvements: 2, distinctSelectedArtifacts: 1 });
  });

  it('preserves rejected-attempt usage in resource denominators', () => {
    const b = fixture('b', [1, 1, 2], true); b.universe!.runs[1].trials[0].status = 'failed';
    b.universe!.runs[1].trials[0].score = null; b.universe!.runs[1].trials[0].delta = null; refresh(b);
    const arm = compare(undefined, b).challenger;
    expect(arm.counts.passedTrials).toBe(2); expect(arm.usage.reportedTokens).toBe(90);
    expect(arm.rates.improvementsPerMillionTokens).toBeCloseTo(1_000_000 / 90);
  });

  it('keeps unreported usage unknown and exposes the recorded subtotal', () => {
    const b = fixture('b', [1, 1, 2], true);
    b.universe!.runs[1].trials[0].generation!.usage = { state: 'unavailable', inputTokens: null, outputTokens: null }; refresh(b);
    const arm = compare(undefined, b).challenger;
    expect(arm.sourceState).toBe('healthy'); expect(arm.usage).toEqual({ complete: false, reportedTokens: null, recordedTokens: 60 });
    expect(arm.rates.improvementsPerMillionTokens).toBeNull(); expect(arm.counts.reportedModelRequests).toBe(2);
  });

  it('does not confuse command-only accounting zero with measured model usage', () => {
    const b = fixture('b'); b.universe!.runs.forEach((run) => { delete run.trials[0].generation; run.tokensUsed = null; });
    b.universe!.manifest.variants = [{ id: 'candidate', niche: 'quality', hypothesis: 'command fixture', command: ['private-worker'] }]; refresh(b);
    const arm = compare(undefined, b).challenger;
    expect(arm.sourceState).toBe('healthy'); expect(arm.feedback.observed).toBe('unobserved');
    expect(arm.usage).toEqual({ complete: false, reportedTokens: null, recordedTokens: 0 });
    expect(arm.rates.improvementsPerMillionTokens).toBeNull();
  });

  it('keeps known zero tokens and zero time denominators null without inventing infinite rates', () => {
    const b = fixture('b'); b.universe!.runs.forEach((run) => { run.durationMs = 0;
      run.trials[0].generation!.usage = { state: 'reported', inputTokens: 0, outputTokens: 0 }; }); refresh(b);
    const arm = compare(undefined, b).challenger;
    expect(arm.usage).toEqual({ complete: true, reportedTokens: 0, recordedTokens: 0 });
    expect(arm.rates.improvementsPerMillionTokens).toBeNull(); expect(arm.rates.improvementsPerHour).toBeNull();
  });

  it('includes interrupted attempts and reservations but withholds all normalized rates', () => {
    const b = fixture('b'); b.campaign!.state = 'interrupted'; b.universe!.runs[2].status = 'interrupted'; refresh(b);
    const arm = compare(undefined, b).challenger;
    expect(arm.counts).toMatchObject({ attempts: 3, completedRuns: 2, interruptedRuns: 1, reservedModelRequests: 3, improvements: 0 });
    expect(arm.usage).toEqual({ complete: false, reportedTokens: null, recordedTokens: 90 });
    expect(arm.rates.improvementsPerMillionTokens).toBeNull(); expect(arm.rates.improvementsPerHour).toBeNull();
  });

  it('does not refund an abandoned reservation with no run evidence', () => {
    const b = fixture('b'); b.universe!.runs.pop(); b.campaign!.state = 'interrupted'; b.campaign!.steps[2].state = 'interrupted';
    b.campaign!.progress.recordedTokens = 60; b.campaign!.progress.reportedTokens = null; b.campaign!.progress.usageComplete = false;
    b.campaign!.progress.completedRuns = 2; b.campaign!.progress.interruptedRuns = 1; b.campaign!.progress.improvements = 0;
    const arm = compare(undefined, b).challenger;
    expect(arm.sourceState).toBe('healthy'); expect(arm.counts.reservedModelRequests).toBe(3);
    expect(arm.fullyAttributed).toBe(false); expect(arm.usage.recordedTokens).toBe(60);
  });

  it('counts independently verified branches separately from delivered artifacts', () => {
    const b = fixture('b', [1, 1, 2], true);
    const first = delivery(b, 'codex/first'); const second = delivery(b, 'codex/second');
    const pending = { ...delivery(b, 'codex/pending'), status: 'pending' as const, completedAt: null };
    const unchanged = { ...delivery(b, 'codex/unchanged'), status: 'unchanged' as const, changedFiles: [] };
    const unrelated = { ...delivery(b, 'codex/unrelated'), runId: 'unrelated-run' };
    b.deliveryReport = { sourceState: 'healthy', reasons: [], deliveries: [first, second, pending, unchanged, unrelated] };
    const arm = compare(undefined, b).challenger;
    expect(arm.counts).toMatchObject({ verifiedDeliveryBranches: 2, distinctDeliveredArtifacts: 1 });
    expect(arm.acceptedChanges).toBeNull();
  });

  it('binds delivery trial IDs to their exact enrolled run occurrence', () => {
    const b = fixture('b'); b.universe!.runs[2].trials[0].id = b.universe!.runs[0].trials[0].id;
    const receipt = delivery(b, 'codex/correct'); receipt.runId = b.universe!.runs[2].id;
    b.deliveryReport = { sourceState: 'healthy', reasons: [], deliveries: [delivery(b, 'codex/first'), receipt] };
    const arm = compare(undefined, b).challenger;
    expect(arm.sourceState).toBe('degraded'); expect(arm.counts.verifiedDeliveryBranches).toBeNull();
    expect(arm.counts.distinctDeliveredArtifacts).toBeNull();
  });

  it('withholds delivery success for degraded independent evidence', () => {
    const b = fixture('b'); b.deliveryReport = { sourceState: 'degraded', reasons: ['private path failure'], deliveries: [delivery(b, 'codex/first')] };
    const arm = compare(undefined, b).challenger;
    expect(arm.counts.verifiedDeliveryBranches).toBeNull(); expect(arm.sourceState).toBe('degraded');
  });

  it('describes legacy feedback and mixed pinned versions without calling them v2 bundle treatment', () => {
    const b = fixture('b', [1, 1, 2], true);
    b.universe!.runs.forEach((run) => { delete run.feedbackVersion; delete run.trials[0].generation!.search; });
    expect(compare(undefined, b)).toMatchObject({ feedbackContrast: 'other-or-mixed', challenger: { feedback: { observed: 'legacy-v1' } } });
    b.universe!.runs[2].feedbackVersion = 2; b.universe!.runs[2].trials[0].generation!.search = { schemaVersion: 2, digest: '5'.repeat(64) };
    expect(compare(undefined, b)).toMatchObject({ feedbackContrast: 'other-or-mixed', challenger: { feedback: { observed: 'mixed' } } });
  });

  it('never treats missing or degraded sources as zero-yield success', () => {
    const missing: UniverseComparisonArmSource = { campaignId: 'missing', sourceState: 'missing', campaign: null, universe: null, seedDigest: null, deliveryReport: null, reasons: [] };
    const report = compare(missing, { ...missing, campaignId: 'other' });
    expect(report.sourceState).toBe('missing'); expect(report.matching.comparable).toBe(false);
    expect(report.baseline.rates.improvementsPerHour).toBeNull(); expect(report.baseline.usage.reportedTokens).toBeNull();
    expect(compare(fixture('a'), missing).sourceState).toBe('degraded');
  });

  it('returns detached metadata and fixed reasons, never raw source, diagnostics, paths or commands', () => {
    const b = fixture('b', [1, 1, 2], true); b.reasons = ['private source reason']; b.universe!.runs[0].error = 'private run error';
    b.universe!.runs[0].trials[0].diagnostics = [{ code: 'SECRET', message: 'private diagnostic message' }];
    const report = compare(undefined, b); const snapshot = structuredClone(report);
    b.universe!.manifest.metric.name = 'mutated'; b.universe!.runs[0].trials[0].score = 999;
    expect(report).toEqual(snapshot); expect(JSON.stringify(report)).not.toMatch(/private|127\.0\.0\.1|SECRET|hypothesis|diagnostic/);
  });

  it('retains the fixed sampling-change diagnostic without forwarding arbitrary reader reasons', () => {
    const b = fixture('b'); b.sourceState = 'degraded'; b.reasons = ['Selected evidence changed while the comparison was sampled', 'private source text'];
    const arm = compare(undefined, b).challenger;
    expect(arm.reasons).toContain('source-changed-during-sampling'); expect(arm.reasons).not.toContain('private source text');
  });

  it.each(['source-evidence-degraded', 'Selected evidence changed while the comparison was sampled'])('withholds stale verified deliveries and complete usage after %s', (reason) => {
    const b = fixture('b'); b.deliveryReport = { sourceState: 'healthy', reasons: [], deliveries: [delivery(b, 'codex/first')] };
    b.sourceState = 'degraded'; b.reasons = [reason];
    const arm = compare(undefined, b).challenger;
    expect(arm.counts.verifiedDeliveryBranches).toBeNull(); expect(arm.counts.distinctDeliveredArtifacts).toBeNull();
    expect(arm.usage).toEqual({ complete: false, reportedTokens: null, recordedTokens: 90 });
  });

  it.each(['attempts', 'completedRuns', 'interruptedRuns', 'reservedModelRequests', 'admissions', 'improvements'] as const)('fails closed on inconsistent campaign %s', (key) => {
    const b = fixture('b'); b.campaign!.progress[key]++;
    const arm = compare(undefined, b).challenger;
    expect(arm.sourceState).toBe('degraded'); expect(arm.reasons).toContain('campaign-counter-evidence-mismatch');
    expect(arm.rates.improvementsPerHour).toBeNull();
  });

  it('treats reversed recorded parallel-trial order as different executed workload', () => {
    const a = fixture('a'); const b = fixture('b');
    for (const source of [a, b]) {
      source.universe!.manifest.budget.maxTrials = 2; source.universe!.manifest.budget.maxParallel = 2;
      source.universe!.manifest.variants.push({ ...source.universe!.manifest.variants[0], id: 'other', niche: 'other' });
      for (const run of source.universe!.runs) run.trials.push({ ...structuredClone(run.trials[0]), id: 'other-trial', variantId: 'other', niche: 'other' });
      refresh(source);
    }
    b.universe!.runs[0].trials.reverse();
    const report = compare(a, b);
    expect(report.matching).toMatchObject({ configuration: true, workload: false, comparable: false });
  });

  it('keeps separate per-niche score differences, without adding unrelated score scales', () => {
    const a = fixture('a', [1]); const b = fixture('b', [2], true);
    for (const source of [a, b]) {
      const run = source.universe!.runs[0];
      source.universe!.manifest.variants.push({ ...source.universe!.manifest.variants[0], id: 'other', niche: 'other' });
      run.trials.push({ ...structuredClone(run.trials[0]), id: 'other-trial', variantId: 'other', niche: 'other', score: source === a ? 100 : 90 });
      refresh(source);
    }
    expect(compare(a, b).scoreDeltas).toEqual([
      { niche: 'other', baselineScore: 100, challengerScore: 90, directionAdjustedDelta: -10 },
      { niche: 'quality', baselineScore: 1, challengerScore: 2, directionAdjustedDelta: 1 },
    ]);
  });

  it('compares configuration objects canonically without depending on property insertion order', () => {
    const b = fixture('b', [1, 1, 2], true);
    b.universe!.manifest.budget = Object.fromEntries(Object.entries(b.universe!.manifest.budget).reverse()) as typeof b.universe.manifest.budget;
    expect(compare(undefined, b).matching.configuration).toBe(true);
  });

  it('bounds oversized campaign attempts before projecting outcomes', () => {
    const b = fixture('b'); b.campaign!.steps = Array.from({ length: 129 }, () => structuredClone(b.campaign!.steps[0]));
    const report = compare(undefined, b);
    expect(report.challenger.sourceState).toBe('degraded'); expect(report.challenger.reasons).toContain('source-bounds-exceeded');
    expect(report.matching.comparable).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER])('fails closed on invalid/overflowing recorded token input %s', (inputTokens) => {
    const b = fixture('b'); b.universe!.runs[0].trials[0].generation!.usage.inputTokens = inputTokens;
    const report = compare(undefined, b);
    expect(report.challenger.sourceState).toBe('degraded'); expect(report.matching.comparable).toBe(false);
    expect(report.challenger.rates.improvementsPerMillionTokens).toBeNull();
    expect(JSON.stringify(report)).not.toContain('Infinity');
  });

  it('does not calculate a nonfinite direction-adjusted score delta', () => {
    const a = fixture('a', [-Number.MAX_VALUE]); const b = fixture('b', [Number.MAX_VALUE], true);
    const report = compare(a, b); expect(report.matching.comparable).toBe(true);
    expect(report.scoreDeltas[0].directionAdjustedDelta).toBeNull();
  });

  it('rejects invalid observation timestamps', () => {
    expect(() => buildUniverseCampaignComparison(fixture('a'), fixture('b'), 'not-a-time')).toThrow(/observation time/);
  });
});
