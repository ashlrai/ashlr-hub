/**
 * Guarded cross-ledger recovery for one authenticated Agent OS epoch.
 *
 * Recovery only removes an authenticated one-link staging artifact or finishes
 * cleanup of an already-linked exact immutable record. It never publishes a
 * staged record, chooses an anchor, mutates an epoch pointer, or grants effect
 * authority. The caller must already hold both M556 coordination capabilities.
 */

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';

import type { LocalStoreLock } from '../fleet/local-store-lock.js';
import { ownsLocalStoreLock } from '../fleet/local-store-lock.js';
import {
  recoverAgentOsEpochAttemptStoreV2,
  type AgentOsEpochAttemptStoreDependenciesV1,
} from './agent-os-epoch-attempt-store.js';
import {
  ownsAgentOsEpochCoordinationLeaseV1,
  type AgentOsEpochCoordinationLeaseV1,
} from './agent-os-epoch-coordination.js';
import { AGENT_OS_EPOCH_RECORD_AUTHORITY_V1 } from './agent-os-epoch-records.js';
import {
  recoverAgentOsEpochSnapshotStoreV2,
  type AgentOsEpochSnapshotStoreDependenciesV1,
} from './agent-os-epoch-snapshot-store.js';
import {
  recoverAgentOsEpochSourceStoreV1,
  type AgentOsEpochSourceStoreDependenciesV1,
} from './agent-os-epoch-source-store.js';

export const AGENT_OS_EPOCH_STAGE_RECOVERY_PROTOCOL_V1 =
  'ashlr-agent-os-epoch-stage-recovery-v1' as const;

export interface AgentOsEpochRecoveryIdentityV1 {
  epoch: number;
  epochHeadDigest: string;
  epochManifestDigest: string;
  attemptNamespaceDigest: string;
  writerProtocolDigest: string;
}

export type AgentOsEpochRecoveryIdentityReadV1 =
  | { state: 'authenticated'; identity: AgentOsEpochRecoveryIdentityV1 }
  | { state: 'missing' | 'uncommissioned' | 'unavailable' | 'degraded' };

/** Trusted seam which must freshly authenticate the fixed epoch identity. */
export interface AgentOsEpochRecoveryIdentityProviderV1 {
  readAuthenticatedFixedEpochIdentity(): AgentOsEpochRecoveryIdentityReadV1;
}

export interface RecoverAgentOsEpochStagesV1Input {
  expectedIdentity: AgentOsEpochRecoveryIdentityV1;
  coordinationLease: AgentOsEpochCoordinationLeaseV1;
  observationLock: LocalStoreLock;
  /** Returns false when cancellation, deadline, or the outer transaction fence stops recovery. */
  isRecoveryAuthorized(): boolean;
  /** Supplies the exact runtime stop reason when cancellation or deadline stops recovery. */
  readRecoveryStopReason?(): 'cancelled' | 'deadline-exceeded' | null;
}

export interface AgentOsEpochStageRecoveryDependenciesV1 {
  anchorPath: string;
  epochStoreRootPath: string;
  writerProtocolDigest: string;
  authenticatedIdentityProvider: AgentOsEpochRecoveryIdentityProviderV1;
  sourceStore: AgentOsEpochSourceStoreDependenciesV1;
  snapshotStore: AgentOsEpochSnapshotStoreDependenciesV1;
  attemptStore: AgentOsEpochAttemptStoreDependenciesV1;
}

type StoreRecoveryDisposition = 'missing' | 'clean' | 'recovered' | 'withheld' | 'failed';
type StageName = 'source' | 'snapshot' | 'attempt';

export type AgentOsEpochStageRecoveryReasonV1 =
  | 'clean'
  | 'recovered'
  | 'invalid-input'
  | 'reentrant-call'
  | 'cancelled'
  | 'deadline-exceeded'
  | 'recovery-not-authorized'
  | 'coordination-capability-unavailable'
  | 'authenticated-identity-unavailable'
  | 'source-recovery-unavailable'
  | 'source-recovery-failed'
  | 'snapshot-recovery-unavailable'
  | 'snapshot-recovery-failed'
  | 'attempt-recovery-unavailable'
  | 'attempt-recovery-failed';

