import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
  type KeyObject,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  buildCapabilitySpectrumShadowV1,
  digestCapabilityClassV1,
} from '../src/core/fabric/capability-spectrum.js';
import type { ExecutionIdentityShadowStatusV1 } from '../src/core/fabric/execution-identity.js';
import {
  buildAgentNativeKernelShadowV1,
  type AgentNativeKernelEvidenceV1,
} from '../src/core/vision/agent-native-kernel.js';
import {
  agentOsSourceBundleDigestV1,
  agentOsSourceTrustKeyIdV1,
  agentOsSourceTrustPolicyDigestV1,
  canonicalAgentOsEvidenceIndexReceiptPayloadV1,
  canonicalAgentOsOutcomeReceiptPayloadV1,
  canonicalAgentOsSourceBundlePayloadV1,
  verifyAgentOsSourceBundleV1,
  type AgentOsEvidenceIndexReceiptV1,
  type AgentOsOutcomeReceiptV1,
  type AgentOsSourceBundleEnvelopeV1,
  type AgentOsSourceBundleUnsignedV1,
  type AgentOsSourceTrustKeyV1,
  type AgentOsSourceTrustPolicyV1,
  type AgentOsSourceTrustRoleV1,
} from '../src/core/vision/agent-os-source-bundle.js';
import {
  buildAgentOsReadModelV1,
  type AgentOsReadModelInputV1,
  type AgentOsSourceBundleVerificationInputV1,
} from '../src/core/vision/agent-os-read-model.js';
import {
  acceptanceContractDigestV1,
  buildPortfolioShadowV1,
  createValueHypothesisV1,
  digestResourceEnvelopeV1,
  type OutcomeEvidenceVerificationInputV1,
  type OutcomeEvidenceVerifierV1,
  type PortfolioShadowV1,
  type ResourceEnvelopeV1,
  type ValueHypothesisV1,
} from '../src/core/vision/value-portfolio.js';

const AS_OF = '2026-09-03T12:00:00.000Z';
const RENDERED_AT = '2026-09-03T12:01:00.000Z';
const ISSUED_AT = '2026-09-03T12:01:30.000Z';
const EXPIRES_AT = '2026-09-03T12:04:30.000Z';
const NOW = new Date('2026-09-03T12:02:00.000Z');
const digest = (label: string): string =>
  createHash('sha256').update(label, 'utf8').digest('hex');
const SPEC = digest('spec');
const MISSION = digest('mission');
const IDENTITY = `sha256:${digest('identity')}`;
const EVIDENCE_INDEX_DIGEST = digest('evidence-index');

interface TestSigner {
  privateKey: KeyObject;
  root: AgentOsSourceTrustKeyV1;
}

function signer(
  role: AgentOsSourceTrustRoleV1,
  label: string,
  overrides: Partial<AgentOsSourceTrustKeyV1> = {},
): TestSigner {
  const pair = generateKeyPairSync('ed25519');
  const publicKeySpki = Buffer.from(pair.publicKey.export({ format: 'der', type: 'spki' })).toString('base64url');
  const keyId = agentOsSourceTrustKeyIdV1(publicKeySpki, role);
  if (!keyId) throw new Error('expected key id');
  return {
    privateKey: pair.privateKey,
    root: {
      keyId,
      principalDigest: digest(`principal-${label}`),
      role,
      signatureAlgorithm: 'ed25519',
      publicKeySpki,
      notBefore: '2026-09-03T11:00:00.000Z',
      notAfter: '2026-09-03T13:00:00.000Z',
      revokedAt: null,
      ...overrides,
    },
  };
}

function policy(signers: readonly TestSigner[]): AgentOsSourceTrustPolicyV1 {
  return {
    schemaVersion: 1,
    protocol: 'ashlr-agent-os-source-trust-v1',
    generation: 7,
    keys: signers.map((item) => item.root).sort((left, right) => left.keyId.localeCompare(right.keyId)),
  };
}

