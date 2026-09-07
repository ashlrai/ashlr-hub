import { describe, expect, it } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { projectCampaign, type CampaignEvent, type CampaignEventInput } from '../src/core/universe/campaign-store.js';
import { buildUniverseCampaignComparison } from '../src/core/universe/comparison.js';
import type { UniverseComparisonArmSource } from '../src/core/universe/comparison-types.js';
import type { UniverseDeliveryReceipt } from '../src/core/universe/delivery.js';
import { generationResources, newGenerationReceipt } from '../src/core/universe/generation.js';
import type { UniverseCampaignDefinition, UniverseManifest, UniverseRun, UniverseSummary, UniverseTrial } from '../src/core/universe/types.js';

const AT = '2026-09-07T10:00:00.000Z';
const END = '2026-09-07T10:01:00.000Z';
const RUN_IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

/** Typed projected evidence only: no ledger, worker, provider or Git process. */
function source(id: string, feedback = false, command = false): UniverseComparisonArmSource {
  const manifest: UniverseManifest = { schemaVersion: 1, id: `universe-${id}`, name: `Fixture ${id}`, objective: 'Improve fixed measured value',
    seed: { repo: '/private/unused-shared-seed', revision: 'a'.repeat(40) }, metric: { name: 'value', direction: 'maximize', minImprovement: 1 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 10000, trialTimeoutMs: 5000 },
    evaluation: { command: ['/usr/bin/node', 'evaluate.mjs'], timeoutMs: 3000 },
    variants: [{ id: 'variant', niche: 'value', hypothesis: 'Improve measured value',
      ...(command ? { command: ['/usr/bin/node', 'worker.mjs'] } : { generation: { kind: 'local-chat' as const,
        endpoint: 'http://127.0.0.1:1/v1', model: 'not-contacted', files: ['value.mjs'], maxOutputTokens: 256 } }) }] };
  const definition: UniverseCampaignDefinition = { schemaVersion: 1, id, universeId: manifest.id, feedback,
    budget: { maxGenerations: 2, maxDurationMs: 60000, maxModelRequests: command ? 0 : 2, maxStagnantGenerations: 2, maxReportedTokens: null } };
  const definitionDigest = digest(canonical(definition));
  const universe: UniverseSummary = { manifest, manifestDigest: digest(canonical(manifest)), comparatorDigest: 'c'.repeat(64),
    runs: [], elites: [], activeRun: null, sourceState: 'healthy', reasons: [] };
  const events: CampaignEvent[] = [];
  const append = (event: CampaignEventInput) => events.push({ ...event, sequence: events.length, id: String(events.length).padStart(8, '0') } as CampaignEvent);
  append({ kind: 'created', at: AT, definition, definitionDigest, manifestDigest: universe.manifestDigest, comparatorDigest: universe.comparatorDigest });
  append({ kind: 'started', at: AT, deadlineAt: END, owner: { pid: 1, startRef: 'fixture-finished-owner' } });
  for (const [index, runId] of RUN_IDS.entries()) {
    const trial: UniverseTrial = { id: 'reused-trial-id', variantId: 'variant', niche: 'value', parentTrialId: index ? 'reused-trial-id' : null,
      status: 'passed', score: index + 1, metrics: { value: index + 1 }, durationMs: 800,
      artifact: { path: `/private/unused/${id}/artifacts/${runId}/reused-trial-id`, digest: String(index + 1).repeat(64), revision: manifest.seed.revision },
      selected: true, delta: index ? 1 : null };
    if (!command) {
      trial.generation = { ...newGenerationReceipt(manifest.variants[0]!.generation!), status: 'succeeded', requestStarted: true,
        promptDigest: 'a'.repeat(64), responseDigest: 'b'.repeat(64), changedFiles: ['value.mjs'], durationMs: 700,
        usage: { state: 'reported', inputTokens: 10, outputTokens: 5 },
        ...(feedback ? { search: { schemaVersion: 2 as const, digest: 'd'.repeat(64) } } : {}) };
    }
    const run: UniverseRun = { id: runId, universeId: manifest.id, generation: index + 1,
      manifestDigest: universe.manifestDigest, comparatorDigest: universe.comparatorDigest,
      startedAt: new Date(Date.parse(AT) + index * 10000).toISOString(), finishedAt: new Date(Date.parse(AT) + index * 10000 + 1000).toISOString(),
      status: 'completed', trials: [trial], durationMs: 1000, ...generationResources([trial], true),
      campaign: { id, ordinal: index + 1, definitionDigest }, ...(feedback ? { feedbackEnabled: true as const, feedbackVersion: 2 as const } : {}) };
    universe.runs.push(run);
    append({ kind: 'step', at: run.startedAt, ordinal: index + 1, runId, generation: index + 1,
      variantIds: ['variant'], reservedModelRequests: command ? 0 : 1 });
  }
  append({ kind: 'settled', at: END, state: 'completed', reason: 'Fixture generation budget exhausted' });
  const last = universe.runs[1]!.trials[0]!;
  universe.elites = [{ niche: 'value', variantId: 'variant', runId: RUN_IDS[1]!, trialId: last.id,
    generation: 2, score: last.score!, metrics: last.metrics, artifact: last.artifact!, comparatorDigest: universe.comparatorDigest }];
  const campaign = projectCampaign(events, universe);
  expect(campaign.sourceState, campaign.reasons.join('; ')).toBe('healthy');
  return { campaignId: id, sourceState: 'healthy', campaign, universe, seedDigest: 'e'.repeat(64),
    deliveryReport: { sourceState: 'missing', deliveries: [], reasons: [] }, reasons: [] };
}
function compare(a = source('baseline'), b = source('challenger', true)) {
  return buildUniverseCampaignComparison(a, b, END);
}
function delivery(arm: UniverseComparisonArmSource, index: number, branch: string): UniverseDeliveryReceipt {
  const run = arm.universe!.runs[index]!; const trial = run.trials[0]!;
  return { schemaVersion: 1, id: digest(canonical({ domain: 'universe-delivery-v1', universeId: run.universeId, branch })),
    universeId: run.universeId, runId: run.id, trialId: trial.id, niche: trial.niche, manifestDigest: run.manifestDigest,
    comparatorDigest: run.comparatorDigest, artifactDigest: trial.artifact!.digest, repo: arm.universe!.manifest.seed.repo, branch,
    baseCommit: arm.universe!.manifest.seed.revision, commit: 'b'.repeat(40), tree: 'c'.repeat(40),
    changedFiles: ['value.mjs'], status: 'delivered', createdAt: END, completedAt: END };
}

