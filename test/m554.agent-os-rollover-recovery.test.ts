import { describe, expect, it } from 'vitest';

import {
  AGENT_OS_EPOCH_GENESIS_V1,
  AGENT_OS_EPOCH_HEAD_PROTOCOL_V1,
  AGENT_OS_EPOCH_MANIFEST_PROTOCOL_V1,
  AGENT_OS_ROLLOVER_AUTHORITY_V1,
  agentOsAttemptNamespaceDigestV1,
  agentOsObservationEpochHeadDigestV1,
  agentOsObservationEpochManifestDigestV1,
  agentOsRolloverOperationIdV1,
  canonicalAgentOsObservationEpochHeadBytesV1,
  canonicalAgentOsObservationEpochManifestBytesV1,
  type AgentOsObservationEpochHeadUnsignedV1,
  type AgentOsObservationEpochHeadV1,
  type AgentOsObservationEpochManifestUnsignedV1,
  type AgentOsObservationEpochManifestV1,
  type AgentOsRolloverPreflightInputV1,
  type AgentOsRolloverStatusInputV1,
} from '../src/core/vision/agent-os-rollover-protocol.js';
import {
  AGENT_OS_EPOCH_STORE_COMPATIBILITY_PROTOCOL_V1,
  AGENT_OS_ROLLOVER_RECOVERY_PROTOCOL_V1,
  compileAgentOsRolloverRecoveryPlanV1,
  type AgentOsRolloverCasAttemptObservationV1,
  type AgentOsRolloverRecoveryInputV1,
} from '../src/core/vision/agent-os-rollover-recovery.js';

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const signedArtifactDigest = (character: string): string => character.repeat(64);
const WRITER = digest('a');
const POLICY = signedArtifactDigest('b');
const SOURCE_ONE = signedArtifactDigest('c');
const SOURCE_TWO = signedArtifactDigest('d');
const SNAPSHOT_ONE = signedArtifactDigest('e');
const ATTEMPT_ONE = digest('f');
const BINDING_ONE = digest('1');
const FLEET = digest('5');
const ANCHOR_POLICY = digest('6');

function manifest(epoch: number, previous?: {
  head: AgentOsObservationEpochHeadV1;
  manifest: AgentOsObservationEpochManifestV1;
}): AgentOsObservationEpochManifestV1 {
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
  return {
    ...unsigned,
    manifestDigest: agentOsObservationEpochManifestDigestV1(unsigned)!,
    localAuthenticator: '4'.repeat(64),
  };
}

function head(value: AgentOsObservationEpochManifestV1): AgentOsObservationEpochHeadV1 {
  const unsigned: AgentOsObservationEpochHeadUnsignedV1 = {
    schemaVersion: 1,
    protocol: AGENT_OS_EPOCH_HEAD_PROTOCOL_V1,
    epoch: value.epoch,
    protocolGeneration: 1,
    previousHeadDigest: value.previousEpochHeadDigest,
    epochManifestDigest: value.manifestDigest,
    firstSourceBundleDigest: value.firstSourceBundle.bundleDigest,
    closedSourceTipDigest: value.previousSourceTip?.bundleDigest ?? AGENT_OS_EPOCH_GENESIS_V1.sourceTipDigest,
    closedSnapshotTipDigest: value.previousSnapshotTip?.envelopeDigest ??
      AGENT_OS_EPOCH_GENESIS_V1.snapshotTipDigest,
    closedAttemptSetDigest: value.previousAttemptSetDigest,
    coherentBindingDigest: value.previousCoherentBindingDigest ??
      AGENT_OS_EPOCH_GENESIS_V1.coherentBindingDigest,
    writerProtocolDigest: WRITER,
    advancedAt: value.createdAt,
    ...AGENT_OS_ROLLOVER_AUTHORITY_V1,
  };
  return { ...unsigned, headDigest: agentOsObservationEpochHeadDigestV1(unsigned)! };
}

function serialize(serializer: (value: unknown) => Buffer | null, value: unknown): Buffer {
  const output = serializer(value);
  if (!output) throw new Error('invalid fixture');
  return output;
}

