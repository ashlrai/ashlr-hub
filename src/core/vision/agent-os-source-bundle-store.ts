/**
 * Durable registry for externally signed Agent OS source bundles.
 *
 * The registry owns no private signing key. It verifies every bundle against a
 * caller-selected deployment trust policy before persistence, uses the shared
 * immutable private-record store for crash-safe publication, and withholds the
 * entire ledger whenever completeness or linear lineage cannot be proven.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

import {
  readImmutablePrivateRecords,
  recoverImmutablePrivateRecordStore,
  writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec,
  type ImmutablePrivateRecordReadStopReason,
  type ImmutablePrivateRecordStoreConfig,
} from '../util/immutable-private-record-store.js';
import {
  AGENT_OS_SOURCE_BUNDLE_GENESIS_DIGEST,
  AGENT_OS_SOURCE_BUNDLE_MAX_SEQUENCE,
  DEFAULT_AGENT_OS_SOURCE_TRUST_POLICY_V1,
  agentOsSourceTrustPolicyDigestV1,
  canonicalAgentOsSourceBundleEnvelopeBytesV1,
  canonicalAgentOsSourceTrustPolicyBytesV1,
  verifyAgentOsSourceBundleV1,
  type AgentOsSourceBundleEnvelopeV1,
  type AgentOsSourceTrustPolicyV1,
} from './agent-os-source-bundle.js';
import {
  acquireAgentOsObservationLockV1,
  releaseAgentOsObservationLockV1,
} from './agent-os-observation-lock.js';
import type { AgentOsReadModelInputV1, AgentOsReadModelVerifierV1 } from './agent-os-read-model.js';

const RECORD_FILE_RE = /^([0-9]{12})-([a-f0-9]{64})\.json$/;
const MAX_RECORD_BYTES = 768 * 1024;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const HARD_MAX_BYTES = 768 * 1024 * 1024;
const MAX_LOCK_WAIT_MS = 2_000;

export interface AgentOsSourceBundleStoreDependenciesV1 {
  /** Existing trusted directory that directly contains `rootPath`. */
  anchorPath: string;
  rootPath: string;
  trustPolicy: AgentOsSourceTrustPolicyV1;
  clock: () => Date;
  maxBundles?: number;
}

export interface AgentOsPinnedSourceBundleV1 {
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  bundleDigest: string;
  readModelInput: AgentOsReadModelInputV1;
  verifier: AgentOsReadModelVerifierV1;
  authority: 'observation-only';
  planningAuthority: false;
  executionAuthority: false;
  proposalAuthority: false;
  mergeAuthority: false;
  releaseAuthority: false;
  deployAuthority: false;
  publicationAuthority: false;
  externalMutationAuthority: false;
}

export type AgentOsSourceBundleStoreStopReasonV1 =
  | ImmutablePrivateRecordReadStopReason
  | 'store-empty'
  | 'trust-policy-invalid'
  | 'trust-root-unprovisioned'
  | 'duplicate-sequence'
  | 'sequence-gap'
  | 'predecessor-mismatch'
  | 'non-monotonic-issued-at'
  | 'current-policy-verification-failed';

export interface AgentOsSourceBundleStoreReadResultV1 {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  bundles: AgentOsSourceBundleEnvelopeV1[];
  current: AgentOsPinnedSourceBundleV1 | null;
  stopReasons: AgentOsSourceBundleStoreStopReasonV1[];
  filesRead: number;
  bytesRead: number;
  invalidFiles: number;
  limitExceeded: boolean;
  authority: 'observation-only';
  planningAuthority: false;
  executionAuthority: false;
  proposalAuthority: false;
  mergeAuthority: false;
  releaseAuthority: false;
  deployAuthority: false;
  publicationAuthority: false;
  externalMutationAuthority: false;
}

export type AgentOsSourceBundleStoreAppendResultV1 = {
  disposition: 'recorded' | 'replayed' | 'rejected' | 'unavailable' | 'failed';
  reason:
    | 'recorded'
    | 'bundle-replay'
    | 'invalid-input'
    | 'trust-policy-unavailable'
    | 'chain-unavailable'
    | 'sequence-conflict'
    | 'predecessor-mismatch'
    | 'non-monotonic-issued-at'
    | 'capacity-exhausted'
    | 'publication-failed';
  current: AgentOsPinnedSourceBundleV1 | null;
  authority: 'observation-only';
  executionAuthority: false;
  proposalAuthority: false;
  externalMutationAuthority: false;
};

