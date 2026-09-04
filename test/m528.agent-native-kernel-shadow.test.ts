import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { ExecutionIdentityShadowStatusV1 } from '../src/core/fabric/execution-identity.js';
import {
  buildAgentNativeKernelShadowV1 as buildKernelReceipt,
  verifyAgentNativeKernelShadowV1,
  type AgentNativeKernelEvidenceVerifierV1,
  type AgentNativeKernelInputV1,
} from '../src/core/vision/agent-native-kernel.js';
import {
  acceptanceContractDigestV1,
  buildPortfolioShadowV1,
  createValueHypothesisV1,
  type OutcomeEvidenceVerifierV1,
  type PortfolioShadowV1,
  type ResourceEnvelopeV1,
  type ValueHypothesisDraftV1,
} from '../src/core/vision/value-portfolio.js';

const hex = (character: string): string => character.repeat(64);
const prefixed = (character: string): `sha256:${string}` => `sha256:${hex(character)}`;
const AS_OF = '2026-09-03T12:00:00.000Z';
const AFTER_WINDOW = '2026-09-05T12:00:00.000Z';
const ACCEPTANCE_CONTRACT = {
  baselineDigest: hex('6'),
  metric: 'retained-builder-value',
  unit: 'index-points',
  direction: 'increase' as const,
  effectiveThreshold: 20,
  refutationThreshold: 5,
  windowStart: '2026-09-01T12:00:00.000Z',
  windowEnd: AFTER_WINDOW,
  minimumCausalGrade: 'quasi-experimental' as const,
};
const ACCEPTANCE_DIGEST = acceptanceContractDigestV1(ACCEPTANCE_CONTRACT);
if (!ACCEPTANCE_DIGEST) throw new Error('expected acceptance contract digest');
const SPEC = hex('a');
const MISSION = hex('b');
const IDENTITY = prefixed('1');

const OUTCOME_VERIFIER: OutcomeEvidenceVerifierV1 = {
  verifyOutcomeEvidence: ({ evidence, producerDigest }) => ({
    authenticated: evidence.receiptDigest === hex('f'),
    independentObserver: evidence.observerDigest !== producerDigest,
  }),
};
const EVIDENCE_INDEX_VERIFIER: AgentNativeKernelEvidenceVerifierV1 = {
  verifyEvidenceIndex: (evidence) => ({
    authenticated: evidence.evidenceDigest === hex('0') || evidence.evidenceDigest === hex('2'),
  }),
};

function buildAgentNativeKernelShadowV1(value: unknown) {
  return buildKernelReceipt(value, EVIDENCE_INDEX_VERIFIER);
}

function identity(overrides: Partial<ExecutionIdentityShadowStatusV1> = {}): ExecutionIdentityShadowStatusV1 {
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
    ...overrides,
  };
}

function envelope(overrides: Partial<ResourceEnvelopeV1> = {}): ResourceEnvelopeV1 {
  return {
    schemaVersion: 1,
    sourceComplete: true,
    sourceDigest: hex('c'),
    reserveFraction: 0.1,
    capacity: [{
      executionIdentityDigest: IDENTITY,
      provider: 'codex',
      state: 'open',
      trustedTokens: 100_000,
      trustedMinutes: 120,
      resetAt: '2026-09-03T14:00:00.000Z',
    }],
    ...overrides,
  };
}

type OutcomeKind = 'none' | 'observing' | 'effective' | 'refuted' | 'guardrail';

