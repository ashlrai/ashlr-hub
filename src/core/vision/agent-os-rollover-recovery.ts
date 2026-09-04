/**
 * Pure M546/M554 rollover recovery orchestration.
 *
 * This module never performs I/O. It turns exact M550 observations into one
 * bounded next operation for a separately reviewed adapter. The external
 * anchor remains the sole commit point and every result remains
 * observation-only.
 */

import {
  AGENT_OS_ROLLOVER_AUTHORITY_V1,
  AGENT_OS_ROLLOVER_PROTOCOL_GENERATION_V1,
  agentOsRolloverOperationIdV1,
  classifyAgentOsAnchorCasOutcomeV1,
  compileAgentOsRolloverStatusV1,
  parseAgentOsObservationEpochHeadV1,
  preflightAgentOsRolloverV1,
  type AgentOsAnchorCasClassificationInputV1,
  type AgentOsMonotonicAnchorCasResultV1,
  type AgentOsMonotonicAnchorReadResultV1,
  type AgentOsRolloverAuthorityV1,
  type AgentOsRolloverPreflightInputV1,
  type AgentOsRolloverPublicResultV1,
  type AgentOsRolloverStatusInputV1,
} from './agent-os-rollover-protocol.js';

export const AGENT_OS_ROLLOVER_RECOVERY_PROTOCOL_V1 =
  'ashlr-agent-os-rollover-recovery-v1' as const;

export type AgentOsRolloverRecoveryOperationV1 =
  | 'none'
  | 'prepare-local-epoch'
  | 'compare-and-swap-anchor'
  | 'reread-anchor'
  | 'install-active-pointer'
  | 'halt';

export type AgentOsRolloverRecoveryStateV1 =
  | 'idle'
  | 'preparation-required'
  | 'cas-ready'
  | 'cas-reread-required'
  | 'cas-replay-ready'
  | 'pointer-recovery-ready'
  | 'uncommissioned'
  | 'unavailable'
  | 'conflict'
  | 'degraded';

export type AgentOsRolloverRecoveryReasonV1 =
  | 'healthy'
  | 'first-observation-owned-by-scheduler'
  | 'rollover-preparation-required'
  | 'prepared-epoch-verified'
  | 'cas-outcome-requires-reread'
  | 'same-cas-operation-replay-required'
  | 'anchor-committed-pointer-lagging'
  | 'not-commissioned'
  | 'anchor-unavailable'
  | 'anchor-conflict'
  | 'invalid-input'
  | 'status-degraded'
  | 'prepared-state-mismatch'
  | 'store-compatibility-unverified'
  | 'prepared-epoch-unverified'
  | 'cas-attempt-mismatch'
  | 'cas-outcome-degraded';

export interface AgentOsRolloverCasAttemptObservationV1 {
  expectedCurrentHeadBytes: Uint8Array;
  intendedNextHeadBytes: Uint8Array;
  fleetIdentityDigest: string;
  anchorPolicyDigest: string;
  operationId: string;
  casResult: AgentOsMonotonicAnchorCasResultV1;
}

export interface AgentOsRolloverRecoveryInputV1 {
  statusInput: AgentOsRolloverStatusInputV1;
  preparedTransition: AgentOsRolloverPreflightInputV1 | null;
  lastCasAttempt: AgentOsRolloverCasAttemptObservationV1 | null;
  postCasAnchorRead: AgentOsMonotonicAnchorReadResultV1 | null;
  storeCompatibility: AgentOsEpochStoreCompatibilityEvidenceV1 | null;
  storeCompatibilityVerifier: AgentOsEpochStoreCompatibilityVerifierV1;
}

export const AGENT_OS_EPOCH_STORE_COMPATIBILITY_PROTOCOL_V1 =
  'ashlr-agent-os-epoch-store-compatibility-v1' as const;

/**
 * Injected evidence only. In particular, this module does not claim that the
 * existing V1 sequence/digest stores are epoch-compatible.
 */
export interface AgentOsEpochStoreCompatibilityEvidenceV1 {
  schemaVersion: 1;
  protocol: typeof AGENT_OS_EPOCH_STORE_COMPATIBILITY_PROTOCOL_V1;
  protocolGeneration: typeof AGENT_OS_ROLLOVER_PROTOCOL_GENERATION_V1;
  currentHeadDigest: string;
  targetEpoch: number;
  sourceStoreEpochCompatible: boolean;
  snapshotStoreEpochCompatible: boolean;
  attemptNamespaceEpochCompatible: boolean;
}