export type AgentOsCurrentSourceLeaseResultV1<T> =
  | { state: 'held'; current: AgentOsPinnedSourceBundleV1; value: T }
  | { state: 'changed' | 'unavailable'; current: AgentOsPinnedSourceBundleV1 | null; value: null };

interface PinnedDependencies extends AgentOsSourceBundleStoreDependenciesV1 {
  maxBundles: number;
  now: Date;
}

const AUTHORITY = Object.freeze({
  authority: 'observation-only' as const,
  planningAuthority: false as const,
  executionAuthority: false as const,
  proposalAuthority: false as const,
  mergeAuthority: false as const,
  releaseAuthority: false as const,
  deployAuthority: false as const,
  publicationAuthority: false as const,
  externalMutationAuthority: false as const,
});

function validPaths(value: AgentOsSourceBundleStoreDependenciesV1): boolean {
  try {
    const anchor = resolve(value.anchorPath);
    const root = resolve(value.rootPath);
    return value.anchorPath === anchor && value.rootPath === root && isAbsolute(anchor) && isAbsolute(root) &&
      anchor !== parse(anchor).root && root !== anchor && dirname(root) === anchor;
  } catch {
    return false;
  }
}

function pinDependencies(value: AgentOsSourceBundleStoreDependenciesV1): PinnedDependencies | null {
  try {
    if (!validPaths(value) || typeof value.clock !== 'function') return null;
    const maxBundles = value.maxBundles ?? AGENT_OS_SOURCE_BUNDLE_MAX_SEQUENCE;
    if (!Number.isSafeInteger(maxBundles) || maxBundles < 1 ||
      maxBundles > AGENT_OS_SOURCE_BUNDLE_MAX_SEQUENCE) return null;
    const policyBytes = canonicalAgentOsSourceTrustPolicyBytesV1(value.trustPolicy);
    if (!policyBytes || policyBytes.length > 256 * 1024) return null;
    const trustPolicy = JSON.parse(policyBytes.toString('utf8')) as AgentOsSourceTrustPolicyV1;
    if (!agentOsSourceTrustPolicyDigestV1(trustPolicy)) return null;
    const now = value.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return null;
    return { ...value, trustPolicy, maxBundles, now: new Date(now.getTime()) };
  } catch {
    return null;
  }
}

function sequenceToken(sequence: number): string {
  return String(sequence).padStart(12, '0');
}

function envelopeClone(value: unknown): AgentOsSourceBundleEnvelopeV1 | null {
  const bytes = canonicalAgentOsSourceBundleEnvelopeBytesV1(value);
  if (!bytes) return null;
  try { return JSON.parse(bytes.toString('utf8')) as AgentOsSourceBundleEnvelopeV1; } catch { return null; }
}

function codec(dependencies: PinnedDependencies): ImmutablePrivateRecordCodec<AgentOsSourceBundleEnvelopeV1> {
  return {
    parse(value) {
      const verified = verifyAgentOsSourceBundleV1(value, dependencies.trustPolicy, dependencies.now, { historical: true });
      return verified.ok ? envelopeClone(value) : null;
    },
    serialize(value) {
      const bytes = canonicalAgentOsSourceBundleEnvelopeBytesV1(value);
      return bytes ? `${bytes.toString('utf8')}\n` : '';
    },
    recordId: (value) => `${sequenceToken(value.sequence)}-${value.bundleDigest}`,
    recordFileName: (value) => `${sequenceToken(value.sequence)}-${value.bundleDigest}.json`,
    isRecordFileName: (value) => RECORD_FILE_RE.test(value),
    stageToken: (value) => value.bundleDigest.slice(0, 32),
    equivalent: (left, right) => left.sequence === right.sequence &&
      left.bundleDigest === right.bundleDigest &&
      canonicalAgentOsSourceBundleEnvelopeBytesV1(left)?.equals(
        canonicalAgentOsSourceBundleEnvelopeBytesV1(right) ?? Buffer.alloc(0),
      ) === true,
    compare: (left, right) => left.sequence - right.sequence || left.bundleDigest.localeCompare(right.bundleDigest),
  };
}