describe('independent Universe comparison projection review', () => {
  it('keeps raw outcomes, recorded-run time and wall-clock span separate without claiming accepted changes', () => {
    const a = source('baseline'); const b = source('challenger', true); const before = canonical([a, b]);
    const report = compare(a, b);
    expect(report.matching.comparable).toBe(true); expect(report.feedbackContrast).toBe('feedback-bundle-v2');
    expect(report.baseline.counts).toMatchObject({ admissions: 1, improvements: 1, distinctSelectedArtifacts: 2 });
    expect(report.baseline.timing).toEqual({ recordedRunDurationMs: 2000, wallSpanMs: 60000 });
    expect(report.baseline.rates.improvementsPerHour).toBe(1800);
    expect(report.baseline.rates.improvementsPerMillionTokens).toBeCloseTo(1_000_000 / 30);
    expect(report.acceptedChanges).toBeNull(); expect(report.baseline.acceptedChanges).toBeNull();
    expect(report).not.toHaveProperty('winner'); expect(report).not.toHaveProperty('savedTokens');
    expect(canonical([a, b])).toBe(before);
  });

  it.each(['run-budget', 'campaign-budget', 'hypothesis', 'model', 'files'] as const)('exposes %s control differences and suppresses score advantage', (kind) => {
    const b = source('challenger', true);
    if (kind === 'run-budget') b.universe!.manifest.budget.trialTimeoutMs++;
    if (kind === 'campaign-budget') b.campaign!.definition.budget.maxStagnantGenerations++;
    if (kind === 'hypothesis') b.universe!.manifest.variants[0]!.hypothesis = 'A different intervention';
    if (kind === 'model') b.universe!.manifest.variants[0]!.generation!.model = 'different-configured-model';
    if (kind === 'files') b.universe!.manifest.variants[0]!.generation!.files.push('another.mjs');
    const report = compare(source('baseline'), b);
    expect(report.matching.configuration).toBe(false); expect(report.matching.comparable).toBe(false);
    expect(report.differences.length).toBeGreaterThan(0);
    expect(report.scoreDeltas.every((delta) => delta.directionAdjustedDelta === null)).toBe(true);
  });

  it('retains descriptive outcomes but does not compare unequal literal comparator digests', () => {
    const b = source('challenger', true);
    b.campaign!.comparatorDigest = 'f'.repeat(64); b.universe!.comparatorDigest = 'f'.repeat(64);
    for (const run of b.universe!.runs) run.comparatorDigest = 'f'.repeat(64);
    const report = compare(source('baseline'), b);
    expect(report.matching.comparator).toBe(false); expect(report.matching.comparable).toBe(false);
    expect(report.challenger.niches[0]!.score).toBe(2); expect(report.scoreDeltas[0]!.directionAdjustedDelta).toBeNull();
  });

  it('distinguishes mixed actual protocols from a stable feedback treatment without hiding measured costs', () => {
    const b = source('challenger', true); const first = b.universe!.runs[0]!;
    delete first.feedbackVersion; delete first.trials[0]!.generation!.search;
    const report = compare(source('baseline'), b);
    expect(report.challenger.feedback.observed).toBe('mixed'); expect(report.feedbackContrast).toBe('other-or-mixed');
    expect(report.matching.comparable).toBe(false); expect(report.scoreDeltas[0]!.directionAdjustedDelta).toBeNull();
    expect(report.challenger.usage.reportedTokens).toBe(30); expect(report.challenger.rates.improvementsPerMillionTokens).toBeCloseTo(1_000_000 / 30);
  });

  it('rejects a configured feedback label that disagrees with the recorded run conditions', () => {
    const b = source('challenger', true); b.campaign!.definition.feedback = false;
    const report = compare(source('baseline'), b);
    expect(report.challenger.sourceState).toBe('degraded'); expect(report.matching.comparable).toBe(false);
  });

  it.each(['attempts', 'completedRuns', 'improvements', 'reservedModelRequests'] as const)('flags drift in projected campaign %s counters', (field) => {
    const b = source('challenger', true); b.campaign!.progress[field]++;
    const report = compare(source('baseline'), b);
    expect(report.challenger.sourceState).toBe('degraded'); expect(report.matching.comparable).toBe(false);
  });

  it('deduplicates delivered artifacts across branches without confusing repeated trial IDs in different runs', () => {
    const b = source('challenger', true);
    b.deliveryReport = { sourceState: 'healthy', reasons: [], deliveries: [delivery(b, 0, 'codex/first'), delivery(b, 0, 'codex/another-first')] };
    const report = compare(source('baseline'), b);
    expect(report.challenger.sourceState).toBe('healthy');
    expect(report.challenger.counts).toMatchObject({ verifiedDeliveryBranches: 2, distinctDeliveredArtifacts: 1 });
    expect(report.challenger.niches[0]!.runId).toBe(RUN_IDS[1]);
  });

  it('withholds all verified delivery counts when any attributed receipt is inconsistent', () => {
    const b = source('challenger', true); const inconsistent = delivery(b, 0, 'codex/inconsistent');
    inconsistent.runId = RUN_IDS[1]!; // Same raw trial ID, different selected occurrence and content.
    b.deliveryReport = { sourceState: 'healthy', reasons: [], deliveries: [delivery(b, 0, 'codex/valid'), inconsistent] };
    const report = compare(source('baseline'), b);
    expect(report.challenger.sourceState).toBe('degraded'); expect(report.matching.comparable).toBe(false);
    expect(report.challenger.counts.verifiedDeliveryBranches).toBeNull(); expect(report.challenger.counts.distinctDeliveredArtifacts).toBeNull();
  });

  it('does not count initial retention of the unchanged seed as a distinct generated artifact', () => {
    const b = source('challenger', true); b.universe!.runs[0]!.trials[0]!.artifact!.digest = b.seedDigest!;
    const report = compare(source('baseline'), b);
    expect(report.challenger.counts.admissions).toBe(1); expect(report.challenger.counts.distinctSelectedArtifacts).toBe(1);
  });

  it('keeps command-only model-token rates unavailable rather than dividing by zero', () => {
    const report = compare(source('baseline', false, true), source('challenger', false, true));
    for (const arm of [report.baseline, report.challenger]) {
      expect(arm.feedback.observed).toBe('unobserved'); expect(arm.counts.modelRequestsStarted).toBe(0);
      expect(arm.rates.improvementsPerMillionTokens).toBeNull(); expect(arm.rates.distinctSelectedArtifactsPerMillionTokens).toBeNull();
      expect(arm.timing.recordedRunDurationMs).toBe(2000);
    }
  });

  it('does not substitute unavailable or degraded sources with a passing empty observation', () => {
    const absent: UniverseComparisonArmSource = { campaignId: 'baseline', sourceState: 'missing', campaign: null,
      universe: null, seedDigest: null, deliveryReport: null, reasons: [] };
    const b = source('challenger', true); b.sourceState = 'degraded'; b.reasons.push('Private fixture diagnostic');
    const report = compare(absent, b);
    expect(report.sourceState).toBe('degraded'); expect(report.matching.comparable).toBe(false);
    expect(report.baseline.sourceState).toBe('missing'); expect(report.baseline.rates.improvementsPerMillionTokens).toBeNull();
    expect(JSON.stringify(report)).not.toContain('Private fixture diagnostic');
  });
});