export type AgentOsEpochStoreCompatibilityVerifierV1 = (
  evidence: Readonly<AgentOsEpochStoreCompatibilityEvidenceV1>,
) => boolean;

/**
 * Boundary expected of a future executor. M554 does not call these methods.
 * Implementations must re-read their own durable inputs and invoke this pure
 * planner again after every method, especially after CAS.
 */
export interface AgentOsRolloverRecoveryOperationsV1 {
  readLocalState(): Promise<AgentOsRolloverRecoveryInputV1>;
  prepareLocalEpoch(plan: AgentOsRolloverRecoveryPlanV1): Promise<void>;
  compareAndSwapAnchor(plan: AgentOsRolloverRecoveryPlanV1): Promise<AgentOsMonotonicAnchorCasResultV1>;
  rereadAnchor(plan: AgentOsRolloverRecoveryPlanV1): Promise<AgentOsMonotonicAnchorReadResultV1>;
  installActivePointer(plan: AgentOsRolloverRecoveryPlanV1): Promise<void>;
}

export interface AgentOsRolloverRecoveryPlanV1 extends AgentOsRolloverAuthorityV1 {
  schemaVersion: 1;
  protocol: typeof AGENT_OS_ROLLOVER_RECOVERY_PROTOCOL_V1;
  state: AgentOsRolloverRecoveryStateV1;
  operation: AgentOsRolloverRecoveryOperationV1;
  reason: AgentOsRolloverRecoveryReasonV1;
  operationId: string | null;
  expectedCurrentHeadHex: string | null;
  intendedNextHeadHex: string | null;
  writesPermitted: false;
  casPermitted: false;
  pointerMutationPermitted: false;
  effectsPermitted: false;
  rollbackProtected: false;
  evidenceAssurance: 'structural-and-injected-verifier-only';
}

const INPUT_KEYS = [
  'statusInput', 'preparedTransition', 'lastCasAttempt', 'postCasAnchorRead',
  'storeCompatibility', 'storeCompatibilityVerifier',
] as const;
const CAS_ATTEMPT_KEYS = [
  'expectedCurrentHeadBytes', 'intendedNextHeadBytes', 'fleetIdentityDigest',
  'anchorPolicyDigest', 'operationId', 'casResult',
] as const;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const COMPATIBILITY_KEYS = [
  'schemaVersion', 'protocol', 'protocolGeneration', 'currentHeadDigest', 'targetEpoch',
  'sourceStoreEpochCompatible', 'snapshotStoreEpochCompatible',
  'attemptNamespaceEpochCompatible',
] as const;

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' ||
      descriptors[String(key)]?.enumerable !== true ||
      !Object.hasOwn(descriptors[String(key)]!, 'value'))) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

function validAnchorRead(value: unknown): value is AgentOsMonotonicAnchorReadResultV1 {
  const row = record(value);
  if (!row || typeof row['state'] !== 'string') return false;
  if (row['state'] === 'present') {
    return exactKeys(row, ['state', 'canonicalHeadBytes']) && row['canonicalHeadBytes'] instanceof Uint8Array;
  }
  return ['missing', 'unavailable', 'degraded'].includes(row['state']) && exactKeys(row, ['state']);
}

function validCasResult(value: unknown): value is AgentOsMonotonicAnchorCasResultV1 {
  const row = record(value);
  if (!row || typeof row['state'] !== 'string') return false;
  if (row['state'] === 'advanced' || row['state'] === 'replayed') {
    return exactKeys(row, ['state', 'canonicalHeadBytes']) && row['canonicalHeadBytes'] instanceof Uint8Array;
  }
  if (row['state'] === 'conflict') {
    return exactKeys(row, ['state', 'canonicalHeadBytes']) &&
      (row['canonicalHeadBytes'] === null || row['canonicalHeadBytes'] instanceof Uint8Array);
  }
  return ['unavailable', 'indeterminate'].includes(row['state']) && exactKeys(row, ['state']);
}

function validCasAttempt(value: unknown): value is AgentOsRolloverCasAttemptObservationV1 {
  const row = record(value);
  return row !== null && exactKeys(row, CAS_ATTEMPT_KEYS) &&
    row['expectedCurrentHeadBytes'] instanceof Uint8Array &&
    row['intendedNextHeadBytes'] instanceof Uint8Array &&
    validDigest(row['fleetIdentityDigest']) && validDigest(row['anchorPolicyDigest']) &&
    validDigest(row['operationId']) && validCasResult(row['casResult']);
}