function storeConfig(
  dependencies: PinnedDependencies,
): ImmutablePrivateRecordStoreConfig<AgentOsSourceBundleEnvelopeV1> {
  return {
    label: 'agent os source bundle',
    anchorPath: dependencies.anchorPath,
    rootPath: dependencies.rootPath,
    lockFileName: '.agent-os-source-bundles.lock',
    maxRecordBytes: MAX_RECORD_BYTES,
    defaultMaxFiles: dependencies.maxBundles,
    hardMaxFiles: dependencies.maxBundles,
    defaultMaxBytes: DEFAULT_MAX_BYTES,
    hardMaxBytes: HARD_MAX_BYTES,
    codecForWrite: () => codec(dependencies),
    codecForRead: () => codec(dependencies),
  };
}

function emptyRead(
  sourceState: AgentOsSourceBundleStoreReadResultV1['sourceState'],
  overrides: Partial<AgentOsSourceBundleStoreReadResultV1> = {},
): AgentOsSourceBundleStoreReadResultV1 {
  return {
    sourceState,
    sourcePresent: sourceState !== 'missing',
    complete: false,
    bundles: [],
    current: null,
    stopReasons: [],
    filesRead: 0,
    bytesRead: 0,
    invalidFiles: 0,
    limitExceeded: false,
    ...AUTHORITY,
    ...overrides,
  };
}

function pinnedCurrent(
  envelope: AgentOsSourceBundleEnvelopeV1,
  dependencies: PinnedDependencies,
): AgentOsPinnedSourceBundleV1 | null {
  const verified = verifyAgentOsSourceBundleV1(envelope, dependencies.trustPolicy, dependencies.now);
  return verified.ok ? {
    sequence: envelope.sequence,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
    bundleDigest: verified.bundleDigest,
    readModelInput: verified.readModelInput,
    verifier: verified.verifier,
    ...AUTHORITY,
  } : null;
}

function chainIssue(records: readonly AgentOsSourceBundleEnvelopeV1[]):
  AgentOsSourceBundleStoreStopReasonV1 | null {
  let expectedSequence = 1;
  let expectedPredecessor = AGENT_OS_SOURCE_BUNDLE_GENESIS_DIGEST;
  let previousIssuedAt = -1;
  for (const record of records) {
    if (record.sequence < expectedSequence) return 'duplicate-sequence';
    if (record.sequence > expectedSequence) return 'sequence-gap';
    if (record.previousBundleDigest !== expectedPredecessor) return 'predecessor-mismatch';
    const issuedAt = Date.parse(record.issuedAt);
    if (!Number.isFinite(issuedAt) || issuedAt <= previousIssuedAt) return 'non-monotonic-issued-at';
    expectedSequence += 1;
    expectedPredecessor = record.bundleDigest;
    previousIssuedAt = issuedAt;
  }
  return null;
}

function readPinned(dependencies: PinnedDependencies): AgentOsSourceBundleStoreReadResultV1 {
  if (!existsSync(dependencies.rootPath)) return emptyRead('missing', { sourcePresent: false });
  if (dependencies.trustPolicy.keys.length === 0) {
    return emptyRead('degraded', { stopReasons: ['trust-root-unprovisioned'] });
  }
  const raw = readImmutablePrivateRecords(storeConfig(dependencies), { requireComplete: true });
  if (raw.sourceState !== 'healthy' || !raw.complete) {
    return emptyRead('degraded', {
      sourcePresent: raw.sourcePresent,
      stopReasons: raw.stopReasons,
      filesRead: raw.filesRead,
      bytesRead: raw.bytesRead,
      invalidFiles: raw.invalidFiles,
      limitExceeded: raw.limitExceeded,
    });
  }
  if (raw.records.length === 0) {
    return emptyRead('degraded', {
      sourcePresent: true,
      stopReasons: ['store-empty'],
      filesRead: raw.filesRead,
      bytesRead: raw.bytesRead,
    });
  }
  const issue = chainIssue(raw.records);
  if (issue) {
    return emptyRead('degraded', {
      sourcePresent: true,
      stopReasons: [issue],
      filesRead: raw.filesRead,
      bytesRead: raw.bytesRead,
      invalidFiles: raw.invalidFiles,
      limitExceeded: raw.limitExceeded,
    });
  }
  const current = pinnedCurrent(raw.records.at(-1)!, dependencies);
  if (!current) {
    return emptyRead('degraded', {
      sourcePresent: true,
      stopReasons: ['current-policy-verification-failed'],
      filesRead: raw.filesRead,
      bytesRead: raw.bytesRead,
      invalidFiles: raw.invalidFiles,
      limitExceeded: raw.limitExceeded,
    });
  }
  return {
    sourceState: 'healthy',
    sourcePresent: true,
    complete: true,
    bundles: raw.records,
    current,
    stopReasons: [],
    filesRead: raw.filesRead,
    bytesRead: raw.bytesRead,
    invalidFiles: raw.invalidFiles,
    limitExceeded: raw.limitExceeded,
    ...AUTHORITY,
  };
}