export interface AgentOsEpochStageRecoveryResultV1 {
  protocol: typeof AGENT_OS_EPOCH_STAGE_RECOVERY_PROTOCOL_V1;
  disposition: 'clean' | 'recovered' | 'withheld' | 'failed';
  reason: AgentOsEpochStageRecoveryReasonV1;
  stages: Readonly<{
    source: StoreRecoveryDisposition | 'not-run';
    snapshot: StoreRecoveryDisposition | 'not-run';
    attempt: StoreRecoveryDisposition | 'not-run';
  }>;
  durable: boolean;
  authority: 'observation-only';
  writesAuthorized: false;
  pointerMutationAuthorized: false;
  anchorMutationAuthority: false;
  planningAuthority: false;
  executionAuthority: false;
  effectAuthority: false;
  proposalAuthority: false;
  learningAuthority: false;
  promotionAuthority: false;
  mergeAuthority: false;
  releaseAuthority: false;
  deployAuthority: false;
  publicationAuthority: false;
  budgetAuthority: false;
  credentialAuthority: false;
  externalMutationAuthority: false;
  rollbackProtected: false;
  sameUserTamperResistant: false;
}

interface RecoveryOperation { reentered: boolean }

const activeRecoveries = new Map<string, RecoveryOperation>();
const PREFIXED_SHA256_RE = /^sha256:[a-f0-9]{64}$/;

function canonicalRoot(path: string): string | null {
  try {
    if (!isAbsolute(path) || path.includes('\0')) return null;
    const absolute = resolve(path);
    if (absolute === parse(absolute).root || !existsSync(absolute) ||
      lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isDirectory()) return null;
    return realpathSync.native(absolute);
  } catch {
    return null;
  }
}

function pinIdentity(value: unknown): Readonly<AgentOsEpochRecoveryIdentityV1> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expected = [
      'attemptNamespaceDigest', 'epoch', 'epochHeadDigest', 'epochManifestDigest',
      'writerProtocolDigest',
    ].sort();
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string') ||
      keys.map(String).sort().some((key, index) => key !== expected[index]) ||
      keys.length !== expected.length || keys.some((key) =>
        descriptors[String(key)]?.enumerable !== true ||
        !Object.hasOwn(descriptors[String(key)]!, 'value'))) return null;
    const row = value as AgentOsEpochRecoveryIdentityV1;
    if (!Number.isSafeInteger(row.epoch) || row.epoch < 1 || row.epoch > 999_999_999_999 ||
      !PREFIXED_SHA256_RE.test(row.epochHeadDigest) ||
      !PREFIXED_SHA256_RE.test(row.epochManifestDigest) ||
      !PREFIXED_SHA256_RE.test(row.attemptNamespaceDigest) ||
      !PREFIXED_SHA256_RE.test(row.writerProtocolDigest)) return null;
    return Object.freeze({ ...row });
  } catch {
    return null;
  }
}

function sameIdentity(left: AgentOsEpochRecoveryIdentityV1, right: AgentOsEpochRecoveryIdentityV1): boolean {
  return left.epoch === right.epoch &&
    left.epochHeadDigest === right.epochHeadDigest &&
    left.epochManifestDigest === right.epochManifestDigest &&
    left.attemptNamespaceDigest === right.attemptNamespaceDigest &&
    left.writerProtocolDigest === right.writerProtocolDigest;
}

function sourceIdentity(dependencies: AgentOsEpochStageRecoveryDependenciesV1): AgentOsEpochRecoveryIdentityV1 | null {
  try {
    const read = dependencies.sourceStore.activeContextProvider
      .readAuthenticatedActiveEpochSourceContext();
    if (!read || read.state !== 'authenticated') return null;
    return {
      epoch: read.context.epoch,
      epochHeadDigest: read.context.epochHeadDigest,
      epochManifestDigest: read.context.epochManifestDigest,
      attemptNamespaceDigest: read.context.attemptNamespaceDigest,
      writerProtocolDigest: read.context.writerProtocolDigest,
    };
  } catch {
    return null;
  }
}

function attemptIdentity(dependencies: AgentOsEpochStageRecoveryDependenciesV1): AgentOsEpochRecoveryIdentityV1 | null {
  try {
    const read = dependencies.attemptStore.activeClosureProvider.readAuthenticatedClosure();
    if (!read || read.state !== 'authenticated') return null;
    return {
      epoch: read.closure.epoch,
      epochHeadDigest: read.closure.epochHeadDigest,
      epochManifestDigest: read.closure.epochManifestDigest,
      attemptNamespaceDigest: read.closure.attemptNamespaceDigest,
      writerProtocolDigest: read.closure.writerProtocolDigest,
    };
  } catch {
    return null;
  }
}

function snapshotIdentity(dependencies: AgentOsEpochStageRecoveryDependenciesV1): AgentOsEpochRecoveryIdentityV1 | null {
  try {
    const read = dependencies.snapshotStore.activeClosureProvider.readAuthenticatedClosure();
    if (!read || read.state !== 'authenticated') return null;
    return {
      epoch: read.closure.epoch,
      epochHeadDigest: read.closure.anchoredHeadDigest,
      epochManifestDigest: read.closure.epochManifestDigest,
      attemptNamespaceDigest: read.closure.attemptNamespaceDigest,
      writerProtocolDigest: read.closure.writerProtocolDigest,
    };
  } catch {
    return null;
  }
}

