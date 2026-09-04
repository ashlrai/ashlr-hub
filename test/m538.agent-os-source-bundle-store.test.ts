import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
  type KeyObject,
} from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

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
  canonicalAgentOsSourceBundleEnvelopeBytesV1,
  canonicalAgentOsSourceBundlePayloadV1,
  type AgentOsEvidenceIndexReceiptV1,
  type AgentOsSourceBundleEnvelopeV1,
  type AgentOsSourceBundleUnsignedV1,
  type AgentOsSourceTrustKeyV1,
  type AgentOsSourceTrustPolicyV1,
  type AgentOsSourceTrustRoleV1,
} from '../src/core/vision/agent-os-source-bundle.js';
import {
  appendAgentOsSourceBundleV1,
  readAgentOsSourceBundleStoreV1,
  recoverAgentOsSourceBundleStoreV1,
  withCurrentAgentOsSourceBundleLeaseV1,
  type AgentOsSourceBundleStoreDependenciesV1,
} from '../src/core/vision/agent-os-source-bundle-store.js';
import type { AgentOsReadModelInputV1 } from '../src/core/vision/agent-os-read-model.js';
import {
  buildPortfolioShadowV1,
  digestResourceEnvelopeV1,
  type PortfolioShadowV1,
  type ResourceEnvelopeV1,
} from '../src/core/vision/value-portfolio.js';

const AS_OF = '2026-09-03T12:00:00.000Z';
const RENDERED_AT = '2026-09-03T12:01:00.000Z';
const NOW = new Date('2026-09-03T12:02:00.000Z');
const digest = (label: string): string => createHash('sha256').update(label).digest('hex');
const SPEC = digest('store-spec');
const MISSION = digest('store-mission');
const IDENTITY = `sha256:${digest('store-identity')}`;
const EVIDENCE_DIGEST = digest('store-evidence');
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

interface Signer {
  privateKey: KeyObject;
  root: AgentOsSourceTrustKeyV1;
}

function signer(role: AgentOsSourceTrustRoleV1, label: string): Signer {
  const pair = generateKeyPairSync('ed25519');
  const publicKeySpki = Buffer.from(pair.publicKey.export({ format: 'der', type: 'spki' })).toString('base64url');
  return {
    privateKey: pair.privateKey,
    root: {
      keyId: agentOsSourceTrustKeyIdV1(publicKeySpki, role)!,
      principalDigest: digest(`store-principal-${label}`),
      role,
      signatureAlgorithm: 'ed25519',
      publicKeySpki,
      notBefore: '2026-09-03T11:00:00.000Z',
      notAfter: '2026-09-03T13:00:00.000Z',
      revokedAt: null,
    },
  };
}

function policyOf(signers: readonly Signer[], generation = 3): AgentOsSourceTrustPolicyV1 {
  return {
    schemaVersion: 1,
    protocol: 'ashlr-agent-os-source-trust-v1',
    generation,
    keys: signers.map((item) => item.root).sort((left, right) => left.keyId.localeCompare(right.keyId)),
  };
}

