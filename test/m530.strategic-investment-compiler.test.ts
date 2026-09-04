import { describe, expect, it } from 'vitest';

import type { StrategicBriefing } from '../src/core/vision/strategist.js';
import {
  compileStrategicInvestmentsV1,
  strategicBriefingDigestV1,
  type StrategicInvestmentCompilerInputV1,
  type StrategicInvestmentEstimateV1,
} from '../src/core/vision/strategic-investment-compiler.js';
import {
  acceptanceContractDigestV1,
  verifyValueHypothesisV1,
} from '../src/core/vision/value-portfolio.js';

const sha = (character: string): string => character.repeat(64);
const SPEC = sha('a');
const MISSION = sha('b');

function goal(key: string) {
  return {
    key,
    objective: `Build the ${key} product capability`,
    rationale: 'It improves user value and creates reusable product IP.',
    specPriority: 'Customer value',
    targetRepo: 'ashlr-hub',
    dependsOn: [] as string[],
    deliverable: `A verified ${key} capability`,
    acceptanceEvidence: ['Frozen outcome receipt'],
    riskClass: 'medium' as const,
    humanGate: false,
    outcome: {
      desiredOutcome: `${key} increases retained user value`,
      successSignals: ['The frozen retained-value threshold is met'],
      guardrails: ['No unauthorized outward effect'],
    },
  };
}

function briefing(keys = ['first-bet', 'second-bet']): StrategicBriefing {
  return {
    generatedAt: '2026-09-03T12:00:00.000Z',
    project: 'ashlr-hub',
    currentState: 'Product outcome evidence is available but not yet joined to strategy.',
    gapToVision: 'The current bottleneck is explicit strategy-to-investment compilation.',
    proposedEvolution: {},
    recommendedDirection: ['Compile the highest-value falsifiable product bets.'],
    newProblems: [],
    questionsForMason: [],
    proposedGoals: keys.map(goal),
  };
}

function estimate(key: string, seed = '1'): StrategicInvestmentEstimateV1 {
  const acceptanceContract = {
    baselineDigest: sha('6'),
    metric: 'retained-user-value',
    unit: 'index-points',
    direction: 'increase' as const,
    effectiveThreshold: 20,
    refutationThreshold: 5,
    windowStart: '2026-09-03T12:00:00.000Z',
    windowEnd: '2026-09-10T12:00:00.000Z',
    minimumCausalGrade: 'quasi-experimental' as const,
  };
  const acceptanceContractDigest = acceptanceContractDigestV1(acceptanceContract);
  if (!acceptanceContractDigest) throw new Error('expected acceptance contract digest');
  return {
    missionNodeKey: key,
    producerDigest: sha('d'),
    constraints: {
      dependenciesSatisfied: true,
      reversible: true,
      allowedProviders: ['codex', 'claude', 'local'],
      shardable: false,
      shardPlanDigest: null,
    },
    acceptanceContract: {
      acceptanceContractDigest,
      ...acceptanceContract,
    },
    budget: {
      maxTokens: 120_000,
      maxMinutes: 240,
      maxAttempts: 4,
      maxInconclusiveWindows: 2,
      spentTokens: 0,
      spentMinutes: 0,
      attempts: 0,
      inconclusiveWindows: 0,
      deadline: '2026-09-12T12:00:00.000Z',
      minimumMarginalValue: 0.08,
    },
    factors: {
      productImpact: 0.9,
      informationGain: 0.75,
      strategicLeverage: 0.85,
      ipLeverage: 0.8,
      dependencyUnlock: 0.6,
      probability: 0.7,
      risk: 0.25,
      uncertainty: 0.35,
      estimatedTokens: 24_000,
      estimatedMinutes: 40,
      factorSourceDigest: sha(seed),
    },
    outcomeSource: {
      complete: true,
      sourceDigest: sha('e'),
      evidence: null,
    },
  };
}

function input(
  strategicBriefing = briefing(),
  estimates = strategicBriefing.proposedGoals.map((entry, index) => estimate(entry.key!, String(index + 1))),
): StrategicInvestmentCompilerInputV1 {
  const digest = strategicBriefingDigestV1(strategicBriefing);
  return {
    schemaVersion: 1,
    briefing: strategicBriefing,
    briefingSource: { complete: true, digest: digest ?? sha('f') },
    specDigest: SPEC,
    missionGraphDigest: MISSION,
    estimates,
  };
}