function fixture() {
  const firstManifest = manifest(1);
  const firstHead = head(firstManifest);
  const nextManifest = manifest(2, { head: firstHead, manifest: firstManifest });
  const nextHead = head(nextManifest);
  return {
    firstManifest,
    firstHead,
    nextManifest,
    nextHead,
    firstManifestBytes: serialize(canonicalAgentOsObservationEpochManifestBytesV1, firstManifest),
    firstHeadBytes: serialize(canonicalAgentOsObservationEpochHeadBytesV1, firstHead),
    nextManifestBytes: serialize(canonicalAgentOsObservationEpochManifestBytesV1, nextManifest),
    nextHeadBytes: serialize(canonicalAgentOsObservationEpochHeadBytesV1, nextHead),
  };
}

function status(overrides: Partial<AgentOsRolloverStatusInputV1> = {}): AgentOsRolloverStatusInputV1 {
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

function prepared(overrides: Partial<AgentOsRolloverPreflightInputV1> = {}): AgentOsRolloverPreflightInputV1 {
  const value = fixture();
  const operationId = agentOsRolloverOperationIdV1({
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
    recoveryOperationId: operationId,
  };
  const baseStatus = status({
    rolloverThresholdReached: true,
    preparedManifestBytes: value.nextManifestBytes,
    preparedEpochEvidence,
  });
  const evidenceVerifier = (evidence: typeof preparedEpochEvidence) => evidence.recoveryOperationId === operationId;
  baseStatus.preparedEpochEvidenceVerifier = evidenceVerifier;
  return {
    ...baseStatus,
    preparedEpochEvidenceVerifier: evidenceVerifier,
    intendedNextHeadBytes: value.nextHeadBytes,
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

function input(overrides: Partial<AgentOsRolloverRecoveryInputV1> = {}): AgentOsRolloverRecoveryInputV1 {
  const value = fixture();
  const storeCompatibility = {
    schemaVersion: 1 as const,
    protocol: AGENT_OS_EPOCH_STORE_COMPATIBILITY_PROTOCOL_V1,
    protocolGeneration: 1 as const,
    currentHeadDigest: value.firstHead.headDigest,
    targetEpoch: 2,
    sourceStoreEpochCompatible: true,
    snapshotStoreEpochCompatible: true,
    attemptNamespaceEpochCompatible: true,
  };
  return {
    statusInput: status(),
    preparedTransition: null,
    lastCasAttempt: null,
    postCasAnchorRead: null,
    storeCompatibility,
    storeCompatibilityVerifier: (candidate) => candidate.currentHeadDigest === value.firstHead.headDigest &&
      candidate.targetEpoch === 2,
    ...overrides,
  };
}

function preparedInput(overrides: Partial<AgentOsRolloverRecoveryInputV1> = {}) {
  const transition = prepared();
  return input({ statusInput: transition, preparedTransition: transition, ...overrides });
}

function attempt(
  casResult: AgentOsRolloverCasAttemptObservationV1['casResult'],
): AgentOsRolloverCasAttemptObservationV1 {
  const value = fixture();
  return {
    expectedCurrentHeadBytes: value.firstHeadBytes,
    intendedNextHeadBytes: value.nextHeadBytes,
    fleetIdentityDigest: FLEET,
    anchorPolicyDigest: ANCHOR_POLICY,
    operationId: agentOsRolloverOperationIdV1({
      fleetIdentityDigest: FLEET,
      anchorPolicyDigest: ANCHOR_POLICY,
      expectedHeadDigest: value.firstHead.headDigest,
      nextHeadDigest: value.nextHead.headDigest,
      protocolGeneration: 1,
    })!,
    casResult,
  };
}

describe('M554 Agent OS rollover recovery orchestration', () => {
  it('keeps a healthy epoch idle and delegates first observation to the scheduler', () => {
    expect(compileAgentOsRolloverRecoveryPlanV1(input())).toMatchObject({
      state: 'idle', operation: 'none', reason: 'healthy',
    });
    expect(compileAgentOsRolloverRecoveryPlanV1(input({
      statusInput: status({ firstSnapshotPresent: false }),
    }))).toMatchObject({
      state: 'idle', operation: 'none', reason: 'first-observation-owned-by-scheduler',
    });
  });

  it('plans local preparation but does not manufacture a successor or claim permission', () => {
    const output = compileAgentOsRolloverRecoveryPlanV1(input({
      statusInput: status({ rolloverThresholdReached: true }),
    }));
    expect(output).toMatchObject({
      state: 'preparation-required', operation: 'prepare-local-epoch',
      reason: 'rollover-preparation-required', operationId: null,
      writesPermitted: false, effectsPermitted: false,
    });
  });

  it.each([
    ['missing', null],
    ['source incompatible', {
      ...input().storeCompatibility!, sourceStoreEpochCompatible: false,
    }],
    ['snapshot incompatible', {
      ...input().storeCompatibility!, snapshotStoreEpochCompatible: false,
    }],
    ['attempt namespace incompatible', {
      ...input().storeCompatibility!, attemptNamespaceEpochCompatible: false,
    }],
    ['wrong current head', {
      ...input().storeCompatibility!, currentHeadDigest: digest('9'),
    }],
    ['wrong target epoch', {
      ...input().storeCompatibility!, targetEpoch: 3,
    }],
  ])('withholds rollover when store compatibility is %s', (_label, storeCompatibility) => {
    expect(compileAgentOsRolloverRecoveryPlanV1(input({
      statusInput: status({ rolloverThresholdReached: true }),
      storeCompatibility,
    }))).toMatchObject({
      state: 'degraded', operation: 'halt', reason: 'store-compatibility-unverified',
    });
  });

  it('requires injected verification of compatibility and contains verifier mutation', () => {
    const compatibility = input().storeCompatibility!;
    const rejected = compileAgentOsRolloverRecoveryPlanV1(input({
      statusInput: status({ rolloverThresholdReached: true }),
      storeCompatibilityVerifier: () => false,
    }));
    expect(rejected.reason).toBe('store-compatibility-unverified');
    const contained = compileAgentOsRolloverRecoveryPlanV1(input({
      statusInput: status({ rolloverThresholdReached: true }),
      storeCompatibilityVerifier: (candidate) => {
        (candidate as { sourceStoreEpochCompatible: boolean }).sourceStoreEpochCompatible = false;
        return true;
      },
    }));
    expect(contained.reason).toBe('store-compatibility-unverified');
    expect(compatibility.sourceStoreEpochCompatible).toBe(true);
  });

  it('plans exact CAS only after the complete M550 prepared preflight succeeds', () => {
    const value = fixture();
    const output = compileAgentOsRolloverRecoveryPlanV1(preparedInput());
    expect(output).toMatchObject({
      state: 'cas-ready', operation: 'compare-and-swap-anchor', reason: 'prepared-epoch-verified',
      expectedCurrentHeadHex: value.firstHeadBytes.toString('hex'),
      intendedNextHeadHex: value.nextHeadBytes.toString('hex'),
    });
    expect(output.operationId).toBe(prepared().preparedEpochEvidence!.recoveryOperationId);
  });

  it.each([
    ['openAttempts', 1],
    ['successorSourceValid', false],
    ['transactionLockHeld', false],
    ['coordinationLeaseHeld', false],
    ['killActive', true],
  ] as const)('halts instead of planning CAS when preflight %s is unsafe', (key, replacement) => {
    const transition = prepared({ [key]: replacement });
    expect(compileAgentOsRolloverRecoveryPlanV1(input({
      statusInput: transition, preparedTransition: transition,
    }))).toMatchObject({
      state: 'degraded', operation: 'halt', reason: 'prepared-epoch-unverified',
    });
  });

  it('requires an anchor reread after every observed CAS result, including advanced', () => {
    const value = fixture();
    for (const casResult of [
      { state: 'advanced' as const, canonicalHeadBytes: value.nextHeadBytes },
      { state: 'replayed' as const, canonicalHeadBytes: value.nextHeadBytes },
      { state: 'conflict' as const, canonicalHeadBytes: value.nextHeadBytes },
      { state: 'indeterminate' as const },
      { state: 'unavailable' as const },
    ]) {
      expect(compileAgentOsRolloverRecoveryPlanV1(preparedInput({
        lastCasAttempt: attempt(casResult),
      }))).toMatchObject({
        state: 'cas-reread-required', operation: 'reread-anchor',
        reason: 'cas-outcome-requires-reread',
      });
    }
  });

  it('recovers committed CAS by installing only the exact intended pointer', () => {
    const value = fixture();
    const output = compileAgentOsRolloverRecoveryPlanV1(preparedInput({
      lastCasAttempt: attempt({ state: 'indeterminate' }),
      postCasAnchorRead: { state: 'present', canonicalHeadBytes: value.nextHeadBytes },
    }));
    expect(output).toMatchObject({
      state: 'pointer-recovery-ready', operation: 'install-active-pointer',
      reason: 'anchor-committed-pointer-lagging',
      intendedNextHeadHex: value.nextHeadBytes.toString('hex'),
      pointerMutationPermitted: false,
    });
  });

  it('replays only the same exact CAS operation when reread still names the old head', () => {
    const value = fixture();
    const prior = attempt({ state: 'indeterminate' });
    const output = compileAgentOsRolloverRecoveryPlanV1(preparedInput({
      lastCasAttempt: prior,
      postCasAnchorRead: { state: 'present', canonicalHeadBytes: value.firstHeadBytes },
    }));
    expect(output).toMatchObject({
      state: 'cas-replay-ready', operation: 'compare-and-swap-anchor',
      reason: 'same-cas-operation-replay-required', operationId: prior.operationId,
      expectedCurrentHeadHex: value.firstHeadBytes.toString('hex'),
      intendedNextHeadHex: value.nextHeadBytes.toString('hex'),
    });
  });

  it('does not replay a CAS whose adapter claimed success but whose reread stayed old', () => {
    const value = fixture();
    for (const state of ['advanced', 'replayed'] as const) {
      expect(compileAgentOsRolloverRecoveryPlanV1(preparedInput({
        lastCasAttempt: attempt({ state, canonicalHeadBytes: value.nextHeadBytes }),
        postCasAnchorRead: { state: 'present', canonicalHeadBytes: value.firstHeadBytes },
      }))).toMatchObject({
        state: 'degraded', operation: 'halt', reason: 'cas-outcome-degraded',
      });
    }
  });

  it('adopts a conflict response only when mandatory reread exactly names the intended head', () => {
    const value = fixture();
    expect(compileAgentOsRolloverRecoveryPlanV1(preparedInput({
      lastCasAttempt: attempt({ state: 'conflict', canonicalHeadBytes: value.nextHeadBytes }),
      postCasAnchorRead: { state: 'present', canonicalHeadBytes: value.nextHeadBytes },
    }))).toMatchObject({
      state: 'pointer-recovery-ready', operation: 'install-active-pointer',
    });
    expect(compileAgentOsRolloverRecoveryPlanV1(preparedInput({
      lastCasAttempt: attempt({ state: 'conflict', canonicalHeadBytes: null }),
      postCasAnchorRead: { state: 'present', canonicalHeadBytes: value.firstHeadBytes },
    }))).toMatchObject({ state: 'conflict', operation: 'halt', reason: 'anchor-conflict' });
  });

  it.each([
    [{ state: 'unavailable' as const }, 'unavailable', 'anchor-unavailable'],
    [{ state: 'degraded' as const }, 'degraded', 'cas-outcome-degraded'],
    [{ state: 'missing' as const }, 'unavailable', 'anchor-unavailable'],
  ])('halts an indeterminate CAS when reread is %j', (anchor, state, reason) => {
    expect(compileAgentOsRolloverRecoveryPlanV1(preparedInput({
      lastCasAttempt: attempt({ state: 'indeterminate' }),
      postCasAnchorRead: anchor,
    }))).toMatchObject({ state, operation: 'halt', reason });
  });

  it('halts on a byte-different valid anchor rather than adopting or replaying it', () => {
    const value = fixture();
    expect(compileAgentOsRolloverRecoveryPlanV1(preparedInput({
      lastCasAttempt: attempt({ state: 'indeterminate' }),
      postCasAnchorRead: { state: 'present', canonicalHeadBytes: value.firstHeadBytes.map(
        (byte, index) => index === 0 ? byte : byte,
      ) },
    })).state).toBe('cas-replay-ready');
    const different = manifest(1);
    const differentHead = head({ ...different, createdAt: '2026-09-03T12:00:01.000Z' });
    const differentBytes = serialize(canonicalAgentOsObservationEpochHeadBytesV1, differentHead);
    expect(compileAgentOsRolloverRecoveryPlanV1(preparedInput({
      lastCasAttempt: attempt({ state: 'indeterminate' }),
      postCasAnchorRead: { state: 'present', canonicalHeadBytes: differentBytes },
    }))).toMatchObject({ state: 'conflict', operation: 'halt', reason: 'anchor-conflict' });
  });

  it('recovers an anchor-ahead local pointer only with exact verified prepared evidence', () => {
    const value = fixture();
    const transition = prepared({ anchor: { state: 'present', canonicalHeadBytes: value.nextHeadBytes } });
    const output = compileAgentOsRolloverRecoveryPlanV1(input({
      statusInput: transition,
      preparedTransition: transition,
    }));
    expect(output).toMatchObject({
      state: 'pointer-recovery-ready', operation: 'install-active-pointer',
      reason: 'anchor-committed-pointer-lagging',
    });
  });

  it('withholds CAS and pointer recovery when epoch-store compatibility is withdrawn', () => {
    expect(compileAgentOsRolloverRecoveryPlanV1(preparedInput({
      storeCompatibility: null,
    }))).toMatchObject({ operation: 'halt', reason: 'store-compatibility-unverified' });
    const value = fixture();
    const transition = prepared({ anchor: { state: 'present', canonicalHeadBytes: value.nextHeadBytes } });
    expect(compileAgentOsRolloverRecoveryPlanV1(input({
      statusInput: transition,
      preparedTransition: transition,
      storeCompatibilityVerifier: () => false,
    }))).toMatchObject({ operation: 'halt', reason: 'store-compatibility-unverified' });
  });

  it('never rolls an ahead pointer backward or skips an epoch', () => {
    const value = fixture();
    expect(compileAgentOsRolloverRecoveryPlanV1(input({
      statusInput: status({
        anchor: { state: 'present', canonicalHeadBytes: value.firstHeadBytes },
        localActiveHeadBytes: value.nextHeadBytes,
      }),
    }))).toMatchObject({ state: 'degraded', operation: 'halt' });
  });

  it('keeps uncommissioned, unavailable, missing, and legacy states non-operational', () => {
    expect(compileAgentOsRolloverRecoveryPlanV1(input({
      statusInput: status({ commissioned: false }),
    }))).toMatchObject({ state: 'uncommissioned', operation: 'none', reason: 'not-commissioned' });
    for (const anchor of [{ state: 'unavailable' as const }, { state: 'missing' as const }]) {
      expect(compileAgentOsRolloverRecoveryPlanV1(input({ statusInput: status({ anchor }) })))
        .toMatchObject({ operation: 'halt' });
    }
    expect(compileAgentOsRolloverRecoveryPlanV1(input({
      statusInput: status({ legacyActivityDetected: true }),
    }))).toMatchObject({ state: 'degraded', operation: 'halt' });
  });

  it('rejects a post-CAS read without an exact prior attempt', () => {
    expect(compileAgentOsRolloverRecoveryPlanV1(input({
      postCasAnchorRead: { state: 'unavailable' },
    }))).toMatchObject({ state: 'degraded', operation: 'halt', reason: 'cas-attempt-mismatch' });
  });

  it.each([
    ['operation ID', (value: ReturnType<typeof attempt>) => ({ ...value, operationId: digest('9') })],
    ['expected bytes', (value: ReturnType<typeof attempt>) => ({
      ...value, expectedCurrentHeadBytes: fixture().nextHeadBytes,
    })],
    ['intended bytes', (value: ReturnType<typeof attempt>) => ({
      ...value, intendedNextHeadBytes: fixture().firstHeadBytes,
    })],
    ['fleet identity', (value: ReturnType<typeof attempt>) => ({
      ...value, fleetIdentityDigest: digest('9'),
    })],
    ['anchor policy', (value: ReturnType<typeof attempt>) => ({
      ...value, anchorPolicyDigest: digest('9'),
    })],
  ])('rejects CAS replay substitution of %s', (_label, change) => {
    expect(compileAgentOsRolloverRecoveryPlanV1(preparedInput({
      lastCasAttempt: change(attempt({ state: 'indeterminate' })),
    }))).toMatchObject({ state: 'degraded', operation: 'halt', reason: 'cas-attempt-mismatch' });
  });

  it('rejects status/prepared split-brain state', () => {
    const transition = prepared();
    expect(compileAgentOsRolloverRecoveryPlanV1(input({
      statusInput: { ...transition, anchorPolicyDigest: digest('9') },
      preparedTransition: transition,
    }))).toMatchObject({ state: 'degraded', operation: 'halt', reason: 'prepared-state-mismatch' });
  });

  it('pins all byte inputs before calling adversarial verifiers', () => {
    const transition = prepared();
    const originalHead = Buffer.from(transition.intendedNextHeadBytes);
    const sourceHead = transition.intendedNextHeadBytes;
    transition.manifestAuthenticatorVerifier = () => {
      sourceHead.fill(0);
      return true;
    };
    const recovery = input({ statusInput: transition, preparedTransition: transition });
    const output = compileAgentOsRolloverRecoveryPlanV1(recovery);
    expect(output.operation).toBe('compare-and-swap-anchor');
    expect(output.intendedNextHeadHex).toBe(originalHead.toString('hex'));
  });

  it('returns frozen immutable strings and literal all-false authority for every path', () => {
    const outputs = [
      compileAgentOsRolloverRecoveryPlanV1(input()),
      compileAgentOsRolloverRecoveryPlanV1(input({ statusInput: status({ rolloverThresholdReached: true }) })),
      compileAgentOsRolloverRecoveryPlanV1(preparedInput()),
      compileAgentOsRolloverRecoveryPlanV1(null as unknown as AgentOsRolloverRecoveryInputV1),
    ];
    for (const output of outputs) {
      expect(Object.isFrozen(output)).toBe(true);
      expect(output.protocol).toBe(AGENT_OS_ROLLOVER_RECOVERY_PROTOCOL_V1);
      expect(output).toMatchObject(AGENT_OS_ROLLOVER_AUTHORITY_V1);
      expect(output).toMatchObject({
        writesPermitted: false, casPermitted: false, pointerMutationPermitted: false,
        effectsPermitted: false, rollbackProtected: false,
      });
    }
  });

  it('fails closed on unknown fields, accessors, malformed CAS, and hostile callbacks', () => {
    expect(compileAgentOsRolloverRecoveryPlanV1({
      ...input(), extra: false,
    } as unknown as AgentOsRolloverRecoveryInputV1).reason).toBe('invalid-input');
    const accessor = { ...input() } as Record<string, unknown>;
    Object.defineProperty(accessor, 'statusInput', {
      enumerable: true, get: () => { throw new Error('hostile'); },
    });
    expect(compileAgentOsRolloverRecoveryPlanV1(
      accessor as unknown as AgentOsRolloverRecoveryInputV1,
    ).reason).toBe('invalid-input');
    expect(compileAgentOsRolloverRecoveryPlanV1(preparedInput({
      lastCasAttempt: { ...attempt({ state: 'indeterminate' }), operationId: 'bad' },
    }))).toMatchObject({ state: 'degraded', operation: 'halt', reason: 'invalid-input' });
    const transition = prepared({ closureEvidenceVerifier: () => { throw new Error('no'); } });
    expect(compileAgentOsRolloverRecoveryPlanV1(input({
      statusInput: transition, preparedTransition: transition,
    }))).toMatchObject({ operation: 'halt', reason: 'prepared-epoch-unverified' });
  });

  it('does not import filesystem, network, daemon, configuration, keys, or M553', async () => {
    const source = await import('node:fs/promises').then(async ({ readFile }) =>
      readFile(new URL('../src/core/vision/agent-os-rollover-recovery.ts', import.meta.url), 'utf8'));
    expect(source).not.toMatch(/from ['"]node:(?:fs|net|http|https|tls|dgram)/);
    expect(source).not.toMatch(/from ['"].*agent-os-epoch-store/);
    expect(source).not.toMatch(/from ['"].*(?:daemon|config|credential|private-key|secret)/i);
    expect(source).not.toContain('operations.');
  });
});
