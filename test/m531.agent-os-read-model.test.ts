import { createHash } from 'node:crypto';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  buildCapabilitySpectrumShadowV1,
  digestCapabilityClassV1,
  type CapabilitySpectrumShadowV1,
} from '../src/core/fabric/capability-spectrum.js';
import type { ExecutionIdentityShadowStatusV1 } from '../src/core/fabric/execution-identity.js';
import {
  buildAgentNativeKernelShadowV1,
  type AgentNativeKernelEvidenceVerifierV1,
  type AgentNativeKernelShadowV1,
} from '../src/core/vision/agent-native-kernel.js';
import {
  AGENT_OS_READ_MODEL_MAX_AGE_MS,
  buildAgentOsReadModelV1,
  type AgentOsReadModelInputV1,
  type AgentOsReadModelV1,
  type AgentOsReadModelVerifierV1,
  type AgentOsSourceBundleVerificationInputV1,
} from '../src/core/vision/agent-os-read-model.js';
import {
  acceptanceContractDigestV1,
  buildPortfolioShadowV1,
  createValueHypothesisV1,
  digestResourceEnvelopeV1,
  verifyPortfolioShadowV1,
  type OutcomeEvidenceVerifierV1,
  type PortfolioShadowV1,
  type ResourceEnvelopeV1,
  type ValueHypothesisV1,
} from '../src/core/vision/value-portfolio.js';
import type { AgentOsCockpitSnapshot } from '../src/web-ui/components/agent-os/types.js';

