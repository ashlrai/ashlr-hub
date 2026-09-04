import { describe, expect, it } from 'vitest';

import {
  acceptanceContractDigestV1,
  buildPortfolioShadowV1,
  createValueHypothesisV1,
  verifyPortfolioShadowV1,
  type OutcomeEvidenceVerifierV1,
  type ResourceEnvelopeV1,
  type ValueHypothesisDraftV1,
  type ValueHypothesisV1,
} from '../src/core/vision/value-portfolio.js';

const sha = (character: string): string => character.repeat(64);
const AS_OF = '2026-09-03T12:00:00.000Z';
const OUTCOME_AS_OF = '2026-09-05T12:00:00.000Z';
const SPEC = sha('a');
const MISSION = sha('b');
const ACCEPTANCE_CONTRACT = {
  baselineDigest: sha('6'),
  metric: 'retained-user-value',
  unit: 'index-points',
  direction: 'increase' as const,
  effectiveThreshold: 20,
  refutationThreshold: 5,
  windowStart: '2026-09-01T12:00:00.000Z',
  windowEnd: '2026-09-05T12:00:00.000Z',
  minimumCausalGrade: 'quasi-experimental' as const,
};
const ACCEPTANCE_DIGEST = acceptanceContractDigestV1(ACCEPTANCE_CONTRACT);
if (!ACCEPTANCE_DIGEST) throw new Error('expected acceptance contract digest');

const OUTCOME_VERIFIER: OutcomeEvidenceVerifierV1 = {
  verifyOutcomeEvidence: ({ evidence, producerDigest }) => ({
    authenticated: evidence.receiptDigest === sha('f'),
    independentObserver: evidence.observerDigest !== producerDigest,
  }),
};

function envelope(overrides: Partial<ResourceEnvelopeV1> = {}): ResourceEnvelopeV1 {
  return {
    schemaVersion: 1,
    sourceComplete: true,
    sourceDigest: sha('c'),
    reserveFraction: 0.1,
    capacity: [
      {
        executionIdentityDigest: sha('1'),
        provider: 'codex',
        state: 'open',
        trustedTokens: 100_000,
        trustedMinutes: 120,
        resetAt: '2026-09-03T14:00:00.000Z',
      },
      {
        executionIdentityDigest: sha('2'),
        provider: 'claude',
        state: 'near',
        trustedTokens: 80_000,
        trustedMinutes: 90,
        resetAt: '2026-09-03T13:00:00.000Z',
      },
      {
        executionIdentityDigest: sha('3'),
        provider: 'local',
        state: 'open',
        trustedTokens: 20_000,
        trustedMinutes: 60,
        resetAt: null,
      },
    ],
    ...overrides,
  };
}

function draft(index: number, overrides: Partial<ValueHypothesisDraftV1> = {}): ValueHypothesisDraftV1 {
  return {
    schemaVersion: 1,
    provenanceDigest: sha('0'),
    specDigest: SPEC,
    missionDigest: MISSION,
    missionNodeKey: `product-bet-${index}`,
    producerDigest: sha('d'),
    claim: `Shipping product capability ${index} will improve retained user value.`,
    constraints: {
      dependenciesSatisfied: true,
      humanGateRequired: false,
      reversible: true,
      allowedProviders: ['codex', 'claude', 'local'],
      shardable: false,
      shardPlanDigest: null,
    },
    frozenOutcome: {
      acceptanceContractDigest: ACCEPTANCE_DIGEST,
      ...ACCEPTANCE_CONTRACT,
    },
    budget: {
      maxTokens: 100_000,
      maxMinutes: 240,
      maxAttempts: 4,
      maxInconclusiveWindows: 2,
      spentTokens: 0,
      spentMinutes: 0,
      attempts: 0,
      inconclusiveWindows: 0,
      deadline: '2026-09-10T12:00:00.000Z',
      minimumMarginalValue: 0.05,
    },
    factors: {
      productImpact: 0.9 - index * 0.02,
      informationGain: 0.8,
      strategicLeverage: 0.9,
      ipLeverage: 0.85,
      dependencyUnlock: 0.7,
      probability: 0.75,
      risk: 0.2,
      uncertainty: 0.3,
      estimatedTokens: 20_000,
      estimatedMinutes: 30,
      factorSourceDigest: sha('7'),
    },
    outcomeSource: {
      complete: true,
      sourceDigest: sha('e'),
      evidence: null,
    },
    ...overrides,
  };
}

function hypothesis(index: number, overrides: Partial<ValueHypothesisDraftV1> = {}): ValueHypothesisV1 {
  const created = createValueHypothesisV1(draft(index, overrides), OUTCOME_VERIFIER);
  if (!created) throw new Error('expected a valid hypothesis');
  return created;
}

