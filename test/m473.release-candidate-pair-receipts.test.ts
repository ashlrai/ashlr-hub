import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildReleaseCandidatePairReceipt,
  parseReleaseCandidatePairReceipt,
  releaseCandidatePairKeyId,
  releaseCandidatePairReleaseIdentityDigest,
  releaseCandidatePairTrustPolicyDigest,
  signReleaseCandidatePairAncestryDeploymentEvidence,
  signReleaseCandidatePairProtectedHeadEvidence,
  verifyReleaseCandidatePairReceipt,
  type BuildReleaseCandidatePairReceiptOptions,
  type ReleaseCandidatePairAncestryDeploymentEvidencePayloadV1,
  type ReleaseCandidatePairExpectedBindingsV1,
  type ReleaseCandidatePairProtectedHeadEvidencePayloadV1,
  type ReleaseCandidatePairReleaseIdentityV1,
  type ReleaseCandidatePairTrustPolicyV1,
} from '../src/core/daemon/release-candidate-pair-receipts.js';

const CAPTURED_AT = '2026-08-02T12:05:00.000Z';
const EXPIRES_AT = '2026-08-02T12:10:00.000Z';
const OBSERVED_AT = '2026-08-02T12:00:00.000Z';
const EVIDENCE_EXPIRES_AT = '2026-08-02T12:12:00.000Z';
const NOW = Date.parse('2026-08-02T12:06:00.000Z');
const SCOPE = { branch: 'master' as const, repositoryId: 'R_ashlr_hub_01' };
const POLICY_EPOCH = 'release-2026-08';
const CURRENT_TIP_DIGEST = digest('9');
const CURRENT_TIP_SEQUENCE = 7;

function digest(marker: string): string {
  return `sha256:${marker.repeat(64)}`;
}

function identity(revisionMarker: string, marker: string): ReleaseCandidatePairReleaseIdentityV1 {
  return {
    artifacts: {
      artifactDigest: digest(marker),
      complete: true,
      immutable: true,
      packagedTreeDigest: digest(marker === 'a' ? 'b' : 'a'),
    },
    configPolicyDigest: digest('c'),
    dependencies: {
      complete: true,
      immutable: true,
      installedClosureDigest: digest('d'),
    },
    revision: revisionMarker.repeat(40),
    runtime: {
      complete: true,
      immutable: true,
      nodeExecutableDigest: digest('e'),
    },
    service: {
      argvDigest: digest('f'),
      environmentPolicyDigest: digest('0'),
    },
  };
}

function publicSpki(publicKey: KeyObject): string {
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
}

interface Fixture {
  ancestry: ReleaseCandidatePairAncestryDeploymentEvidencePayloadV1;
  ancestryEvidence: string;
  candidate: ReleaseCandidatePairReleaseIdentityV1;
  expected: ReleaseCandidatePairExpectedBindingsV1;
  observerPrivateKey: KeyObject;
  observerPublicKey: KeyObject;
  options: BuildReleaseCandidatePairReceiptOptions;
  protectedHead: ReleaseCandidatePairProtectedHeadEvidencePayloadV1;
  protectedHeadEvidence: string;
  receiptPublicKey: KeyObject;
  rollback: ReleaseCandidatePairReleaseIdentityV1;
  trustPolicy: ReleaseCandidatePairTrustPolicyV1;
}

