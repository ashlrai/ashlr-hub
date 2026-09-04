import { describe, expect, it } from 'vitest';

import {
  AGENT_OS_EPOCH_GENESIS_V1,
  AGENT_OS_EPOCH_HEAD_PROTOCOL_V1,
  AGENT_OS_EPOCH_MANIFEST_PROTOCOL_V1,
  AGENT_OS_ROLLOVER_AUTHORITY_V1,
  AGENT_OS_SNAPSHOT_ENVELOPE_GENESIS_DIGEST_V1,
  AGENT_OS_SOURCE_BUNDLE_GENESIS_DIGEST_V1,
  agentOsAttemptNamespaceDigestV1,
  agentOsRolloverOperationIdV1,
  agentOsObservationEpochHeadDigestV1,
  agentOsObservationEpochManifestDigestV1,
  canonicalAgentOsObservationEpochHeadBytesV1,
  canonicalAgentOsObservationEpochManifestBytesV1,
  classifyAgentOsAnchorCasOutcomeV1,
  compileAgentOsRolloverStatusV1,
  parseAgentOsObservationEpochHeadV1,
  parseAgentOsObservationEpochManifestV1,
  preflightAgentOsRolloverV1,
  type AgentOsObservationEpochHeadUnsignedV1,
  type AgentOsObservationEpochHeadV1,
  type AgentOsObservationEpochManifestUnsignedV1,
  type AgentOsObservationEpochManifestV1,
  type AgentOsRolloverPreflightInputV1,
  type AgentOsRolloverStatusInputV1,
} from '../src/core/vision/agent-os-rollover-protocol.js';

const controlDigest = (character: string): string => `sha256:${character.repeat(64)}`;
const signedArtifactDigest = (character: string): string => character.repeat(64);
const WRITER = controlDigest('a');
const POLICY = signedArtifactDigest('b');
const SOURCE_ONE = signedArtifactDigest('c');
const SOURCE_TWO = signedArtifactDigest('d');
const SNAPSHOT_ONE = signedArtifactDigest('e');
const ATTEMPT_ONE = controlDigest('f');
const BINDING_ONE = controlDigest('1');
const FLEET = controlDigest('5');
const ANCHOR_POLICY = controlDigest('6');

function manifest(
  epoch: number,
  previous?: {
    head: AgentOsObservationEpochHeadV1;
    manifest: AgentOsObservationEpochManifestV1;
  },
): AgentOsObservationEpochManifestV1 {
  const unsigned: AgentOsObservationEpochManifestUnsignedV1 = {
    schemaVersion: 1,
    protocol: AGENT_OS_EPOCH_MANIFEST_PROTOCOL_V1,
    recordType: 'agent-os-observation-epoch',
    epoch,
    protocolGeneration: 1,
    previousEpochHeadDigest: previous?.head.headDigest ?? AGENT_OS_EPOCH_GENESIS_V1.headDigest,
    previousEpochManifestDigest: previous?.manifest.manifestDigest ?? AGENT_OS_EPOCH_GENESIS_V1.manifestDigest,
    previousSourceTip: previous ? { sequence: 19, bundleDigest: SOURCE_ONE } : null,
    previousSnapshotTip: previous ? { sequence: 17, envelopeDigest: SNAPSHOT_ONE } : null,
    previousAttemptSetDigest: previous ? ATTEMPT_ONE : AGENT_OS_EPOCH_GENESIS_V1.attemptSetDigest,
    previousCoherentBindingDigest: previous ? BINDING_ONE : null,
    firstSourceBundle: {
      epochSequence: 1,
      bundleDigest: previous ? SOURCE_TWO : SOURCE_ONE,
      previousBundleDigest: previous ? SOURCE_ONE : AGENT_OS_EPOCH_GENESIS_V1.sourceTipDigest,
      trustPolicyDigest: POLICY,
      policyGeneration: 7,
    },
    snapshotBase: {
      nextSequence: 1,
      previousEnvelopeDigest: previous ? SNAPSHOT_ONE : AGENT_OS_EPOCH_GENESIS_V1.snapshotTipDigest,
    },
    attemptNamespaceDigest: agentOsAttemptNamespaceDigestV1({
      epoch,
      previousEpochHeadDigest: previous?.head.headDigest ?? AGENT_OS_EPOCH_GENESIS_V1.headDigest,
      previousAttemptSetDigest: previous ? ATTEMPT_ONE : AGENT_OS_EPOCH_GENESIS_V1.attemptSetDigest,
      firstSourceBundleDigest: previous ? SOURCE_TWO : SOURCE_ONE,
    })!,
    createdAt: epoch === 1 ? '2026-09-03T12:00:00.000Z' : '2026-09-03T12:05:00.000Z',
    ...AGENT_OS_ROLLOVER_AUTHORITY_V1,
  };
  const manifestDigest = agentOsObservationEpochManifestDigestV1(unsigned);
  if (!manifestDigest) throw new Error('fixture manifest was invalid');
  return { ...unsigned, manifestDigest, localAuthenticator: '4'.repeat(64) };
}