function validCompatibility(value: unknown): value is AgentOsEpochStoreCompatibilityEvidenceV1 {
  const row = record(value);
  return row !== null && exactKeys(row, COMPATIBILITY_KEYS) && row['schemaVersion'] === 1 &&
    row['protocol'] === AGENT_OS_EPOCH_STORE_COMPATIBILITY_PROTOCOL_V1 &&
    row['protocolGeneration'] === AGENT_OS_ROLLOVER_PROTOCOL_GENERATION_V1 &&
    validDigest(row['currentHeadDigest']) && Number.isSafeInteger(row['targetEpoch']) &&
    Number(row['targetEpoch']) > 1 &&
    typeof row['sourceStoreEpochCompatible'] === 'boolean' &&
    typeof row['snapshotStoreEpochCompatible'] === 'boolean' &&
    typeof row['attemptNamespaceEpochCompatible'] === 'boolean';
}

function cloneAnchorRead(value: AgentOsMonotonicAnchorReadResultV1): AgentOsMonotonicAnchorReadResultV1 {
  return value.state === 'present'
    ? Object.freeze({ state: 'present' as const, canonicalHeadBytes: Buffer.from(value.canonicalHeadBytes) })
    : Object.freeze({ state: value.state });
}

function cloneCasResult(value: AgentOsMonotonicAnchorCasResultV1): AgentOsMonotonicAnchorCasResultV1 {
  if (value.state === 'advanced' || value.state === 'replayed') {
    return Object.freeze({ state: value.state, canonicalHeadBytes: Buffer.from(value.canonicalHeadBytes) });
  }
  if (value.state === 'conflict') {
    return Object.freeze({
      state: 'conflict' as const,
      canonicalHeadBytes: value.canonicalHeadBytes ? Buffer.from(value.canonicalHeadBytes) : null,
    });
  }
  return Object.freeze({ state: value.state });
}

function cloneStatus(input: AgentOsRolloverStatusInputV1): AgentOsRolloverStatusInputV1 {
  return Object.freeze({
    commissioned: input.commissioned,
    legacyActivityDetected: input.legacyActivityDetected,
    fleetIdentityDigest: input.fleetIdentityDigest,
    anchorPolicyDigest: input.anchorPolicyDigest,
    runningWriterProtocolDigest: input.runningWriterProtocolDigest,
    anchor: cloneAnchorRead(input.anchor),
    localActiveHeadBytes: input.localActiveHeadBytes ? Buffer.from(input.localActiveHeadBytes) : null,
    activeManifestBytes: input.activeManifestBytes ? Buffer.from(input.activeManifestBytes) : null,
    preparedManifestBytes: input.preparedManifestBytes ? Buffer.from(input.preparedManifestBytes) : null,
    manifestAuthenticatorVerifier: input.manifestAuthenticatorVerifier,
    preparedEpochEvidence: input.preparedEpochEvidence
      ? Object.freeze({ ...input.preparedEpochEvidence })
      : null,
    preparedEpochEvidenceVerifier: input.preparedEpochEvidenceVerifier,
    ledgersComplete: input.ledgersComplete,
    capacityExhausted: input.capacityExhausted,
    rolloverThresholdReached: input.rolloverThresholdReached,
    firstSnapshotPresent: input.firstSnapshotPresent,
  });
}

function clonePreflight(input: AgentOsRolloverPreflightInputV1): AgentOsRolloverPreflightInputV1 {
  return Object.freeze({
    ...cloneStatus(input),
    preparedManifestBytes: Buffer.from(input.preparedManifestBytes),
    intendedNextHeadBytes: Buffer.from(input.intendedNextHeadBytes),
    currentClosure: Object.freeze({
      ...input.currentClosure,
      sourceTip: Object.freeze({ ...input.currentClosure.sourceTip }),
      snapshotTip: Object.freeze({ ...input.currentClosure.snapshotTip }),
    }),
    closureEvidenceVerifier: input.closureEvidenceVerifier,
    openAttempts: input.openAttempts,
    currentSourceValid: input.currentSourceValid,
    coherentBindingValid: input.coherentBindingValid,
    maintenanceRequested: input.maintenanceRequested,
    successorSourceValid: input.successorSourceValid,
    roleSeparationPreserved: input.roleSeparationPreserved,
    coordinationLeaseHeld: input.coordinationLeaseHeld,
    transactionLockHeld: input.transactionLockHeld,
    killActive: input.killActive,
    cancellationActive: input.cancellationActive,
    deadlineActive: input.deadlineActive,
  });
}