describe('M530 strict strategic investment compiler', () => {
  it('deterministically joins each modern work goal to exactly one numeric contract', () => {
    const source = input();
    const forward = compileStrategicInvestmentsV1(source);
    const reversed = compileStrategicInvestmentsV1({
      ...source,
      estimates: [...source.estimates].reverse(),
    });

    expect(forward.ok).toBe(true);
    expect(reversed).toEqual(forward);
    if (!forward.ok) throw new Error('expected hypotheses');
    expect(forward.hypotheses.map((entry) => entry.missionNodeKey)).toEqual(['first-bet', 'second-bet']);
    expect(forward.hypotheses.every((entry) => verifyValueHypothesisV1(entry) !== null)).toBe(true);
    expect(forward.hypotheses[0]).toMatchObject({
      specDigest: SPEC,
      missionDigest: MISSION,
      missionNodeKey: 'first-bet',
      claim: 'first-bet increases retained user value',
      factors: { probability: 0.7, estimatedTokens: 24_000, factorSourceDigest: sha('1') },
      frozenOutcome: {
        acceptanceContractDigest: source.estimates[0]!.acceptanceContract.acceptanceContractDigest,
        baselineDigest: sha('6'), effectiveThreshold: 20,
      },
      constraints: { humanGateRequired: false, allowedProviders: ['claude', 'codex', 'local'] },
    });
  });

  it('never infers missing or prose-shaped thresholds, probability, cost, or value', () => {
    const source = input(briefing(['one-bet']), [estimate('one-bet')]);
    const malformed = {
      ...source.estimates[0]!,
      factors: { ...source.estimates[0]!.factors, probability: 'very likely' },
    };
    const missingThreshold = {
      ...source.estimates[0]!,
      acceptanceContract: {
        ...source.estimates[0]!.acceptanceContract,
        effectiveThreshold: undefined,
      },
    };

    expect(compileStrategicInvestmentsV1({ ...source, estimates: [malformed] }))
      .toMatchObject({ ok: false, hypotheses: [], issues: ['hypothesis-rejected'] });
    expect(compileStrategicInvestmentsV1({ ...source, estimates: [missingThreshold] }))
      .toMatchObject({ ok: false, hypotheses: [], issues: ['hypothesis-rejected'] });
  });

  it('fails closed on legacy mission keys, human gates, and more than three goals', () => {
    const legacy = briefing(['legacy-bet']);
    delete legacy.proposedGoals[0]!.key;
    const gated = briefing(['approval']);
    gated.proposedGoals[0] = { ...gated.proposedGoals[0]!, humanGate: true, targetRepo: null };
    const tooMany = briefing(['one', 'two', 'three', 'four']);

    expect(compileStrategicInvestmentsV1(input(legacy, [estimate('legacy-bet')])))
      .toMatchObject({ ok: false, issues: ['legacy-mission-key'] });
    expect(compileStrategicInvestmentsV1(input(gated, [estimate('approval')])))
      .toMatchObject({ ok: false, issues: ['human-gate-node'] });
    expect(compileStrategicInvestmentsV1(input(tooMany)))
      .toMatchObject({ ok: false, issues: ['goal-cap'] });
  });

  it('rejects duplicate, missing, and unmatched estimate sets as a whole', () => {
    const strategicBriefing = briefing();
    expect(compileStrategicInvestmentsV1(input(strategicBriefing, [estimate('first-bet')])))
      .toMatchObject({ ok: false, issues: ['missing-estimate'] });
    expect(compileStrategicInvestmentsV1(input(strategicBriefing, [
      estimate('first-bet'), estimate('first-bet', '2'),
    ]))).toMatchObject({ ok: false, issues: ['duplicate-estimate'] });
    expect(compileStrategicInvestmentsV1(input(strategicBriefing, [
      estimate('first-bet'), estimate('not-in-briefing', '2'),
    ]))).toMatchObject({ ok: false, issues: ['unmatched-estimate'] });
  });

  it('requires a complete briefing source whose digest matches the exact briefing', () => {
    const source = input();
    expect(compileStrategicInvestmentsV1({
      ...source,
      briefingSource: { ...source.briefingSource, complete: false },
    })).toMatchObject({ ok: false, issues: ['briefing-source-incomplete'] });
    expect(compileStrategicInvestmentsV1({
      ...source,
      briefingSource: { complete: true, digest: sha('9') },
    })).toMatchObject({ ok: false, issues: ['briefing-digest-mismatch'] });
    expect(compileStrategicInvestmentsV1({ ...source, specDigest: 'not-a-digest' }))
      .toMatchObject({ ok: false, issues: ['invalid-input'] });
  });

  it('derives the complete acceptance contract digest and rejects threshold replay', () => {
    const strategicBriefing = briefing(['one-bet']);
    const contract = estimate('one-bet');
    const replay = {
      ...contract,
      acceptanceContract: { ...contract.acceptanceContract, effectiveThreshold: 10 },
    };

    expect(compileStrategicInvestmentsV1(input(strategicBriefing, [replay])))
      .toMatchObject({ ok: false, hypotheses: [], issues: ['hypothesis-rejected'] });

    const weakenedContract = {
      ...contract.acceptanceContract,
      effectiveThreshold: 10,
    };
    const { acceptanceContractDigest: _oldDigest, ...weakenedPayload } = weakenedContract;
    const weakenedDigest = acceptanceContractDigestV1(weakenedPayload);
    if (!weakenedDigest) throw new Error('expected weakened contract digest');
    const receiptReplay = {
      ...contract,
      acceptanceContract: { ...weakenedContract, acceptanceContractDigest: weakenedDigest },
      outcomeSource: {
        complete: true,
        sourceDigest: sha('e'),
        evidence: {
          verification: 'preverified-outcome-v1' as const,
          observerDigest: sha('f'),
          receiptDigest: sha('2'),
          artifactDigest: sha('3'),
          deploymentDigest: sha('4'),
          baselineDigest: contract.acceptanceContract.baselineDigest,
          acceptanceContractDigest: contract.acceptanceContract.acceptanceContractDigest,
          metric: contract.acceptanceContract.metric,
          value: 15,
          observedAt: contract.acceptanceContract.windowEnd,
          windowStart: contract.acceptanceContract.windowStart,
          windowEnd: contract.acceptanceContract.windowEnd,
          causalGrade: 'quasi-experimental' as const,
          guardrailBreached: false,
        },
      },
    };
    expect(compileStrategicInvestmentsV1(input(strategicBriefing, [receiptReplay])))
      .toMatchObject({ ok: false, hypotheses: [], issues: ['hypothesis-rejected'] });
    expect(compileStrategicInvestmentsV1(input(strategicBriefing, [contract]))).toMatchObject({ ok: true });
  });

  it('binds the exact briefing and mission-node contract into hypothesis provenance', () => {
    const firstBriefing = briefing(['one-bet']);
    const secondBriefing = briefing(['one-bet']);
    secondBriefing.proposedGoals[0] = {
      ...secondBriefing.proposedGoals[0]!,
      targetRepo: 'phantom-secrets',
      deliverable: 'A different verified capability',
      acceptanceEvidence: ['A different executable receipt'],
    };
    const first = compileStrategicInvestmentsV1(input(firstBriefing, [estimate('one-bet')]));
    const second = compileStrategicInvestmentsV1(input(secondBriefing, [estimate('one-bet')]));

    if (!first.ok || !second.ok) throw new Error('expected hypotheses');
    expect(first.hypotheses[0]!.provenanceDigest).not.toBe(second.hypotheses[0]!.provenanceDigest);
    expect(first.hypotheses[0]!.hypothesisId).not.toBe(second.hypotheses[0]!.hypothesisId);
  });

  it('rejects unsafe public text before any hypothesis can expose it', () => {
    const unsafePath = briefing(['one-bet']);
    unsafePath.proposedGoals[0] = {
      ...unsafePath.proposedGoals[0]!,
      outcome: { ...unsafePath.proposedGoals[0]!.outcome!, desiredOutcome: 'Read /Users/operator/private/config' },
    };
    const unsafeSecret = briefing(['one-bet']);
    unsafeSecret.currentState = 'The access_token=super-secret-value is present.';

    expect(compileStrategicInvestmentsV1(input(unsafePath, [estimate('one-bet')])))
      .toMatchObject({ ok: false, hypotheses: [], issues: ['invalid-briefing'] });
    expect(compileStrategicInvestmentsV1(input(unsafeSecret, [estimate('one-bet')])))
      .toMatchObject({ ok: false, hypotheses: [], issues: ['invalid-briefing'] });

    const unsafeEstimate = estimate('one-bet');
    unsafeEstimate.acceptanceContract.metric = 'path:/Users/operator/private/config';
    unsafeEstimate.acceptanceContract.unit = 'access_token=dummy-secret-value';
    expect(compileStrategicInvestmentsV1(input(briefing(['one-bet']), [unsafeEstimate])))
      .toMatchObject({ ok: false, hypotheses: [], issues: ['invalid-estimate'] });
  });

  it('rejects empty evidence contracts, dependency cycles, and deadlines before the outcome window', () => {
    for (const field of ['acceptanceEvidence', 'successSignals', 'guardrails'] as const) {
      const incomplete = briefing(['one-bet']);
      if (field === 'acceptanceEvidence') incomplete.proposedGoals[0]!.acceptanceEvidence = [];
      else incomplete.proposedGoals[0]!.outcome![field] = [];
      expect(compileStrategicInvestmentsV1(input(incomplete, [estimate('one-bet')])))
        .toMatchObject({ ok: false, hypotheses: [] });
    }

    const cyclic = briefing(['first-bet', 'second-bet']);
    cyclic.proposedGoals[0]!.dependsOn = ['second-bet'];
    cyclic.proposedGoals[1]!.dependsOn = ['first-bet'];
    expect(compileStrategicInvestmentsV1(input(cyclic)))
      .toMatchObject({ ok: false, hypotheses: [], issues: ['invalid-briefing'] });

    const impossible = estimate('one-bet');
    impossible.budget.deadline = '2026-09-09T12:00:00.000Z';
    expect(compileStrategicInvestmentsV1(input(briefing(['one-bet']), [impossible])))
      .toMatchObject({ ok: false, hypotheses: [], issues: ['hypothesis-rejected'] });
  });

  it('rejects non-finite numeric contracts', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const contract = estimate('one-bet');
      contract.factors.probability = value;
      expect(compileStrategicInvestmentsV1(input(briefing(['one-bet']), [contract])))
        .toMatchObject({ ok: false, hypotheses: [] });
    }
  });

  it('binds provider/shard plans, budgets, factor provenance, and outcome source without authority fields', () => {
    const strategicBriefing = briefing(['sharded-bet']);
    const contract = estimate('sharded-bet');
    contract.constraints = {
      dependenciesSatisfied: true,
      reversible: false,
      allowedProviders: ['local', 'codex'],
      shardable: true,
      shardPlanDigest: sha('5'),
    };
    contract.outcomeSource = { complete: false, sourceDigest: sha('4'), evidence: null };
    const result = compileStrategicInvestmentsV1(input(strategicBriefing, [contract]));

    if (!result.ok) throw new Error(`expected hypothesis: ${result.issues.join(',')}`);
    expect(result.hypotheses[0]).toMatchObject({
      constraints: {
        allowedProviders: ['codex', 'local'], shardable: true, shardPlanDigest: sha('5'), reversible: false,
      },
      budget: contract.budget,
      factors: { factorSourceDigest: contract.factors.factorSourceDigest },
      outcomeSource: { complete: false, sourceDigest: sha('4'), evidence: null },
    });
    expect(JSON.stringify(result)).not.toMatch(/Authority|policyEligible|effectAuthority/);
  });

  it('rejects unknown fields instead of silently dropping adversarial metadata', () => {
    const source = input(briefing(['one-bet']), [estimate('one-bet')]);
    expect(compileStrategicInvestmentsV1({ ...source, unexpected: true }))
      .toMatchObject({ ok: false, issues: ['invalid-input'] });
    expect(compileStrategicInvestmentsV1({
      ...source,
      estimates: [{ ...source.estimates[0]!, unexpected: true }],
    })).toMatchObject({ ok: false, issues: ['invalid-estimate'] });
    expect(compileStrategicInvestmentsV1({
      ...source,
      estimates: [{
        ...source.estimates[0]!,
        constraints: { ...source.estimates[0]!.constraints, humanGateRequired: false },
      }],
    })).toMatchObject({ ok: false, issues: ['invalid-estimate'] });
  });
});