function head(
  value: AgentOsObservationEpochManifestV1,
): AgentOsObservationEpochHeadV1 {
  const unsigned: AgentOsObservationEpochHeadUnsignedV1 = {
    schemaVersion: 1,
    protocol: AGENT_OS_EPOCH_HEAD_PROTOCOL_V1,
    epoch: value.epoch,
    protocolGeneration: 1,
    previousHeadDigest: value.previousEpochHeadDigest,
    epochManifestDigest: value.manifestDigest,
    firstSourceBundleDigest: value.firstSourceBundle.bundleDigest,
    closedSourceTipDigest: value.previousSourceTip?.bundleDigest ?? AGENT_OS_EPOCH_GENESIS_V1.sourceTipDigest,
    closedSnapshotTipDigest: value.previousSnapshotTip?.envelopeDigest ?? AGENT_OS_EPOCH_GENESIS_V1.snapshotTipDigest,
    closedAttemptSetDigest: value.previousAttemptSetDigest,
    coherentBindingDigest: value.previousCoherentBindingDigest ?? AGENT_OS_EPOCH_GENESIS_V1.coherentBindingDigest,
    writerProtocolDigest: WRITER,
    advancedAt: value.createdAt,
    ...AGENT_OS_ROLLOVER_AUTHORITY_V1,
  };
  const headDigest = agentOsObservationEpochHeadDigestV1(unsigned);
  if (!headDigest) throw new Error('fixture head was invalid');
  return { ...unsigned, headDigest };
}

function bytes<T>(serializer: (value: unknown) => Buffer | null, value: T): Buffer {
  const serialized = serializer(value);
  if (!serialized) throw new Error('fixture did not serialize');
  return serialized;
}

function fixture(): {
  firstManifest: AgentOsObservationEpochManifestV1;
  firstHead: AgentOsObservationEpochHeadV1;
  nextManifest: AgentOsObservationEpochManifestV1;
  nextHead: AgentOsObservationEpochHeadV1;
  firstManifestBytes: Buffer;
  firstHeadBytes: Buffer;
  nextManifestBytes: Buffer;
  nextHeadBytes: Buffer;
} {
  const firstManifest = manifest(1);
  const firstHead = head(firstManifest);
  const nextManifest = manifest(2, { head: firstHead, manifest: firstManifest });
  const nextHead = head(nextManifest);
  return {
    firstManifest,
    firstHead,
    nextManifest,
    nextHead,
    firstManifestBytes: bytes(canonicalAgentOsObservationEpochManifestBytesV1, firstManifest),
    firstHeadBytes: bytes(canonicalAgentOsObservationEpochHeadBytesV1, firstHead),
    nextManifestBytes: bytes(canonicalAgentOsObservationEpochManifestBytesV1, nextManifest),
    nextHeadBytes: bytes(canonicalAgentOsObservationEpochHeadBytesV1, nextHead),
  };
}

function statusInput(overrides: Partial<AgentOsRolloverStatusInputV1> = {}): AgentOsRolloverStatusInputV1 {
  const value = fixture();
  return {
    commissioned: true,
    legacyActivityDetected: false,
    fleetIdentityDigest: FLEET,
    anchorPolicyDigest: ANCHOR_POLICY,
    runningWriterProtocolDigest: WRITER,
    anchor: { state: 'present', canonicalHeadBytes: value.firstHeadBytes },
    localActiveHeadBytes: value.firstHeadBytes,
    activeManifestBytes: value.firstManifestBytes,
    preparedManifestBytes: null,
    manifestAuthenticatorVerifier: (_bytes, candidate) => candidate.localAuthenticator === '4'.repeat(64),
    preparedEpochEvidence: null,
    preparedEpochEvidenceVerifier: () => false,
    ledgersComplete: true,
    capacityExhausted: false,
    rolloverThresholdReached: false,
    firstSnapshotPresent: true,
    ...overrides,
  };
}

function preflightInput(overrides: Partial<AgentOsRolloverPreflightInputV1> = {}): AgentOsRolloverPreflightInputV1 {
  const value = fixture();
  const recoveryOperationId = agentOsRolloverOperationIdV1({
    fleetIdentityDigest: FLEET,
    anchorPolicyDigest: ANCHOR_POLICY,
    expectedHeadDigest: value.firstHead.headDigest,
    nextHeadDigest: value.nextHead.headDigest,
    protocolGeneration: 1,
  })!;
  const preparedEpochEvidence = {
    epoch: 2,
    previousHeadDigest: value.firstHead.headDigest,
    manifestDigest: value.nextManifest.manifestDigest,
    firstSourceBundleDigest: value.nextManifest.firstSourceBundle.bundleDigest,
    snapshotBasePreviousEnvelopeDigest: value.nextManifest.snapshotBase.previousEnvelopeDigest,
    attemptNamespaceDigest: value.nextManifest.attemptNamespaceDigest,
    recoveryOperationId,
  };
  return {
    ...statusInput({ rolloverThresholdReached: true }),
    preparedManifestBytes: value.nextManifestBytes,
    intendedNextHeadBytes: value.nextHeadBytes,
    preparedEpochEvidence,
    preparedEpochEvidenceVerifier: (evidence) => evidence.recoveryOperationId === recoveryOperationId,
    currentClosure: {
      epoch: 1,
      epochHeadDigest: value.firstHead.headDigest,
      sourceTip: { sequence: 19, bundleDigest: SOURCE_ONE },
      snapshotTip: { sequence: 17, envelopeDigest: SNAPSHOT_ONE },
      attemptSetDigest: ATTEMPT_ONE,
      coherentBindingDigest: BINDING_ONE,
    },
    closureEvidenceVerifier: (closure) => closure.epochHeadDigest === value.firstHead.headDigest &&
      closure.sourceTip.bundleDigest === SOURCE_ONE && closure.snapshotTip.envelopeDigest === SNAPSHOT_ONE &&
      closure.attemptSetDigest === ATTEMPT_ONE && closure.coherentBindingDigest === BINDING_ONE,
    openAttempts: 0,
    currentSourceValid: true,
    coherentBindingValid: true,
    maintenanceRequested: false,
    successorSourceValid: true,
    roleSeparationPreserved: true,
    coordinationLeaseHeld: true,
    transactionLockHeld: true,
    killActive: false,
    cancellationActive: false,
    deadlineActive: false,
    ...overrides,
  };
}