function cloneInput(input: AgentOsRolloverRecoveryInputV1): AgentOsRolloverRecoveryInputV1 | null {
  const row = record(input);
  if (!row || !exactKeys(row, INPUT_KEYS) ||
    (row['preparedTransition'] !== null && !record(row['preparedTransition'])) ||
    (row['lastCasAttempt'] !== null && !validCasAttempt(row['lastCasAttempt'])) ||
    (row['postCasAnchorRead'] !== null && !validAnchorRead(row['postCasAnchorRead'])) ||
    (row['storeCompatibility'] !== null && !validCompatibility(row['storeCompatibility'])) ||
    typeof row['storeCompatibilityVerifier'] !== 'function') return null;
  try {
    const statusInput = cloneStatus(input.statusInput);
    const preparedTransition = input.preparedTransition ? clonePreflight(input.preparedTransition) : null;
    const lastCasAttempt = input.lastCasAttempt ? Object.freeze({
      expectedCurrentHeadBytes: Buffer.from(input.lastCasAttempt.expectedCurrentHeadBytes),
      intendedNextHeadBytes: Buffer.from(input.lastCasAttempt.intendedNextHeadBytes),
      fleetIdentityDigest: input.lastCasAttempt.fleetIdentityDigest,
      anchorPolicyDigest: input.lastCasAttempt.anchorPolicyDigest,
      operationId: input.lastCasAttempt.operationId,
      casResult: cloneCasResult(input.lastCasAttempt.casResult),
    }) : null;
    return Object.freeze({
      statusInput,
      preparedTransition,
      lastCasAttempt,
      postCasAnchorRead: input.postCasAnchorRead ? cloneAnchorRead(input.postCasAnchorRead) : null,
      storeCompatibility: input.storeCompatibility
        ? Object.freeze({ ...input.storeCompatibility })
        : null,
      storeCompatibilityVerifier: input.storeCompatibilityVerifier,
    });
  } catch {
    return null;
  }
}

function compatibleStores(
  input: AgentOsRolloverRecoveryInputV1,
  transition: ReturnType<typeof exactTransition>,
): boolean {
  const evidence = input.storeCompatibility;
  if (!evidence || !validCompatibility(evidence) ||
    evidence.sourceStoreEpochCompatible !== true ||
    evidence.snapshotStoreEpochCompatible !== true ||
    evidence.attemptNamespaceEpochCompatible !== true) return false;
  const currentBytes = transition?.expectedCurrentHeadBytes ?? input.statusInput.localActiveHeadBytes;
  const current = currentBytes ? parseAgentOsObservationEpochHeadV1(currentBytes) : null;
  if (!current || evidence.currentHeadDigest !== current.headDigest ||
    evidence.targetEpoch !== current.epoch + 1) return false;
  try {
    return input.storeCompatibilityVerifier(Object.freeze({ ...evidence })) === true;
  } catch {
    return false;
  }
}

function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  return Buffer.from(left).equals(Buffer.from(right));
}

function sameAnchor(left: AgentOsMonotonicAnchorReadResultV1, right: AgentOsMonotonicAnchorReadResultV1): boolean {
  return left.state === right.state &&
    (left.state !== 'present' || (right.state === 'present' &&
      sameBytes(left.canonicalHeadBytes, right.canonicalHeadBytes)));
}

function preparedMatchesStatus(
  status: AgentOsRolloverStatusInputV1,
  prepared: AgentOsRolloverPreflightInputV1,
): boolean {
  return status.commissioned === prepared.commissioned &&
    status.legacyActivityDetected === prepared.legacyActivityDetected &&
    status.fleetIdentityDigest === prepared.fleetIdentityDigest &&
    status.anchorPolicyDigest === prepared.anchorPolicyDigest &&
    status.runningWriterProtocolDigest === prepared.runningWriterProtocolDigest &&
    sameAnchor(status.anchor, prepared.anchor) &&
    sameBytes(status.localActiveHeadBytes, prepared.localActiveHeadBytes) &&
    sameBytes(status.activeManifestBytes, prepared.activeManifestBytes) &&
    sameBytes(status.preparedManifestBytes, prepared.preparedManifestBytes) &&
    status.manifestAuthenticatorVerifier === prepared.manifestAuthenticatorVerifier &&
    status.preparedEpochEvidenceVerifier === prepared.preparedEpochEvidenceVerifier &&
    JSON.stringify(status.preparedEpochEvidence) === JSON.stringify(prepared.preparedEpochEvidence) &&
    status.ledgersComplete === prepared.ledgersComplete &&
    status.capacityExhausted === prepared.capacityExhausted &&
    status.rolloverThresholdReached === prepared.rolloverThresholdReached &&
    status.firstSnapshotPresent === prepared.firstSnapshotPresent;
}