function fixture(): Fixture {
  const observer = generateKeyPairSync('ed25519');
  const receiptSigner = generateKeyPairSync('ed25519');
  const keyId = releaseCandidatePairKeyId(observer.publicKey)!;
  const trustPolicy: ReleaseCandidatePairTrustPolicyV1 = {
    domain: 'ashlr:release-candidate-pair-trust-policy:v1',
    keys: [{
      algorithm: 'ed25519',
      keyId,
      notAfter: '2027-01-01T00:00:00.000Z',
      notBefore: '2026-01-01T00:00:00.000Z',
      publicKeySpki: publicSpki(observer.publicKey),
      signerRole: 'release-observer',
    }],
    policyEpoch: POLICY_EPOCH,
    repositoryScope: SCOPE,
    schemaVersion: 1,
  };
  const trustPolicyDigest = releaseCandidatePairTrustPolicyDigest(trustPolicy)!;
  const candidate = identity('b', '2');
  const rollback = identity('a', '4');
  const protectedHead: ReleaseCandidatePairProtectedHeadEvidencePayloadV1 = {
    adminEnforced: true,
    authority: 'externally-authenticated-observation',
    candidateOid: candidate.revision,
    deletionAllowed: false,
    evidenceType: 'protected-head',
    expiresAt: EVIDENCE_EXPIRES_AT,
    forcePushAllowed: false,
    observedAt: OBSERVED_AT,
    policyEpoch: POLICY_EPOCH,
    protected: true,
    protectionSnapshotDigest: digest('1'),
    repositoryScope: SCOPE,
    requiredChecks: [
      { appId: '101', conclusion: 'success', context: 'CI / test' },
      { appId: '202', conclusion: 'success', context: 'Dependency audit' },
    ],
    schemaVersion: 1,
    signerRole: 'release-observer',
    strictRequiredChecks: true,
    trustPolicyDigest,
  };
  const ancestry: ReleaseCandidatePairAncestryDeploymentEvidencePayloadV1 = {
    authority: 'externally-authenticated-observation',
    candidateDescendsFromRollback: true,
    candidateOid: candidate.revision,
    evidenceType: 'ancestry-deployment',
    expiresAt: EVIDENCE_EXPIRES_AT,
    installedReceiptDigest: digest('7'),
    observedAt: OBSERVED_AT,
    policyEpoch: POLICY_EPOCH,
    repositoryScope: SCOPE,
    rollbackOid: rollback.revision,
    rollbackWasPreviouslyActivated: true,
    schemaVersion: 1,
    signerRole: 'release-observer',
    trustPolicyDigest,
  };
  const signedHead = signReleaseCandidatePairProtectedHeadEvidence({
    payload: protectedHead,
    privateKey: observer.privateKey,
  });
  const signedAncestry = signReleaseCandidatePairAncestryDeploymentEvidence({
    payload: ancestry,
    privateKey: observer.privateKey,
  });
  if (!signedHead.ok || !signedAncestry.ok) throw new Error('fixture evidence did not sign');
  const expected: ReleaseCandidatePairExpectedBindingsV1 = {
    currentTipAuthority: 'externally-authenticated-observation',
    currentTipDigest: CURRENT_TIP_DIGEST,
    currentTipSequence: CURRENT_TIP_SEQUENCE,
    policyEpoch: POLICY_EPOCH,
    repositoryScope: SCOPE,
    trustPolicyDigest,
  };
  return {
    ancestry,
    ancestryEvidence: signedAncestry.canonicalJson,
    candidate,
    expected,
    observerPrivateKey: observer.privateKey,
    observerPublicKey: observer.publicKey,
    options: {
      ancestryDeploymentEvidence: signedAncestry.canonicalJson,
      candidate,
      capturedAt: CAPTURED_AT,
      expected,
      expiresAt: EXPIRES_AT,
      predecessorReceiptDigest: CURRENT_TIP_DIGEST,
      privateKey: receiptSigner.privateKey,
      protectedHeadEvidence: signedHead.canonicalJson,
      rollbackTarget: rollback,
      sequence: CURRENT_TIP_SEQUENCE + 1,
      trustPolicy,
    },
    protectedHead,
    protectedHeadEvidence: signedHead.canonicalJson,
    receiptPublicKey: receiptSigner.publicKey,
    rollback,
    trustPolicy,
  };
}

function built(value = fixture()) {
  const result = buildReleaseCandidatePairReceipt(value.options);
  if (!result.ok) throw new Error(result.reason);
  return { result, value };
}

function verify(value: Fixture, receipt: string) {
  return verifyReleaseCandidatePairReceipt({
    ancestryDeploymentEvidence: value.ancestryEvidence,
    expected: value.expected,
    now: NOW,
    protectedHeadEvidence: value.protectedHeadEvidence,
    receipt,
    receiptTrustedPublicKeys: [value.receiptPublicKey],
    trustPolicy: value.trustPolicy,
  });
}