function result(
  disposition: AgentOsEpochStageRecoveryResultV1['disposition'],
  reason: AgentOsEpochStageRecoveryReasonV1,
  stages: AgentOsEpochStageRecoveryResultV1['stages'] = {
    source: 'not-run', snapshot: 'not-run', attempt: 'not-run',
  },
): AgentOsEpochStageRecoveryResultV1 {
  return Object.freeze({
    protocol: AGENT_OS_EPOCH_STAGE_RECOVERY_PROTOCOL_V1,
    disposition,
    reason,
    stages: Object.freeze({ ...stages }),
    durable: disposition === 'clean' || disposition === 'recovered',
    ...AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
    writesAuthorized: false as const,
    pointerMutationAuthorized: false as const,
    anchorMutationAuthority: false as const,
  });
}

function validDependencies(dependencies: AgentOsEpochStageRecoveryDependenciesV1): boolean {
  try {
    const stores = [dependencies.sourceStore, dependencies.snapshotStore, dependencies.attemptStore];
    return typeof dependencies.anchorPath === 'string' &&
      typeof dependencies.epochStoreRootPath === 'string' &&
      typeof dependencies.writerProtocolDigest === 'string' &&
      typeof dependencies.authenticatedIdentityProvider?.readAuthenticatedFixedEpochIdentity === 'function' &&
      stores.every((store) => store.anchorPath === dependencies.anchorPath &&
        store.epochStoreRootPath === dependencies.epochStoreRootPath &&
        store.writerProtocolDigest === dependencies.writerProtocolDigest);
  } catch {
    return false;
  }
}

function liveGuardFailure(
  input: Pick<RecoverAgentOsEpochStagesV1Input,
  'coordinationLease' | 'observationLock' | 'readRecoveryStopReason'>,
  expectedIdentity: Readonly<AgentOsEpochRecoveryIdentityV1>,
  isRecoveryAuthorized: () => boolean,
  dependencies: AgentOsEpochStageRecoveryDependenciesV1,
  operation: RecoveryOperation,
): AgentOsEpochStageRecoveryReasonV1 | null {
  if (operation.reentered) return 'reentrant-call';
  const readStop = (): AgentOsEpochStageRecoveryReasonV1 | null => {
    if (!input.readRecoveryStopReason) return null;
    try {
      const value = input.readRecoveryStopReason();
      return value === null || value === 'cancelled' || value === 'deadline-exceeded'
        ? value
        : 'recovery-not-authorized';
    } catch {
      return 'recovery-not-authorized';
    }
  };
  const stopReason = readStop();
  if (operation.reentered) return 'reentrant-call';
  if (stopReason) return stopReason;
  let authorized = false;
  try { authorized = isRecoveryAuthorized() === true; } catch { /* fail closed */ }
  if (operation.reentered) return 'reentrant-call';
  if (!authorized) return readStop() ?? 'recovery-not-authorized';
  try {
    if (!ownsAgentOsEpochCoordinationLeaseV1(input.coordinationLease, {
        rootPath: dependencies.epochStoreRootPath,
        writerProtocolDigest: dependencies.writerProtocolDigest,
      }) || !ownsLocalStoreLock(input.observationLock) ||
      input.observationLock.path !== join(
        dependencies.anchorPath, '.agent-os-observation-transaction-v1.lock',
      )) {
      return operation.reentered ? 'reentrant-call' : 'coordination-capability-unavailable';
    }
  } catch {
    return operation.reentered ? 'reentrant-call' : 'coordination-capability-unavailable';
  }
  try {
    const read = dependencies.authenticatedIdentityProvider.readAuthenticatedFixedEpochIdentity();
    if (operation.reentered) return 'reentrant-call';
    if (!read || read.state !== 'authenticated' ||
      !sameIdentity(expectedIdentity, read.identity)) return 'authenticated-identity-unavailable';
    const storeIdentities = [
      sourceIdentity(dependencies), attemptIdentity(dependencies), snapshotIdentity(dependencies),
    ];
    if (operation.reentered) return 'reentrant-call';
    return storeIdentities.every((identity) => identity !== null &&
      sameIdentity(expectedIdentity, identity))
      ? null
      : 'authenticated-identity-unavailable';
  } catch {
    return operation.reentered ? 'reentrant-call' : 'authenticated-identity-unavailable';
  }
}