function draft(outcome: OutcomeKind = 'none'): ValueHypothesisDraftV1 {
  const asOf = outcome === 'effective' || outcome === 'refuted' ? AFTER_WINDOW : AS_OF;
  return {
    schemaVersion: 1,
    provenanceDigest: hex('0'),
    specDigest: SPEC,
    missionDigest: MISSION,
    missionNodeKey: 'kernel-product-bet',
    producerDigest: hex('d'),
    claim: 'A verified kernel cycle will improve retained builder value.',
    constraints: {
      dependenciesSatisfied: true,
      humanGateRequired: false,
      reversible: true,
      allowedProviders: ['codex'],
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
      productImpact: 0.9,
      informationGain: 0.8,
      strategicLeverage: 0.9,
      ipLeverage: 0.85,
      dependencyUnlock: 0.7,
      probability: 0.75,
      risk: 0.2,
      uncertainty: 0.3,
      estimatedTokens: 20_000,
      estimatedMinutes: 30,
      factorSourceDigest: hex('7'),
    },
    outcomeSource: {
      complete: true,
      sourceDigest: hex('e'),
      evidence: outcome === 'none' ? null : {
        format: 'outcome-evidence-v1',
        observerDigest: hex('9'),
        receiptDigest: hex('f'),
        artifactDigest: hex('4'),
        deploymentDigest: hex('5'),
        baselineDigest: hex('6'),
        acceptanceContractDigest: ACCEPTANCE_DIGEST,
        metric: 'retained-builder-value',
        value: outcome === 'refuted' ? 0 : 25,
        observedAt: asOf,
        windowStart: '2026-09-01T12:00:00.000Z',
        windowEnd: AFTER_WINDOW,
        causalGrade: 'quasi-experimental',
        guardrailBreached: outcome === 'guardrail',
      },
    },
  };
}

function portfolio(
  asOf = AS_OF,
  outcome: OutcomeKind = 'none',
  resourceEnvelope = envelope(),
  includeCandidate = true,
): PortfolioShadowV1 {
  const hypothesis = createValueHypothesisV1(draft(outcome), OUTCOME_VERIFIER);
  if (!hypothesis) throw new Error('expected valid hypothesis');
  const result = buildPortfolioShadowV1({
    schemaVersion: 1,
    asOf,
    specDigest: SPEC,
    missionDigest: MISSION,
    resourceEnvelope,
    hypotheses: includeCandidate ? [hypothesis] : [],
  }, OUTCOME_VERIFIER);
  if (!result.ok) throw new Error(result.issues.join(','));
  return result.portfolio;
}

function input(overrides: Partial<AgentNativeKernelInputV1> = {}): AgentNativeKernelInputV1 {
  const resourceEnvelope = overrides.resourceEnvelope ?? envelope();
  const portfolioSnapshot = overrides.portfolio ?? portfolio(AS_OF, 'none', resourceEnvelope);
  return {
    schemaVersion: 1,
    asOf: AS_OF,
    specDigest: SPEC,
    missionDigest: MISSION,
    executionIdentity: identity(),
    resourceEnvelope,
    portfolio: portfolioSnapshot,
    evidence: {
      format: 'evidence-index-v1',
      sourceComplete: true,
      evidenceDigest: hex('0'),
      resourceDigest: portfolioSnapshot.basis.resourceEnvelopeDigest,
      portfolioDigest: portfolioSnapshot.portfolioDigest,
      observedAt: AS_OF,
    },
    checkpoint: {
      sequence: 0,
      previousCycle: null,
      nextWakeAt: '2026-09-03T12:05:00.000Z',
    },
    ...overrides,
  };
}

function kernel(overrides: Partial<AgentNativeKernelInputV1> = {}) {
  const result = buildAgentNativeKernelShadowV1(input(overrides));
  if (!result.ok) throw new Error(result.issues.join(','));
  return result.kernel;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
}

function resignKernel(value: ReturnType<typeof kernel>): ReturnType<typeof kernel> {
  const unsigned: Record<string, unknown> = structuredClone(value) as unknown as Record<string, unknown>;
  delete unsigned['cycleDigest'];
  return {
    ...value,
    cycleDigest: createHash('sha256').update('ashlr:agent-native-kernel:cycle:v1', 'utf8')
      .update('\0').update(canonicalJson(unsigned), 'utf8').digest('hex'),
  };
}

