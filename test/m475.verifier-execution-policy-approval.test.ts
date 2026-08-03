import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const trustState = vi.hoisted(() => ({
  policy: {
    schemaVersion: 1,
    protocol: 'ashlr-verifier-execution-policy-approval-trust-v1',
    policyGeneration: 0,
    roots: [] as unknown[],
  },
}));

vi.mock('../src/core/run/verifier-execution-policy-trust-roots.js', async (importOriginal) => ({
  ...await importOriginal<
  typeof import('../src/core/run/verifier-execution-policy-trust-roots.js')
  >(),
  VERIFIER_EXECUTION_POLICY_APPROVAL_TRUST_POLICY: trustState.policy,
}));

import {
  VERIFIER_EXECUTION_AUTHORITY_PROTOCOL_V2,
  VERIFIER_EXECUTION_SIGNATURE_ALGORITHM,
  VERIFIER_EXECUTION_TRUST_PROTOCOL_V1,
  canonicalVerifierExecutionAuthorityPayloadV2,
  verifierExecutionAuthorityKeyId,
  verifierExecutionAuthorityTrustPolicyDigest,
  type InspectVerifierExecutionAuthorityV2Input,
  type VerifierExecutionAuthorityStatementUnsignedV2,
  type VerifierExecutionExpectedBindingsV1,
  type VerifierExecutionTrustPolicyV1,
} from '../src/core/run/verifier-execution-authority.js';
import {
  VERIFIER_EXECUTION_POLICY_APPROVAL_BLOCKERS_V1,
  VERIFIER_EXECUTION_POLICY_APPROVAL_PROTOCOL_V1,
  canonicalVerifierExecutionPolicyApprovalPayloadV1,
  inspectVerifierExecutionCompositionV1,
  inspectVerifierExecutionPolicyApprovalV1,
  verifierExecutionApprovedTrustPolicyDigestV1,
  verifierExecutionPolicyApprovalTrustPolicyDigest,
  verifierExecutionPolicyApproverKeyId,
  type InspectVerifierExecutionPolicyApprovalV1Input,
  type VerifierExecutionCompositionIdentityV1,
  type VerifierExecutionPolicyApprovalEnvelopeV1,
  type VerifierExecutionPolicyApprovalScopeV1,
  type VerifierExecutionPolicyApprovalUnsignedV1,
} from '../src/core/run/verifier-execution-policy-approval.js';

const NOW = Date.parse('2026-08-02T15:05:00.000Z');
const ISSUED_AT = '2026-08-02T15:00:00.000Z';
const EXPIRES_AT = '2026-08-02T15:10:00.000Z';

