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
  VERIFIER_EXECUTION_SIGNATURE_ALGORITHM,
  VERIFIER_EXECUTION_TRUST_PROTOCOL_V1,
  verifierExecutionAuthorityKeyId,
  verifierExecutionAuthorityTrustPolicyDigest,
  type VerifierExecutionTrustPolicyV1,
} from '../src/core/run/verifier-execution-authority.js';
import {
  VERIFIER_EXECUTION_POLICY_APPROVAL_BLOCKERS_V1,
  VERIFIER_EXECUTION_POLICY_APPROVAL_PROTOCOL_V1,
  canonicalVerifierExecutionPolicyApprovalPayloadV1,
  inspectVerifierExecutionPolicyApprovalV1,
  verifierExecutionApprovedTrustPolicyDigestV1,
  verifierExecutionPolicyApprovalTrustPolicyDigest,
  verifierExecutionPolicyApproverKeyId,
  type InspectVerifierExecutionPolicyApprovalV1Input,
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
  capsulePublicKeySpki: string;
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
    capsulePublicKeySpki,
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

function allAuthorityFalse(result: ReturnType<typeof inspectVerifierExecutionPolicyApprovalV1>): void {
  expect(result).toMatchObject({
    authority: 'observation-only',
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

  it('authenticates an exact role-separated approval while granting no authority', () => {
    const value = fixture({ provisionRoot: true });
    const first = inspectVerifierExecutionPolicyApprovalV1(value.input);
    const replay = inspectVerifierExecutionPolicyApprovalV1(structuredClone(value.input));

    expect(first).toMatchObject({
      state: 'authenticated',
      reason: 'policy-approval-authenticated',
      approvalDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      approvedTrustPolicyDigest: value.unsignedApproval.approvedTrustPolicyDigest,
      approvalTrustPolicyDigest: verifierExecutionPolicyApprovalTrustPolicyDigest(),
      policyGeneration: 4,
      approvalTrustPolicyGeneration: 7,
      approverKeyId: value.unsignedApproval.approverKeyId,
      capsuleStatementVerified: false,
      signatureVerified: true,
      trustPolicyApprovalVerified: true,
      trustRootProvisioned: true,
      replayTransparencyVerified: false,
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
    ['not-yet-valid', { issuedAt: '2026-08-02T15:06:00.000Z' }, 'approval-not-current'],
    ['expired', { expiresAt: '2026-08-02T15:05:00.000Z' }, 'approval-expired'],
    ['reversed', { expiresAt: '2026-08-02T14:59:59.000Z' }, 'approval-expired'],
    ['too-long', { expiresAt: '2026-08-02T15:10:00.001Z' }, 'approval-lifetime-invalid'],
  ])('rejects a %s approval window', (_label, changes, reason) => {
    const value = fixture({ provisionRoot: true });
    expect(inspectVerifierExecutionPolicyApprovalV1(resignApproval(value, changes)).reason)
      .toBe(reason);
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
    const serialized = JSON.stringify(result);
    for (const secret of [
      'raw prompt canary', 'diff --git canary', '/private/path/canary', 'stdout canary',
      'stderr canary', 'SECRET_ENV=canary', 'file contents canary', value.approval.signature,
      value.approvalPublicKeySpki,
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

    expect(firstResult.state).toBe('authenticated');
    expect(secondResult.state).toBe('authenticated');
    expect(secondResult.approvedTrustPolicyDigest).not.toBe(firstResult.approvedTrustPolicyDigest);
    allAuthorityFalse(firstResult);
    allAuthorityFalse(secondResult);
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
