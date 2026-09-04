import { createHash } from 'node:crypto';
import {
  chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireAgentOsEpochCoordinationLeaseV1,
  releaseAgentOsEpochCoordinationLeaseV1,
} from '../src/core/vision/agent-os-epoch-coordination.js';
import {
  recoverAgentOsEpochStagesV1,
  type AgentOsEpochRecoveryIdentityV1,
  type AgentOsEpochStageRecoveryDependenciesV1,
} from '../src/core/vision/agent-os-epoch-stage-recovery.js';
import {
  acquireAgentOsObservationLockV1,
  releaseAgentOsObservationLockV1,
} from '../src/core/vision/agent-os-observation-lock.js';

const roots: string[] = [];
const raw = (label: string): string => createHash('sha256').update(`m563:${label}`).digest('hex');
const prefixed = (label: string): string => `sha256:${raw(label)}`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const anchorPath = mkdtempSync(join(tmpdir(), 'ashlr-m563-'));
  roots.push(anchorPath);
  chmodSync(anchorPath, 0o700);
  const epochStoreRootPath = join(anchorPath, 'agent-os-epochs');
  const epochPath = join(epochStoreRootPath, 'epochs', 'epoch-000000000001');
  for (const path of [epochStoreRootPath, join(epochStoreRootPath, 'epochs'), epochPath,
    join(epochPath, 'sources'), join(epochPath, 'snapshots'), join(epochPath, 'attempts')]) {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  const writerProtocolDigest = prefixed('writer');
  let identity: AgentOsEpochRecoveryIdentityV1 = {
    epoch: 1,
    epochHeadDigest: prefixed('head'),
    epochManifestDigest: prefixed('manifest'),
    attemptNamespaceDigest: prefixed('namespace'),
    writerProtocolDigest,
  };
  const sourceContext = {
    ...identity,
    previousEpochHeadDigest: prefixed('previous-head'),
    previousEpochSourceTipDigest: null,
    firstSourceBundleDigest: raw('first-source'),
    trustPolicyDigest: raw('policy'),
    policyGeneration: 1,
    expectedSourceKeyId: raw('source-key'),
    expectedSourcePrincipalDigest: prefixed('source-principal'),
    epochCreatedAt: '2026-09-03T12:00:00.000Z',
    observedAt: '2026-09-03T12:00:30.000Z',
  };
  const attemptClosure = {
    epoch: 1,
    epochHeadDigest: identity.epochHeadDigest,
    epochManifestDigest: identity.epochManifestDigest,
    attemptNamespaceDigest: identity.attemptNamespaceDigest,
    sourceBundleDigest: raw('source'),
    trustPolicyDigest: raw('policy'),
    attemptAuthenticatorKeyId: raw('attempt-key'),
    attemptAuthenticatorGeneration: 1,
    writerProtocolDigest,
  };
  const attemptVerifier = {
    keyId: attemptClosure.attemptAuthenticatorKeyId,
    verify: () => true,
  };
  const snapshotClosure = {
    epoch: 1,
    anchoredHeadDigest: identity.epochHeadDigest,
    epochManifestDigest: identity.epochManifestDigest,
    attemptNamespaceDigest: identity.attemptNamespaceDigest,
    sourceBundleDigest: attemptClosure.sourceBundleDigest,
    trustPolicyDigest: attemptClosure.trustPolicyDigest,
    snapshotBasePreviousEnvelopeDigest: raw('snapshot-base'),
    writerProtocolDigest,
    expectedProducerIdentityDigest: prefixed('producer'),
    expectedAuthenticatorKeyId: raw('snapshot-key'),
    expectedAuthenticatorKeyGeneration: 1,
  };
  const dependencies: AgentOsEpochStageRecoveryDependenciesV1 = {
    anchorPath,
    epochStoreRootPath,
    writerProtocolDigest,
    authenticatedIdentityProvider: {
      readAuthenticatedFixedEpochIdentity: () => ({
        state: 'authenticated' as const, identity: { ...identity },
      }),
    },
    sourceStore: {
      anchorPath, epochStoreRootPath, writerProtocolDigest,
      activeContextProvider: {
        readAuthenticatedActiveEpochSourceContext: () => ({
          state: 'authenticated' as const,
          context: { ...sourceContext, ...identity },
        }),
      },
      firstSourceSignatureVerifier: { verify: () => false },
      renewalSignatureVerifier: { verify: () => false },
      renewalSigner: null,
      attemptAuthenticatorResolver: {
        resolveAuthenticatedAttemptAuthenticator: () => ({ state: 'missing' as const }),
      },
    },
    attemptStore: {
      anchorPath, epochStoreRootPath, writerProtocolDigest,
      activeClosureProvider: {
        readAuthenticatedClosure: () => ({
          state: 'authenticated' as const, closure: { ...attemptClosure, ...identity },
        }),
      },
      historicalSourceLineageProvider: {
        resolveAuthenticatedHistoricalSource: (lineage) => ({
          state: 'authenticated' as const,
          lineage: { ...lineage, attemptAuthenticatorGeneration: 1 },
          verifier: attemptVerifier,
          signer: {
            keyId: attemptClosure.attemptAuthenticatorKeyId,
            authenticate: () => raw('attempt-authenticator'),
          },
        }),
        resolveAuthenticatedHistoricalSources: () => ({ state: 'degraded' as const }),
      },
      signer: {
        keyId: attemptClosure.attemptAuthenticatorKeyId,
        authenticate: () => raw('attempt-authenticator'),
      },
    },
    snapshotStore: {
      anchorPath, epochStoreRootPath, writerProtocolDigest,
      activeClosureProvider: {
        readAuthenticatedClosure: () => ({
          state: 'authenticated' as const,
          closure: { ...snapshotClosure, epoch: identity.epoch,
            anchoredHeadDigest: identity.epochHeadDigest,
            epochManifestDigest: identity.epochManifestDigest,
            attemptNamespaceDigest: identity.attemptNamespaceDigest,
            writerProtocolDigest: identity.writerProtocolDigest },
        }),
      },
      historicalContextProvider: {
        readAuthenticatedHistoricalContext: () => ({ state: 'missing' as const }),
      },
      startReceiptProvider: {
        readAuthenticatedStartReceipt: () => ({ state: 'missing' as const }),
      },
      signer: null,
      verifier: null,
    },
  };
  const leaseRead = acquireAgentOsEpochCoordinationLeaseV1({
    rootPath: epochStoreRootPath, writerProtocolDigest,
  });
  if (leaseRead.state !== 'acquired') throw new Error('expected lease');
  const observationLock = acquireAgentOsObservationLockV1(anchorPath);
  if (!observationLock) throw new Error('expected observation lock');
  const input = {
    expectedIdentity: { ...identity },
    coordinationLease: leaseRead.lease,
    observationLock,
    isRecoveryAuthorized: () => true,
  };
  return {
    epochPath, dependencies, input,
    setIdentity: (next: AgentOsEpochRecoveryIdentityV1) => { identity = next; },
    release: () => {
      releaseAgentOsObservationLockV1(observationLock);
      releaseAgentOsEpochCoordinationLeaseV1(leaseRead.lease);
    },
  };
}