const OUTCOME_VERIFIER: OutcomeEvidenceVerifierV1 = {
  verifyOutcomeEvidence: ({ evidence, producerDigest }) => ({
    authenticated: evidence.receiptDigest.startsWith(digest('receipt-prefix').slice(0, 8)),
    independentObserver: evidence.observerDigest !== producerDigest,
  }),
};

function hypothesis(node: string): ValueHypothesisV1 {
  const baselineDigest = digest(`baseline-${node}`);
  const acceptance = {
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
  const acceptanceContractDigest = acceptanceContractDigestV1(acceptance);
  if (!acceptanceContractDigest) throw new Error('expected acceptance digest');
  const receiptDigest = `${digest('receipt-prefix').slice(0, 8)}${digest(`receipt-${node}`).slice(8)}`;
  const value = createValueHypothesisV1({
    schemaVersion: 1,
    provenanceDigest: digest(`provenance-${node}`),
    specDigest: SPEC,
    missionDigest: MISSION,
    missionNodeKey: node,
    producerDigest: digest(`producer-${node}`),
    claim: `Improve retained builder value through ${node}.`,
    constraints: {
      dependenciesSatisfied: true,
      humanGateRequired: false,
      reversible: true,
      allowedProviders: ['codex'],
      shardable: false,
      shardPlanDigest: null,
    },
    frozenOutcome: { acceptanceContractDigest, ...acceptance },
    budget: {
      maxTokens: 100_000,
      maxMinutes: 240,
      maxAttempts: 4,
      maxInconclusiveWindows: 2,
      spentTokens: 0,
      spentMinutes: 0,
      attempts: 1,
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
      sourceDigest: digest(`outcome-source-${node}`),
      evidence: {
        format: 'outcome-evidence-v1',
        observerDigest: digest(`observer-${node}`),
        receiptDigest,
        artifactDigest: digest(`artifact-${node}`),
        deploymentDigest: digest(`deployment-${node}`),
        baselineDigest,
        acceptanceContractDigest,
        metric: 'retained-builder-value',
        value: 30,
        observedAt: AS_OF,
        windowStart: acceptance.windowStart,
        windowEnd: acceptance.windowEnd,
        causalGrade: 'quasi-experimental',
        guardrailBreached: false,
      },
    },
  }, OUTCOME_VERIFIER);
  if (!value) throw new Error('expected hypothesis');
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

function fixture(): { readModelInput: AgentOsReadModelInputV1; evidence: AgentNativeKernelEvidenceV1 } {
  const hypotheses = [hypothesis('bet-one'), hypothesis('bet-two')];
  const portfolioResult = buildPortfolioShadowV1({
    schemaVersion: 1,
    asOf: AS_OF,
    specDigest: SPEC,
    missionDigest: MISSION,
    resourceEnvelope: resourceEnvelope(),
    hypotheses,
  }, OUTCOME_VERIFIER);
  if (!portfolioResult.ok) throw new Error(portfolioResult.issues.join(','));
  const portfolio: PortfolioShadowV1 = portfolioResult.portfolio;
  const evidence: AgentNativeKernelEvidenceV1 = {
    format: 'evidence-index-v1',
    sourceComplete: true,
    evidenceDigest: EVIDENCE_INDEX_DIGEST,
    resourceDigest: portfolio.basis.resourceEnvelopeDigest,
    portfolioDigest: portfolio.portfolioDigest,
    observedAt: AS_OF,
  };
  const kernelResult = buildAgentNativeKernelShadowV1({
    schemaVersion: 1,
    asOf: AS_OF,
    specDigest: SPEC,
    missionDigest: MISSION,
    executionIdentity: identity(),
    resourceEnvelope: resourceEnvelope(),
    portfolio,
    evidence,
    checkpoint: { sequence: 0, previousCycle: null, nextWakeAt: '2026-09-03T12:05:00.000Z' },
  }, { verifyEvidenceIndex: () => ({ authenticated: true }) });
  if (!kernelResult.ok) throw new Error(kernelResult.issues.join(','));
  const resourceDigest = digestResourceEnvelopeV1(resourceEnvelope());
  if (!resourceDigest) throw new Error('expected resource digest');
  const capabilityResult = buildCapabilitySpectrumShadowV1({
    schemaVersion: 1,
    asOf: AS_OF,
    sourceDigest: `sha256:${digest('capability-source')}`,
    resourceEnvelopeDigest: resourceDigest,
    executionIdentitySourceState: 'healthy',
    executionIdentityResources: [{ resource: identity().identities[0]! }],
    resetWindows: [{ executionIdentityDigest: IDENTITY, resetAt: '2026-09-03T14:00:00.000Z' }],
    localResources: [],
    lanes: [{
      laneDigest: `sha256:${digest('lane')}`,
      queueRank: 1,
      sourceComplete: true,
      requirements: [{ kind: 'model', classDigest: digestCapabilityClassV1('model', 'codex')!, units: 1 }],
    }],
  });
  if (!capabilityResult.ok) throw new Error(capabilityResult.issues.join(','));
  return {
    evidence,
    readModelInput: {
      schemaVersion: 1,
      renderedAt: RENDERED_AT,
      kernel: kernelResult.kernel,
      capabilitySpectrum: capabilityResult.spectrum,
      portfolio,
      hypotheses,
    },
  };
}

function outcomeInput(hypothesisValue: ValueHypothesisV1): OutcomeEvidenceVerificationInputV1 {
  if (!hypothesisValue.outcomeSource.evidence) throw new Error('expected outcome evidence');
  return {
    evidence: hypothesisValue.outcomeSource.evidence,
    sourceDigest: hypothesisValue.outcomeSource.sourceDigest,
    producerDigest: hypothesisValue.producerDigest,
    specDigest: hypothesisValue.specDigest,
    missionDigest: hypothesisValue.missionDigest,
  };
}

function sign(privateKey: KeyObject, payload: Buffer | null): string {
  if (!payload) throw new Error('expected canonical payload');
  return signBytes(null, payload, privateKey).toString('base64url');
}

interface BundleFixture {
  envelope: AgentOsSourceBundleEnvelopeV1;
  policy: AgentOsSourceTrustPolicyV1;
  source: TestSigner;
  evidence: TestSigner;
  outcome: TestSigner;
  outcomes: readonly TestSigner[];
}

function bundleFixture(options: {
  source?: TestSigner;
  evidence?: TestSigner;
  outcome?: TestSigner;
  issuedAt?: string;
  expiresAt?: string;
} = {}): BundleFixture {
  const source = options.source ?? signer('source-observer', 'source');
  const evidenceSigner = options.evidence ?? signer('evidence-index-observer', 'evidence');
  const { readModelInput, evidence } = fixture();
  const outcomes = options.outcome
    ? [options.outcome]
    : readModelInput.hypotheses.map((_hypothesis, index) => signer('outcome-observer', `outcome-${index}`));
  const outcome = outcomes[0]!;
  const trustPolicy = policy([source, evidenceSigner, ...outcomes]);
  const evidenceUnsigned = {
    schemaVersion: 1 as const,
    protocol: 'ashlr-agent-os-evidence-index-receipt-v1' as const,
    keyId: evidenceSigner.root.keyId,
    principalDigest: evidenceSigner.root.principalDigest,
    signatureAlgorithm: 'ed25519' as const,
    specDigest: SPEC,
    missionDigest: MISSION,
    evidence,
  };
  const evidenceIndexReceipt: AgentOsEvidenceIndexReceiptV1 = {
    ...evidenceUnsigned,
    signature: sign(evidenceSigner.privateKey, canonicalAgentOsEvidenceIndexReceiptPayloadV1(evidenceUnsigned)),
  };
  const outcomeReceipts = readModelInput.hypotheses.map((hypothesisValue, index) => {
    const outcomeSigner = outcomes[index] ?? outcome;
    const unsigned = {
      schemaVersion: 1 as const,
      protocol: 'ashlr-agent-os-outcome-receipt-v1' as const,
      keyId: outcomeSigner.root.keyId,
      principalDigest: outcomeSigner.root.principalDigest,
      signatureAlgorithm: 'ed25519' as const,
      input: outcomeInput(hypothesisValue),
    };
    return {
      ...unsigned,
      signature: sign(outcomeSigner.privateKey, canonicalAgentOsOutcomeReceiptPayloadV1(unsigned)),
    } satisfies AgentOsOutcomeReceiptV1;
  }).sort((left, right) => left.input.evidence.receiptDigest.localeCompare(right.input.evidence.receiptDigest));
  const trustPolicyDigest = agentOsSourceTrustPolicyDigestV1(trustPolicy);
  if (!trustPolicyDigest) throw new Error('expected policy digest');
  const unsigned: AgentOsSourceBundleUnsignedV1 = {
    schemaVersion: 1,
    protocol: 'ashlr-agent-os-source-bundle-v1',
    recordType: 'agent-os-source-bundle',
    authority: 'observation-only',
    planningAuthority: false,
    executionAuthority: false,
    proposalAuthority: false,
    mergeAuthority: false,
    releaseAuthority: false,
    deployAuthority: false,
    publicationAuthority: false,
    externalMutationAuthority: false,
    learningAuthority: false,
    budgetAuthority: false,
    effects: {
      files: false,
      models: false,
      providers: false,
      dispatches: false,
      goals: false,
      proposals: false,
      merges: false,
      releases: false,
      deployments: false,
      publications: false,
      externalMutations: false,
      budgets: false,
      learning: false,
    },
    sequence: 1,
    previousBundleDigest: '0'.repeat(64),
    issuedAt: options.issuedAt ?? ISSUED_AT,
    expiresAt: options.expiresAt ?? EXPIRES_AT,
    policyGeneration: trustPolicy.generation,
    trustPolicyDigest,
    sourceKeyId: source.root.keyId,
    sourcePrincipalDigest: source.root.principalDigest,
    readModelInput,
    evidenceIndexReceipt,
    producerBindings: readModelInput.hypotheses.map((hypothesisValue) => ({
      producerDigest: hypothesisValue.producerDigest,
      principalDigest: digest(`producer-principal-${hypothesisValue.missionNodeKey}`),
      bindingAuthority: 'source-observer-attestation' as const,
    })).sort((left, right) => left.producerDigest.localeCompare(right.producerDigest)),
    outcomeReceipts,
  };
  return {
    envelope: seal(unsigned, source.privateKey),
    policy: trustPolicy,
    source,
    evidence: evidenceSigner,
    outcome,
    outcomes,
  };
}

function unsignedOf(envelope: AgentOsSourceBundleEnvelopeV1): AgentOsSourceBundleUnsignedV1 {
  const { bundleDigest: _bundleDigest, signatureAlgorithm: _algorithm, signature: _signature, ...unsigned } = envelope;
  return unsigned;
}

function seal(unsigned: AgentOsSourceBundleUnsignedV1, privateKey: KeyObject): AgentOsSourceBundleEnvelopeV1 {
  const signature = sign(privateKey, canonicalAgentOsSourceBundlePayloadV1(unsigned));
  const bundleDigest = agentOsSourceBundleDigestV1(unsigned, signature);
  if (!bundleDigest) throw new Error('expected bundle digest');
  return { ...unsigned, bundleDigest, signatureAlgorithm: 'ed25519', signature };
}

function sourceTuple(input: AgentOsReadModelInputV1): AgentOsSourceBundleVerificationInputV1 {
  return {
    renderedAt: input.renderedAt,
    kernelCycleDigest: input.kernel.cycleDigest,
    evidenceIndexDigest: input.kernel.basis.evidenceDigest,
    capabilityProjectionDigest: input.capabilitySpectrum.projectionDigest,
    portfolioDigest: input.portfolio.portfolioDigest,
    hypothesisDigests: input.hypotheses.map((item) => item.hypothesisDigest).sort(),
    outcomeReceiptDigests: input.hypotheses.map((item) => item.outcomeSource.evidence!.receiptDigest).sort(),
  };
}

describe('M535 Agent OS independently signed source bundle', () => {
  it('authenticates the exact bundle and returns a verifier closed over its tuple and outcome inputs', () => {
    const fixtureValue = bundleFixture();
    const result = verifyAgentOsSourceBundleV1(fixtureValue.envelope, fixtureValue.policy, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundleDigest).toBe(fixtureValue.envelope.bundleDigest);
    expect(buildAgentOsReadModelV1(result.readModelInput, result.verifier).ok).toBe(true);
    expect(result.verifier.verifySourceBundle(sourceTuple(result.readModelInput))).toEqual({
      sourceBundleAuthenticated: true,
      evidenceIndexAuthenticated: true,
    });
    expect(result.verifier.verifySourceBundle({
      ...sourceTuple(result.readModelInput),
      evidenceIndexDigest: digest('caller-marker-bypass'),
    })).toEqual({ sourceBundleAuthenticated: false, evidenceIndexAuthenticated: false });
    const exactOutcome = outcomeInput(result.readModelInput.hypotheses[0]!);
    expect(result.verifier.outcomeEvidenceVerifier.verifyOutcomeEvidence(exactOutcome)).toEqual({
      authenticated: true,
      independentObserver: true,
    });
    expect(result.verifier.outcomeEvidenceVerifier.verifyOutcomeEvidence({
      ...exactOutcome,
      sourceDigest: digest('different-source'),
    })).toEqual({ authenticated: false, independentObserver: false });
  });

  it('fails closed under the default-empty trust policy', () => {
    const fixtureValue = bundleFixture();
    expect(verifyAgentOsSourceBundleV1(fixtureValue.envelope, undefined, NOW)).toMatchObject({
      ok: false,
      issues: ['trust-root-unprovisioned'],
    });
  });

  it('detects exact payload tampering and invalid source signatures', () => {
    const fixtureValue = bundleFixture();
    const tampered = structuredClone(fixtureValue.envelope);
    tampered.readModelInput.hypotheses[0]!.claim = 'Tampered claim';
    expect(verifyAgentOsSourceBundleV1(tampered, fixtureValue.policy, NOW)).toMatchObject({
      ok: false,
      issues: ['bundle-digest-invalid'],
    });
    const recomputed = {
      ...tampered,
      bundleDigest: agentOsSourceBundleDigestV1(unsignedOf(tampered), tampered.signature)!,
    };
    expect(verifyAgentOsSourceBundleV1(recomputed, fixtureValue.policy, NOW)).toMatchObject({
      ok: false,
      issues: ['bundle-signature-invalid'],
    });
  });

  it('rejects a source key that is provisioned under the wrong role', () => {
    const fixtureValue = bundleFixture();
    const unsigned = unsignedOf(fixtureValue.envelope);
    unsigned.sourceKeyId = fixtureValue.outcome.root.keyId;
    unsigned.sourcePrincipalDigest = fixtureValue.outcome.root.principalDigest;
    const wrongRole = seal(unsigned, fixtureValue.outcome.privateKey);
    expect(verifyAgentOsSourceBundleV1(wrongRole, fixtureValue.policy, NOW)).toMatchObject({
      ok: false,
      issues: ['source-key-invalid'],
    });
  });

  it('rejects expired and future-dated bundles', () => {
    const expired = bundleFixture({
      issuedAt: '2026-09-03T11:50:00.000Z',
      expiresAt: '2026-09-03T11:55:00.000Z',
    });
    expect(verifyAgentOsSourceBundleV1(expired.envelope, expired.policy, NOW)).toMatchObject({
      ok: false,
      issues: ['bundle-expired'],
    });
    const future = bundleFixture({
      issuedAt: '2026-09-03T12:04:00.000Z',
      expiresAt: '2026-09-03T12:06:00.000Z',
    });
    expect(verifyAgentOsSourceBundleV1(future.envelope, future.policy, NOW)).toMatchObject({
      ok: false,
      issues: ['bundle-not-current'],
    });
  });

  it('rejects unknown and revoked source keys', () => {
    const fixtureValue = bundleFixture();
    const unknownUnsigned = unsignedOf(fixtureValue.envelope);
    unknownUnsigned.sourceKeyId = digest('unknown-key');
    const unknown = seal(unknownUnsigned, fixtureValue.source.privateKey);
    expect(verifyAgentOsSourceBundleV1(unknown, fixtureValue.policy, NOW)).toMatchObject({
      ok: false,
      issues: ['source-key-unknown'],
    });

    const revokedPolicy = structuredClone(fixtureValue.policy);
    const sourceRoot = revokedPolicy.keys.find((key) => key.keyId === fixtureValue.source.root.keyId)!;
    sourceRoot.revokedAt = '2026-09-03T12:01:45.000Z';
    const revokedDigest = agentOsSourceTrustPolicyDigestV1(revokedPolicy)!;
    const revokedUnsigned = unsignedOf(fixtureValue.envelope);
    revokedUnsigned.trustPolicyDigest = revokedDigest;
    const revoked = seal(revokedUnsigned, fixtureValue.source.privateKey);
    expect(verifyAgentOsSourceBundleV1(revoked, revokedPolicy, NOW)).toMatchObject({
      ok: false,
      issues: ['source-key-revoked'],
    });
  });

  it('requires source and evidence signatures to use separate keys even with distinct principals', () => {
    const sharedPair = generateKeyPairSync('ed25519');
    const publicKeySpki = Buffer.from(sharedPair.publicKey.export({ format: 'der', type: 'spki' })).toString('base64url');
    const makeShared = (role: AgentOsSourceTrustRoleV1): TestSigner => ({
      privateKey: sharedPair.privateKey,
      root: {
        keyId: agentOsSourceTrustKeyIdV1(publicKeySpki, role)!,
        principalDigest: digest(`shared-key-${role}`),
        role,
        signatureAlgorithm: 'ed25519',
        publicKeySpki,
        notBefore: '2026-09-03T11:00:00.000Z',
        notAfter: '2026-09-03T13:00:00.000Z',
        revokedAt: null,
      },
    });
    const collided = bundleFixture({
      source: makeShared('source-observer'),
      evidence: makeShared('evidence-index-observer'),
    });
    expect(verifyAgentOsSourceBundleV1(collided.envelope, collided.policy, NOW)).toMatchObject({
      ok: false,
      issues: ['source-evidence-separation-failed'],
    });
  });

  it('rejects one principal provisioned into multiple independent trust roles', () => {
    const fixtureValue = bundleFixture();
    const collidedPolicy = structuredClone(fixtureValue.policy);
    const source = collidedPolicy.keys.find((key) => key.role === 'source-observer')!;
    const evidence = collidedPolicy.keys.find((key) => key.role === 'evidence-index-observer')!;
    evidence.principalDigest = source.principalDigest;

    expect(verifyAgentOsSourceBundleV1(fixtureValue.envelope, collidedPolicy, NOW)).toMatchObject({
      ok: false,
      issues: ['trust-policy-invalid'],
    });
  });

  it('requires outcome observers to be key- and principal-separated from source and evidence observers', () => {
    const sharedPair = generateKeyPairSync('ed25519');
    const publicKeySpki = Buffer.from(sharedPair.publicKey.export({ format: 'der', type: 'spki' })).toString('base64url');
    const source: TestSigner = {
      privateKey: sharedPair.privateKey,
      root: {
        ...signer('source-observer', 'shared-source').root,
        keyId: agentOsSourceTrustKeyIdV1(publicKeySpki, 'source-observer')!,
        publicKeySpki,
      },
    };
    const outcome: TestSigner = {
      privateKey: sharedPair.privateKey,
      root: {
        ...signer('outcome-observer', 'shared-outcome').root,
        keyId: agentOsSourceTrustKeyIdV1(publicKeySpki, 'outcome-observer')!,
        publicKeySpki,
      },
    };
    const collided = bundleFixture({ source, outcome });

    expect(verifyAgentOsSourceBundleV1(collided.envelope, collided.policy, NOW)).toMatchObject({
      ok: false,
      issues: ['outcome-observer-separation-failed'],
    });
  });

  it('requires a distinct outcome-observer principal for each outcome receipt', () => {
    const outcome = signer('outcome-observer', 'reused-outcome');
    const collided = bundleFixture({ outcome });

    expect(verifyAgentOsSourceBundleV1(collided.envelope, collided.policy, NOW)).toMatchObject({
      ok: false,
      issues: ['outcome-observer-separation-failed'],
    });
  });

  it('rejects an outcome observer principal that matches the bound hypothesis producer', () => {
    const fixtureValue = bundleFixture();
    const unsigned = unsignedOf(fixtureValue.envelope);
    unsigned.producerBindings[0]!.principalDigest = fixtureValue.outcome.root.principalDigest;
    const collided = seal(unsigned, fixtureValue.source.privateKey);
    expect(verifyAgentOsSourceBundleV1(collided, fixtureValue.policy, NOW)).toMatchObject({
      ok: false,
      issues: ['outcome-producer-separation-failed'],
    });
  });

  it('rejects reordered signed collections and caller-authored verification markers', () => {
    const fixtureValue = bundleFixture();
    const reorderedUnsigned = unsignedOf(structuredClone(fixtureValue.envelope));
    reorderedUnsigned.producerBindings.reverse();
    const reordered = seal(reorderedUnsigned, fixtureValue.source.privateKey);
    expect(verifyAgentOsSourceBundleV1(reordered, fixtureValue.policy, NOW)).toMatchObject({
      ok: false,
      issues: ['producer-binding-invalid'],
    });

    const reorderedOutcomes = unsignedOf(structuredClone(fixtureValue.envelope));
    reorderedOutcomes.outcomeReceipts.reverse();
    expect(verifyAgentOsSourceBundleV1(
      seal(reorderedOutcomes, fixtureValue.source.privateKey),
      fixtureValue.policy,
      NOW,
    )).toMatchObject({ ok: false, issues: ['outcome-binding-mismatch'] });

    const marker = structuredClone(fixtureValue.envelope) as AgentOsSourceBundleEnvelopeV1 & {
      preverified?: boolean;
    };
    marker.preverified = true;
    expect(verifyAgentOsSourceBundleV1(marker, fixtureValue.policy, NOW)).toMatchObject({
      ok: false,
      issues: ['invalid-input'],
    });
  });

  it('binds evidence and each outcome signature to the exact full input', () => {
    const fixtureValue = bundleFixture();
    const evidenceUnsigned = unsignedOf(structuredClone(fixtureValue.envelope));
    evidenceUnsigned.evidenceIndexReceipt.evidence.observedAt = '2026-09-03T11:59:59.000Z';
    const resignedSource = seal(evidenceUnsigned, fixtureValue.source.privateKey);
    expect(verifyAgentOsSourceBundleV1(resignedSource, fixtureValue.policy, NOW)).toMatchObject({
      ok: false,
      issues: ['evidence-signature-invalid'],
    });

    const outcomeUnsigned = unsignedOf(structuredClone(fixtureValue.envelope));
    outcomeUnsigned.outcomeReceipts[0]!.input.sourceDigest = digest('forged-source');
    const resignedOutcomeSource = seal(outcomeUnsigned, fixtureValue.source.privateKey);
    expect(verifyAgentOsSourceBundleV1(resignedOutcomeSource, fixtureValue.policy, NOW)).toMatchObject({
      ok: false,
      issues: ['outcome-binding-mismatch'],
    });
  });
});