function build(
  hypotheses: ValueHypothesisV1[],
  resourceEnvelope: ResourceEnvelopeV1 = envelope(),
  asOf = AS_OF,
) {
  return buildPortfolioShadowV1({
    schemaVersion: 1,
    asOf,
    specDigest: SPEC,
    missionDigest: MISSION,
    resourceEnvelope,
    hypotheses,
  }, OUTCOME_VERIFIER);
}

function portfolio(
  hypotheses: ValueHypothesisV1[],
  resourceEnvelope?: ResourceEnvelopeV1,
  asOf = AS_OF,
) {
  const result = build(hypotheses, resourceEnvelope, asOf);
  if (!result.ok) throw new Error(`expected portfolio: ${result.issues.join(',')}`);
  return result.portfolio;
}

describe('M527 Living End-State portfolio shadow', () => {
  it('is deterministic across hypothesis and inventory order and binds every digest', () => {
    const hypotheses = [hypothesis(0), hypothesis(1), hypothesis(2)];
    const first = portfolio(hypotheses);
    const second = portfolio(
      [...hypotheses].reverse(),
      envelope({ capacity: [...envelope().capacity].reverse() }),
    );

    expect(second).toEqual(first);
    expect(verifyPortfolioShadowV1(first)).toEqual(first);
    expect(Object.fromEntries(first.decisions.map((entry) => [entry.missionNodeKey, entry.rank])))
      .toEqual({ 'product-bet-0': 1, 'product-bet-1': 2, 'product-bet-2': 3 });

    const changed = portfolio([
      hypothesis(0, { claim: 'A different falsifiable product-value claim.' }),
      hypotheses[1]!,
      hypotheses[2]!,
    ]);
    expect(changed.portfolioId).not.toBe(first.portfolioId);
    expect(changed.portfolioDigest).not.toBe(first.portfolioDigest);
  });

  it('strictly rejects unknown input/output fields and forged effect authority', () => {
    const valid = hypothesis(0);
    expect(createValueHypothesisV1({ ...draft(0), unexpected: true })).toBeNull();
    expect(buildPortfolioShadowV1({
      schemaVersion: 1,
      asOf: AS_OF,
      specDigest: SPEC,
      missionDigest: MISSION,
      resourceEnvelope: envelope(),
      hypotheses: [valid],
      unexpected: true,
    })).toEqual({ ok: false, portfolio: null, issues: ['invalid-input'] });

    const output = portfolio([valid]);
    expect(verifyPortfolioShadowV1({ ...output, unexpected: true })).toBeNull();
    expect(verifyPortfolioShadowV1({
      ...output,
      effects: { ...output.effects, deployments: true },
    })).toBeNull();
    expect(verifyPortfolioShadowV1({ ...output, executionAuthority: true })).toBeNull();
  });

  it('withholds incomplete outcomes and rejects marker-only, self-reported, or forged evidence', () => {
    const incomplete = hypothesis(0, {
      outcomeSource: {
        complete: false,
        sourceDigest: sha('e'),
        evidence: null,
      },
    });
    const selfReported = draft(1, {
      outcomeSource: {
        complete: true,
        sourceDigest: sha('e'),
        evidence: {
          format: 'outcome-evidence-v1',
          observerDigest: sha('d'),
          receiptDigest: sha('f'),
          artifactDigest: sha('4'),
          deploymentDigest: sha('5'),
          baselineDigest: sha('6'),
          acceptanceContractDigest: ACCEPTANCE_DIGEST,
          metric: 'retained-user-value',
          value: 30,
          observedAt: AS_OF,
          windowStart: '2026-09-01T12:00:00.000Z',
          windowEnd: '2026-09-05T12:00:00.000Z',
          causalGrade: 'quasi-experimental',
          guardrailBreached: false,
        },
      },
    });
    expect(createValueHypothesisV1(selfReported)).toBeNull();
    expect(createValueHypothesisV1(selfReported, OUTCOME_VERIFIER)).toBeNull();
    const forged = {
      ...selfReported,
      outcomeSource: {
        ...selfReported.outcomeSource,
        evidence: { ...selfReported.outcomeSource.evidence!, observerDigest: sha('9'), receiptDigest: sha('8') },
      },
    };
    expect(createValueHypothesisV1(forged, OUTCOME_VERIFIER)).toBeNull();

    const decisions = new Map(portfolio([incomplete]).decisions
      .map((entry) => [entry.missionNodeKey, entry]));

    expect(decisions.get('product-bet-0')).toMatchObject({
      reason: 'source-incomplete', disposition: 'hold', effective: null,
      score: null, scoreFactors: null, allocation: null,
    });
  });

  it('spends earliest-reset inventory while excluding unknown, stale, reserved, and exhausted capacity', () => {
    const capacities: ResourceEnvelopeV1['capacity'] = [
      ...envelope().capacity,
      ...(['unknown', 'stale', 'reserved', 'exhausted'] as const).map((state, index) => ({
        executionIdentityDigest: sha(String(4 + index)),
        provider: 'codex' as const,
        state,
        trustedTokens: 900_000_000,
        trustedMinutes: 500_000,
        resetAt: '2026-09-03T12:30:00.000Z',
      })),
    ];
    const output = portfolio([hypothesis(0)], envelope({ capacity: capacities }));
    const decision = output.decisions[0]!;

    expect(output.resources).toMatchObject({
      usableTokens: 200_000,
      usableMinutes: 270,
      reservedTokens: 20_000,
      reservedMinutes: 27,
      allocatableTokens: 180_000,
      allocatableMinutes: 243,
    });
    expect(decision.reason).toBe('allocated');
    expect(decision.allocation?.inventory[0]).toMatchObject({
      executionIdentityDigest: sha('2'),
      provider: 'claude',
      resetAt: '2026-09-03T13:00:00.000Z',
    });
    expect(JSON.stringify(output)).not.toContain(sha('4'));
    expect(JSON.stringify(output)).not.toContain(sha('5'));
    expect(JSON.stringify(output)).not.toContain(sha('6'));
    expect(JSON.stringify(output)).not.toContain(sha('7'));
  });

  it('never exceeds reserve, per-bet, total-budget, or active-bet bounds', () => {
    const output = portfolio(Array.from({ length: 6 }, (_, index) => hypothesis(index)));
    const allocations = output.decisions.flatMap((entry) => entry.allocation ? [entry.allocation] : []);
    const totalTokens = allocations.reduce((sum, entry) => sum + entry.tokens, 0);
    const totalMinutes = allocations.reduce((sum, entry) => sum + entry.minutes, 0);

    expect(allocations).toHaveLength(3);
    expect(totalTokens).toBeLessThanOrEqual(output.resources.allocatableTokens);
    expect(totalMinutes).toBeLessThanOrEqual(output.resources.allocatableMinutes);
    expect(allocations.every((entry) => entry.tokens <= output.resources.usableTokens * 0.4)).toBe(true);
    expect(allocations.every((entry) => entry.minutes <= output.resources.usableMinutes * 0.4)).toBe(true);
    expect(output.resources.reservedTokens).toBeGreaterThanOrEqual(output.resources.usableTokens * 0.1);
    expect(output.decisions.filter((entry) => entry.reason === 'portfolio-cap')).toHaveLength(3);
    expect(output.decisions.filter((entry) => entry.reason === 'portfolio-cap')
      .every((entry) => entry.disposition === 'hold')).toBe(true);
  });

  it('marks effectiveness/refutation only from frozen independent evidence and applies stop rules', () => {
    const evidence = (value: number, guardrailBreached = false) => ({
      complete: true,
      sourceDigest: sha('e'),
      evidence: {
        format: 'outcome-evidence-v1' as const,
        observerDigest: sha('9'),
        receiptDigest: sha('f'),
        artifactDigest: sha('4'),
        deploymentDigest: sha('5'),
        baselineDigest: sha('6'),
        acceptanceContractDigest: ACCEPTANCE_DIGEST,
        metric: 'retained-user-value',
        value,
        observedAt: OUTCOME_AS_OF,
        windowStart: '2026-09-01T12:00:00.000Z',
        windowEnd: '2026-09-05T12:00:00.000Z',
        causalGrade: 'quasi-experimental' as const,
        guardrailBreached,
      },
    });
    const cases = [
      hypothesis(0, { outcomeSource: evidence(25) }),
      hypothesis(1, { outcomeSource: evidence(3) }),
      hypothesis(2, { outcomeSource: evidence(15, true) }),
      hypothesis(3, { budget: { ...draft(3).budget, deadline: OUTCOME_AS_OF } }),
      hypothesis(4, { budget: { ...draft(4).budget, attempts: 4 } }),
      hypothesis(5, { budget: { ...draft(5).budget, inconclusiveWindows: 2 } }),
      hypothesis(6, { budget: { ...draft(6).budget, minimumMarginalValue: 0.99 } }),
    ];
    const outcomePortfolio = portfolio(cases, undefined, OUTCOME_AS_OF);
    const decisions = outcomePortfolio.decisions;
    const byNode = new Map(decisions.map((entry) => [entry.missionNodeKey, entry]));

    expect(byNode.get('product-bet-0')).toMatchObject({
      disposition: 'stop', reason: 'effective', effective: true,
    });
    expect(byNode.get('product-bet-1')).toMatchObject({
      disposition: 'stop', reason: 'refuted', effective: false,
    });
    expect(byNode.get('product-bet-2')).toMatchObject({
      disposition: 'stop', reason: 'guardrail-breached', effective: false,
    });
    expect(byNode.get('product-bet-3')).toMatchObject({ reason: 'deadline-reached' });
    expect(byNode.get('product-bet-4')).toMatchObject({ reason: 'budget-exhausted' });
    expect(byNode.get('product-bet-5')).toMatchObject({ reason: 'inconclusive-limit' });
    expect(byNode.get('product-bet-6')).toMatchObject({ reason: 'marginal-value-low' });
    expect(verifyPortfolioShadowV1(outcomePortfolio)).toEqual(outcomePortfolio);

    const beforeWindowClose = portfolio([
      hypothesis(0, {
        outcomeSource: {
          ...evidence(25),
          evidence: { ...evidence(25).evidence, observedAt: AS_OF },
        },
      }),
    ]);
    expect(beforeWindowClose.decisions[0]).toMatchObject({
      disposition: 'hold', reason: 'outcome-window-open', effective: null, allocation: null,
    });
  });

  it('keeps routine reversible work on the fast path and prices deeper assurance only when warranted', () => {
    const fast = hypothesis(0);
    const uncertain = hypothesis(1, {
      constraints: {
        dependenciesSatisfied: true,
        humanGateRequired: false,
        reversible: false,
        allowedProviders: ['codex', 'claude', 'local'],
        shardable: false,
        shardPlanDigest: null,
      },
      factors: { ...draft(1).factors, risk: 0.85, uncertainty: 0.8 },
    });
    const decisions = portfolio([fast, uncertain]).decisions;
    const byNode = new Map(decisions.map((entry) => [entry.missionNodeKey, entry]));

    expect(byNode.get('product-bet-0')?.assurance).toEqual({
      depth: 'fast-path', tokenObligation: 0, minuteObligation: 0,
    });
    expect(byNode.get('product-bet-1')?.assurance).toEqual({
      depth: 'deep-review', tokenObligation: 4_000, minuteObligation: 6,
    });
    expect(byNode.get('product-bet-1')?.allocation).toMatchObject({ tokens: 24_000, minutes: 36 });
  });

  it('keeps downstream human effect gates out of shadow thinking and requires a feasible identity bundle', () => {
    const gated = hypothesis(0, {
      constraints: {
        ...draft(0).constraints,
        humanGateRequired: true,
        allowedProviders: ['local'],
      },
      factors: { ...draft(0).factors, estimatedTokens: 30_000, estimatedMinutes: 30 },
    });
    const noSingleLocalBundle = portfolio([gated]);
    expect(noSingleLocalBundle.decisions[0]).toMatchObject({
      disposition: 'hold', reason: 'insufficient-capacity', allocation: null,
    });

    const shardable = hypothesis(0, {
      constraints: {
        ...draft(0).constraints,
        humanGateRequired: true,
        allowedProviders: ['codex', 'claude'],
        shardable: true,
        shardPlanDigest: sha('7'),
      },
      factors: { ...draft(0).factors, estimatedTokens: 70_000, estimatedMinutes: 100 },
    });
    const output = portfolio([shardable]);
    expect(output.decisions[0]).toMatchObject({ disposition: 'continue', reason: 'allocated' });
    expect(output.decisions[0]?.allocation?.inventory.length).toBeGreaterThan(1);
  });

  it('returns public, values-free JSON with every authority and effect bit false', () => {
    const output = portfolio([hypothesis(0)]);
    const json = JSON.stringify(output);
    const authorityValues = [
      output.planningAuthority, output.executionAuthority, output.proposalAuthority,
      output.agentAuthority, output.mergeAuthority, output.releaseAuthority,
      output.deployAuthority, output.rollbackAuthority, output.publicationAuthority,
      output.externalMutationAuthority, output.budgetAuthority, output.learningAuthority,
      output.policyEligible,
    ];

    expect(authorityValues.every((value) => value === false)).toBe(true);
    expect(Object.values(output.effects).every((value) => value === false)).toBe(true);
    expect(json).not.toMatch(/identityRef|accountRef|runtimeLocator|secret|credential|CODEX_HOME|CLAUDE_CONFIG_DIR/);
    expect(json).not.toContain('/Users/');
  });

  it('holds when resource evidence is incomplete and rejects impossible derived totals', () => {
    const output = portfolio([hypothesis(0)], envelope({ sourceComplete: false }));
    expect(output.resources).toMatchObject({
      usableTokens: 0, usableMinutes: 0, allocatableTokens: 0, allocatableMinutes: 0,
    });
    expect(output.decisions[0]).toMatchObject({
      disposition: 'hold', reason: 'insufficient-capacity', allocation: null,
    });

    expect(verifyPortfolioShadowV1({
      ...output,
      resources: { ...output.resources, allocatableTokens: 1 },
    })).toBeNull();
    expect(verifyPortfolioShadowV1({
      ...output,
      portfolioId: sha('0'),
    })).toBeNull();
  });
});