function casInput(
  casResult: Parameters<typeof classifyAgentOsAnchorCasOutcomeV1>[0]['casResult'],
  readAfterCas: Parameters<typeof classifyAgentOsAnchorCasOutcomeV1>[0]['readAfterCas'],
): Parameters<typeof classifyAgentOsAnchorCasOutcomeV1>[0] {
  const value = fixture();
  const operationId = agentOsRolloverOperationIdV1({
    fleetIdentityDigest: FLEET,
    anchorPolicyDigest: ANCHOR_POLICY,
    expectedHeadDigest: value.firstHead.headDigest,
    nextHeadDigest: value.nextHead.headDigest,
    protocolGeneration: 1,
  });
  if (!operationId) throw new Error('fixture operation ID was invalid');
  return {
    expectedCurrentHeadBytes: value.firstHeadBytes,
    intendedNextHeadBytes: value.nextHeadBytes,
    fleetIdentityDigest: FLEET,
    anchorPolicyDigest: ANCHOR_POLICY,
    operationId,
    casResult,
    readAfterCas,
  };
}

function alteredSuccessor(overrides: Partial<AgentOsObservationEpochManifestUnsignedV1>) {
  const value = fixture();
  const { manifestDigest: _manifestDigest, localAuthenticator, ...base } = value.nextManifest;
  const unsigned = { ...base, ...overrides };
  const manifestDigest = agentOsObservationEpochManifestDigestV1(unsigned);
  if (!manifestDigest) throw new Error('timestamp fixture manifest was invalid');
  const nextManifest = { ...unsigned, manifestDigest, localAuthenticator };
  const nextHead = head(nextManifest);
  return {
    nextManifest,
    nextHead,
    nextManifestBytes: bytes(canonicalAgentOsObservationEpochManifestBytesV1, nextManifest),
    nextHeadBytes: bytes(canonicalAgentOsObservationEpochHeadBytesV1, nextHead),
  };
}

function successorAt(createdAt: string) {
  return alteredSuccessor({ createdAt });
}