function unavailableReason(stage: StageName, disposition: StoreRecoveryDisposition): AgentOsEpochStageRecoveryReasonV1 {
  return `${stage}-recovery-${disposition === 'failed' ? 'failed' : 'unavailable'}` as
    AgentOsEpochStageRecoveryReasonV1;
}

/**
 * Recovers source, then snapshot, then attempt staging while the same fixed
 * epoch remains freshly authenticated. Every stage is conservative and a
 * non-success disposition prevents all later stages from running.
 */
export function recoverAgentOsEpochStagesV1(
  input: RecoverAgentOsEpochStagesV1Input,
  dependencies: AgentOsEpochStageRecoveryDependenciesV1,
): AgentOsEpochStageRecoveryResultV1 {
  if (!input || !dependencies || !validDependencies(dependencies) ||
    typeof input.isRecoveryAuthorized !== 'function' ||
    (input.readRecoveryStopReason !== undefined &&
      typeof input.readRecoveryStopReason !== 'function')) return result('withheld', 'invalid-input');
  const pinnedDependencies: AgentOsEpochStageRecoveryDependenciesV1 = Object.freeze({
    anchorPath: dependencies.anchorPath,
    epochStoreRootPath: dependencies.epochStoreRootPath,
    writerProtocolDigest: dependencies.writerProtocolDigest,
    authenticatedIdentityProvider: dependencies.authenticatedIdentityProvider,
    sourceStore: Object.freeze({ ...dependencies.sourceStore }),
    snapshotStore: Object.freeze({ ...dependencies.snapshotStore }),
    attemptStore: Object.freeze({ ...dependencies.attemptStore }),
  });
  const root = canonicalRoot(pinnedDependencies.epochStoreRootPath);
  const expectedIdentity = pinIdentity(input.expectedIdentity);
  if (!root || !expectedIdentity) return result('withheld', 'invalid-input');
  const active = activeRecoveries.get(root);
  if (active) {
    active.reentered = true;
    return result('withheld', 'reentrant-call');
  }
  const operation = { reentered: false };
  activeRecoveries.set(root, operation);
  const isRecoveryAuthorized = input.isRecoveryAuthorized;
  const stages: {
    source: StoreRecoveryDisposition | 'not-run';
    snapshot: StoreRecoveryDisposition | 'not-run';
    attempt: StoreRecoveryDisposition | 'not-run';
  } = { source: 'not-run', snapshot: 'not-run', attempt: 'not-run' };
  try {
    const admissionFailure = liveGuardFailure(
      input, expectedIdentity, isRecoveryAuthorized, pinnedDependencies, operation,
    );
    if (admissionFailure) return result('withheld', admissionFailure, stages);
    const recoverInput = {
      coordinationLease: input.coordinationLease,
      observationLock: input.observationLock,
    };
    for (const stage of ['source', 'snapshot', 'attempt'] as const) {
      const beforeStageFailure = liveGuardFailure(
        input, expectedIdentity, isRecoveryAuthorized, pinnedDependencies, operation,
      );
      if (beforeStageFailure) return result('withheld', beforeStageFailure, stages);
      const recovered = stage === 'source'
        ? recoverAgentOsEpochSourceStoreV1(recoverInput, pinnedDependencies.sourceStore)
        : stage === 'snapshot'
          ? recoverAgentOsEpochSnapshotStoreV2(recoverInput, pinnedDependencies.snapshotStore)
          : recoverAgentOsEpochAttemptStoreV2(recoverInput, pinnedDependencies.attemptStore);
      stages[stage] = recovered;
      if (recovered !== 'clean' && recovered !== 'recovered') {
        const afterWithheldFailure = liveGuardFailure(
          input, expectedIdentity, isRecoveryAuthorized, pinnedDependencies, operation,
        );
        if (afterWithheldFailure) return result('withheld', afterWithheldFailure, stages);
        return result(recovered === 'failed' ? 'failed' : 'withheld', unavailableReason(stage, recovered), stages);
      }
      const afterStageFailure = liveGuardFailure(
        input, expectedIdentity, isRecoveryAuthorized, pinnedDependencies, operation,
      );
      if (afterStageFailure) return result('withheld', afterStageFailure, stages);
    }
    return stages.source === 'recovered' || stages.snapshot === 'recovered' ||
      stages.attempt === 'recovered'
      ? result('recovered', 'recovered', stages)
      : result('clean', 'clean', stages);
  } catch {
    return result('failed', 'authenticated-identity-unavailable', stages);
  } finally {
    if (activeRecoveries.get(root) === operation) activeRecoveries.delete(root);
  }
}