const digest = (label: string): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(label, 'utf8').digest('hex')}`;
const AS_OF = '2026-09-03T12:00:00.000Z';
const RENDERED_AT = '2026-09-03T12:01:00.000Z';
const SPEC = digest('spec');
const MISSION = digest('mission');
const IDENTITY = digest('identity');
const EVIDENCE_INDEX_DIGEST = digest('evidence-index');
const TRUSTED_RECEIPTS = new Set<string>();

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
}

function domainDigest(value: unknown, domain: string): string {
  return createHash('sha256').update(domain, 'utf8').update('\0')
    .update(canonicalJson(value), 'utf8').digest('hex');
}

const OUTCOME_VERIFIER: OutcomeEvidenceVerifierV1 = {
  verifyOutcomeEvidence: ({ evidence, producerDigest }) => ({
    authenticated: TRUSTED_RECEIPTS.has(evidence.receiptDigest),
    independentObserver: evidence.observerDigest !== producerDigest,
  }),
};

const EVIDENCE_INDEX_VERIFIER: AgentNativeKernelEvidenceVerifierV1 = {
  verifyEvidenceIndex: (evidence) => ({
    authenticated: evidence.evidenceDigest === EVIDENCE_INDEX_DIGEST,
  }),
};

function hypothesis(
  node = 'bet-one',
  outcome: 'pending' | 'observing' | 'guardrail' = 'pending',
  claim = `Improve retained builder value through ${node}.`,
): ValueHypothesisV1 {
  const baselineDigest = digest(`baseline-${node}`);
  const acceptanceContract = {
    baselineDigest,
    metric: 'retained-builder-value',
    unit: 'index-points',
    direction: 'increase' as const,
    effectiveThreshold: 20,
    refutationThreshold: 5,
    windowStart: '2026-09-01T12:00:00.000Z',
    windowEnd: '2026-09-05T12:00:00.000Z',
    minimumCausalGrade: 'quasi-experimental' as const,
  };
  const acceptanceContractDigest = acceptanceContractDigestV1(acceptanceContract);
  if (!acceptanceContractDigest) throw new Error('expected acceptance contract digest');
  const receiptDigest = digest(`receipt-${node}`);
  if (outcome !== 'pending') TRUSTED_RECEIPTS.add(receiptDigest);
  const value = createValueHypothesisV1({
    schemaVersion: 1,
    provenanceDigest: digest(`provenance-${node}`),
    specDigest: SPEC,
    missionDigest: MISSION,
    missionNodeKey: node,
    producerDigest: digest(`producer-${node}`),
    claim,
    constraints: {
      dependenciesSatisfied: true,
      humanGateRequired: false,
      reversible: true,
      allowedProviders: ['codex'],
      shardable: false,
      shardPlanDigest: null,
    },
    frozenOutcome: {
      acceptanceContractDigest,
      ...acceptanceContract,
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
      productImpact: 0.9,
      informationGain: 0.8,
      strategicLeverage: 0.9,
      ipLeverage: 0.8,
      dependencyUnlock: 0.7,
      probability: 0.8,
      risk: 0.2,
      uncertainty: 0.3,
      estimatedTokens: 10_000,
      estimatedMinutes: 20,
      factorSourceDigest: digest(`factors-${node}`),
    },
    outcomeSource: {
      complete: true,
      sourceDigest: digest(`outcome-${node}`),
      evidence: outcome === 'pending' ? null : {
        format: 'outcome-evidence-v1',
        observerDigest: digest(`observer-${node}`),
        receiptDigest,
        artifactDigest: digest(`artifact-${node}`),
        deploymentDigest: digest(`deployment-${node}`),
        baselineDigest,
        acceptanceContractDigest,
        metric: 'retained-builder-value',
        value: 50,
        observedAt: AS_OF,
        windowStart: '2026-09-01T12:00:00.000Z',
        windowEnd: '2026-09-05T12:00:00.000Z',
        causalGrade: 'quasi-experimental',
        guardrailBreached: outcome === 'guardrail',
      },
    },
  }, OUTCOME_VERIFIER);
  if (!value) throw new Error('expected valid hypothesis');
  return value;
}

function resourceEnvelope(): ResourceEnvelopeV1 {
  return {
    schemaVersion: 1,
    sourceComplete: true,
    sourceDigest: digest('resource-source'),
    reserveFraction: 0.1,
    capacity: [{
      executionIdentityDigest: IDENTITY,
      provider: 'codex',
      state: 'open',
      trustedTokens: 500_000,
      trustedMinutes: 500,
      resetAt: '2026-09-03T14:00:00.000Z',
    }],
  };
}

function portfolio(hypotheses: ValueHypothesisV1[]): PortfolioShadowV1 {
  const result = buildPortfolioShadowV1({
    schemaVersion: 1,
    asOf: AS_OF,
    specDigest: SPEC,
    missionDigest: MISSION,
    resourceEnvelope: resourceEnvelope(),
    hypotheses,
  }, OUTCOME_VERIFIER);
  if (!result.ok) throw new Error(result.issues.join(','));
  return result.portfolio;
}

function identity(): ExecutionIdentityShadowStatusV1 {
  return {
    schemaVersion: 1,
    authority: 'shadow-only',
    enabled: true,
    shadowOnly: true,
    sourceState: 'healthy',
    stopReasons: [],
    configuredIdentityCount: 1,
    identities: [{
      executionIdentityDigest: IDENTITY,
      engine: 'codex',
      state: 'open',
      trustedSlots: 2,
      maxConcurrent: 2,
      usedPercent: 20,
      observedAt: AS_OF,
      reason: 'observed-open',
    }],
    assignments: [],
    unassigned: [],
    executionAuthority: false,
    proposalAuthority: false,
    routingMutation: false,
  };
}

function kernel(value: PortfolioShadowV1): AgentNativeKernelShadowV1 {
  const result = buildAgentNativeKernelShadowV1({
    schemaVersion: 1,
    asOf: AS_OF,
    specDigest: SPEC,
    missionDigest: MISSION,
    executionIdentity: identity(),
    resourceEnvelope: resourceEnvelope(),
    portfolio: value,
    evidence: {
      format: 'evidence-index-v1',
      sourceComplete: true,
      evidenceDigest: EVIDENCE_INDEX_DIGEST,
      resourceDigest: value.basis.resourceEnvelopeDigest,
      portfolioDigest: value.portfolioDigest,
      observedAt: AS_OF,
    },
    checkpoint: {
      sequence: 0,
      previousCycle: null,
      nextWakeAt: '2026-09-03T12:05:00.000Z',
    },
  }, EVIDENCE_INDEX_VERIFIER);
  if (!result.ok) throw new Error(result.issues.join(','));
  return result.kernel;
}

function spectrum(options: {
  identity?: Partial<ExecutionIdentityShadowStatusV1['identities'][number]>;
  resourceEnvelopeDigest?: string;
} = {}): CapabilitySpectrumShadowV1 {
  const publicIdentity = { ...identity().identities[0]!, ...options.identity };
  const envelopeDigest = options.resourceEnvelopeDigest ?? digestResourceEnvelopeV1(resourceEnvelope());
  if (!envelopeDigest) throw new Error('expected resource envelope digest');
  const result = buildCapabilitySpectrumShadowV1({
    schemaVersion: 1,
    asOf: AS_OF,
    sourceDigest: digest('capability-source'),
    resourceEnvelopeDigest: envelopeDigest,
    executionIdentitySourceState: 'healthy',
    executionIdentityResources: [{ resource: publicIdentity }],
    resetWindows: [{
      executionIdentityDigest: publicIdentity.executionIdentityDigest,
      resetAt: '2026-09-03T14:00:00.000Z',
    }],
    localResources: [],
    lanes: [{
      laneDigest: digest('lane'),
      queueRank: 1,
      sourceComplete: true,
      requirements: [{ kind: 'model', classDigest: digestCapabilityClassV1('model', 'codex')!, units: 1 }],
    }],
  });
  if (!result.ok) throw new Error(result.issues.join(','));
  return result.spectrum;
}

function fixture(hypotheses = [hypothesis()]): AgentOsReadModelInputV1 {
  const portfolioValue = portfolio(hypotheses);
  return {
    schemaVersion: 1,
    renderedAt: RENDERED_AT,
    kernel: kernel(portfolioValue),
    capabilitySpectrum: spectrum(),
    portfolio: portfolioValue,
    hypotheses,
  };
}

function sourceBundle(input: AgentOsReadModelInputV1): AgentOsSourceBundleVerificationInputV1 {
  return {
    renderedAt: input.renderedAt,
    kernelCycleDigest: input.kernel.cycleDigest,
    evidenceIndexDigest: input.kernel.basis.evidenceDigest,
    capabilityProjectionDigest: input.capabilitySpectrum.projectionDigest,
    portfolioDigest: input.portfolio.portfolioDigest,
    hypothesisDigests: input.hypotheses.map((item) => item.hypothesisDigest).sort(),
    outcomeReceiptDigests: input.hypotheses.flatMap((item) =>
      item.outcomeSource.evidence ? [item.outcomeSource.evidence.receiptDigest] : []).sort(),
  };
}

function verifierFor(input: AgentOsReadModelInputV1): AgentOsReadModelVerifierV1 {
  const expected = canonicalJson(sourceBundle(input));
  return {
    outcomeEvidenceVerifier: OUTCOME_VERIFIER,
    verifySourceBundle: (actual) => ({
      sourceBundleAuthenticated: canonicalJson(actual) === expected,
      evidenceIndexAuthenticated: actual.evidenceIndexDigest === EVIDENCE_INDEX_DIGEST,
    }),
  };
}

function build(input: AgentOsReadModelInputV1, verifier = verifierFor(input)) {
  return buildAgentOsReadModelV1(input, verifier);
}

function forgePortfolioDecision(
  value: PortfolioShadowV1,
  reason: 'effective' | 'refuted',
): PortfolioShadowV1 {
  const forged = structuredClone(value);
  const decision = forged.decisions[0]!;
  decision.disposition = 'stop';
  decision.reason = reason;
  decision.effective = reason === 'effective';
  decision.score = null;
  decision.rank = null;
  decision.scoreFactors = null;
  decision.allocation = null;
  const unsigned = { ...forged };
  delete (unsigned as Partial<PortfolioShadowV1>).portfolioDigest;
  forged.portfolioDigest = domainDigest(unsigned, 'ashlr:value-portfolio:v1');
  return forged;
}

describe('M531 Agent OS authenticated internal read model', () => {
  it('projects a closed deterministic taxonomy with compile-time cockpit parity', () => {
    expectTypeOf<AgentOsReadModelV1>().toMatchTypeOf<AgentOsCockpitSnapshot>();
    expectTypeOf<AgentOsCockpitSnapshot>().toMatchTypeOf<AgentOsReadModelV1>();
    const input = fixture();
    const first = build(input);
    expect(build(input)).toEqual(first);
    expect(first).toMatchObject({
      ok: true,
      snapshot: {
        sourceState: 'healthy',
        livingEndState: {
          northStar: 'Convert governed engineering capacity into durable customer value.',
          revisionLabel: 'Current mission basis',
          evidenceState: 'complete',
        },
        capabilitySpectrum: [
          { lane: 'codex', label: 'Codex', state: 'ready', headroom: 'ample' },
          { lane: 'claude', label: 'Claude', state: 'unavailable', headroom: 'none' },
          { lane: 'local', label: 'Local models', state: 'unavailable', headroom: 'none' },
        ],
        activeValueBets: [{ title: 'Value bet 1', decision: 'continue', outcome: { state: 'pending' } }],
      },
    });
  });

  it('fails closed without an external verifier or with a rejected exact bundle', () => {
    const input = fixture();
    expect(buildAgentOsReadModelV1(input)).toMatchObject({
      ok: false, issues: ['source-verifier-unavailable'],
    });
    expect(buildAgentOsReadModelV1(input, {
      outcomeEvidenceVerifier: OUTCOME_VERIFIER,
      verifySourceBundle: () => ({ sourceBundleAuthenticated: false, evidenceIndexAuthenticated: true }),
    })).toMatchObject({ ok: false, issues: ['source-authentication-failed'] });
  });

  it('rejects a coherent but unauthenticated replacement source bundle', () => {
    const trusted = fixture([hypothesis('trusted')]);
    const replacement = fixture([hypothesis('replacement')]);
    expect(buildAgentOsReadModelV1(replacement, verifierFor(trusted))).toMatchObject({
      ok: false, issues: ['source-authentication-failed'],
    });
  });

  it('rejects structural authority, cross-basis, freshness, and reference drift', () => {
    const input = fixture();
    expect(build({ ...input, portfolio: { ...input.portfolio, executionAuthority: true } }))
      .toMatchObject({ ok: false, issues: ['invalid-portfolio'] });
    expect(build({ ...input, renderedAt: new Date(
      Date.parse(AS_OF) + AGENT_OS_READ_MODEL_MAX_AGE_MS + 1,
    ).toISOString() })).toMatchObject({ ok: false, issues: ['stale-snapshot'] });
    expect(build({ ...input, hypotheses: [] }))
      .toMatchObject({ ok: false, issues: ['unknown-source-reference'] });
    expect(build({ ...input, capabilitySpectrum: spectrum({
      resourceEnvelopeDigest: digest('unrelated-envelope'),
    }) })).toMatchObject({ ok: false, issues: ['basis-mismatch'] });
  });

  it('rejects structurally valid effective and refuted decisions with null outcome evidence', () => {
    for (const reason of ['effective', 'refuted'] as const) {
      const pending = hypothesis(`forged-${reason}`);
      const forgedPortfolio = forgePortfolioDecision(portfolio([pending]), reason);
      expect(verifyPortfolioShadowV1(forgedPortfolio)).not.toBeNull();
      const input: AgentOsReadModelInputV1 = {
        schemaVersion: 1,
        renderedAt: RENDERED_AT,
        kernel: kernel(forgedPortfolio),
        capabilitySpectrum: spectrum(),
        portfolio: forgedPortfolio,
        hypotheses: [pending],
      };
      expect(buildAgentOsReadModelV1(input, {
        outcomeEvidenceVerifier: OUTCOME_VERIFIER,
        verifySourceBundle: () => ({
          sourceBundleAuthenticated: true,
          evidenceIndexAuthenticated: true,
        }),
      })).toMatchObject({ ok: false, issues: ['source-authentication-failed'] });
    }
  });

  it('does not export caller-authored claims, metric prose, or private source internals', () => {
    const callerProse = 'Caller supplied executive claim for account Alpha.';
    const result = build(fixture([hypothesis('privacy-safe', 'pending', callerProse)]));
    if (!result.ok) throw new Error(result.issues.join(','));
    const encoded = JSON.stringify(result.snapshot);
    expect(encoded).not.toContain(callerProse);
    expect(encoded).not.toContain('retained-builder-value');
    expect(encoded).not.toContain('preverified');
    expect(encoded).not.toMatch(/account|identity|secret|credential|runtimeLocator|\/Users\/|CODEX_HOME/iu);
    expect(encoded).not.toMatch(/dispatch|merge|release|deploy|authority|effects/iu);
    expect(Object.keys(result.snapshot)).toEqual([
      'sourceState', 'livingEndState', 'capabilitySpectrum', 'activeValueBets', 'nextAction',
    ]);
  });

  it('rejects oversized inputs and more than three authenticated active observations', () => {
    const input = fixture();
    expect(buildAgentOsReadModelV1({
      ...input,
      hypotheses: Array.from({ length: 13 }, () => input.hypotheses[0]!),
    }, verifierFor(input))).toMatchObject({ ok: false, issues: ['invalid-input'] });
    const observing = ['one', 'two', 'three', 'four'].map((node) => hypothesis(node, 'observing'));
    expect(build(fixture(observing))).toMatchObject({ ok: false, issues: ['too-many-value-bets'] });
  });

  it('keeps authenticated guardrail stops out of active bets without relabeling them as refutations', () => {
    const guarded = hypothesis('guardrail-stop', 'guardrail');
    const input = fixture([guarded]);
    expect(input.portfolio.decisions[0]).toMatchObject({
      disposition: 'stop', reason: 'guardrail-breached', effective: false,
    });
    const result = build(input);
    expect(result).toMatchObject({ ok: true, snapshot: { activeValueBets: [] } });
    if (result.ok) expect(JSON.stringify(result.snapshot)).not.toContain('refuted');
  });
});