function plan(
  state: AgentOsRolloverRecoveryStateV1,
  operation: AgentOsRolloverRecoveryOperationV1,
  reason: AgentOsRolloverRecoveryReasonV1,
  exact?: {
    operationId: string;
    expectedCurrentHeadBytes: Uint8Array;
    intendedNextHeadBytes: Uint8Array;
  },
): AgentOsRolloverRecoveryPlanV1 {
  return Object.freeze({
    schemaVersion: 1,
    protocol: AGENT_OS_ROLLOVER_RECOVERY_PROTOCOL_V1,
    state,
    operation,
    reason,
    operationId: exact?.operationId ?? null,
    expectedCurrentHeadHex: exact ? Buffer.from(exact.expectedCurrentHeadBytes).toString('hex') : null,
    intendedNextHeadHex: exact ? Buffer.from(exact.intendedNextHeadBytes).toString('hex') : null,
    writesPermitted: false,
    casPermitted: false,
    pointerMutationPermitted: false,
    effectsPermitted: false,
    rollbackProtected: false,
    evidenceAssurance: 'structural-and-injected-verifier-only',
    ...AGENT_OS_ROLLOVER_AUTHORITY_V1,
  });
}

function exactTransition(
  input: AgentOsRolloverRecoveryInputV1,
): {
  operationId: string;
  fleetIdentityDigest: string;
  anchorPolicyDigest: string;
  expectedCurrentHeadBytes: Uint8Array;
  intendedNextHeadBytes: Uint8Array;
} | null {
  const prepared = input.preparedTransition;
  if (!prepared || !prepared.localActiveHeadBytes) return null;
  const current = parseAgentOsObservationEpochHeadV1(prepared.localActiveHeadBytes);
  const intended = parseAgentOsObservationEpochHeadV1(prepared.intendedNextHeadBytes);
  if (!current || !intended) return null;
  const operationId = agentOsRolloverOperationIdV1({
    fleetIdentityDigest: prepared.fleetIdentityDigest,
    anchorPolicyDigest: prepared.anchorPolicyDigest,
    expectedHeadDigest: current.headDigest,
    nextHeadDigest: intended.headDigest,
    protocolGeneration: AGENT_OS_ROLLOVER_PROTOCOL_GENERATION_V1,
  });
  if (!operationId || prepared.preparedEpochEvidence?.recoveryOperationId !== operationId) return null;
  return {
    operationId,
    fleetIdentityDigest: prepared.fleetIdentityDigest,
    anchorPolicyDigest: prepared.anchorPolicyDigest,
    expectedCurrentHeadBytes: Buffer.from(prepared.localActiveHeadBytes),
    intendedNextHeadBytes: Buffer.from(prepared.intendedNextHeadBytes),
  };
}

function casMatchesTransition(
  attempt: AgentOsRolloverCasAttemptObservationV1,
  transition: NonNullable<ReturnType<typeof exactTransition>>,
): boolean {
  return attempt.operationId === transition.operationId &&
    attempt.fleetIdentityDigest === transition.fleetIdentityDigest &&
    attempt.anchorPolicyDigest === transition.anchorPolicyDigest &&
    sameBytes(attempt.expectedCurrentHeadBytes, transition.expectedCurrentHeadBytes) &&
    sameBytes(attempt.intendedNextHeadBytes, transition.intendedNextHeadBytes);
}

function stopFromStatus(status: AgentOsRolloverPublicResultV1): AgentOsRolloverRecoveryPlanV1 {
  if (status.state === 'uncommissioned') return plan('uncommissioned', 'none', 'not-commissioned');
  if (status.state === 'unavailable') return plan('unavailable', 'halt', 'anchor-unavailable');
  if (status.state === 'conflict') return plan('conflict', 'halt', 'anchor-conflict');
  return plan('degraded', 'halt', 'status-degraded');
}

