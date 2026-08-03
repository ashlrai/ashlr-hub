import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildReleaseCandidatePairReceipt,
  releaseCandidatePairKeyId,
  releaseCandidatePairTrustPolicyDigest,
  signReleaseCandidatePairAncestryDeploymentEvidence,
  signReleaseCandidatePairProtectedHeadEvidence,
  type BuildReleaseCandidatePairReceiptOptions,
  type ReleaseCandidatePairReleaseIdentityV1,
  type ReleaseCandidatePairTrustPolicyV1,
} from '../src/core/daemon/release-candidate-pair-receipts.js';

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
    dependencies: { complete: true, immutable: true, installedClosureDigest: digest('d') },
    revision: revisionMarker.repeat(40),
    runtime: { complete: true, immutable: true, nodeExecutableDigest: digest('e') },
    service: { argvDigest: digest('f'), environmentPolicyDigest: digest('0') },
  };
}

function spki(key: KeyObject): string {
  return key.export({ format: 'der', type: 'spki' }).toString('base64url');
}

function options(): BuildReleaseCandidatePairReceiptOptions {
  const observer = generateKeyPairSync('ed25519');
  const receipt = generateKeyPairSync('ed25519');
  const scope = { branch: 'master' as const, repositoryId: 'R_ashlr_hub_01' };
  const keyId = releaseCandidatePairKeyId(observer.publicKey)!;
  const policy: ReleaseCandidatePairTrustPolicyV1 = {
    domain: 'ashlr:release-candidate-pair-trust-policy:v1',
    keys: [{
      algorithm: 'ed25519',
      keyId,
      notAfter: '2027-01-01T00:00:00.000Z',
      notBefore: '2026-01-01T00:00:00.000Z',
      publicKeySpki: spki(observer.publicKey),
      signerRole: 'release-observer',
    }],
    policyEpoch: 'release-2026-08',
    repositoryScope: scope,
    schemaVersion: 1,
  };
  const policyDigest = releaseCandidatePairTrustPolicyDigest(policy)!;
  const candidate = identity('b', '2');
  const rollback = identity('a', '4');
  const head = signReleaseCandidatePairProtectedHeadEvidence({
    payload: {
      adminEnforced: true,
      authority: 'externally-authenticated-observation',
      candidateOid: candidate.revision,
      deletionAllowed: false,
      evidenceType: 'protected-head',
      expiresAt: '2026-08-02T12:12:00.000Z',
      forcePushAllowed: false,
      observedAt: '2026-08-02T12:00:00.000Z',
      policyEpoch: policy.policyEpoch,
      protected: true,
      protectionSnapshotDigest: digest('1'),
      repositoryScope: scope,
      requiredChecks: [{ appId: '101', conclusion: 'success', context: 'CI / test' }],
      schemaVersion: 1,
      signerRole: 'release-observer',
      strictRequiredChecks: true,
      trustPolicyDigest: policyDigest,
    },
    privateKey: observer.privateKey,
  });
  const ancestry = signReleaseCandidatePairAncestryDeploymentEvidence({
    payload: {
      authority: 'externally-authenticated-observation',
      candidateDescendsFromRollback: true,
      candidateOid: candidate.revision,
      evidenceType: 'ancestry-deployment',
      expiresAt: '2026-08-02T12:12:00.000Z',
      installedReceiptDigest: digest('7'),
      observedAt: '2026-08-02T12:00:00.000Z',
      policyEpoch: policy.policyEpoch,
      repositoryScope: scope,
      rollbackOid: rollback.revision,
      rollbackWasPreviouslyActivated: true,
      schemaVersion: 1,
      signerRole: 'release-observer',
      trustPolicyDigest: policyDigest,
    },
    privateKey: observer.privateKey,
  });
  if (!head.ok || !ancestry.ok) throw new Error('fixture evidence did not sign');
  return {
    ancestryDeploymentEvidence: ancestry.canonicalJson,
    candidate,
    capturedAt: '2026-08-02T12:05:00.000Z',
    expected: {
      currentTipAuthority: 'externally-authenticated-observation',
      currentTipDigest: digest('9'),
      currentTipSequence: 7,
      policyEpoch: policy.policyEpoch,
      repositoryScope: scope,
      trustPolicyDigest: policyDigest,
    },
    expiresAt: '2026-08-02T12:10:00.000Z',
    predecessorReceiptDigest: digest('9'),
    privateKey: receipt.privateKey,
    protectedHeadEvidence: head.canonicalJson,
    rollbackTarget: rollback,
    sequence: 8,
    trustPolicy: policy,
  };
}