describe('M550 Agent OS rollover protocol core', () => {
  it('produces deterministic, domain-separated, exact canonical manifest and head bytes', () => {
    const value = fixture();
    expect(value.firstManifest.manifestDigest).not.toBe(value.firstHead.headDigest);
    expect(parseAgentOsObservationEpochManifestV1(value.firstManifestBytes)).toEqual(value.firstManifest);
    expect(parseAgentOsObservationEpochHeadV1(value.firstHeadBytes)).toEqual(value.firstHead);
    expect(value.firstManifestBytes.at(-1)).toBe('}'.charCodeAt(0));
    expect(value.firstHeadBytes.at(-1)).toBe('}'.charCodeAt(0));
    expect(value.firstManifestBytes.toString()).toBe(
      JSON.stringify(JSON.parse(value.firstManifestBytes.toString())),
    );
  });

  it('uses exactly one digest representation for each control or signed-artifact field', () => {
    const value = fixture();
    expect(AGENT_OS_SOURCE_BUNDLE_GENESIS_DIGEST_V1).toMatch(/^[a-f0-9]{64}$/);
    expect(AGENT_OS_SNAPSHOT_ENVELOPE_GENESIS_DIGEST_V1).toMatch(/^[a-f0-9]{64}$/);
    expect(AGENT_OS_EPOCH_GENESIS_V1.sourceTipDigest)
      .toBe(AGENT_OS_SOURCE_BUNDLE_GENESIS_DIGEST_V1);
    expect(AGENT_OS_EPOCH_GENESIS_V1.snapshotTipDigest)
      .toBe(AGENT_OS_SNAPSHOT_ENVELOPE_GENESIS_DIGEST_V1);
    expect(AGENT_OS_EPOCH_GENESIS_V1.headDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    for (const firstSourceBundle of [
      { ...value.nextManifest.firstSourceBundle, bundleDigest: controlDigest('7') },
      { ...value.nextManifest.firstSourceBundle, previousBundleDigest: controlDigest('7') },
      { ...value.nextManifest.firstSourceBundle, trustPolicyDigest: controlDigest('7') },
    ]) {
      expect(canonicalAgentOsObservationEpochManifestBytesV1({
        ...value.nextManifest,
        firstSourceBundle,
      })).toBeNull();
    }
    expect(canonicalAgentOsObservationEpochManifestBytesV1({
      ...value.nextManifest,
      previousSourceTip: {
        ...value.nextManifest.previousSourceTip!, bundleDigest: controlDigest('7'),
      },
    })).toBeNull();
    expect(canonicalAgentOsObservationEpochManifestBytesV1({
      ...value.nextManifest,
      previousSnapshotTip: {
        ...value.nextManifest.previousSnapshotTip!, envelopeDigest: controlDigest('7'),
      },
    })).toBeNull();
    expect(canonicalAgentOsObservationEpochManifestBytesV1({
      ...value.nextManifest,
      snapshotBase: {
        ...value.nextManifest.snapshotBase, previousEnvelopeDigest: controlDigest('7'),
      },
    })).toBeNull();

    expect(canonicalAgentOsObservationEpochManifestBytesV1({
      ...value.nextManifest,
      previousEpochHeadDigest: signedArtifactDigest('7'),
    })).toBeNull();
    for (const replacement of [
      { firstSourceBundleDigest: controlDigest('7') },
      { closedSourceTipDigest: controlDigest('7') },
      { closedSnapshotTipDigest: controlDigest('7') },
    ]) {
      expect(canonicalAgentOsObservationEpochHeadBytesV1({
        ...value.nextHead,
        ...replacement,
      })).toBeNull();
    }
    expect(canonicalAgentOsObservationEpochHeadBytesV1({
      ...value.nextHead,
      writerProtocolDigest: signedArtifactDigest('7'),
    })).toBeNull();
    expect(agentOsAttemptNamespaceDigestV1({
      epoch: 2,
      previousEpochHeadDigest: value.firstHead.headDigest,
      previousAttemptSetDigest: ATTEMPT_ONE,
      firstSourceBundleDigest: controlDigest('7'),
    })).toBeNull();
    expect(agentOsRolloverOperationIdV1({
      fleetIdentityDigest: signedArtifactDigest('7'),
      anchorPolicyDigest: ANCHOR_POLICY,
      expectedHeadDigest: value.firstHead.headDigest,
      nextHeadDigest: value.nextHead.headDigest,
      protocolGeneration: 1,
    })).toBeNull();
  });

  it('rejects whitespace, duplicate keys, unknown fields, digest tamper, accessors, cycles, and unsafe integers', () => {
    const value = fixture();
    expect(parseAgentOsObservationEpochHeadV1(Buffer.concat([value.firstHeadBytes, Buffer.from('\n')]))).toBeNull();
    expect(parseAgentOsObservationEpochHeadV1(Buffer.from(
      '{"epoch":1,' + value.firstHeadBytes.toString().slice(1),
    ))).toBeNull();
    const unknown = { ...value.firstHead, extra: false };
    expect(canonicalAgentOsObservationEpochHeadBytesV1(unknown)).toBeNull();
    expect(canonicalAgentOsObservationEpochHeadBytesV1({
      ...value.firstHead, headDigest: controlDigest('9'),
    })).toBeNull();
    const accessor = { ...value.firstHead } as Record<string, unknown>;
    Object.defineProperty(accessor, 'epoch', { enumerable: true, get: () => 1 });
    expect(canonicalAgentOsObservationEpochHeadBytesV1(accessor)).toBeNull();
    const cycle: Record<string, unknown> = { ...value.firstHead };
    cycle['extra'] = cycle;
    expect(canonicalAgentOsObservationEpochHeadBytesV1(cycle)).toBeNull();
    expect(canonicalAgentOsObservationEpochHeadBytesV1({
      ...value.firstHead, epoch: Number.MAX_SAFE_INTEGER + 1,
    })).toBeNull();
  });

  it('enforces protocol generation, exact all-false authority, and epoch-reset lineage', () => {
    const value = fixture();
    expect(canonicalAgentOsObservationEpochManifestBytesV1({
      ...value.firstManifest, protocolGeneration: 2,
    })).toBeNull();
    expect(canonicalAgentOsObservationEpochManifestBytesV1({
      ...value.firstManifest, executionAuthority: true,
    })).toBeNull();
    expect(canonicalAgentOsObservationEpochManifestBytesV1({
      ...value.firstManifest,
      firstSourceBundle: { ...value.firstManifest.firstSourceBundle, previousBundleDigest: SOURCE_ONE },
    })).toBeNull();
    expect(canonicalAgentOsObservationEpochManifestBytesV1({
      ...value.nextManifest,
      snapshotBase: {
        ...value.nextManifest.snapshotBase,
        previousEnvelopeDigest: signedArtifactDigest('8'),
      },
    })).toBeNull();
    expect(canonicalAgentOsObservationEpochManifestBytesV1({
      ...value.nextManifest,
      previousSourceTip: { sequence: 4_097, bundleDigest: SOURCE_ONE },
    })).toBeNull();

    for (const reset of [
      {
        previousSourceTip: {
          ...value.nextManifest.previousSourceTip!,
          bundleDigest: AGENT_OS_SOURCE_BUNDLE_GENESIS_DIGEST_V1,
        },
        firstSourceBundle: {
          ...value.nextManifest.firstSourceBundle,
          previousBundleDigest: AGENT_OS_SOURCE_BUNDLE_GENESIS_DIGEST_V1,
        },
      },
      {
        previousSnapshotTip: {
          ...value.nextManifest.previousSnapshotTip!,
          envelopeDigest: AGENT_OS_SNAPSHOT_ENVELOPE_GENESIS_DIGEST_V1,
        },
        snapshotBase: {
          ...value.nextManifest.snapshotBase,
          previousEnvelopeDigest: AGENT_OS_SNAPSHOT_ENVELOPE_GENESIS_DIGEST_V1,
        },
      },
    ]) {
      const { manifestDigest: _digest, localAuthenticator: _authenticator, ...unsigned } = {
        ...value.nextManifest,
        ...reset,
      };
      expect(agentOsObservationEpochManifestDigestV1(unsigned)).toBeNull();
      expect(canonicalAgentOsObservationEpochManifestBytesV1({
        ...unsigned,
        manifestDigest: controlDigest('9'),
        localAuthenticator: '9'.repeat(64),
      })).toBeNull();
    }
  });

  it('is uncommissioned by default and halts on unavailable, degraded, or missing anchors', () => {
    expect(compileAgentOsRolloverStatusV1(statusInput({ commissioned: false }))).toMatchObject({
      state: 'uncommissioned', operationalState: 'uncommissioned', recoveryAction: 'none',
      blockers: ['not-commissioned'], rollbackProtected: false,
    });
    expect(compileAgentOsRolloverStatusV1(statusInput({ anchor: { state: 'unavailable' } }))).toMatchObject({
      state: 'unavailable', operationalState: 'anchor-unavailable', recoveryAction: 'halt-writes',
    });
    expect(compileAgentOsRolloverStatusV1(statusInput({ anchor: { state: 'degraded' } })).blockers)
      .toEqual(['anchor-degraded']);
    expect(compileAgentOsRolloverStatusV1(statusInput({ anchor: { state: 'missing' } })).blockers)
      .toEqual(['anchor-missing']);
  });

  it('classifies coherent active state, threshold, first-snapshot, incomplete, and exhausted states', () => {
    expect(compileAgentOsRolloverStatusV1(statusInput())).toMatchObject({
      state: 'accepted', operationalState: 'healthy', recoveryAction: 'none',
    });
    expect(compileAgentOsRolloverStatusV1(statusInput({ rolloverThresholdReached: true }))).toMatchObject({
      state: 'accepted', operationalState: 'rollover-required', recoveryAction: 'prepare-rollover',
    });
    expect(compileAgentOsRolloverStatusV1(statusInput({ firstSnapshotPresent: false }))).toMatchObject({
      state: 'accepted', operationalState: 'awaiting-first-snapshot', recoveryAction: 'run-first-observation',
    });
    expect(compileAgentOsRolloverStatusV1(statusInput({ ledgersComplete: false })).blockers)
      .toEqual(['ledger-incomplete']);
    expect(compileAgentOsRolloverStatusV1(statusInput({ capacityExhausted: true }))).toMatchObject({
      operationalState: 'capacity-exhausted', recoveryAction: 'halt-writes',
      blockers: ['capacity-exhausted'],
    });
  });

  it('excludes legacy activity and any writer-protocol mismatch before recovery or writes', () => {
    expect(compileAgentOsRolloverStatusV1(statusInput({ legacyActivityDetected: true }))).toMatchObject({
      state: 'degraded', operationalState: 'legacy-detected', blockers: ['legacy-activity-detected'],
    });
    expect(compileAgentOsRolloverStatusV1(statusInput({ runningWriterProtocolDigest: controlDigest('9') })))
      .toMatchObject({ state: 'degraded', blockers: ['writer-protocol-mismatch'] });
    expect(compileAgentOsRolloverStatusV1(statusInput({ runningWriterProtocolDigest: 'main' })))
      .toMatchObject({ state: 'degraded', blockers: ['writer-protocol-mismatch'] });
  });

  it('rejects head/manifest substitutions and malformed local pointers', () => {
    const value = fixture();
    expect(compileAgentOsRolloverStatusV1(statusInput({
      activeManifestBytes: value.nextManifestBytes,
    })).blockers).toEqual(['head-manifest-incoherent']);
    expect(compileAgentOsRolloverStatusV1(statusInput({
      localActiveHeadBytes: Buffer.concat([value.firstHeadBytes, Buffer.from('\n')]),
    })).blockers).toEqual(['local-head-invalid']);
    expect(compileAgentOsRolloverStatusV1(statusInput({
      anchor: { state: 'present', canonicalHeadBytes: Buffer.from('{}') },
    })).blockers).toEqual(['anchor-head-invalid']);
  });

  it('requires the injected local authenticator verifier for active and prepared manifests', () => {
    expect(compileAgentOsRolloverStatusV1(statusInput({
      manifestAuthenticatorVerifier: () => false,
    }))).toMatchObject({ state: 'degraded', blockers: ['manifest-invalid'] });
    expect(preflightAgentOsRolloverV1(preflightInput({
      manifestAuthenticatorVerifier: (_bytes, candidate) => candidate.epoch === 1,
    }))).toMatchObject({ state: 'withheld', blockers: ['prepared-epoch-invalid'] });
  });

  it('contains verifier reentrancy by passing immutable owned manifest and closure copies', () => {
    expect(compileAgentOsRolloverStatusV1(statusInput({
      manifestAuthenticatorVerifier: (_bytes, candidate) => {
        candidate.epoch = 99;
        return true;
      },
    }))).toMatchObject({ state: 'degraded', blockers: ['manifest-invalid'] });
    expect(preflightAgentOsRolloverV1(preflightInput({
      closureEvidenceVerifier: (closure) => {
        closure.sourceTip.bundleDigest = signedArtifactDigest('9');
        return true;
      },
    }))).toMatchObject({ state: 'withheld', blockers: ['prepared-epoch-invalid'] });
  });

  it('recovers a pointer behind by exactly one only from a coherent prepared epoch', () => {
    const value = fixture();
    const prepared = preflightInput();
    const recovered = compileAgentOsRolloverStatusV1(statusInput({
      anchor: { state: 'present', canonicalHeadBytes: value.nextHeadBytes },
      preparedManifestBytes: value.nextManifestBytes,
      preparedEpochEvidence: prepared.preparedEpochEvidence,
      preparedEpochEvidenceVerifier: prepared.preparedEpochEvidenceVerifier,
    }));
    expect(recovered).toMatchObject({
      state: 'accepted', operationalState: 'anchor-advanced', recoveryAction: 'recover-local-pointer',
    });
    expect(compileAgentOsRolloverStatusV1(statusInput({
      anchor: { state: 'present', canonicalHeadBytes: value.nextHeadBytes },
      preparedManifestBytes: value.firstManifestBytes,
      preparedEpochEvidence: prepared.preparedEpochEvidence,
      preparedEpochEvidenceVerifier: prepared.preparedEpochEvidenceVerifier,
    })).blockers).toEqual(['prepared-epoch-invalid']);
  });

  it('never recovers a lagging pointer from a matching manifest without verified durable epoch evidence', () => {
    const value = fixture();
    expect(compileAgentOsRolloverStatusV1(statusInput({
      anchor: { state: 'present', canonicalHeadBytes: value.nextHeadBytes },
      preparedManifestBytes: value.nextManifestBytes,
    }))).toMatchObject({
      state: 'degraded', operationalState: 'anchor-advanced', recoveryAction: 'halt-writes',
      blockers: ['prepared-epoch-evidence-unverified'],
    });
  });

  it('rejects predecessor-manifest substitution during both preflight and pointer recovery', () => {
    const value = fixture();
    const altered = alteredSuccessor({ previousEpochManifestDigest: controlDigest('9') });
    const operationId = agentOsRolloverOperationIdV1({
      fleetIdentityDigest: FLEET,
      anchorPolicyDigest: ANCHOR_POLICY,
      expectedHeadDigest: value.firstHead.headDigest,
      nextHeadDigest: altered.nextHead.headDigest,
      protocolGeneration: 1,
    })!;
    const preparedEpochEvidence = {
      ...preflightInput().preparedEpochEvidence!,
      manifestDigest: altered.nextManifest.manifestDigest,
      recoveryOperationId: operationId,
    };
    expect(preflightAgentOsRolloverV1(preflightInput({
      preparedManifestBytes: altered.nextManifestBytes,
      intendedNextHeadBytes: altered.nextHeadBytes,
      preparedEpochEvidence,
      preparedEpochEvidenceVerifier: () => true,
    }))).toMatchObject({ state: 'withheld', blockers: ['prepared-epoch-invalid'] });
    expect(compileAgentOsRolloverStatusV1(statusInput({
      anchor: { state: 'present', canonicalHeadBytes: altered.nextHeadBytes },
      preparedManifestBytes: altered.nextManifestBytes,
      preparedEpochEvidence,
      preparedEpochEvidenceVerifier: () => true,
    }))).toMatchObject({
      state: 'degraded', operationalState: 'anchor-advanced', recoveryAction: 'halt-writes',
      blockers: ['prepared-epoch-invalid'],
    });
  });

  it('degrades rather than rolling an ahead, skipped, or byte-conflicting local pointer backward', () => {
    const value = fixture();
    expect(compileAgentOsRolloverStatusV1(statusInput({
      anchor: { state: 'present', canonicalHeadBytes: value.firstHeadBytes },
      localActiveHeadBytes: value.nextHeadBytes,
    })).blockers).toEqual(['local-pointer-ahead']);
    const epochThreeManifest = manifest(3, { head: value.nextHead, manifest: value.nextManifest });
    const epochThreeBytes = bytes(canonicalAgentOsObservationEpochHeadBytesV1, head(epochThreeManifest));
    expect(compileAgentOsRolloverStatusV1(statusInput({
      anchor: { state: 'present', canonicalHeadBytes: epochThreeBytes },
    })).blockers).toEqual(['epoch-skip']);
    const conflicting = head({ ...value.firstManifest, firstSourceBundle: {
      ...value.firstManifest.firstSourceBundle, bundleDigest: signedArtifactDigest('7'),
    } });
    expect(compileAgentOsRolloverStatusV1(statusInput({
      anchor: { state: 'present', canonicalHeadBytes: bytes(canonicalAgentOsObservationEpochHeadBytesV1, conflicting) },
    }))).toMatchObject({ state: 'conflict', operationalState: 'anchor-conflict' });
  });

  it('binds operation identity to fleet, anchor policy, both heads, and protocol generation', () => {
    const value = fixture();
    const input = {
      fleetIdentityDigest: FLEET,
      anchorPolicyDigest: ANCHOR_POLICY,
      expectedHeadDigest: value.firstHead.headDigest,
      nextHeadDigest: value.nextHead.headDigest,
      protocolGeneration: 1 as const,
    };
    const operationId = agentOsRolloverOperationIdV1(input);
    expect(operationId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(agentOsRolloverOperationIdV1({ ...input, fleetIdentityDigest: controlDigest('7') }))
      .not.toBe(operationId);
    expect(agentOsRolloverOperationIdV1({ ...input, expectedHeadDigest: value.nextHead.headDigest }))
      .not.toBe(operationId);
    expect(agentOsRolloverOperationIdV1({ ...input, protocolGeneration: 2 as 1 })).toBeNull();
  });

  it('accepts only a complete locked successor preflight linked to the exact anchored head', () => {
    expect(preflightAgentOsRolloverV1(preflightInput())).toMatchObject({
      state: 'accepted', operationalState: 'rollover-preparing', recoveryAction: 'none', blockers: [],
    });
    const value = fixture();
    expect(preflightAgentOsRolloverV1(preflightInput({
      preparedManifestBytes: value.firstManifestBytes,
    }))).toMatchObject({ state: 'withheld', blockers: ['prepared-epoch-invalid'] });
  });

  it('binds rollover to the exact authenticated closure of the current ledgers', () => {
    expect(preflightAgentOsRolloverV1(preflightInput({
      currentClosure: {
        ...preflightInput().currentClosure,
        sourceTip: { sequence: 19, bundleDigest: signedArtifactDigest('9') },
      },
    }))).toMatchObject({ state: 'withheld', blockers: ['prepared-epoch-invalid'] });
    expect(preflightAgentOsRolloverV1(preflightInput({
      closureEvidenceVerifier: () => false,
    }))).toMatchObject({ state: 'withheld', blockers: ['prepared-epoch-invalid'] });
  });

  it('rejects recovery evidence replayed from another operation even if its verifier returns true', () => {
    const current = preflightInput();
    expect(preflightAgentOsRolloverV1(preflightInput({
      preparedEpochEvidence: {
        ...current.preparedEpochEvidence!,
        recoveryOperationId: controlDigest('9'),
      },
      preparedEpochEvidenceVerifier: () => true,
    }))).toMatchObject({
      state: 'withheld', blockers: ['prepared-epoch-evidence-unverified'],
    });
  });

  it.each([
    '2026-09-03T12:00:00.000Z',
    '2026-09-03T11:59:59.999Z',
  ])('rejects a successor epoch whose creation time is not after the current head: %s', (createdAt) => {
    const successor = successorAt(createdAt);
    expect(preflightAgentOsRolloverV1(preflightInput({
      preparedManifestBytes: successor.nextManifestBytes,
      intendedNextHeadBytes: successor.nextHeadBytes,
    }))).toMatchObject({ state: 'withheld', blockers: ['prepared-epoch-invalid'] });
  });

  it.each([
    ['openAttempts', 1, 'open-attempts'],
    ['currentSourceValid', false, 'source-not-current'],
    ['coherentBindingValid', false, 'coherent-binding-missing'],
    ['successorSourceValid', false, 'successor-source-invalid'],
    ['roleSeparationPreserved', false, 'role-separation-weakened'],
    ['coordinationLeaseHeld', false, 'coordination-lease-missing'],
    ['transactionLockHeld', false, 'transaction-lock-missing'],
    ['killActive', true, 'kill-active'],
    ['cancellationActive', true, 'cancellation-active'],
    ['deadlineActive', true, 'deadline-active'],
  ] as const)('withholds preflight when %s fails', (key, replacement, blocker) => {
    const output = preflightAgentOsRolloverV1(preflightInput({ [key]: replacement }));
    expect(output.state).toBe('withheld');
    expect(output.blockers).toContain(blocker);
    expect(output.recoveryAction).toBe('halt-writes');
  });

  it('requires threshold or explicit observation-only maintenance to request rollover', () => {
    expect(preflightAgentOsRolloverV1(preflightInput({
      rolloverThresholdReached: false,
      maintenanceRequested: false,
    })).blockers).toEqual(['rollover-not-requested']);
    expect(preflightAgentOsRolloverV1(preflightInput({
      rolloverThresholdReached: false,
      maintenanceRequested: true,
    })).state).toBe('accepted');
  });

  it('accepts advanced/replayed/conflict CAS only when returned bytes exactly equal the intended head', () => {
    const value = fixture();
    for (const state of ['advanced', 'replayed'] as const) {
      expect(classifyAgentOsAnchorCasOutcomeV1(casInput(
        { state, canonicalHeadBytes: value.nextHeadBytes },
        { state: 'present', canonicalHeadBytes: value.nextHeadBytes },
      ))).toMatchObject({ state: 'accepted', operationalState: 'anchor-advanced' });
      expect(classifyAgentOsAnchorCasOutcomeV1(casInput(
        { state, canonicalHeadBytes: value.firstHeadBytes },
        { state: 'present', canonicalHeadBytes: value.firstHeadBytes },
      ))).toMatchObject({ state: 'degraded', operationalState: 'degraded' });
    }
    expect(classifyAgentOsAnchorCasOutcomeV1(casInput(
      { state: 'conflict', canonicalHeadBytes: value.nextHeadBytes },
      { state: 'present', canonicalHeadBytes: value.nextHeadBytes },
    )).state).toBe('accepted');
    expect(classifyAgentOsAnchorCasOutcomeV1(casInput(
      { state: 'conflict', canonicalHeadBytes: Buffer.from('{}') },
      { state: 'present', canonicalHeadBytes: value.nextHeadBytes },
    ))).toMatchObject({ state: 'degraded', blockers: ['anchor-head-invalid'] });
  });

  it('resolves indeterminate CAS only by exact read-back and never retries blindly', () => {
    const value = fixture();
    const classify = (readAfterCas: AgentOsRolloverPreflightInputV1['anchor']) =>
      classifyAgentOsAnchorCasOutcomeV1(casInput({ state: 'indeterminate' }, readAfterCas));
    expect(classify({ state: 'present', canonicalHeadBytes: value.nextHeadBytes })).toMatchObject({
      state: 'accepted', recoveryAction: 'recover-local-pointer',
    });
    expect(classify({ state: 'present', canonicalHeadBytes: value.firstHeadBytes })).toMatchObject({
      state: 'indeterminate', recoveryAction: 'replay-same-cas-operation',
    });
    expect(classify({ state: 'unavailable' })).toMatchObject({
      state: 'indeterminate', recoveryAction: 'halt-writes',
    });
    expect(classify({ state: 'missing' })).toMatchObject({ state: 'indeterminate', recoveryAction: 'halt-writes' });
  });

  it('requires exact read-back even after an adapter reports advanced and binds replay to the operation ID', () => {
    const value = fixture();
    expect(classifyAgentOsAnchorCasOutcomeV1(casInput(
      { state: 'advanced', canonicalHeadBytes: value.nextHeadBytes },
      { state: 'unavailable' },
    ))).toMatchObject({ state: 'indeterminate', recoveryAction: 'halt-writes' });
    expect(classifyAgentOsAnchorCasOutcomeV1({
      ...casInput(
        { state: 'unavailable' },
        { state: 'present', canonicalHeadBytes: value.firstHeadBytes },
      ),
      operationId: controlDigest('9'),
    })).toMatchObject({ state: 'degraded', recoveryAction: 'halt-writes' });
  });

  it('keeps the literal all-false authority block on every result path', () => {
    const outputs = [
      compileAgentOsRolloverStatusV1(statusInput()),
      compileAgentOsRolloverStatusV1(statusInput({ commissioned: false })),
      compileAgentOsRolloverStatusV1(statusInput({ anchor: { state: 'unavailable' } })),
      preflightAgentOsRolloverV1(preflightInput({ killActive: true })),
      classifyAgentOsAnchorCasOutcomeV1(casInput(
        { state: 'unavailable' },
        { state: 'unavailable' },
      )),
    ];
    for (const output of outputs) {
      expect(output).toMatchObject(AGENT_OS_ROLLOVER_AUTHORITY_V1);
      expect(Object.entries(AGENT_OS_ROLLOVER_AUTHORITY_V1).every(
        ([key, expected]) => output[key as keyof typeof output] === expected,
      )).toBe(true);
      expect(output.rollbackProtected).toBe(false);
      expect(output.evidenceAssurance).toBe('structural-and-injected-verifier-only');
      expect(output).toMatchObject({
        writesPermitted: false, casPermitted: false, pointerMutationPermitted: false,
      });
    }
  });

  it('returns frozen authority and blocker projections', () => {
    const output = compileAgentOsRolloverStatusV1(statusInput());
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.blockers)).toBe(true);
    expect(() => { (output as unknown as { executionAuthority: boolean }).executionAuthority = true; })
      .toThrow();
  });

  it('fails closed instead of throwing on malformed public API input', () => {
    expect(() => compileAgentOsRolloverStatusV1(null as unknown as AgentOsRolloverStatusInputV1))
      .not.toThrow();
    expect(compileAgentOsRolloverStatusV1({
      ...statusInput(), extra: false,
    } as unknown as AgentOsRolloverStatusInputV1).state).toBe('degraded');
    const accessor = { ...statusInput() } as Record<string, unknown>;
    Object.defineProperty(accessor, 'anchor', { enumerable: true, get: () => { throw new Error('no'); } });
    expect(compileAgentOsRolloverStatusV1(accessor as unknown as AgentOsRolloverStatusInputV1).state)
      .toBe('degraded');
    expect(classifyAgentOsAnchorCasOutcomeV1(null as unknown as Parameters<
      typeof classifyAgentOsAnchorCasOutcomeV1
    >[0]).state).toBe('degraded');
  });
});