describe('release candidate pair receipts v1', () => {
  it('produces deterministic canonical policy, evidence, and pair identities', () => {
    const value = fixture();
    const first = buildReleaseCandidatePairReceipt(value.options);
    const second = buildReleaseCandidatePairReceipt(value.options);
    expect(first).toEqual(second);
    expect(releaseCandidatePairTrustPolicyDigest(value.trustPolicy))
      .toBe(value.expected.trustPolicyDigest);
    expect(first.ok && first.canonicalJson.endsWith('\n')).toBe(true);
  });

  it('binds externally authenticated protected-head and ancestry/deployment evidence', () => {
    const { result, value } = built();

    expect(result.receipt.payload).toMatchObject({
      activationPermitted: false,
      authority: 'observation-only',
      candidateReleaseDigest: releaseCandidatePairReleaseIdentityDigest(value.candidate),
      deployPermitted: false,
      installPermitted: false,
      mergePermitted: false,
      policyEpoch: POLICY_EPOCH,
      predecessorReceiptDigest: CURRENT_TIP_DIGEST,
      previousReleaseDigest: releaseCandidatePairReleaseIdentityDigest(value.rollback),
      rollbackPermitted: false,
      rollbackTargetReleaseDigest: releaseCandidatePairReleaseIdentityDigest(value.rollback),
      sequence: CURRENT_TIP_SEQUENCE + 1,
      startPermitted: false,
      trustPolicyDigest: value.expected.trustPolicyDigest,
      protectedHead: {
        candidateOid: value.candidate.revision,
        protectionSnapshotDigest: digest('1'),
        requiredChecks: value.protectedHead.requiredChecks,
      },
      ancestryDeployment: {
        candidateDescendsFromRollback: true,
        candidateOid: value.candidate.revision,
        installedReceiptDigest: digest('7'),
        rollbackOid: value.rollback.revision,
        rollbackWasPreviouslyActivated: true,
      },
    });
    expect(verify(value, result.canonicalJson)).toMatchObject({
      ok: true,
      authority: 'observation-only',
      predecessorReceiptDigest: CURRENT_TIP_DIGEST,
      sequence: CURRENT_TIP_SEQUENCE + 1,
      verifiedAtMs: NOW,
    });
  });

  it('refuses forked sequence and predecessor state against the trusted current tip', () => {
    const value = fixture();
    expect(buildReleaseCandidatePairReceipt({ ...value.options, sequence: 99 })).toEqual({
      ok: false,
      reason: 'release candidate pair fork/conflict: predecessor is not trusted current tip',
    });
    expect(buildReleaseCandidatePairReceipt({
      ...value.options,
      predecessorReceiptDigest: digest('8'),
    })).toEqual({
      ok: false,
      reason: 'release candidate pair fork/conflict: predecessor is not trusted current tip',
    });

    const result = built(value).result;
    expect(verifyReleaseCandidatePairReceipt({
      ancestryDeploymentEvidence: value.ancestryEvidence,
      expected: { ...value.expected, currentTipSequence: CURRENT_TIP_SEQUENCE + 1 },
      now: NOW,
      protectedHeadEvidence: value.protectedHeadEvidence,
      receipt: result.canonicalJson,
      receiptTrustedPublicKeys: [value.receiptPublicKey],
      trustPolicy: value.trustPolicy,
    })).toEqual({
      ok: false,
      reason: 'release candidate pair fork/conflict: predecessor is not trusted current tip',
    });
  });

  it('rejects fabricated required-check or App identity without observer authorization', () => {
    const value = fixture();
    const envelope = JSON.parse(value.protectedHeadEvidence) as Record<string, unknown>;
    const payload = envelope['payload'] as Record<string, unknown>;
    payload['requiredChecks'] = [{ appId: '999', conclusion: 'success', context: 'CI / test' }];
    value.options.protectedHeadEvidence = `${JSON.stringify(envelope)}\n`;
    expect(buildReleaseCandidatePairReceipt(value.options)).toEqual({
      ok: false,
      reason: 'release candidate pair evidence signature verification failed',
    });

    const failedCheck = fixture();
    const signed = signReleaseCandidatePairProtectedHeadEvidence({
      payload: {
        ...failedCheck.protectedHead,
        requiredChecks: [{
          appId: '101',
          conclusion: 'failure',
          context: 'CI / test',
        }],
      } as unknown as ReleaseCandidatePairProtectedHeadEvidencePayloadV1,
      privateKey: failedCheck.observerPrivateKey,
    });
    expect(signed).toEqual({
      ok: false,
      reason: 'release candidate pair required check is not an exact successful App check',
    });
  });

  it('rejects ancestry inversion and an unactivated rollback target', () => {
    const inverted = fixture();
    const signedInversion = signReleaseCandidatePairAncestryDeploymentEvidence({
      payload: {
        ...inverted.ancestry,
        candidateOid: inverted.rollback.revision,
        rollbackOid: inverted.candidate.revision,
      },
      privateKey: inverted.observerPrivateKey,
    });
    if (!signedInversion.ok) throw new Error(signedInversion.reason);
    expect(buildReleaseCandidatePairReceipt({
      ...inverted.options,
      ancestryDeploymentEvidence: signedInversion.canonicalJson,
    })).toEqual({
      ok: false,
      reason: 'release candidate pair signed evidence OID binding mismatch',
    });

    const inactive = fixture();
    expect(signReleaseCandidatePairAncestryDeploymentEvidence({
      payload: {
        ...inactive.ancestry,
        rollbackWasPreviouslyActivated: false,
      } as unknown as ReleaseCandidatePairAncestryDeploymentEvidencePayloadV1,
      privateKey: inactive.observerPrivateKey,
    })).toEqual({
      ok: false,
      reason: 'release candidate pair ancestry/deployment evidence is invalid',
    });
  });

  it('rejects trust-policy substitution despite reuse of the same observer key', () => {
    const value = fixture();
    const substituted: ReleaseCandidatePairTrustPolicyV1 = {
      ...value.trustPolicy,
      policyEpoch: 'release-2026-09',
    };
    expect(buildReleaseCandidatePairReceipt({
      ...value.options,
      trustPolicy: substituted,
    })).toEqual({
      ok: false,
      reason: 'release candidate pair trust policy substitution detected',
    });
    expect(buildReleaseCandidatePairReceipt({
      ...value.options,
      expected: { ...value.expected, trustPolicyDigest: digest('6') },
    })).toEqual({
      ok: false,
      reason: 'release candidate pair trust policy substitution detected',
    });
  });

  it('rejects untrusted evidence signers and policy role substitution', () => {
    const value = fixture();
    const other = generateKeyPairSync('ed25519');
    const signed = signReleaseCandidatePairProtectedHeadEvidence({
      payload: value.protectedHead,
      privateKey: other.privateKey,
    });
    if (!signed.ok) throw new Error(signed.reason);
    expect(buildReleaseCandidatePairReceipt({
      ...value.options,
      protectedHeadEvidence: signed.canonicalJson,
    })).toEqual({
      ok: false,
      reason: 'release candidate pair evidence signer is not a trusted release observer',
    });

    const wrongRole = structuredClone(value.trustPolicy) as unknown as {
      keys: Array<{ signerRole: string }>;
    };
    wrongRole.keys[0]!.signerRole = 'release-activator';
    expect(buildReleaseCandidatePairReceipt({
      ...value.options,
      trustPolicy: wrongRole as unknown as ReleaseCandidatePairTrustPolicyV1,
    })).toEqual({ ok: false, reason: 'release candidate pair trust key is invalid' });
  });

  it('refuses stale evidence and noncanonical or tampered pair receipts', () => {
    const { result, value } = built();
    expect(verifyReleaseCandidatePairReceipt({
      ancestryDeploymentEvidence: value.ancestryEvidence,
      expected: value.expected,
      now: Date.parse(EVIDENCE_EXPIRES_AT),
      protectedHeadEvidence: value.protectedHeadEvidence,
      receipt: result.canonicalJson,
      receiptTrustedPublicKeys: [value.receiptPublicKey],
      trustPolicy: value.trustPolicy,
    })).toEqual({ ok: false, reason: 'release candidate pair evidence is stale' });
    expect(parseReleaseCandidatePairReceipt(
      JSON.stringify(JSON.parse(result.canonicalJson) as unknown, null, 2),
    )).toEqual({
      ok: false,
      reason: 'release candidate pair receipt encoding is not canonical',
    });

    const tampered = JSON.parse(result.canonicalJson) as Record<string, unknown>;
    const signature = tampered['signature'] as string;
    tampered['signature'] = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
    expect(verify(value, `${JSON.stringify(tampered)}\n`)).toEqual({
      ok: false,
      reason: 'release candidate pair receipt signature verification failed',
    });
  });

  it('refuses a pair receipt whose lifetime extends beyond either evidence envelope', () => {
    const value = fixture();
    expect(buildReleaseCandidatePairReceipt({
      ...value.options,
      expiresAt: '2026-08-02T12:13:00.000Z',
    })).toEqual({
      ok: false,
      reason: 'release candidate pair outlives signed external evidence',
    });
  });
});