/** Default read-only configuration; it creates neither storage nor trust roots. */
export function defaultAgentOsSourceBundleStoreDependenciesV1(): AgentOsSourceBundleStoreDependenciesV1 | null {
  try {
    const home = resolve(homedir());
    if (!isAbsolute(home) || home === parse(home).root) return null;
    const anchorPath = join(home, '.ashlr');
    return {
      anchorPath,
      rootPath: join(anchorPath, 'agent-os-source-bundles-v1'),
      trustPolicy: DEFAULT_AGENT_OS_SOURCE_TRUST_POLICY_V1,
      clock: () => new Date(),
    };
  } catch {
    return null;
  }
}

/** Stable complete-ledger read. No storage, lock, key, or root is created. */
export function readAgentOsSourceBundleStoreV1(
  value: AgentOsSourceBundleStoreDependenciesV1,
): AgentOsSourceBundleStoreReadResultV1 {
  if (!validPaths(value)) return emptyRead('degraded', {
    sourcePresent: false,
    stopReasons: ['invalid-options'],
    limitExceeded: true,
  });
  const dependencies = pinDependencies(value);
  if (!dependencies) return emptyRead('degraded', {
    sourcePresent: false,
    stopReasons: ['trust-policy-invalid'],
    limitExceeded: true,
  });
  return readPinned(dependencies);
}

function appendResult(
  disposition: AgentOsSourceBundleStoreAppendResultV1['disposition'],
  reason: AgentOsSourceBundleStoreAppendResultV1['reason'],
  current: AgentOsPinnedSourceBundleV1 | null,
): AgentOsSourceBundleStoreAppendResultV1 {
  return {
    disposition,
    reason,
    current,
    authority: 'observation-only',
    executionAuthority: false,
    proposalAuthority: false,
    externalMutationAuthority: false,
  };
}