function compileInternal(input: AgentOsRolloverRecoveryInputV1): AgentOsRolloverRecoveryPlanV1 {
  const owned = cloneInput(input);
  if (!owned) return plan('degraded', 'halt', 'invalid-input');
  const status = compileAgentOsRolloverStatusV1(owned.statusInput);

  if (owned.postCasAnchorRead && !owned.lastCasAttempt) {
    return plan('degraded', 'halt', 'cas-attempt-mismatch');
  }
  if (owned.preparedTransition && !preparedMatchesStatus(owned.statusInput, owned.preparedTransition)) {
    return plan('degraded', 'halt', 'prepared-state-mismatch');
  }

  const transition = exactTransition(owned);
  if (owned.lastCasAttempt) {
    if (!transition || !casMatchesTransition(owned.lastCasAttempt, transition)) {
      return plan('degraded', 'halt', 'cas-attempt-mismatch');
    }
    if (!compatibleStores(owned, transition)) {
      return plan('degraded', 'halt', 'store-compatibility-unverified');
    }
    if (!owned.postCasAnchorRead) {
      return plan('cas-reread-required', 'reread-anchor', 'cas-outcome-requires-reread', transition);
    }
    const classificationInput: AgentOsAnchorCasClassificationInputV1 = {
      expectedCurrentHeadBytes: owned.lastCasAttempt.expectedCurrentHeadBytes,
      intendedNextHeadBytes: owned.lastCasAttempt.intendedNextHeadBytes,
      fleetIdentityDigest: owned.lastCasAttempt.fleetIdentityDigest,
      anchorPolicyDigest: owned.lastCasAttempt.anchorPolicyDigest,
      operationId: owned.lastCasAttempt.operationId,
      casResult: owned.lastCasAttempt.casResult,
      readAfterCas: owned.postCasAnchorRead,
    };
    const classified = classifyAgentOsAnchorCasOutcomeV1(classificationInput);
    if (classified.recoveryAction === 'replay-same-cas-operation') {
      return plan('cas-replay-ready', 'compare-and-swap-anchor',
        'same-cas-operation-replay-required', transition);
    }
    if (classified.recoveryAction === 'recover-local-pointer') {
      return plan('pointer-recovery-ready', 'install-active-pointer',
        'anchor-committed-pointer-lagging', transition);
    }
    if (classified.state === 'unavailable' || classified.state === 'indeterminate') {
      return plan('unavailable', 'halt', 'anchor-unavailable');
    }
    if (classified.state === 'conflict') return plan('conflict', 'halt', 'anchor-conflict');
    return plan('degraded', 'halt', 'cas-outcome-degraded');
  }

  if (status.recoveryAction === 'recover-local-pointer') {
    if (!transition || owned.statusInput.anchor.state !== 'present' ||
      !sameBytes(owned.statusInput.anchor.canonicalHeadBytes, transition.intendedNextHeadBytes)) {
      return plan('degraded', 'halt', 'prepared-epoch-unverified');
    }
    if (!compatibleStores(owned, transition)) {
      return plan('degraded', 'halt', 'store-compatibility-unverified');
    }
    return plan('pointer-recovery-ready', 'install-active-pointer',
      'anchor-committed-pointer-lagging', transition);
  }

  if (owned.preparedTransition) {
    if (!transition || preflightAgentOsRolloverV1(owned.preparedTransition).state !== 'accepted') {
      return plan('degraded', 'halt', 'prepared-epoch-unverified');
    }
    if (!compatibleStores(owned, transition)) {
      return plan('degraded', 'halt', 'store-compatibility-unverified');
    }
    return plan('cas-ready', 'compare-and-swap-anchor', 'prepared-epoch-verified', transition);
  }

  if (status.state !== 'accepted') return stopFromStatus(status);
  if (status.recoveryAction === 'prepare-rollover') {
    if (!compatibleStores(owned, null)) {
      return plan('degraded', 'halt', 'store-compatibility-unverified');
    }
    return plan('preparation-required', 'prepare-local-epoch', 'rollover-preparation-required');
  }
  if (status.recoveryAction === 'run-first-observation') {
    return plan('idle', 'none', 'first-observation-owned-by-scheduler');
  }
  return plan('idle', 'none', 'healthy');
}

export function compileAgentOsRolloverRecoveryPlanV1(
  input: AgentOsRolloverRecoveryInputV1,
): AgentOsRolloverRecoveryPlanV1 {
  try {
    return compileInternal(input);
  } catch {
    return plan('degraded', 'halt', 'invalid-input');
  }
}