describe('M528 Agent-Native Kernel Shadow V1', () => {
  it('binds verified identity, resource, evidence, portfolio, spec, and mission snapshots', () => {
    const first = kernel();
    const second = kernel();

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      phase: 'allocate',
      lifecycle: 'running',
      degradedReasons: [],
      holdReasons: [],
      sources: { identity: 'healthy', resourceComplete: true, evidenceComplete: true },
      counts: { identities: 1, trustedSlots: 2, candidates: 1, allocated: 1 },
    });
    expect(first.basis).toMatchObject({
      asOf: AS_OF,
      specDigest: SPEC,
      missionDigest: MISSION,
      resourceDigest: input().portfolio.basis.resourceEnvelopeDigest,
      evidenceDigest: hex('0'),
      portfolioDigest: input().portfolio.portfolioDigest,
    });
    expect(verifyAgentNativeKernelShadowV1(first)).toEqual(first);

    const changedEvidence = kernel({ evidence: { ...input().evidence, evidenceDigest: hex('2') } });
    expect(changedEvidence.basisDigest).not.toBe(first.basisDigest);
    expect(changedEvidence.checkpoint.checkpointDigest).not.toBe(first.checkpoint.checkpointDigest);
    expect(changedEvidence.cycleDigest).not.toBe(first.cycleDigest);
  });

  it('derives sense, allocate, and observe without a committee or self-issued effects', () => {
    const sensingPortfolio = portfolio(AS_OF, 'none', envelope(), false);
    const sensing = kernel({ portfolio: sensingPortfolio });
    expect(sensing).toMatchObject({
      phase: 'sense', lifecycle: 'holding', holdReasons: ['no-candidates'],
    });

    const allocating = kernel();
    expect(allocating).toMatchObject({ phase: 'allocate', lifecycle: 'running' });

    const observingPortfolio = portfolio(AS_OF, 'observing');
    const observing = kernel({ portfolio: observingPortfolio });
    expect(observing).toMatchObject({
      phase: 'observe', lifecycle: 'observing', holdReasons: ['outcome-window-open'],
      counts: { observing: 1, held: 1, effective: 0 },
    });

    const effectivePortfolio = portfolio(AFTER_WINDOW, 'effective');
    const settled = kernel({
      asOf: AFTER_WINDOW,
      portfolio: effectivePortfolio,
      executionIdentity: identity({
        identities: [{ ...identity().identities[0]!, observedAt: AFTER_WINDOW }],
      }),
      evidence: {
        ...input({ portfolio: effectivePortfolio }).evidence,
        observedAt: AFTER_WINDOW,
      },
      checkpoint: { sequence: 1, previousCycle: allocating,
        nextWakeAt: '2026-09-05T12:05:00.000Z' },
    });
    expect(settled).toMatchObject({
      phase: 'observe', lifecycle: 'settled',
      counts: { candidates: 1, stopped: 1, effective: 1, refuted: 0 },
    });
  });

  it('degrades explicitly when identity, resource, evidence, or allocation bindings are unsafe', () => {
    const disabledIdentity = identity({
      enabled: false,
      sourceState: 'disabled',
      configuredIdentityCount: 0,
      identities: [],
    });
    const incompleteEnvelope = envelope({ sourceComplete: false });
    const incompletePortfolio = portfolio(AS_OF, 'none', incompleteEnvelope);
    const degraded = kernel({
      executionIdentity: disabledIdentity,
      resourceEnvelope: incompleteEnvelope,
      portfolio: incompletePortfolio,
      evidence: { ...input({ portfolio: incompletePortfolio }).evidence, sourceComplete: false },
    });
    expect(degraded).toMatchObject({
      phase: 'sense',
      lifecycle: 'degraded',
      degradedReasons: [
        'evidence-source-incomplete',
        'identity-disabled',
        'resource-source-incomplete',
      ],
    });

    const otherIdentity = identity({
      identities: [{ ...identity().identities[0]!, executionIdentityDigest: prefixed('2') }],
    });
    const mismatch = kernel({ executionIdentity: otherIdentity });
    expect(mismatch).toMatchObject({
      phase: 'sense', lifecycle: 'degraded',
      degradedReasons: ['identity-resource-mismatch'],
    });

    const claudeHypothesis = createValueHypothesisV1({
      ...draft(),
      constraints: { ...draft().constraints, allowedProviders: ['claude'] },
    });
    if (!claudeHypothesis) throw new Error('expected valid Claude hypothesis');
    const claudePortfolioResult = buildPortfolioShadowV1({
      schemaVersion: 1,
      asOf: AS_OF,
      specDigest: SPEC,
      missionDigest: MISSION,
      resourceEnvelope: envelope({
        capacity: [{ ...envelope().capacity[0]!, provider: 'claude' }],
      }),
      hypotheses: [claudeHypothesis],
    });
    if (!claudePortfolioResult.ok) throw new Error(claudePortfolioResult.issues.join(','));
    const claudeEnvelope = envelope({
      capacity: [{ ...envelope().capacity[0]!, provider: 'claude' }],
    });
    expect(kernel({
      resourceEnvelope: claudeEnvelope,
      portfolio: claudePortfolioResult.portfolio,
    })).toMatchObject({
      lifecycle: 'degraded', degradedReasons: ['identity-resource-mismatch'],
    });
  });

  it('strictly rejects unknown fields, forged snapshots, invalid continuity, and basis drift', () => {
    expect(buildKernelReceipt(input())).toEqual({
      ok: false, kernel: null, issues: ['evidence-index-authentication-failed'],
    });
    expect(buildKernelReceipt({
      ...input(),
      evidence: { ...input().evidence, evidenceDigest: hex('8') },
    }, EVIDENCE_INDEX_VERIFIER)).toEqual({
      ok: false, kernel: null, issues: ['evidence-index-authentication-failed'],
    });
    expect(buildKernelReceipt({
      ...input(),
      evidence: { ...input().evidence, format: 'preverified-evidence-index-v1' },
    }, EVIDENCE_INDEX_VERIFIER)).toEqual({
      ok: false, kernel: null, issues: ['invalid-cycle-metadata'],
    });
    expect(buildAgentNativeKernelShadowV1({ ...input(), unexpected: true }))
      .toEqual({ ok: false, kernel: null, issues: ['invalid-input'] });
    expect(buildAgentNativeKernelShadowV1({
      ...input(),
      executionIdentity: { ...identity(), unexpected: true },
    })).toEqual({ ok: false, kernel: null, issues: ['invalid-identity-snapshot'] });
    expect(buildAgentNativeKernelShadowV1({
      ...input(),
      executionIdentity: identity({
        identities: [{
          ...identity().identities[0]!,
          state: 'open',
          trustedSlots: 0,
          reason: 'observation-missing',
          observedAt: null,
        }],
      }),
    })).toEqual({ ok: false, kernel: null, issues: ['invalid-identity-snapshot'] });
    expect(buildAgentNativeKernelShadowV1({
      ...input(),
      portfolio: { ...portfolio(), executionAuthority: true },
    })).toEqual({ ok: false, kernel: null, issues: ['invalid-portfolio-snapshot'] });
    expect(buildAgentNativeKernelShadowV1({
      ...input(),
      missionDigest: hex('3'),
    })).toEqual({ ok: false, kernel: null, issues: ['basis-mismatch'] });
    expect(buildAgentNativeKernelShadowV1({
      ...input(),
      checkpoint: { ...input().checkpoint, sequence: 1 },
    })).toEqual({ ok: false, kernel: null, issues: ['invalid-cycle-metadata'] });
    expect(buildAgentNativeKernelShadowV1({
      ...input(),
      evidence: { ...input().evidence, observedAt: '2026-09-03T12:00:01.000Z' },
    })).toEqual({ ok: false, kernel: null, issues: ['invalid-cycle-metadata'] });

    const output = kernel();
    expect(verifyAgentNativeKernelShadowV1({ ...output, unexpected: true })).toBeNull();
    expect(verifyAgentNativeKernelShadowV1({
      ...output,
      authorityBits: { ...output.authorityBits, deploy: true },
    })).toBeNull();
    expect(verifyAgentNativeKernelShadowV1({
      ...output,
      effects: { ...output.effects, files: true },
    })).toBeNull();
    expect(verifyAgentNativeKernelShadowV1({
      ...output,
      counts: { ...output.counts, effective: 2 },
    })).toBeNull();

    const incompletePartition = structuredClone(output);
    incompletePartition.counts.candidates = 2;
    incompletePartition.holdReasons = [];
    expect(verifyAgentNativeKernelShadowV1(resignKernel(incompletePartition))).toBeNull();
  });

  it('binds fresh identity, resource, portfolio, and outcome-evidence sources', () => {
    const base = input();
    expect(buildAgentNativeKernelShadowV1({
      ...base,
      evidence: { ...base.evidence, portfolioDigest: hex('2') },
    })).toEqual({ ok: false, kernel: null, issues: ['invalid-cycle-metadata'] });
    expect(buildAgentNativeKernelShadowV1({
      ...base,
      evidence: { ...base.evidence, resourceDigest: hex('3') },
    })).toEqual({ ok: false, kernel: null, issues: ['invalid-cycle-metadata'] });
    expect(buildAgentNativeKernelShadowV1({
      ...base,
      evidence: { ...base.evidence, observedAt: '2026-09-03T11:54:59.999Z' },
    })).toEqual({ ok: false, kernel: null, issues: ['invalid-cycle-metadata'] });
    expect(buildAgentNativeKernelShadowV1({
      ...base,
      executionIdentity: identity({
        identities: [{
          ...identity().identities[0]!,
          observedAt: '2026-09-03T12:00:00.001Z',
        }],
      }),
    })).toMatchObject({ ok: true, kernel: { lifecycle: 'running' } });
    expect(buildAgentNativeKernelShadowV1({
      ...base,
      executionIdentity: identity({
        identities: [{
          ...identity().identities[0]!,
          observedAt: '2026-09-03T12:01:00.001Z',
        }],
      }),
    })).toEqual({ ok: false, kernel: null, issues: ['invalid-identity-snapshot'] });
    expect(buildAgentNativeKernelShadowV1({
      ...base,
      executionIdentity: identity({
        identities: [{
          ...identity().identities[0]!,
          observedAt: '2026-09-03T11:54:59.999Z',
        }],
      }),
    })).toEqual({ ok: false, kernel: null, issues: ['invalid-identity-snapshot'] });

    const otherEnvelope = envelope({
      capacity: [{ ...envelope().capacity[0]!, executionIdentityDigest: prefixed('2') }],
    });
    const effectivePortfolio = portfolio(AFTER_WINDOW, 'effective', otherEnvelope);
    const mismatch = kernel({
      asOf: AFTER_WINDOW,
      executionIdentity: identity({
        identities: [{ ...identity().identities[0]!, observedAt: AFTER_WINDOW }],
      }),
      resourceEnvelope: otherEnvelope,
      portfolio: effectivePortfolio,
      evidence: {
        ...input({ resourceEnvelope: otherEnvelope, portfolio: effectivePortfolio }).evidence,
        observedAt: AFTER_WINDOW,
      },
      checkpoint: {
        sequence: 0,
        previousCycle: null,
        nextWakeAt: '2026-09-05T12:05:00.000Z',
      },
    });
    expect(mismatch).toMatchObject({
      lifecycle: 'degraded',
      degradedReasons: ['identity-resource-mismatch'],
      counts: { effective: 1 },
    });

    const secondIdentity = {
      ...identity().identities[0]!,
      executionIdentityDigest: prefixed('2'),
      engine: 'claude' as const,
      trustedSlots: 1,
      maxConcurrent: 1,
    };
    expect(kernel({
      executionIdentity: identity({
        configuredIdentityCount: 2,
        identities: [...identity().identities, secondIdentity],
      }),
    })).toMatchObject({
      lifecycle: 'degraded', degradedReasons: ['identity-resource-mismatch'],
      counts: { identities: 2, trustedSlots: 3 },
    });

    const stateMismatchEnvelope = envelope({
      capacity: [{ ...envelope().capacity[0]!, state: 'exhausted' }],
    });
    const stateMismatchPortfolio = portfolio(AS_OF, 'none', stateMismatchEnvelope);
    expect(kernel({
      resourceEnvelope: stateMismatchEnvelope,
      portfolio: stateMismatchPortfolio,
    })).toMatchObject({
      lifecycle: 'degraded',
      degradedReasons: ['identity-resource-mismatch'],
    });
  });

  it.each(['kimi', 'nim', 'grok'] as const)(
    'never represents the %s cloud engine as local capacity',
    (engine) => {
      const cloudIdentityDigest = prefixed(engine === 'kimi' ? '2' : engine === 'nim' ? '3' : '4');
      const cloudEnvelope = envelope({
        capacity: [
          ...envelope().capacity,
          {
            executionIdentityDigest: cloudIdentityDigest,
            provider: 'local',
            state: 'open',
            trustedTokens: 100_000,
            trustedMinutes: 120,
            resetAt: '2026-09-03T14:00:00.000Z',
          },
        ],
      });
      expect(kernel({
        executionIdentity: identity({
          configuredIdentityCount: 2,
          identities: [
            ...identity().identities,
            {
              ...identity().identities[0]!,
              executionIdentityDigest: cloudIdentityDigest,
              engine,
              trustedSlots: 1,
              maxConcurrent: 1,
            },
          ],
        }),
        resourceEnvelope: cloudEnvelope,
      })).toMatchObject({
        lifecycle: 'degraded', degradedReasons: ['identity-resource-mismatch'],
      });
    },
  );

  it('derives checkpoint continuity from the complete prior verified cycle', () => {
    const first = kernel();
    const nextPortfolio = portfolio(AFTER_WINDOW, 'effective');
    const nextBase = input({
      asOf: AFTER_WINDOW,
      executionIdentity: identity({
        identities: [{ ...identity().identities[0]!, observedAt: AFTER_WINDOW }],
      }),
      portfolio: nextPortfolio,
      evidence: {
        ...input({ portfolio: nextPortfolio }).evidence,
        observedAt: AFTER_WINDOW,
      },
      checkpoint: {
        sequence: 1,
        previousCycle: first,
        nextWakeAt: '2026-09-05T12:05:00.000Z',
      },
    });
    const next = buildAgentNativeKernelShadowV1(nextBase);
    expect(next.ok).toBe(true);
    if (!next.ok) throw new Error(next.issues.join(','));
    expect(next.kernel.checkpoint).toMatchObject({
      sequence: 1,
      previousCycleDigest: first.cycleDigest,
    });

    expect(buildAgentNativeKernelShadowV1({
      ...nextBase,
      checkpoint: { ...nextBase.checkpoint, sequence: 2 },
    })).toEqual({ ok: false, kernel: null, issues: ['invalid-cycle-metadata'] });
    expect(buildAgentNativeKernelShadowV1({
      ...nextBase,
      checkpoint: {
        ...nextBase.checkpoint,
        previousCycle: { ...first, cycleDigest: hex('3') },
      },
    })).toEqual({ ok: false, kernel: null, issues: ['invalid-cycle-metadata'] });
    expect(buildAgentNativeKernelShadowV1({
      ...input(),
      checkpoint: { sequence: 1, previousCycle: first,
        nextWakeAt: '2026-09-03T12:05:00.000Z' },
    })).toEqual({ ok: false, kernel: null, issues: ['invalid-cycle-metadata'] });
  });

  it('keeps guardrail breaches distinct from value-hypothesis refutation', () => {
    const guardrailPortfolio = portfolio(AS_OF, 'guardrail');
    const output = kernel({ portfolio: guardrailPortfolio });
    expect(output).toMatchObject({
      phase: 'observe',
      lifecycle: 'settled',
      counts: { stopped: 1, effective: 0, refuted: 0, guardrailBreached: 1 },
    });
  });

  it('rejects accessor and cyclic objects before they can masquerade as snapshots', () => {
    const accessor = { ...input() } as Record<string, unknown>;
    Object.defineProperty(accessor, 'asOf', { enumerable: true, get: () => AS_OF });
    expect(buildAgentNativeKernelShadowV1(accessor))
      .toEqual({ ok: false, kernel: null, issues: ['invalid-input'] });

    const cyclic = { ...input() } as Record<string, unknown>;
    cyclic['cycle'] = cyclic;
    expect(buildAgentNativeKernelShadowV1(cyclic))
      .toEqual({ ok: false, kernel: null, issues: ['invalid-input'] });
  });

  it('uses caller-supplied time only and emits values-free, inert public JSON', () => {
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('kernel must not read the clock');
    });
    try {
      const output = kernel();
      const json = JSON.stringify(output);
      expect(verifyAgentNativeKernelShadowV1(output)).toEqual(output);
      expect(Object.values(output.authorityBits).every((value) => value === false)).toBe(true);
      expect(Object.values(output.effects).every((value) => value === false)).toBe(true);
      expect(json).not.toMatch(/identityRef|accountRef|runtimeLocator|secret|credential|CODEX_HOME|CLAUDE_CONFIG_DIR/);
      expect(json).not.toMatch(/\/Users\/|private-store|vendor-home/);
      expect(json).not.toContain('kernel-product-bet');
      expect(json).not.toContain('retained builder value');
    } finally {
      dateSpy.mockRestore();
    }
  });
});