describe('release candidate pair authority firewall', () => {
  it('contains only pure cryptography and no storage, process, service, network, or activation imports', () => {
    const source = readFileSync(
      new URL('../src/core/daemon/release-candidate-pair-receipts.ts', import.meta.url),
      'utf8',
    );
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/gu)].map((match) => match[1]);
    expect(imports).toEqual(['node:crypto']);
    expect(source).not.toMatch(/child_process|node:fs|service\.js|loop\.js|activation-permit|launchd|spawnSync|spawn\(|execFile|fetch\(|writeFile|mkdir|rmSync/u);
    expect(source).not.toMatch(/installPermitted:\s*true|startPermitted:\s*true|mergePermitted:\s*true|rollbackPermitted:\s*true|deployPermitted:\s*true|activationPermitted:\s*true/u);
  });

  it('refuses missing expected tip and malformed trust-policy scope', () => {
    const missingTip = options();
    missingTip.expected = {
      ...missingTip.expected,
      currentTipDigest: undefined,
    } as unknown as typeof missingTip.expected;
    expect(buildReleaseCandidatePairReceipt(missingTip)).toMatchObject({ ok: false });

    const wrongBranch = options();
    wrongBranch.expected.repositoryScope = {
      branch: 'main',
      repositoryId: 'R_ashlr_hub_01',
    } as unknown as typeof wrongBranch.expected.repositoryScope;
    expect(buildReleaseCandidatePairReceipt(wrongBranch)).toEqual({
      ok: false,
      reason: 'release candidate pair repository scope is invalid',
    });
  });

  it('refuses mutable or incomplete artifact, dependency, and runtime identities', () => {
    const runtime = options();
    (runtime.candidate.runtime as { immutable: boolean }).immutable = false;
    expect(buildReleaseCandidatePairReceipt(runtime)).toEqual({
      ok: false,
      reason: 'release candidate runtime identity is mutable or incomplete',
    });

    const dependencies = options();
    (dependencies.rollbackTarget.dependencies as { complete: boolean }).complete = false;
    expect(buildReleaseCandidatePairReceipt(dependencies)).toEqual({
      ok: false,
      reason: 'release rollback target dependency identity is mutable or incomplete',
    });

    const artifacts = options();
    (artifacts.candidate.artifacts as { immutable: boolean }).immutable = false;
    expect(buildReleaseCandidatePairReceipt(artifacts)).toEqual({
      ok: false,
      reason: 'release candidate artifact identity is mutable or incomplete',
    });
  });

  it('keeps raw argv, environment, paths, package data, and policy contents out of receipts', () => {
    const result = buildReleaseCandidatePairReceipt(options());
    if (!result.ok) throw new Error(result.reason);
    for (const forbidden of [
      '/Users/example', 'node_modules/example', 'GITHUB_TOKEN', 'npm run test',
      '--secret', 'package-lock.json', 'PUBLIC KEY',
    ]) expect(result.canonicalJson).not.toContain(forbidden);
    expect(result.canonicalJson).toContain('argvDigest');
    expect(result.canonicalJson).toContain('installedClosureDigest');
    expect(result.canonicalJson).toContain('trustPolicyDigest');
  });
});
