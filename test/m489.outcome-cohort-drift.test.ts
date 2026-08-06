import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  adjacentOutcomeCohortWindows,
  buildOutcomeCohortDrift,
  outcomeCohortMergeIdentityKey,
  OUTCOME_COHORT_COST_REGRESSION_ABSOLUTE_USD,
  OUTCOME_COHORT_COST_REGRESSION_RELATIVE_THRESHOLD,
  OUTCOME_COHORT_EXCLUSION_REGRESSION_THRESHOLD,
  OUTCOME_COHORT_OUTCOME_MATURITY_MS,
  privacySafeModelFamily,
  type BuildOutcomeCohortDriftInput,
  type OutcomeCohortMergeIdentity,
  type OutcomeCohortObservation,
} from '../src/core/fleet/outcome-cohort-drift.js';
import { formatFleetStatus } from '../src/cli/fleet.js';
import { projectOutcomeCohortMergeEvidence } from '../src/core/fleet/status.js';

const OBSERVED_AT = '2026-08-13T12:00:00.000Z';
const WINDOWS = adjacentOutcomeCohortWindows(OBSERVED_AT);
const BASELINE_AT = '2026-08-05T18:00:00.000Z';
const CURRENT_AT = '2026-08-06T06:00:00.000Z';
const POLICY_DIGEST = digest(900);

function digest(index: number): string {
  return index.toString(16).padStart(64, '0');
}

function commit(index: number): string {
  return index.toString(16).padStart(40, '0');
}