function digest(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

function publicKeySpki(key: KeyObject): string {
  return Buffer.from(key.export({ format: 'der', type: 'spki' })).toString('base64url');
}

interface Fixture {
  input: InspectVerifierExecutionPolicyApprovalV1Input;
  approval: VerifierExecutionPolicyApprovalEnvelopeV1;
  approvalPrivateKey: KeyObject;
  approvalPublicKeySpki: string;
  capsulePrivateKey: KeyObject;
  capsulePublicKeySpki: string;
  executionAuthorityInput: InspectVerifierExecutionAuthorityV2Input;
  expectedIdentity: VerifierExecutionCompositionIdentityV1;
  unsignedApproval: VerifierExecutionPolicyApprovalUnsignedV1;
}

function fixture(options: {
  provisionRoot?: boolean;
  minimumApprovedPolicyGeneration?: number;
  policyGeneration?: number;
  rootNotAfter?: string;
  revokedAt?: string | null;
  shareCapsuleKey?: boolean;
} = {}): Fixture {
  const capsuleKeys = generateKeyPairSync('ed25519');
  const approvalKeys = options.shareCapsuleKey ? capsuleKeys : generateKeyPairSync('ed25519');
  const capsulePublicKeySpki = publicKeySpki(capsuleKeys.publicKey);
  const approvalPublicKeySpki = publicKeySpki(approvalKeys.publicKey);
  const capsuleKeyId = verifierExecutionAuthorityKeyId(capsulePublicKeySpki)!;
  const approverKeyId = verifierExecutionPolicyApproverKeyId(approvalPublicKeySpki)!;
  const scope: VerifierExecutionPolicyApprovalScopeV1 = {
    fleetDigest: digest('fleet:ashlr-production'),
    repositoryDigest: digest('repository:ashlrai/ashlr-hub'),
    environmentDigest: digest('environment:production'),
    platform: 'linux',
    architecture: 'x64',
    backend: 'linux-namespace-cgroup-broker',
  };
  if (options.provisionRoot) {
    trustState.policy.policyGeneration = 7;
    trustState.policy.roots = [{
      keyId: approverKeyId,
      publicKeySpki: approvalPublicKeySpki,
      role: 'verifier-execution-policy-approver',
      signatureAlgorithm: 'ed25519',
      fleetDigest: scope.fleetDigest,
      repositoryDigest: scope.repositoryDigest,
      environmentDigest: scope.environmentDigest,
      allowedPlatforms: ['darwin', 'linux', 'win32'],
      allowedArchitectures: ['arm64', 'x64'],
      allowedBackends: [
        'linux-namespace-cgroup-broker',
        'macos-virtualization-framework-broker',
        'windows-appcontainer-job-broker',
      ],
      minimumApprovedPolicyGeneration: options.minimumApprovedPolicyGeneration ?? 4,
      notBefore: '2026-08-02T14:00:00.000Z',
      notAfter: options.rootNotAfter ?? '2026-08-02T16:00:00.000Z',
      revokedAt: options.revokedAt ?? null,
    }];
  }

  const trustPolicy: VerifierExecutionTrustPolicyV1 = {
    schemaVersion: 1,
    protocol: VERIFIER_EXECUTION_TRUST_PROTOCOL_V1,
    policyVersion: 'capsule-admission-2026-08',
    keys: [{
      keyId: capsuleKeyId,
      signatureAlgorithm: VERIFIER_EXECUTION_SIGNATURE_ALGORITHM,
      role: 'verifier-capsule-admission-signer',
      publicKeySpki: capsulePublicKeySpki,
      notBefore: '2026-08-02T14:00:00.000Z',
      notAfter: '2026-08-02T16:00:00.000Z',
      allowedPlatforms: ['darwin', 'linux', 'win32'],
      allowedArchitectures: ['arm64', 'x64'],
      allowedBackends: [
        'linux-namespace-cgroup-broker',
        'macos-virtualization-framework-broker',
        'windows-appcontainer-job-broker',
      ],
    }],
  };
  const approvedTrustPolicyDigest = verifierExecutionAuthorityTrustPolicyDigest(trustPolicy)!;
  expect(verifierExecutionApprovedTrustPolicyDigestV1(trustPolicy)).toBe(approvedTrustPolicyDigest);
  const expectedBindings: VerifierExecutionExpectedBindingsV1 = {
    ticketDigest: digest('ticket'),
    candidateDigest: digest('candidate'),
    baseDigest: digest('base'),
    commandPlanDigest: digest('command-plan'),
    capsuleTreeDigest: digest('capsule-tree'),
    executableDigest: digest('executable'),
    dependencyDigest: digest('dependency'),
    brokerDigest: digest('broker'),
    isolationPolicyDigest: digest('isolation-policy'),
    commandEntrypoints: [{
      commandId: 'test',
      entrypoint: '/opt/ashlr/verifier-capsule/entrypoints/test',
    }],
    capsuleRoot: '/opt/ashlr/verifier-capsule',
    platform: scope.platform,
    architecture: scope.architecture,
    backend: scope.backend,
  };
  const unsignedStatement: VerifierExecutionAuthorityStatementUnsignedV2 = {
    schemaVersion: 1,
    protocol: VERIFIER_EXECUTION_AUTHORITY_PROTOCOL_V2,
    assurance: 'externally-signed-capsule-observation',
    ...structuredClone(expectedBindings),
    candidateMount: 'read-only',
    hostMounts: [],
    networkPolicy: 'denied',
    descendantOwnership: 'kernel-owned',
    capsuleMutability: 'immutable',
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    nonce: Buffer.alloc(24, 3).toString('base64url'),
    trustPolicyDigest: approvedTrustPolicyDigest,
    keyId: capsuleKeyId,
    signatureAlgorithm: VERIFIER_EXECUTION_SIGNATURE_ALGORITHM,
    executionPermitted: false,
    mergePermitted: false,
    evidencePermitted: false,
  };
  const executionAuthorityInput: InspectVerifierExecutionAuthorityV2Input = {
    statement: {
      ...unsignedStatement,
      signature: sign(
        null,
        canonicalVerifierExecutionAuthorityPayloadV2(unsignedStatement)!,
        capsuleKeys.privateKey,
      ).toString('base64url'),
    },
    trustPolicy,
    expectedPolicyDigest: approvedTrustPolicyDigest,
    expectedBindings,
    nowMs: NOW,
  };
  const expectedIdentity: VerifierExecutionCompositionIdentityV1 = {
    ticketDigest: expectedBindings.ticketDigest,
    candidateDigest: expectedBindings.candidateDigest,
    baseDigest: expectedBindings.baseDigest,
    commandPlanDigest: expectedBindings.commandPlanDigest,
    capsuleTreeDigest: expectedBindings.capsuleTreeDigest,
    executableDigest: expectedBindings.executableDigest,
    dependencyDigest: expectedBindings.dependencyDigest,
    brokerDigest: expectedBindings.brokerDigest,
    isolationPolicyDigest: expectedBindings.isolationPolicyDigest,
    platform: expectedBindings.platform,
    architecture: expectedBindings.architecture,
    backend: expectedBindings.backend,
  };
  const policyGeneration = options.policyGeneration ?? 4;
  const unsignedApproval: VerifierExecutionPolicyApprovalUnsignedV1 = {
    schemaVersion: 1,
    protocol: VERIFIER_EXECUTION_POLICY_APPROVAL_PROTOCOL_V1,
    assurance: 'externally-approved-verifier-execution-policy',
    approvedTrustPolicyDigest,
    approvedTrustProtocol: VERIFIER_EXECUTION_TRUST_PROTOCOL_V1,
    policyGeneration,
    ...scope,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    nonce: Buffer.alloc(24, 9).toString('base64url'),
    approverKeyId,
    approverRole: 'verifier-execution-policy-approver',
    signatureAlgorithm: 'ed25519',
    authority: 'observation-only',
    replayTransparencyVerified: false,
    executionPermitted: false,
    evidencePermitted: false,
    mergePermitted: false,
    activationPermitted: false,
    deployPermitted: false,
  };
  const approval: VerifierExecutionPolicyApprovalEnvelopeV1 = {
    ...unsignedApproval,
    signature: sign(
      null,
      canonicalVerifierExecutionPolicyApprovalPayloadV1(unsignedApproval)!,
      approvalKeys.privateKey,
    ).toString('base64url'),
  };
  return {
    approval,
    approvalPrivateKey: approvalKeys.privateKey,
    approvalPublicKeySpki,
    capsulePrivateKey: capsuleKeys.privateKey,
    capsulePublicKeySpki,
    executionAuthorityInput,
    expectedIdentity,
    unsignedApproval,
    input: {
      approval,
      approvedTrustPolicy: trustPolicy,
      expectedApprovedTrustPolicyDigest: approvedTrustPolicyDigest,
      expectedPolicyGeneration: policyGeneration,
      expectedScope: structuredClone(scope),
      nowMs: NOW,
    },
  };
}

function resignApproval(
  value: Fixture,
  overrides: Record<string, unknown>,
): InspectVerifierExecutionPolicyApprovalV1Input {
  const unsigned = {
    ...value.unsignedApproval,
    ...overrides,
  } as unknown as VerifierExecutionPolicyApprovalUnsignedV1;
  const payload = canonicalVerifierExecutionPolicyApprovalPayloadV1(unsigned);
  const approval = payload === null
    ? { ...value.approval, ...overrides }
    : { ...unsigned, signature: sign(null, payload, value.approvalPrivateKey).toString('base64url') };
  return { ...value.input, approval } as InspectVerifierExecutionPolicyApprovalV1Input;
}

function compositionInput(value: Fixture) {
  return {
    policyApprovalInput: structuredClone(value.input),
    executionAuthorityInput: structuredClone(value.executionAuthorityInput),
    expectedIdentity: structuredClone(value.expectedIdentity),
    timeAuthorityObservation: {
      schemaVersion: 1 as const,
      protocol: 'ashlr-verifier-execution-time-authority-observation-v1' as const,
      state: 'unavailable' as const,
      authority: 'none' as const,
      observedAt: null,
      receiptDigest: null,
      clockAuthorityVerified: false as const,
    },
  };
}

function authorityWithPolicyVersion(
  value: Fixture,
  policyVersion: string,
): InspectVerifierExecutionAuthorityV2Input {
  const input = structuredClone(value.executionAuthorityInput);
  input.trustPolicy.policyVersion = policyVersion;
  const policyDigest = verifierExecutionAuthorityTrustPolicyDigest(input.trustPolicy)!;
  const { signature: _signature, ...unsigned } = input.statement;
  const nextUnsigned = { ...unsigned, trustPolicyDigest: policyDigest };
  input.statement = {
    ...nextUnsigned,
    signature: sign(
      null,
      canonicalVerifierExecutionAuthorityPayloadV2(nextUnsigned)!,
      value.capsulePrivateKey,
    ).toString('base64url'),
  };
  input.expectedPolicyDigest = policyDigest;
  return input;
}

function allAuthorityFalse(result: ReturnType<typeof inspectVerifierExecutionPolicyApprovalV1>): void {
  expect(result).toMatchObject({
    authority: 'observation-only',
    trustPolicyApprovalVerified: false,
    clockAuthorityVerified: false,
    freshnessState: 'unavailable',
    freshnessObservedAt: null,
    replayTransparencyVerified: false,
    executionPermitted: false,
    evidencePermitted: false,
    mergePermitted: false,
    activationPermitted: false,
    deployPermitted: false,
    blockers: VERIFIER_EXECUTION_POLICY_APPROVAL_BLOCKERS_V1,
  });
}

beforeEach(() => {
  trustState.policy.policyGeneration = 0;
  trustState.policy.roots = [];
});

describe('M475 Verifier Policy Approval Authority V1', () => {
  it('ships with empty code-owned production roots and no ambient fallback', () => {
    const value = fixture();
    const result = inspectVerifierExecutionPolicyApprovalV1(value.input);
    expect(result).toMatchObject({
      state: 'withheld',
      reason: 'trust-root-unprovisioned',
      trustRootProvisioned: false,
      trustPolicyApprovalVerified: false,
    });
    allAuthorityFalse(result);

    const source = readFileSync(join(
      process.cwd(), 'src/core/run/verifier-execution-policy-trust-roots.ts',
    ), 'utf8');
    expect(source).toContain('roots: Object.freeze([])');
    expect(source).not.toMatch(/process\.env|Deno\.env|Bun\.env|BEGIN (?:PRIVATE|OPENSSH) KEY/);
  });

  it('verifies exact role-separated cryptography without claiming freshness or authority', () => {
    const value = fixture({ provisionRoot: true });
    const first = inspectVerifierExecutionPolicyApprovalV1(value.input);
    const replay = inspectVerifierExecutionPolicyApprovalV1(structuredClone(value.input));

    expect(first).toMatchObject({
      state: 'cryptographically-verified',
      reason: 'policy-approval-cryptography-verified',
      approvalDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      approvedTrustPolicyDigest: value.unsignedApproval.approvedTrustPolicyDigest,
      approvalTrustPolicyDigest: verifierExecutionPolicyApprovalTrustPolicyDigest(),
      policyGeneration: 4,
      approvalTrustPolicyGeneration: 7,
      approverKeyId: value.unsignedApproval.approverKeyId,
      capsuleStatementVerified: false,
      signatureVerified: true,
      approvalCryptographyVerified: true,
      trustPolicyApprovalVerified: false,
      trustRootProvisioned: true,
      replayTransparencyVerified: false,
      clockAuthorityVerified: false,
      freshnessState: 'unavailable',
      freshnessObservedAt: null,
    });
    expect(replay).toEqual(first);
    allAuthorityFalse(first);
  });

  it('binds the exact #202 policy digest against caller and signer substitution', () => {
    const value = fixture({ provisionRoot: true });
    expect(inspectVerifierExecutionPolicyApprovalV1(resignApproval(value, {
      approvedTrustPolicyDigest: digest('substituted-policy'),
    })).reason).toBe('approved-policy-digest-mismatch');

    const substituted = structuredClone(value.input);
    substituted.expectedApprovedTrustPolicyDigest = digest('caller-selected-policy');
    expect(inspectVerifierExecutionPolicyApprovalV1(substituted).reason)
      .toBe('approved-policy-digest-mismatch');
  });

  it('rejects approved-protocol substitution before signature authority', () => {
    const value = fixture({ provisionRoot: true });
    expect(inspectVerifierExecutionPolicyApprovalV1(resignApproval(value, {
      approvedTrustProtocol: 'ashlr-verifier-execution-trust-v0',
    })).reason).toBe('approval-invalid');
  });

  it.each([
    ['fleetDigest', digest('other-fleet')],
    ['repositoryDigest', digest('other-repository')],
    ['environmentDigest', digest('other-environment')],
    ['platform', 'darwin'],
    ['architecture', 'arm64'],
    ['backend', 'macos-virtualization-framework-broker'],
  ])('rejects signed scope replay through %s', (field, replacement) => {
    const value = fixture({ provisionRoot: true });
    expect(inspectVerifierExecutionPolicyApprovalV1(
      resignApproval(value, { [field]: replacement }),
    ).reason).toBe('scope-mismatch');
  });

  it('rejects expected-scope substitution independently of the signed envelope', () => {
    const value = fixture({ provisionRoot: true });
    const input = structuredClone(value.input);
    input.expectedScope.repositoryDigest = digest('caller-other-repository');
    expect(inspectVerifierExecutionPolicyApprovalV1(input).reason).toBe('scope-mismatch');
  });

  it('rejects policy generation substitution and code-owned downgrade', () => {
    const mismatch = fixture({ provisionRoot: true });
    expect(inspectVerifierExecutionPolicyApprovalV1({
      ...mismatch.input,
      expectedPolicyGeneration: 5,
    }).reason).toBe('policy-generation-mismatch');

    const downgraded = fixture({
      provisionRoot: true,
      policyGeneration: 4,
      minimumApprovedPolicyGeneration: 5,
    });
    expect(inspectVerifierExecutionPolicyApprovalV1(downgraded.input).reason)
      .toBe('policy-generation-downgrade');
  });

  it('rejects approver and capsule-signer identity collision even across key-id domains', () => {
    const value = fixture({ provisionRoot: true, shareCapsuleKey: true });
    expect(value.approvalPublicKeySpki).toBe(value.capsulePublicKeySpki);
    expect(inspectVerifierExecutionPolicyApprovalV1(value.input).reason)
      .toBe('approver-capsule-role-collision');
  });

  it('rejects unknown, wrong-role, non-Ed25519, and noncanonical approval roots', () => {
    const unknown = fixture({ provisionRoot: true });
    const unrelatedKeys = generateKeyPairSync('ed25519');
    const unrelatedSpki = publicKeySpki(unrelatedKeys.publicKey);
    trustState.policy.roots = [{
      ...(trustState.policy.roots[0] as Record<string, unknown>),
      keyId: verifierExecutionPolicyApproverKeyId(unrelatedSpki),
      publicKeySpki: unrelatedSpki,
    }];
    expect(inspectVerifierExecutionPolicyApprovalV1(unknown.input).reason)
      .toBe('approver-key-unknown');

    const wrongRole = fixture({ provisionRoot: true });
    (trustState.policy.roots[0] as Record<string, unknown>).role = 'verifier-capsule-admission-signer';
    expect(inspectVerifierExecutionPolicyApprovalV1(wrongRole.input).reason)
      .toBe('trust-policy-invalid');

    const rsa = fixture({ provisionRoot: true });
    const rsaKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaSpki = publicKeySpki(rsaKeys.publicKey);
    const root = trustState.policy.roots[0] as Record<string, unknown>;
    root.publicKeySpki = rsaSpki;
    root.keyId = digest('fake-rsa-key-id');
    expect(inspectVerifierExecutionPolicyApprovalV1(rsa.input).reason)
      .toBe('trust-policy-invalid');

    const noncanonical = fixture({ provisionRoot: true });
    (trustState.policy.roots[0] as Record<string, unknown>).publicKeySpki =
      `${noncanonical.approvalPublicKeySpki}=`;
    expect(inspectVerifierExecutionPolicyApprovalV1(noncanonical.input).reason)
      .toBe('trust-policy-invalid');
  });

  it('rejects duplicate and unsorted roots', () => {
    const value = fixture({ provisionRoot: true });
    const root = structuredClone(trustState.policy.roots[0]);
    trustState.policy.roots = [root, structuredClone(root)];
    expect(inspectVerifierExecutionPolicyApprovalV1(value.input).reason)
      .toBe('trust-policy-invalid');
  });

  it.each([
    ['reversed', { expiresAt: '2026-08-02T14:59:59.000Z' }],
    ['too-long', { expiresAt: '2026-08-02T15:10:00.001Z' }],
  ])('rejects a structurally %s approval window', (_label, changes) => {
    const value = fixture({ provisionRoot: true });
    expect(inspectVerifierExecutionPolicyApprovalV1(resignApproval(value, changes)).reason)
      .toBe('approval-lifetime-invalid');
  });

  it('never converts caller-selected historical time into freshness authority', () => {
    const value = fixture({ provisionRoot: true });
    const historical = inspectVerifierExecutionPolicyApprovalV1({ ...value.input, nowMs: NOW });
    const epoch = inspectVerifierExecutionPolicyApprovalV1({ ...value.input, nowMs: 0 });
    const farFuture = inspectVerifierExecutionPolicyApprovalV1({
      ...value.input,
      nowMs: Date.parse('2100-01-01T00:00:00.000Z'),
    });

    for (const result of [historical, epoch, farFuture]) {
      expect(result).toMatchObject({
        state: 'cryptographically-verified',
        reason: 'policy-approval-cryptography-verified',
        approvalCryptographyVerified: true,
        trustPolicyApprovalVerified: false,
        clockAuthorityVerified: false,
        freshnessState: 'unavailable',
      });
      allAuthorityFalse(result);
    }
  });

  it('rejects inactive and revoked approver roots', () => {
    const inactive = fixture({
      provisionRoot: true,
      rootNotAfter: '2026-08-02T15:04:00.000Z',
    });
    expect(inspectVerifierExecutionPolicyApprovalV1(inactive.input).reason)
      .toBe('approver-key-inactive');

    const revoked = fixture({
      provisionRoot: true,
      revokedAt: '2026-08-02T15:04:00.000Z',
    });
    expect(inspectVerifierExecutionPolicyApprovalV1(revoked.input).reason)
      .toBe('approver-key-revoked');

    const outlivesRevocation = fixture({
      provisionRoot: true,
      revokedAt: '2026-08-02T15:07:00.000Z',
    });
    expect(inspectVerifierExecutionPolicyApprovalV1(outlivesRevocation.input).reason)
      .toBe('approver-key-revoked');
  });

  it('rejects malformed signatures and every signed authority escalation', () => {
    const value = fixture({ provisionRoot: true });
    expect(inspectVerifierExecutionPolicyApprovalV1({
      ...value.input,
      approval: { ...value.approval, signature: Buffer.alloc(64, 5).toString('base64url') },
    }).reason).toBe('signature-invalid');

    for (const field of [
      'replayTransparencyVerified', 'executionPermitted', 'evidencePermitted', 'mergePermitted',
      'activationPermitted', 'deployPermitted',
    ]) {
      const result = inspectVerifierExecutionPolicyApprovalV1(resignApproval(value, { [field]: true }));
      expect(result.reason).toBe('approval-invalid');
      allAuthorityFalse(result);
    }
  });

  it('rejects unknown fields, sparse arrays, getters, proxies, cycles, and oversized policies', () => {
    const unknown = fixture({ provisionRoot: true });
    expect(inspectVerifierExecutionPolicyApprovalV1({
      ...unknown.input,
      callerApprovalRoot: trustState.policy,
    }).reason).toBe('invalid-input');

    const sparse = fixture({ provisionRoot: true });
    const sparseRoots = new Array(2);
    sparseRoots[1] = trustState.policy.roots[0];
    trustState.policy.roots = sparseRoots;
    expect(inspectVerifierExecutionPolicyApprovalV1(sparse.input).reason)
      .toBe('trust-policy-invalid');

    const getter = fixture({ provisionRoot: true });
    const getterInput = { ...getter.input } as Record<string, unknown>;
    Object.defineProperty(getterInput, 'nowMs', { enumerable: true, get: () => NOW });
    expect(inspectVerifierExecutionPolicyApprovalV1(getterInput).reason).toBe('invalid-input');

    const proxy = new Proxy({}, {
      getPrototypeOf: () => { throw new Error('proxy canary'); },
    });
    expect(() => inspectVerifierExecutionPolicyApprovalV1(proxy)).not.toThrow();
    expect(inspectVerifierExecutionPolicyApprovalV1(proxy).reason).toBe('invalid-input');

    const cyclic = fixture({ provisionRoot: true });
    const cyclicInput = { ...cyclic.input } as Record<string, unknown>;
    cyclicInput.self = cyclicInput;
    expect(inspectVerifierExecutionPolicyApprovalV1(cyclicInput).reason).toBe('invalid-input');

    const oversized = fixture({ provisionRoot: true });
    trustState.policy.roots = Array.from({ length: 17 }, (_, index) => ({
      ...(trustState.policy.roots[0] as Record<string, unknown>),
      keyId: index.toString(16).padStart(64, '0'),
    }));
    expect(inspectVerifierExecutionPolicyApprovalV1(oversized.input).reason)
      .toBe('trust-policy-invalid');
  });

  it('rejects malformed and substituted approved capsule policies', () => {
    const value = fixture({ provisionRoot: true });
    const input = structuredClone(value.input);
    input.approvedTrustPolicy.keys[0]!.role = 'other-role' as 'verifier-capsule-admission-signer';
    expect(inspectVerifierExecutionPolicyApprovalV1(input).reason)
      .toBe('approved-policy-invalid');
  });

  it('persists only bounded metadata in results', () => {
    const value = fixture({ provisionRoot: true });
    const result = inspectVerifierExecutionPolicyApprovalV1(value.input);
    const composition = inspectVerifierExecutionCompositionV1(compositionInput(value));
    const serialized = JSON.stringify([result, composition]);
    for (const secret of [
      'raw prompt canary', 'diff --git canary', '/private/path/canary', 'stdout canary',
      'stderr canary', 'SECRET_ENV=canary', 'file contents canary', value.approval.signature,
      value.approvalPublicKeySpki, '/opt/ashlr/verifier-capsule/entrypoints/test',
    ]) expect(serialized).not.toContain(secret);
  });

  it('keeps same-generation equivocation visible and non-authoritative', () => {
    const first = fixture({ provisionRoot: true });
    const firstResult = inspectVerifierExecutionPolicyApprovalV1(first.input);

    const secondPolicy = structuredClone(first.input.approvedTrustPolicy);
    secondPolicy.policyVersion = 'capsule-admission-2026-08-equivocation';
    const secondDigest = verifierExecutionApprovedTrustPolicyDigestV1(secondPolicy)!;
    const secondInput = resignApproval(first, { approvedTrustPolicyDigest: secondDigest });
    secondInput.approvedTrustPolicy = secondPolicy;
    secondInput.expectedApprovedTrustPolicyDigest = secondDigest;
    const secondResult = inspectVerifierExecutionPolicyApprovalV1(secondInput);

    expect(firstResult.state).toBe('cryptographically-verified');
    expect(secondResult.state).toBe('cryptographically-verified');
    expect(secondResult.approvedTrustPolicyDigest).not.toBe(firstResult.approvedTrustPolicyDigest);
    allAuthorityFalse(firstResult);
    allAuthorityFalse(secondResult);
  });

  it('canonically composes both observations but stops at unavailable freshness', () => {
    const value = fixture({ provisionRoot: true });
    const result = inspectVerifierExecutionCompositionV1(compositionInput(value));

    expect(result).toMatchObject({
      state: 'freshness-unavailable',
      reason: 'clock-authority-unavailable',
      trustPolicyDigest: value.input.expectedApprovedTrustPolicyDigest,
      approvalDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      statementDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      bindingDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      policyApprovalCryptographyVerified: true,
      capsuleStatementCryptographyVerified: true,
      identityBindingVerified: true,
      scopeBindingVerified: true,
      trustPolicyApprovalVerified: false,
      clockAuthorityVerified: false,
      freshnessState: 'unavailable',
      freshnessObservedAt: null,
    });
    allAuthorityFalse(result);
  });

  it('rejects policy A plus independently valid statement B mix-and-match', () => {
    const value = fixture({ provisionRoot: true });
    const input = compositionInput(value);
    input.executionAuthorityInput = authorityWithPolicyVersion(
      value,
      'capsule-admission-2026-08-policy-b',
    );

    const result = inspectVerifierExecutionCompositionV1(input);
    expect(result).toMatchObject({
      state: 'withheld',
      reason: 'trust-policy-mismatch',
      trustPolicyApprovalVerified: false,
      clockAuthorityVerified: false,
    });
    allAuthorityFalse(result);
  });

  it.each([
    'ticketDigest', 'candidateDigest', 'baseDigest', 'commandPlanDigest', 'capsuleTreeDigest',
    'executableDigest', 'dependencyDigest', 'brokerDigest', 'isolationPolicyDigest',
  ] as const)('rejects composition identity substitution for %s', (field) => {
    const value = fixture({ provisionRoot: true });
    const input = compositionInput(value);
    input.expectedIdentity[field] = digest(`substituted:${field}`);
    const result = inspectVerifierExecutionCompositionV1(input);
    expect(result.reason).toBe('identity-mismatch');
    allAuthorityFalse(result);
  });

  it.each([
    ['platform', 'darwin'],
    ['architecture', 'arm64'],
    ['backend', 'macos-virtualization-framework-broker'],
  ] as const)('rejects composition platform identity substitution for %s', (field, replacement) => {
    const value = fixture({ provisionRoot: true });
    const input = compositionInput(value);
    Object.assign(input.expectedIdentity, { [field]: replacement });
    const result = inspectVerifierExecutionCompositionV1(input);
    expect(result.reason).toBe('identity-mismatch');
    allAuthorityFalse(result);
  });

  it('rejects a valid policy-approval scope that differs from the statement scope', () => {
    const value = fixture({ provisionRoot: true });
    const input = compositionInput(value);
    input.policyApprovalInput = resignApproval(value, { platform: 'darwin' });
    input.policyApprovalInput.expectedScope.platform = 'darwin';
    const result = inspectVerifierExecutionCompositionV1(input);
    expect(result.reason).toBe('scope-mismatch');
    allAuthorityFalse(result);
  });

  it('fails closed when either cryptographic observation is invalid', () => {
    const policyInvalid = fixture({ provisionRoot: true });
    const policyInput = compositionInput(policyInvalid);
    policyInput.policyApprovalInput.approval.signature = Buffer.alloc(64, 7).toString('base64url');
    expect(inspectVerifierExecutionCompositionV1(policyInput).reason)
      .toBe('policy-approval-unverified');

    const statementInvalid = fixture({ provisionRoot: true });
    const statementInput = compositionInput(statementInvalid);
    statementInput.executionAuthorityInput.statement.signature =
      Buffer.alloc(64, 8).toString('base64url');
    expect(inspectVerifierExecutionCompositionV1(statementInput).reason)
      .toBe('capsule-statement-unverified');
  });

  it('rejects caller-invented clock authority and retains the unavailable contract', () => {
    const value = fixture({ provisionRoot: true });
    const input = compositionInput(value) as unknown as Record<string, unknown>;
    input['timeAuthorityObservation'] = {
      schemaVersion: 1,
      protocol: 'ashlr-verifier-execution-time-authority-observation-v1',
      state: 'authenticated',
      authority: 'caller',
      observedAt: '2026-08-02T15:05:00.000Z',
      receiptDigest: digest('caller-clock'),
      clockAuthorityVerified: true,
    };
    const result = inspectVerifierExecutionCompositionV1(input);
    expect(result.reason).toBe('invalid-input');
    allAuthorityFalse(result);
  });

  it('keeps historically selected nowMs freshness-unqualified after full composition', () => {
    const value = fixture({ provisionRoot: true });
    const input = compositionInput(value);
    input.policyApprovalInput.nowMs = NOW;
    input.executionAuthorityInput.nowMs = NOW;
    const result = inspectVerifierExecutionCompositionV1(input);
    expect(result).toMatchObject({
      state: 'freshness-unavailable',
      reason: 'clock-authority-unavailable',
      trustPolicyApprovalVerified: false,
      clockAuthorityVerified: false,
      freshnessState: 'unavailable',
    });
    allAuthorityFalse(result);
  });

  it('contains hostile composition objects inside the fail-closed boundary', () => {
    const value = fixture({ provisionRoot: true });
    const unknown = { ...compositionInput(value), extraAuthority: true };
    expect(inspectVerifierExecutionCompositionV1(unknown).reason).toBe('invalid-input');

    const getter = compositionInput(value) as Record<string, unknown>;
    Object.defineProperty(getter, 'expectedIdentity', {
      enumerable: true,
      get: () => value.expectedIdentity,
    });
    expect(inspectVerifierExecutionCompositionV1(getter).reason).toBe('invalid-input');

    const proxy = new Proxy({}, {
      getPrototypeOf: () => { throw new Error('composition proxy canary'); },
    });
    expect(() => inspectVerifierExecutionCompositionV1(proxy)).not.toThrow();
    expect(inspectVerifierExecutionCompositionV1(proxy).reason).toBe('invalid-input');

    const cyclic = compositionInput(value) as unknown as Record<string, unknown>;
    cyclic['cycle'] = cyclic;
    expect(inspectVerifierExecutionCompositionV1(cyclic).reason).toBe('invalid-input');
  });

  it('is a crypto-only verifier with no operational or signing imports', () => {
    const approvalSource = readFileSync(join(
      process.cwd(), 'src/core/run/verifier-execution-policy-approval.ts',
    ), 'utf8');
    const rootsSource = readFileSync(join(
      process.cwd(), 'src/core/run/verifier-execution-policy-trust-roots.ts',
    ), 'utf8');
    const combined = `${approvalSource}\n${rootsSource}`;
    expect(combined).not.toMatch(/from ['"]node:(?:fs|net|http|https|tls|child_process|worker_threads)['"]/);
    expect(combined).not.toMatch(/from ['"][^'"]*(?:daemon|storage|store|ledger|runner|executor)[^'"]*['"]/);
    expect(approvalSource).not.toMatch(
      /import\s*\{[^}]*\bsign\b[^}]*\}\s*from ['"]node:crypto/s,
    );
    expect(approvalSource).not.toMatch(/\bcreatePrivateKey\b|\bgenerateKeyPair/);
  });
});