/** Verify and durably ingest one externally signed bundle. */
export function appendAgentOsSourceBundleV1(
  value: unknown,
  rawDependencies: AgentOsSourceBundleStoreDependenciesV1,
): AgentOsSourceBundleStoreAppendResultV1 {
  const dependencies = pinDependencies(rawDependencies);
  if (!dependencies) return appendResult('rejected', 'invalid-input', null);
  if (dependencies.trustPolicy.keys.length === 0) {
    return appendResult('unavailable', 'trust-policy-unavailable', null);
  }
  const verified = verifyAgentOsSourceBundleV1(value, dependencies.trustPolicy, dependencies.now);
  const incoming = verified.ok ? envelopeClone(value) : null;
  if (!verified.ok || !incoming) return appendResult('rejected', 'invalid-input', null);
  if (!existsSync(dependencies.anchorPath)) return appendResult('unavailable', 'chain-unavailable', null);

  const transactionLock = acquireAgentOsObservationLockV1(dependencies.anchorPath);
  if (!transactionLock) return appendResult('failed', 'publication-failed', null);
  let outcome: AgentOsSourceBundleStoreAppendResultV1;
  try {
    outcome = (() => {
      const config = storeConfig(dependencies);
      const recovery = recoverImmutablePrivateRecordStore(config, { lockWaitMs: MAX_LOCK_WAIT_MS });
      if (!['missing', 'clean', 'recovered'].includes(recovery)) {
        return appendResult('unavailable', 'chain-unavailable', null);
      }
      const before = readPinned(dependencies);
      if (before.sourceState !== 'missing' && !before.complete &&
        !(before.stopReasons.length === 1 && before.stopReasons[0] === 'store-empty')) {
        return appendResult('unavailable', 'chain-unavailable', null);
      }
      const records = before.bundles;
      const replay = records.find((record) => record.sequence === incoming.sequence &&
        record.bundleDigest === incoming.bundleDigest);
      if (replay) return appendResult('replayed', 'bundle-replay', before.current);
      if (records.some((record) => record.sequence === incoming.sequence)) {
        return appendResult('rejected', 'sequence-conflict', before.current);
      }
      if (records.length >= dependencies.maxBundles) {
        return appendResult('rejected', 'capacity-exhausted', before.current);
      }
      const expectedSequence = (records.at(-1)?.sequence ?? 0) + 1;
      const expectedPredecessor = records.at(-1)?.bundleDigest ?? AGENT_OS_SOURCE_BUNDLE_GENESIS_DIGEST;
      if (incoming.sequence !== expectedSequence) {
        return appendResult('rejected', 'sequence-conflict', before.current);
      }
      if (incoming.previousBundleDigest !== expectedPredecessor) {
        return appendResult('rejected', 'predecessor-mismatch', before.current);
      }
      if (records.length > 0 && Date.parse(incoming.issuedAt) <= Date.parse(records.at(-1)!.issuedAt)) {
        return appendResult('rejected', 'non-monotonic-issued-at', before.current);
      }
      const publication = writeImmutablePrivateRecord(config, incoming, { lockWaitMs: MAX_LOCK_WAIT_MS });
      if (publication !== 'recorded' && publication !== 'replayed') {
        return appendResult('failed', 'publication-failed', before.current);
      }
      const after = readPinned(dependencies);
      return after.complete && after.current?.bundleDigest === incoming.bundleDigest
        ? appendResult(publication === 'replayed' ? 'replayed' : 'recorded',
          publication === 'replayed' ? 'bundle-replay' : 'recorded', after.current)
        : appendResult('failed', 'publication-failed', null);
    })();
  } catch {
    outcome = appendResult('failed', 'publication-failed', null);
  }
  return releaseAgentOsObservationLockV1(transactionLock)
    ? outcome
    : appendResult('failed', 'publication-failed', null);
}

/**
 * Hold the official source writer fence while a synchronous observation
 * transaction revalidates and consumes one exact current signed source.
 */
export function withCurrentAgentOsSourceBundleLeaseV1<T>(
  expectedBundleDigest: string,
  rawDependencies: AgentOsSourceBundleStoreDependenciesV1,
  consume: (current: AgentOsPinnedSourceBundleV1) => T,
): AgentOsCurrentSourceLeaseResultV1<T> {
  const dependencies = pinDependencies(rawDependencies);
  if (!dependencies || dependencies.trustPolicy.keys.length === 0 ||
    !/^[a-f0-9]{64}$/u.test(expectedBundleDigest) || typeof consume !== 'function' ||
    !existsSync(dependencies.anchorPath)) {
    return { state: 'unavailable', current: null, value: null };
  }
  const lock = acquireAgentOsObservationLockV1(dependencies.anchorPath);
  if (!lock) return { state: 'unavailable', current: null, value: null };
  let outcome: AgentOsCurrentSourceLeaseResultV1<T>;
  try {
    const current = readPinned(dependencies).current;
    if (!current || current.bundleDigest !== expectedBundleDigest) {
      outcome = { state: 'changed', current, value: null };
    } else {
      outcome = { state: 'held', current, value: consume(current) };
    }
  } catch {
    outcome = { state: 'unavailable', current: null, value: null };
  }
  return releaseAgentOsObservationLockV1(lock)
    ? outcome
    : { state: 'unavailable', current: null, value: null };
}

/** Conservatively clean authenticated writer residue; never publish a new bundle. */
export function recoverAgentOsSourceBundleStoreV1(
  value: AgentOsSourceBundleStoreDependenciesV1,
): 'missing' | 'clean' | 'recovered' | 'invalid' | 'failed' | 'trust-policy-unavailable' {
  const dependencies = pinDependencies(value);
  if (!dependencies) return 'invalid';
  if (dependencies.trustPolicy.keys.length === 0) return 'trust-policy-unavailable';
  return recoverImmutablePrivateRecordStore(storeConfig(dependencies), { lockWaitMs: MAX_LOCK_WAIT_MS });
}
