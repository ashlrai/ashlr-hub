/**
 * Public, observation-only projection of the private Agent OS snapshot store.
 *
 * The authenticated persistence envelope is intentionally not part of this
 * contract. Callers receive only a verified cockpit snapshot and bounded
 * source-quality metadata; no authenticator, key identity, digest, sequence,
 * filesystem location, or execution authority crosses this boundary.
 */

import {
  defaultAgentOsSnapshotStoreDependenciesV1,
  readAgentOsSnapshotsV1,
  type AgentOsSnapshotReadResultV1,
  type AgentOsSnapshotReadStopReasonV1,
} from './agent-os-snapshot-store.js';
import type { AgentOsReadModelV1 } from './agent-os-read-model.js';

export type AgentOsRuntimeReadReasonV1 =
  | AgentOsSnapshotReadStopReasonV1
  | 'snapshot-store-missing'
  | 'snapshot-store-empty'
  | 'snapshot-store-degraded';

export interface AgentOsRuntimeReadResultV1 {
  sourceState: 'missing' | 'healthy' | 'degraded';
  complete: boolean;
  reason: AgentOsRuntimeReadReasonV1 | null;
  snapshot: AgentOsReadModelV1 | null;
  authentication: 'authenticated' | 'invalid' | 'unavailable';
  authority: 'observation-only';
  sameUserTamperResistant: false;
  rollbackProtected: false;
  historicalAuthority: false;
  executionAuthority: false;
  proposalAuthority: false;
  mergeAuthority: false;
  deployAuthority: false;
  publicationAuthority: false;
  externalMutationAuthority: false;
}

const OBSERVATION_ONLY_AUTHORITY = Object.freeze({
  authority: 'observation-only' as const,
  sameUserTamperResistant: false as const,
  rollbackProtected: false as const,
  historicalAuthority: false as const,
  executionAuthority: false as const,
  proposalAuthority: false as const,
  mergeAuthority: false as const,
  deployAuthority: false as const,
  publicationAuthority: false as const,
  externalMutationAuthority: false as const,
});

function degradedAuthentication(
  read: AgentOsSnapshotReadResultV1,
): AgentOsRuntimeReadResultV1['authentication'] {
  if (
    read.invalidFiles > 0 ||
    read.stopReasons.includes('invalid-file') ||
    read.stopReasons.includes('checkpoint-invalid')
  ) {
    return 'invalid';
  }
  if (
    read.sourcePresent &&
    read.filesRead > 0 &&
    !read.stopReasons.includes('codec-unavailable')
  ) {
    // The private store codec admits only individually authenticated records.
    // Aggregate chain completeness is reported separately and still withholds
    // the current snapshot whenever it cannot be established.
    return 'authenticated';
  }
  return 'unavailable';
}

function degradedReason(read: AgentOsSnapshotReadResultV1): AgentOsRuntimeReadReasonV1 {
  return read.stopReasons[0] ?? (read.sourcePresent ? 'snapshot-store-degraded' : 'snapshot-store-empty');
}

function hasObservationOnlyAuthority(read: AgentOsSnapshotReadResultV1): boolean {
  return read.authority === 'observation-only' &&
    read.sameUserTamperResistant === false &&
    read.rollbackProtected === false &&
    read.historicalAuthority === false &&
    read.executionAuthority === false &&
    read.proposalAuthority === false &&
    read.mergeAuthority === false &&
    read.deployAuthority === false &&
    read.publicationAuthority === false &&
    read.externalMutationAuthority === false;
}

/**
 * Project a private store read into the only response shape safe for the web
 * dashboard. Inconsistent or unexpectedly authoritative inputs fail closed.
 */
export function buildAgentOsRuntimeReadResultV1(
  read: AgentOsSnapshotReadResultV1,
): AgentOsRuntimeReadResultV1 {
  if (read.sourceState === 'missing' && !read.sourcePresent) {
    return {
      sourceState: 'missing',
      complete: false,
      reason: 'snapshot-store-missing',
      snapshot: null,
      authentication: 'unavailable',
      ...OBSERVATION_ONLY_AUTHORITY,
    };
  }

  const current = read.current;
  if (
    read.sourceState === 'healthy' &&
    read.availability === 'available' &&
    read.complete === true &&
    read.stopReasons.length === 0 &&
    current !== null &&
    hasObservationOnlyAuthority(read) &&
    current.authority === 'observation-only' &&
    current.sameUserTamperResistant === false &&
    current.rollbackProtected === false &&
    current.historicalAuthority === false &&
    current.executionAuthority === false &&
    current.proposalAuthority === false &&
    current.mergeAuthority === false &&
    current.deployAuthority === false &&
    current.publicationAuthority === false &&
    current.externalMutationAuthority === false
  ) {
    return {
      sourceState: 'healthy',
      complete: true,
      reason: null,
      snapshot: current.payload.snapshot,
      authentication: 'authenticated',
      ...OBSERVATION_ONLY_AUTHORITY,
    };
  }

  return {
    sourceState: 'degraded',
    complete: false,
    reason: degradedReason(read),
    snapshot: null,
    authentication: degradedAuthentication(read),
    ...OBSERVATION_ONLY_AUTHORITY,
  };
}

/** Read the default host-local store without creating credentials or storage. */
export function readAgentOsRuntimeSnapshotV1(): AgentOsRuntimeReadResultV1 {
  try {
    const dependencies = defaultAgentOsSnapshotStoreDependenciesV1('read');
    if (!dependencies) {
      return {
        sourceState: 'degraded',
        complete: false,
        reason: 'snapshot-store-degraded',
        snapshot: null,
        authentication: 'unavailable',
        ...OBSERVATION_ONLY_AUTHORITY,
      };
    }
    return buildAgentOsRuntimeReadResultV1(readAgentOsSnapshotsV1(dependencies));
  } catch {
    return {
      sourceState: 'degraded',
      complete: false,
      reason: 'snapshot-store-degraded',
      snapshot: null,
      authentication: 'unavailable',
      ...OBSERVATION_ONLY_AUTHORITY,
    };
  }
}