function addMs(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function mergeIdentity(id: string, occurredAt: string, repoDigest = digest(1)): OutcomeCohortMergeIdentity {
  const numeric = Number(id.replace(/\D/g, '').slice(-8)) || 1;
  return {
    repoDigest,
    proposalId: id,
    mergeCommit: commit(numeric),
    mergedAt: occurredAt,
  };
}

function observation(
  id: string,
  occurredAt: string,
  overrides: Partial<OutcomeCohortObservation> = {},
): OutcomeCohortObservation {
  const repoDigest = overrides.repoDigest ?? digest(Number(id.replace(/\D/g, '').slice(-8)) || 1);
  const identity = overrides.mergeIdentity === undefined
    ? mergeIdentity(id, occurredAt, repoDigest)
    : overrides.mergeIdentity;
  return {
    observationId: id,
    occurredAt,
    projectKind: 'node',
    riskClass: 'low',
    workSource: 'goal',
    engineTier: 'frontier',
    modelFamily: 'codex',
    routerPolicyDigest: POLICY_DIGEST,
    learningEpoch: '2026-08-06',
    repoDigest,
    eligible: true,
    proposalCreated: true,
    verificationPassed: true,
    mergeIdentity: identity,
    postMergeOutcome: 'stable',
    outcomeObservedAt: identity ? addMs(identity.mergedAt, OUTCOME_COHORT_OUTCOME_MATURITY_MS) : null,
    costUsd: 1,
    ...overrides,
  };
}

function input(
  observations: OutcomeCohortObservation[],
  overrides: Partial<BuildOutcomeCohortDriftInput> = {},
): BuildOutcomeCohortDriftInput {
  return {
    observations,
    source: {
      sourceState: 'healthy',
      complete: true,
      stopReasons: [],
      snapshotAt: OBSERVED_AT,
      pendingProtectedMerges: 0,
    },
    observedAt: OBSERVED_AT,
    windows: WINDOWS,
    minimumSample: 5,
    selectionPropensityAvailable: false,
    ...overrides,
  };
}

function paired(count = 5): OutcomeCohortObservation[] {
  return Array.from({ length: count }, (_, index) => [
    observation(`baseline-${index + 1}`, BASELINE_AT, { repoDigest: digest(index + 1) }),
    observation(`current-${index + 101}`, CURRENT_AT, { repoDigest: digest(index + 1) }),
  ]).flat();
}

function exclude(id: string, occurredAt: string): OutcomeCohortObservation {
  return observation(id, occurredAt, {
    eligible: false,
    exclusionReason: 'ineligible',
    proposalCreated: false,
    verificationPassed: false,
    mergeIdentity: null,
    postMergeOutcome: 'not-merged',
    outcomeObservedAt: null,
    costUsd: 0,
  });
}

describe('M489 outcome cohort drift sentinel', () => {
  it('uses adjacent 12h decision windows that are exactly seven days mature', () => {
    expect(WINDOWS).toEqual({
      baseline: {
        startedAt: '2026-08-05T12:00:00.000Z',
        endedAt: '2026-08-06T00:00:00.000Z',
      },
      current: {
        startedAt: '2026-08-06T00:00:00.000Z',
        endedAt: '2026-08-06T12:00:00.000Z',
      },
    });
    expect(Date.parse(OBSERVED_AT) - Date.parse(WINDOWS.current.endedAt))
      .toBe(OUTCOME_COHORT_OUTCOME_MATURITY_MS);
  });

  it('reconciles every mature attempt into one member per declared dimension', () => {
    const result = buildOutcomeCohortDrift(input(paired()));

    expect(result).toMatchObject({
      verdict: 'stable',
      authority: {
        mode: 'observation-only',
        mutationEligible: false,
        routingEligible: false,
        mergeEligible: false,
        learningEligible: false,
        rollbackEligible: false,
        deploymentEligible: false,
        readinessEligible: false,
      },
      claim: {
        basis: 'descriptive-only',
        selectionPropensityAvailable: false,
        causalClaimEligible: false,
      },
      maturity: {
        minimumAgeMs: OUTCOME_COHORT_OUTCOME_MATURITY_MS,
        pendingProtectedMerges: 0,
        withheldMatureMerges: 0,
      },
      denominatorQuality: {
        state: 'complete',
        observed: 10,
        eligible: 10,
        excluded: 0,
        expectedMemberships: 60,
        actualMemberships: 60,
        dimensions: 6,
      },
    });
    expect(result.highestRiskCohort?.current).toMatchObject({
      proposalYield: 1,
      verificationRate: 1,
      protectedMergeRate: 1,
      adversePostMergeRate: 0,
      exclusionRate: 0,
      costToStableMergeUsd: 1,
      postMergeDenominatorState: 'complete',
    });
  });

  it('keeps recent unripe merges pending without withholding unrelated funnel metrics', () => {
    const observations = paired();
    const pendingMerge = mergeIdentity('current-101', addMs(OBSERVED_AT, -60 * 60 * 1_000), digest(1));
    observations[1] = observation('current-101', CURRENT_AT, {
      repoDigest: digest(1),
      mergeIdentity: pendingMerge,
      postMergeOutcome: 'pending',
      outcomeObservedAt: null,
    });

    const result = buildOutcomeCohortDrift(input(observations, {
      source: { ...input([]).source, pendingProtectedMerges: 1 },
    }));
    const current = result.comparisons.find((row) => row.dimension === 'risk-class')?.current;

    expect(result.verdict).toBe('stable');
    expect(result.maturity.pendingProtectedMerges).toBe(1);
    expect(current).toMatchObject({
      proposalYield: 1,
      verificationRate: 1,
      protectedMergeRate: 1,
      pendingPostMerge: 1,
      postMergeDenominatorState: 'pending',
      adversePostMergeRate: null,
      costToStableMergeUsd: null,
    });
  });

  it('accepts stability exactly at maturity and rejects it one millisecond early', () => {
    const exact = observation('exact-boundary', CURRENT_AT, {
      repoDigest: digest(77),
      mergeIdentity: mergeIdentity('exact-boundary', CURRENT_AT, digest(77)),
      outcomeObservedAt: addMs(CURRENT_AT, OUTCOME_COHORT_OUTCOME_MATURITY_MS),
    });
    expect(buildOutcomeCohortDrift(input([
      observation('exact-baseline', BASELINE_AT, { repoDigest: digest(77) }),
      exact,
    ], { minimumSample: 1 })).verdict).toBe('stable');

    const early = { ...exact, observationId: 'early-boundary', outcomeObservedAt: addMs(
      CURRENT_AT,
      OUTCOME_COHORT_OUTCOME_MATURITY_MS - 1,
    ) };
    const rejected = buildOutcomeCohortDrift(input([
      observation('early-baseline', BASELINE_AT, { repoDigest: digest(77) }),
      early,
    ], { minimumSample: 1 }));
    expect(rejected.verdict).toBe('withheld');
    expect(rejected.denominatorQuality.stopReasons).toContain('post-merge-stability-immature');
  });

  it('keeps mature missing evidence local to the affected cohort', () => {
    const observations = paired();
    observations[1] = observation('current-101', CURRENT_AT, {
      repoDigest: digest(1),
      postMergeOutcome: 'withheld',
      outcomeObservedAt: null,
    });

    const result = buildOutcomeCohortDrift(input(observations));
    const current = result.comparisons.find((row) => row.dimension === 'risk-class')?.current;
    expect(result.denominatorQuality.state).toBe('complete');
    expect(result.verdict).toBe('insufficient-sample');
    expect(result.maturity.withheldMatureMerges).toBe(1);
    expect(current).toMatchObject({
      withheldPostMerge: 1,
      postMergeDenominatorState: 'withheld',
      adversePostMergeRate: null,
      costToStableMergeUsd: null,
    });
  });

  it('ranks sampled confirmed adverse evidence ahead of larger undersampled alerts', () => {
    const observations = paired();
    observations[1]!.postMergeOutcome = 'adverse';
    observations[1]!.outcomeObservedAt = addMs(CURRENT_AT, 1_000);
    for (const index of [98, 99]) {
      const common = {
        projectKind: 'python' as const,
        riskClass: 'high' as const,
        workSource: 'issue' as const,
        engineTier: 'local' as const,
        modelFamily: 'local' as const,
        routerPolicyDigest: digest(700),
        learningEpoch: '2026-08-05',
        repoDigest: digest(700),
      };
      observations.push(
        observation(`baseline-high-${index}`, BASELINE_AT, common),
        observation(`current-high-${index}`, CURRENT_AT, {
          ...common,
          postMergeOutcome: 'adverse',
          outcomeObservedAt: addMs(CURRENT_AT, 1_000),
        }),
      );
    }

    const result = buildOutcomeCohortDrift(input(observations));
    expect(result.verdict).toBe('adverse-observed');
    expect(result.highestRiskCohort?.sampleState).toBe('observed');
    expect(result.highestRiskCohort?.current?.adversePostMerge).toBeGreaterThan(0);
    expect(result.comparisons.some((row) =>
      row.sampleState === 'insufficient-sample' && (row.current?.adversePostMerge ?? 0) > 0,
    )).toBe(true);
  });

  it('does not promote an undersampled adverse cohort into an adverse claim', () => {
    const observations = paired(10);
    const isolated = {
      projectKind: 'python' as const,
      riskClass: 'high' as const,
      workSource: 'issue' as const,
      engineTier: 'local' as const,
      modelFamily: 'local' as const,
      routerPolicyDigest: digest(701),
      learningEpoch: '2026-08-05',
      repoDigest: digest(999),
    };
    observations.push(
      observation('baseline-high-999', BASELINE_AT, isolated),
      observation('current-high-999', CURRENT_AT, {
        ...isolated,
        postMergeOutcome: 'adverse',
        outcomeObservedAt: addMs(CURRENT_AT, 1_000),
      }),
    );
    const result = buildOutcomeCohortDrift(input(observations));
    expect(result.verdict).toBe('insufficient-sample');
    expect(result.highestRiskCohort).toMatchObject({
      dimension: 'risk-class', cohort: 'high', sampleState: 'insufficient-sample',
    });
    expect(result.summary).toContain('no drift, adverse, disparity, or superiority claim');
  });

  it('detects material cost-to-stable-merge regression with explicit thresholds', () => {
    const observations = paired();
    for (const row of observations.filter((candidate) => candidate.occurredAt === CURRENT_AT)) row.costUsd = 100;
    const result = buildOutcomeCohortDrift(input(observations));

    expect(result.verdict).toBe('drift-observed');
    expect(result.thresholds).toMatchObject({
      costToStableMergeAbsoluteUsd: OUTCOME_COHORT_COST_REGRESSION_ABSOLUTE_USD,
      costToStableMergeRelative: OUTCOME_COHORT_COST_REGRESSION_RELATIVE_THRESHOLD,
    });
    expect(result.highestRiskCohort?.drift.costToStableMergeUsd).toBe(99);
    expect(result.highestRiskCohort?.drift.costToStableMergeRelative).toBe(99);
  });

  it('handles a zero cost baseline without Infinity or a false stable verdict', () => {
    const observations = paired();
    for (const row of observations.filter((candidate) => candidate.occurredAt === BASELINE_AT)) row.costUsd = 0;
    for (const row of observations.filter((candidate) => candidate.occurredAt === CURRENT_AT)) row.costUsd = 2;
    const result = buildOutcomeCohortDrift(input(observations));

    expect(result.verdict).toBe('drift-observed');
    expect(result.highestRiskCohort?.drift.costToStableMergeRelative).toBeNull();
    expect(JSON.stringify(result)).not.toContain('Infinity');
  });

  it('detects a material exclusion-rate regression', () => {
    const observations = paired();
    for (let index = 0; index < 20; index++) observations.push(exclude(`excluded-${index}`, CURRENT_AT));
    const result = buildOutcomeCohortDrift(input(observations));

    expect(result.verdict).toBe('drift-observed');
    expect(result.thresholds.exclusionRateRegression).toBe(OUTCOME_COHORT_EXCLUSION_REGRESSION_THRESHOLD);
    expect(result.highestRiskCohort?.baseline?.exclusionRate).toBe(0);
    expect(result.highestRiskCohort?.current?.exclusionRate).toBe(0.8);
    expect(result.highestRiskCohort?.drift.exclusionRate).toBe(0.8);
  });

  it('compares the union of baseline and current keys', () => {
    const observations = Array.from({ length: 5 }, (_, index) => [
      observation(`baseline-union-${index}`, BASELINE_AT, { riskClass: 'high', repoDigest: digest(1) }),
      observation(`current-union-${index}`, CURRENT_AT, { riskClass: 'low', repoDigest: digest(1) }),
    ]).flat();
    const result = buildOutcomeCohortDrift(input(observations));
    const risk = result.comparisons.filter((row) => row.dimension === 'risk-class');

    expect(risk.map((row) => row.cohort).sort()).toEqual(['high', 'low']);
    expect(risk.find((row) => row.cohort === 'high')).toMatchObject({
      current: null, sampleState: 'insufficient-sample',
    });
    expect(risk.find((row) => row.cohort === 'low')).toMatchObject({
      baseline: null, sampleState: 'insufficient-sample',
    });
    expect(result.denominatorQuality).toMatchObject({ expectedMemberships: 60, actualMemberships: 60 });
    expect(result.verdict).toBe('insufficient-sample');
  });

  it('never compares across a different policy digest or learning epoch', () => {
    for (const mismatch of ['policy', 'epoch'] as const) {
      const observations = paired();
      for (const row of observations.filter((candidate) => candidate.occurredAt === BASELINE_AT)) {
        if (mismatch === 'policy') row.routerPolicyDigest = digest(901);
        else row.learningEpoch = '2026-08-05';
      }
      const result = buildOutcomeCohortDrift(input(observations));
      expect(result.comparisons.every((row) =>
        row.sampleState === 'insufficient-sample' && (row.baseline === null || row.current === null),
      )).toBe(true);
      expect(new Set(result.comparisons.map((row) => row.dimension))).toEqual(new Set([
        'project-kind', 'risk-class', 'work-source', 'engine-tier-model-family',
        'router-policy-learning-epoch', 'repo-digest',
      ]));
    }
  });

  it('keeps repository, proposal, and commit in the exact merge identity', () => {
    const repoACommitA = mergeIdentity('shared-proposal', CURRENT_AT, digest(1));
    const repoBCommitA = { ...repoACommitA, repoDigest: digest(2) };
    const repoACommitB = { ...repoACommitA, mergeCommit: commit(2) };
    expect(outcomeCohortMergeIdentityKey(repoACommitA)).not.toBe(outcomeCohortMergeIdentityKey(repoBCommitA));
    expect(outcomeCohortMergeIdentityKey(repoACommitA)).not.toBe(outcomeCohortMergeIdentityKey(repoACommitB));

    const result = buildOutcomeCohortDrift(input([
      observation('collision-baseline', BASELINE_AT, {
        repoDigest: digest(1),
        mergeIdentity: { ...repoACommitA, mergedAt: BASELINE_AT },
        outcomeObservedAt: addMs(BASELINE_AT, OUTCOME_COHORT_OUTCOME_MATURITY_MS),
      }),
      observation('collision-current', CURRENT_AT, {
        repoDigest: digest(2),
        mergeIdentity: repoBCommitA,
        outcomeObservedAt: addMs(CURRENT_AT, OUTCOME_COHORT_OUTCOME_MATURITY_MS),
      }),
    ], { minimumSample: 1 }));
    expect(result.verdict).not.toBe('withheld');
  });

  it('reconciles colliding proposal ids by exact repo and commit without cross-attribution', () => {
    const projectionType = {} as Parameters<typeof projectOutcomeCohortMergeEvidence>[0]['projection'];
    const projection = {
      ...projectionType,
      sourceComplete: true,
      denominatorComplete: true,
      protectedMerges: 2,
      observedMerges: 2,
      unmatchedMerges: 0,
      stopReasons: [],
      matchedAdverse: [{ repo: '/repo/a', proposalId: 'same', mergeCommit: commit(1), observedAt: OBSERVED_AT }],
      matchedStability: [{
        repoDigest: digest(2), proposalId: 'same', mergeCommit: commit(2), stableAt: OBSERVED_AT,
      }],
    } as unknown as Parameters<typeof projectOutcomeCohortMergeEvidence>[0]['projection'];
    const result = projectOutcomeCohortMergeEvidence({
      population: {
        merges: [
          { repo: '/repo/a', proposalId: 'same', mergeCommit: commit(1), mergedAt: CURRENT_AT },
          { repo: '/repo/b', proposalId: 'same', mergeCommit: commit(2), mergedAt: CURRENT_AT },
        ],
        sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [], capturedAt: OBSERVED_AT,
      },
      projection,
      observedAt: OBSERVED_AT,
    }, {
      repoDigest: (repo) => repo === '/repo/a' ? digest(1) : repo === '/repo/b' ? digest(2) : null,
    });

    expect(result.invalidIdentities).toBe(0);
    expect(result.ambiguousRepoProposalKeys).toEqual([]);
    expect(result.resolutions).toEqual(expect.arrayContaining([
      expect.objectContaining({ identity: expect.objectContaining({ repoDigest: digest(1), mergeCommit: commit(1) }), outcome: 'adverse' }),
      expect.objectContaining({ identity: expect.objectContaining({ repoDigest: digest(2), mergeCommit: commit(2) }), outcome: 'stable' }),
    ]));
  });

  it('marks same-repo same-proposal different-commit populations ambiguous', () => {
    const projection = {
      sourceComplete: true, denominatorComplete: false, protectedMerges: 2, observedMerges: 0,
      unmatchedMerges: 2, matchedAdverse: [], matchedStability: [], stopReasons: [],
    } as unknown as Parameters<typeof projectOutcomeCohortMergeEvidence>[0]['projection'];
    const result = projectOutcomeCohortMergeEvidence({
      population: {
        merges: [
          { repo: '/repo/a', proposalId: 'same', mergeCommit: commit(1), mergedAt: CURRENT_AT },
          { repo: '/repo/a', proposalId: 'same', mergeCommit: commit(2), mergedAt: CURRENT_AT },
        ],
        sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [], capturedAt: OBSERVED_AT,
      },
      projection,
      observedAt: OBSERVED_AT,
    }, { repoDigest: () => digest(1) });
    expect(result.ambiguousRepoProposalKeys).toHaveLength(1);
    expect(new Set(result.resolutions.map((row) => row.identity.mergeCommit))).toEqual(new Set([commit(1), commit(2)]));
  });

  it.each([
    ['missing source', (base: BuildOutcomeCohortDriftInput) => ({
      ...base, source: { ...base.source, sourceState: 'missing' as const, complete: false },
    }), 'missing-source'],
    ['degraded source', (base: BuildOutcomeCohortDriftInput) => ({
      ...base, source: { ...base.source, sourceState: 'degraded' as const, complete: false },
    }), 'degraded-source'],
    ['stale source', (base: BuildOutcomeCohortDriftInput) => ({
      ...base, source: { ...base.source, snapshotAt: addMs(OBSERVED_AT, -60 * 60 * 1_000) },
    }), 'snapshot-stale'],
    ['unmatured windows', (base: BuildOutcomeCohortDriftInput) => ({
      ...base,
      windows: adjacentOutcomeCohortWindows(OBSERVED_AT, 12 * 60 * 60 * 1_000, 24 * 60 * 60 * 1_000),
    }), 'window-reconciliation-failed'],
  ])('withholds %s instead of publishing a healthy zero', (_name, mutate, reason) => {
    const result = buildOutcomeCohortDrift(mutate(input(paired())));
    expect(result).toMatchObject({
      verdict: 'withheld',
      denominatorQuality: { state: 'withheld', actualMemberships: 0 },
      comparisons: [],
      highestRiskCohort: null,
    });
    expect(result.denominatorQuality.stopReasons).toContain(reason);
  });

  it('withholds duplicate, missing, degraded, and malformed funnel observations', () => {
    const duplicate = paired();
    duplicate[1]!.observationId = duplicate[0]!.observationId;
    expect(buildOutcomeCohortDrift(input(duplicate)).denominatorQuality.stopReasons)
      .toContain('duplicate-observation');

    const missing = paired();
    missing[0]!.riskClass = null;
    expect(buildOutcomeCohortDrift(input(missing)).denominatorQuality.stopReasons)
      .toContain('risk-class-missing');

    const degraded = paired();
    degraded[0]!.eligible = false;
    degraded[0]!.exclusionReason = 'degraded';
    expect(buildOutcomeCohortDrift(input(degraded)).denominatorQuality.stopReasons)
      .toContain('degraded-observation');

    const invalidFunnel = paired();
    invalidFunnel[0]!.proposalCreated = false;
    expect(buildOutcomeCohortDrift(input(invalidFunnel)).denominatorQuality.stopReasons)
      .toContain('verification-funnel-invalid');
  });

  it('accepts only closed cohort labels and never emits rejected raw text', () => {
    const rawTenant = 'tenant-acme-prod-private';
    const invalidLabels: Array<{
      reason: string;
      mutate: (row: OutcomeCohortObservation) => void;
    }> = [
      {
        reason: 'project-kind-missing',
        mutate: (row) => { row.projectKind = rawTenant as unknown as OutcomeCohortObservation['projectKind']; },
      },
      {
        reason: 'work-source-missing',
        mutate: (row) => { row.workSource = rawTenant as unknown as OutcomeCohortObservation['workSource']; },
      },
      {
        reason: 'model-family-missing',
        mutate: (row) => { row.modelFamily = rawTenant as unknown as OutcomeCohortObservation['modelFamily']; },
      },
      {
        reason: 'router-policy-digest-missing',
        mutate: (row) => { row.routerPolicyDigest = rawTenant; },
      },
    ];
    for (const invalidLabel of invalidLabels) {
      const invalid = paired();
      invalidLabel.mutate(invalid[0]!);
      const labelResult = buildOutcomeCohortDrift(input(invalid));
      expect(labelResult.verdict).toBe('withheld');
      expect(labelResult.denominatorQuality.stopReasons).toContain(invalidLabel.reason);
      expect(JSON.stringify(labelResult)).not.toContain(rawTenant);
    }

    const reasonResult = buildOutcomeCohortDrift(input(paired(), {
      source: { ...input([]).source, stopReasons: ['/Users/mason/private/raw-prompt'] },
    }));
    const reasonSerialized = JSON.stringify(reasonResult);
    expect(reasonResult.denominatorQuality.stopReasons).toContain('source-stop-reason-invalid');
    expect(reasonSerialized).not.toContain('/Users/mason');
    expect(reasonSerialized).not.toContain('raw-prompt');
  });

  it('coarsens model identities to closed privacy-safe families', () => {
    expect(privacySafeModelFamily({ backend: 'claude', model: 'private-model-id' })).toBe('claude');
    expect(privacySafeModelFamily({ backend: 'nim', model: 'moonshotai/kimi-k2' })).toBe('kimi');
    expect(privacySafeModelFamily({ backend: 'codex', model: 'private-model-id' })).toBe('codex');
    expect(privacySafeModelFamily({ backend: 'custom', model: 'secret-model-name', tier: 'local' })).toBe('local');
    expect(privacySafeModelFamily({ backend: 'custom', model: 'secret-model-name', tier: 'mid' })).toBe('other');
  });

  it('surfaces maturity, denominator quality, highest risk, and next action in CLI and Fleet OS', () => {
    const result = buildOutcomeCohortDrift(input(paired()));
    const cli = formatFleetStatus({
      generatedAt: OBSERVED_AT,
      daemon: { running: false, lastTickAt: null, todaySpentUsd: 0 },
      backends: [],
      queue: { backlogItems: 0 },
      proposals: { pending: 0, frontierPending: 0, applied: 0 },
      merges: { recent: 0 },
      outcomeCohortDrift: result,
      killed: false,
    });
    expect(cli).toContain('Outcome cohort drift:');
    expect(cli).toContain('complete');
    expect(cli).toContain('7d');
    expect(cli).toContain('0 pending');
    expect(cli).toContain('cost +25% and $1.00');
    expect(cli).toContain('highest:');
    expect(cli).toContain('cost/stable $1.0000');

    const root = join(dirname(fileURLToPath(import.meta.url)), '../src/core/web/public');
    const app = readFileSync(join(root, 'app.js'), 'utf8');
    expect(app).toContain('function renderOutcomeCohortDriftCard(drift');
    expect(app).toContain("['Maturity'");
    expect(app).toContain("['Thresholds'");
    expect(app).toContain("['Outcome evidence'");
    expect(app).toContain('f.outcomeCohortDrift');
    expect(app).toContain('d.fleet?.outcomeCohortDrift ?? fleet.outcomeCohortDrift ?? null');
  });
});