function envelope(): ResourceEnvelopeV1 {
  return {
    schemaVersion: 1,
    sourceComplete: true,
    sourceDigest: digest('store-resource-source'),
    reserveFraction: 0.1,
    capacity: [{
      executionIdentityDigest: IDENTITY,
      provider: 'codex',
      state: 'open',
      trustedTokens: 20_000,
      trustedMinutes: 60,
      resetAt: '2026-09-03T13:00:00.000Z',
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
      trustedSlots: 1,
      maxConcurrent: 1,
      usedPercent: 10,
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

function readModelFixture(): { input: AgentOsReadModelInputV1; evidence: AgentNativeKernelEvidenceV1 } {
  const portfolioResult = buildPortfolioShadowV1({
    schemaVersion: 1,
    asOf: AS_OF,
    specDigest: SPEC,
    missionDigest: MISSION,
    resourceEnvelope: envelope(),
    hypotheses: [],
  });
  if (!portfolioResult.ok) throw new Error(portfolioResult.issues.join(','));
  const portfolio: PortfolioShadowV1 = portfolioResult.portfolio;
  const evidence: AgentNativeKernelEvidenceV1 = {
    format: 'evidence-index-v1',
    sourceComplete: true,
    evidenceDigest: EVIDENCE_DIGEST,
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
    resourceEnvelope: envelope(),
    portfolio,
    evidence,
    checkpoint: { sequence: 0, previousCycle: null, nextWakeAt: '2026-09-03T12:05:00.000Z' },
  }, { verifyEvidenceIndex: () => ({ authenticated: true }) });
  if (!kernelResult.ok) throw new Error(kernelResult.issues.join(','));
  const resourceDigest = digestResourceEnvelopeV1(envelope());
  if (!resourceDigest) throw new Error('expected resource digest');
  const capabilityResult = buildCapabilitySpectrumShadowV1({
    schemaVersion: 1,
    asOf: AS_OF,
    sourceDigest: `sha256:${digest('store-capability-source')}`,
    resourceEnvelopeDigest: resourceDigest,
    executionIdentitySourceState: 'healthy',
    executionIdentityResources: [{ resource: identity().identities[0]! }],
    resetWindows: [{ executionIdentityDigest: IDENTITY, resetAt: '2026-09-03T13:00:00.000Z' }],
    localResources: [],
    lanes: [{
      laneDigest: `sha256:${digest('store-lane')}`,
      queueRank: 1,
      sourceComplete: true,
      requirements: [{ kind: 'model', classDigest: digestCapabilityClassV1('model', 'codex')!, units: 1 }],
    }],
  });
  if (!capabilityResult.ok) throw new Error(capabilityResult.issues.join(','));
  return {
    evidence,
    input: {
      schemaVersion: 1,
      renderedAt: RENDERED_AT,
      kernel: kernelResult.kernel,
      capabilitySpectrum: capabilityResult.spectrum,
      portfolio,
      hypotheses: [],
    },
  };
}

function signature(privateKey: KeyObject, payload: Buffer | null): string {
  if (!payload) throw new Error('missing payload');
  return signBytes(null, payload, privateKey).toString('base64url');
}

interface Fixture {
  source: Signer;
  evidence: Signer;
  policy: AgentOsSourceTrustPolicyV1;
  dependencies: AgentOsSourceBundleStoreDependenciesV1;
  anchor: string;
  root: string;
}

function storeFixture(maxBundles?: number): Fixture {
  const temporary = mkdtempSync(join(tmpdir(), 'ashlr-source-bundle-store-'));
  roots.push(temporary);
  const anchor = join(temporary, '.ashlr');
  mkdirSync(anchor, { mode: 0o700 });
  chmodSync(anchor, 0o700);
  const source = signer('source-observer', 'source');
  const evidence = signer('evidence-index-observer', 'evidence');
  const policy = policyOf([source, evidence]);
  const root = join(anchor, 'agent-os-source-bundles-v1');
  return {
    source,
    evidence,
    policy,
    anchor,
    root,
    dependencies: { anchorPath: anchor, rootPath: root, trustPolicy: policy, clock: () => NOW, maxBundles },
  };
}

function signedBundle(
  fixtureValue: Fixture,
  sequence: number,
  previousBundleDigest: string,
  issuedAt = `2026-09-03T12:01:${String(sequence).padStart(2, '0')}.000Z`,
): AgentOsSourceBundleEnvelopeV1 {
  const { input, evidence } = readModelFixture();
  const evidenceUnsigned = {
    schemaVersion: 1 as const,
    protocol: 'ashlr-agent-os-evidence-index-receipt-v1' as const,
    keyId: fixtureValue.evidence.root.keyId,
    principalDigest: fixtureValue.evidence.root.principalDigest,
    signatureAlgorithm: 'ed25519' as const,
    specDigest: SPEC,
    missionDigest: MISSION,
    evidence,
  };
  const evidenceIndexReceipt: AgentOsEvidenceIndexReceiptV1 = {
    ...evidenceUnsigned,
    signature: signature(
      fixtureValue.evidence.privateKey,
      canonicalAgentOsEvidenceIndexReceiptPayloadV1(evidenceUnsigned),
    ),
  };
  const trustPolicyDigest = agentOsSourceTrustPolicyDigestV1(fixtureValue.policy)!;
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
    sequence,
    previousBundleDigest,
    issuedAt,
    expiresAt: '2026-09-03T12:04:30.000Z',
    policyGeneration: fixtureValue.policy.generation,
    trustPolicyDigest,
    sourceKeyId: fixtureValue.source.root.keyId,
    sourcePrincipalDigest: fixtureValue.source.root.principalDigest,
    readModelInput: input,
    evidenceIndexReceipt,
    producerBindings: [],
    outcomeReceipts: [],
  };
  const sourceSignature = signature(
    fixtureValue.source.privateKey,
    canonicalAgentOsSourceBundlePayloadV1(unsigned),
  );
  return {
    ...unsigned,
    bundleDigest: agentOsSourceBundleDigestV1(unsigned, sourceSignature)!,
    signatureAlgorithm: 'ed25519',
    signature: sourceSignature,
  };
}

function writeDirect(root: string, bundle: AgentOsSourceBundleEnvelopeV1): string {
  const sequence = String(bundle.sequence).padStart(12, '0');
  const path = join(root, 'records', `${sequence}-${bundle.bundleDigest}.json`);
  const bytes = canonicalAgentOsSourceBundleEnvelopeBytesV1(bundle)!;
  writeFileSync(path, `${bytes.toString('utf8')}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

describe('M538 durable Agent OS source-bundle registry', () => {
  it('persists a linear sequence, replays idempotently, and returns a pinned current verifier', () => {
    const fixtureValue = storeFixture();
    const first = signedBundle(fixtureValue, 1, '0'.repeat(64));
    expect(appendAgentOsSourceBundleV1(first, fixtureValue.dependencies)).toMatchObject({
      disposition: 'recorded', reason: 'recorded',
    });
    const second = signedBundle(fixtureValue, 2, first.bundleDigest);
    expect(appendAgentOsSourceBundleV1(second, fixtureValue.dependencies)).toMatchObject({
      disposition: 'recorded', reason: 'recorded',
    });
    expect(appendAgentOsSourceBundleV1(second, fixtureValue.dependencies)).toMatchObject({
      disposition: 'replayed', reason: 'bundle-replay',
    });
    const read = readAgentOsSourceBundleStoreV1(fixtureValue.dependencies);
    expect(read).toMatchObject({ sourceState: 'healthy', complete: true, executionAuthority: false });
    expect(read.bundles).toHaveLength(2);
    expect(read.current).toMatchObject({ sequence: 2, bundleDigest: second.bundleDigest, executionAuthority: false });
    const current = read.current!;
    const input = current.readModelInput;
    expect(current.verifier.verifySourceBundle({
      renderedAt: input.renderedAt,
      kernelCycleDigest: input.kernel.cycleDigest,
      evidenceIndexDigest: input.kernel.basis.evidenceDigest,
      capabilityProjectionDigest: input.capabilitySpectrum.projectionDigest,
      portfolioDigest: input.portfolio.portfolioDigest,
      hypothesisDigests: [],
      outcomeReceiptDigests: [],
    })).toEqual({ sourceBundleAuthenticated: true, evidenceIndexAuthenticated: true });
  });

  it('leases only the exact current signed source under the publication fence', () => {
    const fixtureValue = storeFixture();
    const first = signedBundle(fixtureValue, 1, '0'.repeat(64));
    expect(appendAgentOsSourceBundleV1(first, fixtureValue.dependencies).disposition).toBe('recorded');
    expect(withCurrentAgentOsSourceBundleLeaseV1(
      first.bundleDigest,
      fixtureValue.dependencies,
      (current) => current.sequence,
    )).toEqual({ state: 'held', current: expect.objectContaining({ bundleDigest: first.bundleDigest }), value: 1 });
    expect(withCurrentAgentOsSourceBundleLeaseV1(
      digest('not-current'),
      fixtureValue.dependencies,
      () => 'must-not-run',
    )).toMatchObject({ state: 'changed', current: { bundleDigest: first.bundleDigest }, value: null });
  });

  it('never reports a held source lease when the shared lock cannot be released', () => {
    const fixtureValue = storeFixture();
    const first = signedBundle(fixtureValue, 1, '0'.repeat(64));
    expect(appendAgentOsSourceBundleV1(first, fixtureValue.dependencies).disposition).toBe('recorded');
    const lockPath = join(fixtureValue.anchor, '.agent-os-observation-transaction-v1.lock');
    const result = withCurrentAgentOsSourceBundleLeaseV1(
      first.bundleDigest,
      fixtureValue.dependencies,
      () => {
        unlinkSync(lockPath);
        writeFileSync(lockPath, '{"replaced":true}\n', { mode: 0o600 });
        return 'must-not-escape';
      },
    );
    expect(result).toEqual({ state: 'unavailable', current: null, value: null });
  });

  it('rejects gaps, wrong predecessors, and non-monotonic issue times before persistence', () => {
    const fixtureValue = storeFixture();
    const first = signedBundle(fixtureValue, 1, '0'.repeat(64));
    expect(appendAgentOsSourceBundleV1(first, fixtureValue.dependencies).disposition).toBe('recorded');
    expect(appendAgentOsSourceBundleV1(
      signedBundle(fixtureValue, 3, first.bundleDigest),
      fixtureValue.dependencies,
    )).toMatchObject({ disposition: 'rejected', reason: 'sequence-conflict' });
    expect(appendAgentOsSourceBundleV1(
      signedBundle(fixtureValue, 2, digest('wrong-predecessor')),
      fixtureValue.dependencies,
    )).toMatchObject({ disposition: 'rejected', reason: 'predecessor-mismatch' });
    expect(appendAgentOsSourceBundleV1(
      signedBundle(fixtureValue, 2, first.bundleDigest, first.issuedAt),
      fixtureValue.dependencies,
    )).toMatchObject({ disposition: 'rejected', reason: 'non-monotonic-issued-at' });
  });

  it('rejects input tampering and withholds every record after on-disk corruption', () => {
    const fixtureValue = storeFixture();
    const first = signedBundle(fixtureValue, 1, '0'.repeat(64));
    const tampered = structuredClone(first);
    tampered.readModelInput.renderedAt = '2026-09-03T12:01:01.000Z';
    expect(appendAgentOsSourceBundleV1(tampered, fixtureValue.dependencies)).toMatchObject({
      disposition: 'rejected', reason: 'invalid-input',
    });
    expect(appendAgentOsSourceBundleV1(first, fixtureValue.dependencies).disposition).toBe('recorded');
    const path = join(fixtureValue.root, 'records', `000000000001-${first.bundleDigest}.json`);
    const bytes = readFileSync(path);
    bytes[20] = bytes[20] === 65 ? 66 : 65;
    writeFileSync(path, bytes, { mode: 0o600 });
    chmodSync(path, 0o600);
    const read = readAgentOsSourceBundleStoreV1(fixtureValue.dependencies);
    expect(read.sourceState).toBe('degraded');
    expect(read.complete).toBe(false);
    expect(read.bundles).toEqual([]);
    expect(read.current).toBeNull();
  });

  it('withholds the ledger on a direct gap or fork', () => {
    const gapFixture = storeFixture();
    const first = signedBundle(gapFixture, 1, '0'.repeat(64));
    expect(appendAgentOsSourceBundleV1(first, gapFixture.dependencies).disposition).toBe('recorded');
    writeDirect(gapFixture.root, signedBundle(gapFixture, 3, first.bundleDigest));
    expect(readAgentOsSourceBundleStoreV1(gapFixture.dependencies)).toMatchObject({
      sourceState: 'degraded', complete: false, bundles: [], current: null, stopReasons: ['sequence-gap'],
    });

    const forkFixture = storeFixture();
    const forkFirst = signedBundle(forkFixture, 1, '0'.repeat(64));
    expect(appendAgentOsSourceBundleV1(forkFirst, forkFixture.dependencies).disposition).toBe('recorded');
    const fork = signedBundle(forkFixture, 1, '0'.repeat(64), '2026-09-03T12:01:20.000Z');
    writeDirect(forkFixture.root, fork);
    expect(readAgentOsSourceBundleStoreV1(forkFixture.dependencies)).toMatchObject({
      sourceState: 'degraded', complete: false, bundles: [], current: null, stopReasons: ['duplicate-sequence'],
    });
  });

  it('fails closed for unsafe or non-child storage paths', () => {
    const fixtureValue = storeFixture();
    expect(readAgentOsSourceBundleStoreV1({
      ...fixtureValue.dependencies,
      rootPath: join(fixtureValue.anchor, 'nested', 'store'),
    })).toMatchObject({
      sourceState: 'degraded', complete: false, sourcePresent: false, bundles: [], current: null,
      stopReasons: ['invalid-options'],
    });
  });

  it('withholds records when the selected policy rotates or revokes a root', () => {
    const fixtureValue = storeFixture();
    const first = signedBundle(fixtureValue, 1, '0'.repeat(64));
    expect(appendAgentOsSourceBundleV1(first, fixtureValue.dependencies).disposition).toBe('recorded');
    const rotated = structuredClone(fixtureValue.policy);
    rotated.generation += 1;
    expect(readAgentOsSourceBundleStoreV1({ ...fixtureValue.dependencies, trustPolicy: rotated })).toMatchObject({
      sourceState: 'degraded', complete: false, bundles: [], current: null,
    });
    const revoked = structuredClone(fixtureValue.policy);
    revoked.keys.find((key) => key.keyId === fixtureValue.source.root.keyId)!.revokedAt =
      '2026-09-03T12:01:30.000Z';
    expect(readAgentOsSourceBundleStoreV1({ ...fixtureValue.dependencies, trustPolicy: revoked })).toMatchObject({
      sourceState: 'degraded', complete: false, bundles: [], current: null,
    });
  });

  it('detects writer residue and conservatively removes an authenticated one-link stage', () => {
    const fixtureValue = storeFixture();
    const first = signedBundle(fixtureValue, 1, '0'.repeat(64));
    expect(appendAgentOsSourceBundleV1(first, fixtureValue.dependencies).disposition).toBe('recorded');
    const id = `000000000001-${first.bundleDigest}`;
    const target = join(fixtureValue.root, 'records', `${id}.json`);
    const stage = join(fixtureValue.root, 'staging', `.${id}.${first.bundleDigest.slice(0, 32)}.stage`);
    copyFileSync(target, stage);
    chmodSync(stage, 0o600);
    expect(readAgentOsSourceBundleStoreV1(fixtureValue.dependencies)).toMatchObject({
      sourceState: 'degraded', complete: false, bundles: [], current: null,
    });
    expect(recoverAgentOsSourceBundleStoreV1(fixtureValue.dependencies)).toBe('clean');
    expect(readAgentOsSourceBundleStoreV1(fixtureValue.dependencies)).toMatchObject({
      sourceState: 'healthy', complete: true,
    });
  });

  it('enforces configured capacity without damaging the current bundle', () => {
    const fixtureValue = storeFixture(1);
    const first = signedBundle(fixtureValue, 1, '0'.repeat(64));
    expect(appendAgentOsSourceBundleV1(first, fixtureValue.dependencies).disposition).toBe('recorded');
    const second = signedBundle(fixtureValue, 2, first.bundleDigest);
    expect(appendAgentOsSourceBundleV1(second, fixtureValue.dependencies)).toMatchObject({
      disposition: 'rejected', reason: 'capacity-exhausted',
    });
    expect(readAgentOsSourceBundleStoreV1(fixtureValue.dependencies).current?.bundleDigest).toBe(first.bundleDigest);
  });

  it('distinguishes a missing store from an unprovisioned trust policy without creating either', () => {
    const fixtureValue = storeFixture();
    expect(readAgentOsSourceBundleStoreV1(fixtureValue.dependencies)).toMatchObject({
      sourceState: 'missing', sourcePresent: false, complete: false, bundles: [], current: null,
    });
    expect(appendAgentOsSourceBundleV1(
      signedBundle(fixtureValue, 1, '0'.repeat(64)),
      fixtureValue.dependencies,
    ).disposition).toBe('recorded');
    expect(readAgentOsSourceBundleStoreV1({
      ...fixtureValue.dependencies,
      trustPolicy: {
        schemaVersion: 1,
        protocol: 'ashlr-agent-os-source-trust-v1',
        generation: 0,
        keys: [],
      },
    })).toMatchObject({
      sourceState: 'degraded', complete: false, bundles: [], current: null,
      stopReasons: ['trust-root-unprovisioned'],
    });
  });
});