function noAuthority(value: Record<string, unknown>): void {
  expect(value).toMatchObject({
    authority: 'observation-only', writesAuthorized: false, pointerMutationAuthorized: false,
    anchorMutationAuthority: false, planningAuthority: false, executionAuthority: false,
    effectAuthority: false, proposalAuthority: false, learningAuthority: false,
    promotionAuthority: false, mergeAuthority: false, releaseAuthority: false,
    deployAuthority: false, publicationAuthority: false, budgetAuthority: false,
    credentialAuthority: false, externalMutationAuthority: false,
    rollbackProtected: false, sameUserTamperResistant: false,
  });
}

describe('M563 guarded cross-ledger recovery', () => {
  it('recovers only in source then snapshot then attempt order and reports no authority', () => {
    const value = fixture();
    try {
      const recovered = recoverAgentOsEpochStagesV1(value.input, value.dependencies);
      expect(recovered).toMatchObject({
        disposition: 'clean', reason: 'clean', durable: true,
        stages: { source: 'clean', snapshot: 'clean', attempt: 'clean' },
      });
      noAuthority(recovered as unknown as Record<string, unknown>);
    } finally { value.release(); }
  });

  it('pins the expected identity before authorization callbacks can mutate caller input', () => {
    const value = fixture();
    const original = { ...value.input.expectedIdentity };
    let mutated = false;
    value.input.isRecoveryAuthorized = () => {
      if (!mutated) {
        mutated = true;
        value.input.expectedIdentity.epochHeadDigest = prefixed('forged-head');
        value.setIdentity({ ...original, epochHeadDigest: prefixed('forged-head') });
      }
      return true;
    };
    try {
      expect(recoverAgentOsEpochStagesV1(value.input, value.dependencies)).toMatchObject({
        disposition: 'withheld', stages: { source: 'not-run', snapshot: 'not-run', attempt: 'not-run' },
      });
    } finally { value.release(); }
  });

  it('reports cancellation, deadline, capability loss, and identity drift truthfully', () => {
    for (const [reason, mutate] of [
      ['cancelled', (value: ReturnType<typeof fixture>) => {
        value.input.readRecoveryStopReason = () => 'cancelled' as const;
      }],
      ['deadline-exceeded', (value: ReturnType<typeof fixture>) => {
        value.input.readRecoveryStopReason = () => 'deadline-exceeded' as const;
      }],
      ['coordination-capability-unavailable', (value: ReturnType<typeof fixture>) => {
        value.release();
      }],
      ['authenticated-identity-unavailable', (value: ReturnType<typeof fixture>) => {
        value.setIdentity({ ...value.input.expectedIdentity, epochHeadDigest: prefixed('advanced-head') });
      }],
    ] as const) {
      const value = fixture();
      let released = false;
      try {
        mutate(value);
        released = reason === 'coordination-capability-unavailable';
        expect(recoverAgentOsEpochStagesV1(value.input, value.dependencies)).toMatchObject({
          disposition: 'withheld', reason,
          stages: { source: 'not-run', snapshot: 'not-run', attempt: 'not-run' },
        });
      } finally {
        if (!released) value.release();
      }
    }
  });

  it('canonicalizes a root alias, marks an ignored nested call, and withholds the outer recovery', () => {
    const value = fixture();
    let nested = false;
    const aliasParent = join(value.dependencies.anchorPath, 'alias-parent');
    mkdirSync(aliasParent, { mode: 0o700 });
    const rootAlias = join(aliasParent, '..', 'agent-os-epochs');
    const aliasDependencies: AgentOsEpochStageRecoveryDependenciesV1 = {
      ...value.dependencies,
      epochStoreRootPath: rootAlias,
      sourceStore: { ...value.dependencies.sourceStore, epochStoreRootPath: rootAlias },
      snapshotStore: { ...value.dependencies.snapshotStore, epochStoreRootPath: rootAlias },
      attemptStore: { ...value.dependencies.attemptStore, epochStoreRootPath: rootAlias },
    };
    value.dependencies.authenticatedIdentityProvider = {
      readAuthenticatedFixedEpochIdentity() {
        if (!nested) {
          nested = true;
          expect(recoverAgentOsEpochStagesV1(value.input, aliasDependencies)).toMatchObject({
            disposition: 'withheld', reason: 'reentrant-call',
          });
        }
        return { state: 'authenticated' as const, identity: { ...value.input.expectedIdentity } };
      },
    };
    try {
      expect(recoverAgentOsEpochStagesV1(value.input, value.dependencies)).toMatchObject({
        disposition: 'withheld', reason: 'reentrant-call',
      });
    } finally { value.release(); }
  });

  it('stops after hostile source, snapshot, and attempt staging evidence', () => {
    for (const [stage, kind] of [
      ['sources', 'malformed'], ['snapshots', 'symlink'], ['attempts', 'conflict'],
    ] as const) {
      const value = fixture();
      try {
        expect(recoverAgentOsEpochStagesV1(value.input, value.dependencies).disposition).toBe('clean');
        const staging = join(value.epochPath, stage, 'staging');
        mkdirSync(join(value.epochPath, stage, 'records'), { mode: 0o700, recursive: true });
        mkdirSync(staging, { mode: 0o700, recursive: true });
        const hostile = join(staging, '.hostile.invalid.stage');
        if (kind === 'symlink') symlinkSync('/dev/null', hostile);
        else writeFileSync(hostile, kind === 'conflict' ? '{}\n' : 'not-json\n', { mode: 0o600 });
        const recovered = recoverAgentOsEpochStagesV1(value.input, value.dependencies);
        expect(recovered.disposition).toBe('failed');
        if (stage === 'sources') {
          expect(recovered.stages).toEqual({ source: 'failed', snapshot: 'not-run', attempt: 'not-run' });
        } else if (stage === 'snapshots') {
          expect(recovered.stages).toEqual({ source: 'clean', snapshot: 'failed', attempt: 'not-run' });
        } else {
          expect(recovered.stages).toEqual({ source: 'clean', snapshot: 'clean', attempt: 'failed' });
        }
      } finally { value.release(); }
    }
  });
});
