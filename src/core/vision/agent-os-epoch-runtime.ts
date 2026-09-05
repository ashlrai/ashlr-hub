/**
 * Observation-only transaction coordinator for one authenticated Agent OS epoch.
 *
 * The injected closure provider is the trust boundary: it must perform a fresh
 * external-anchor read and authenticate the exact M553 active artifacts before
 * returning either store closure. This module deliberately cannot choose an
 * anchor, load or provision keys, mutate a pointer, or grant effect authority.
 */

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, parse, resolve } from 'node:path';

import type { LocalStoreLock } from '../fleet/local-store-lock.js';
import {
  beginAgentOsEpochAttemptV2,
  completeAgentOsEpochAttemptV2,
  createAgentOsEpochAttemptStartReceiptProviderV1,
  readAgentOsEpochAttemptReceiptsV2,
  type AgentOsAuthenticatedActiveEpochAttemptClosureV1,
  type AgentOsEpochAttemptHistoricalSourceLineageProviderV1,
  type AgentOsEpochAttemptStoreDependenciesV1,
  type AgentOsEpochSnapshotBindingBatchRequestV1,
  type AgentOsEpochSnapshotBindingBatchResultV1,
  type AgentOsEpochSnapshotV2ExistenceVerifierV1,
} from './agent-os-epoch-attempt-store.js';
import {
  acquireAgentOsEpochCoordinationLeaseV1,
  releaseAgentOsEpochCoordinationLeaseV1,
  type AgentOsEpochCoordinationLeaseV1,
} from './agent-os-epoch-coordination.js';
import {
  AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
  agentOsEpochAttemptIdV1,
  isAgentOsPrefixedSha256DigestV1,
  type AgentOsEpochAttemptReceiptV2,
  type AgentOsEpochAttemptSignerV2,
} from './agent-os-epoch-records.js';
import type {
  AgentOsEpochSnapshotEnvelopeV2,
  AgentOsEpochSnapshotSignerV2,
  AgentOsEpochSnapshotVerifierV2,
} from './agent-os-epoch-snapshot-record.js';
import {
  createAgentOsEpochSnapshotV2ExistenceVerifierV1,
  readAgentOsEpochSnapshotsV2,
  writeAgentOsEpochSnapshotV2,
  type AgentOsAuthenticatedActiveEpochSnapshotClosureV1,
  type AgentOsEpochSnapshotHistoricalContextProviderV1,
  type AgentOsEpochSnapshotStoreDependenciesV1,
  type WriteAgentOsEpochSnapshotV2Input,
} from './agent-os-epoch-snapshot-store.js';
import {
  type AgentOsAuthenticatedActiveEpochSourceContextV1,
  type AgentOsEpochSourceStoreDependenciesV1,
} from './agent-os-epoch-source-store.js';
import {
  recoverAgentOsEpochStagesV1,
  type AgentOsEpochRecoveryIdentityV1,
} from './agent-os-epoch-stage-recovery.js';
import {
  acquireAgentOsObservationLockV1,
  releaseAgentOsObservationLockV1,
} from './agent-os-observation-lock.js';
import type { AgentOsReadModelV1 } from './agent-os-read-model.js';

export const AGENT_OS_EPOCH_RUNTIME_PROTOCOL_V1 =
  'ashlr-agent-os-epoch-observation-runtime-v1' as const;

export interface AgentOsAuthenticatedEpochRuntimeClosureV1 {
  source: AgentOsAuthenticatedActiveEpochSourceContextV1;
  attempt: AgentOsAuthenticatedActiveEpochAttemptClosureV1;
  snapshot: AgentOsAuthenticatedActiveEpochSnapshotClosureV1;
}

export type AgentOsAuthenticatedEpochRuntimeClosureReadV1 =
  | { state: 'authenticated'; closure: AgentOsAuthenticatedEpochRuntimeClosureV1 }
  | { state: 'missing' | 'uncommissioned' | 'unavailable' | 'degraded' };

/**
 * Trusted composition seam. An authenticated result asserts a fresh external
 * anchor check plus authentication of the exact M553 pointer-selected files.
 */
export interface AgentOsAuthenticatedEpochRuntimeClosureProviderV1 {
  readAuthenticatedClosure(): AgentOsAuthenticatedEpochRuntimeClosureReadV1;
}

export interface AgentOsEpochRuntimeClockV1 {
  now(): Readonly<{ unixMs: number; iso: string }>;
}

export interface AgentOsEpochRuntimeCancellationV1 {
  isCancellationRequested(): boolean;
}

declare const AGENT_OS_EPOCH_RUNTIME_TRUST_READ_SESSION_TOKEN: unique symbol;

/** Opaque one-use token minted only while M562 holds both write locks. */
export interface AgentOsEpochRuntimeTrustReadSessionTokenV1 {
  readonly [AGENT_OS_EPOCH_RUNTIME_TRUST_READ_SESSION_TOKEN]: true;
}

const LIVE_TRUST_READ_SESSION_TOKENS = new WeakMap<
  object,
  AgentOsEpochRuntimeTrustReadSessionV1
>();

/** Atomically consumes a token bound to one exact session object. */
export function consumeAgentOsEpochRuntimeTrustReadSessionTokenV1(
  value: unknown,
  session: AgentOsEpochRuntimeTrustReadSessionV1,
): value is AgentOsEpochRuntimeTrustReadSessionTokenV1 {
  if (typeof value !== 'object' || value === null) return false;
  const expected = LIVE_TRUST_READ_SESSION_TOKENS.get(value);
  LIVE_TRUST_READ_SESSION_TOKENS.delete(value);
  return expected === session;
}

function mintTrustReadSessionToken(
  session: AgentOsEpochRuntimeTrustReadSessionV1,
): AgentOsEpochRuntimeTrustReadSessionTokenV1 {
  const token = Object.freeze(Object.create(null)) as AgentOsEpochRuntimeTrustReadSessionTokenV1;
  LIVE_TRUST_READ_SESSION_TOKENS.set(token, session);
  return token;
}

function revokeTrustReadSessionToken(token: AgentOsEpochRuntimeTrustReadSessionTokenV1): void {
  LIVE_TRUST_READ_SESSION_TOKENS.delete(token);
}

/** Optional synchronous read-session hint for a concrete trust composition. */
export interface AgentOsEpochRuntimeTrustReadSessionV1 {
  begin(token: AgentOsEpochRuntimeTrustReadSessionTokenV1): boolean;
  end(): void;
}

export interface AgentOsEpochObservationContextV1 {
  protocol: typeof AGENT_OS_EPOCH_RUNTIME_PROTOCOL_V1;
  epoch: number;
  durableTickDigest: string;
  attemptId: string;
  startReceiptDigest: string;
  authority: 'observation-only';
  executionAuthority: false;
  effectAuthority: false;
  externalMutationAuthority: false;
}

export interface AgentOsEpochObservationMaterialV1 {
  renderedAt: string;
  observedAt: string;
  kernelCycleDigest: string;
  capabilityProjectionDigest: string;
  portfolioDigest: string;
  snapshot: AgentOsReadModelV1;
  snapshotDigest: string;
}

export interface RunAgentOsEpochObservationV1Input {
  durableTickDigest: string;
  deadlineUnixMs: number | null;
  cancellation: AgentOsEpochRuntimeCancellationV1 | null;
  /**
   * Trusted same-process observation callback. The context's false authority
   * flags are evidence labels, not a sandbox or ambient fs/network capability
   * membrane; untrusted agent code must run behind a separate isolation layer.
   */
  observe(
    context: Readonly<AgentOsEpochObservationContextV1>,
  ): AgentOsEpochObservationMaterialV1;
}

export interface AgentOsEpochRuntimeDependenciesV1 {
  anchorPath: string;
  epochStoreRootPath: string;
  writerProtocolDigest: string;
  authenticatedClosureProvider: AgentOsAuthenticatedEpochRuntimeClosureProviderV1;
  sourceStore: AgentOsEpochSourceStoreDependenciesV1;
  attemptHistoricalSourceLineageProvider: AgentOsEpochAttemptHistoricalSourceLineageProviderV1;
  attemptSigner: AgentOsEpochAttemptSignerV2 | null;
  snapshotHistoricalContextProvider: AgentOsEpochSnapshotHistoricalContextProviderV1;
  snapshotSigner: AgentOsEpochSnapshotSignerV2 | null;
  snapshotVerifier: AgentOsEpochSnapshotVerifierV2 | null;
  clock: AgentOsEpochRuntimeClockV1;
  trustReadSession?: AgentOsEpochRuntimeTrustReadSessionV1;
  maxAttemptRecords?: number;
  maxSnapshotRecords?: number;
}

export type AgentOsEpochRuntimeReasonV1 =
  | 'succeeded'
  | 'recovered-snapshot'
  | 'terminal-replay'
  | 'cancelled'
  | 'deadline-exceeded'
  | 'observation-failed'
  | 'invalid-input'
  | 'closure-unavailable'
  | 'coordination-contended'
  | 'observation-lock-contended'
  | 'stage-recovery-unavailable'
  | 'attempt-start-unavailable'
  | 'attempt-chain-unavailable'
  | 'snapshot-unavailable'
  | 'terminal-unavailable'
  | 'reentrant-call';

export interface AgentOsEpochRuntimeResultV1 {
  disposition: 'completed' | 'recovered' | 'withheld' | 'open' | 'failed';
  reason: AgentOsEpochRuntimeReasonV1;
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'deadline-exceeded' | null;
  attemptId: string | null;
  startReceipt: Readonly<AgentOsEpochAttemptReceiptV2> | null;
  snapshotEnvelope: Readonly<AgentOsEpochSnapshotEnvelopeV2> | null;
  terminalReceipt: Readonly<AgentOsEpochAttemptReceiptV2> | null;
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

export interface AgentOsEpochRuntimeStoresV1 {
  attempt: AgentOsEpochAttemptStoreDependenciesV1;
  snapshot: AgentOsEpochSnapshotStoreDependenciesV1;
}

interface RuntimeOperation {
  reentered: boolean;
}

const activeRuntimeOperations = new Map<string, RuntimeOperation>();

function canonicalRuntimeRoot(path: string): string | null {
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

function enterRuntime(rootPath: string): RuntimeOperation | null {
  const active = activeRuntimeOperations.get(rootPath);
  if (active) {
    active.reentered = true;
    return null;
  }
  const operation = { reentered: false };
  activeRuntimeOperations.set(rootPath, operation);
  return operation;
}

function leaveRuntime(rootPath: string, operation: RuntimeOperation): void {
  if (activeRuntimeOperations.get(rootPath) === operation) activeRuntimeOperations.delete(rootPath);
}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (ArrayBuffer.isView(value)) return value;
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const nested of Object.values(value as Record<string, unknown>)) freeze(nested, seen);
    Object.freeze(value);
  }
  return value;
}

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
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function clonePlain<T>(value: T, depth = 0, seen = new WeakSet<object>()): T | null {
  if (depth > 32) return null;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) && !Object.is(value, -0) ? value : null;
  }
  if (typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol' ||
      (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key)) ||
      (key !== 'length' && (descriptors[String(key)]?.enumerable !== true ||
        !Object.hasOwn(descriptors[String(key)]!, 'value'))))) return null;
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) return null;
      const item = clonePlain(value[index], depth + 1, seen);
      if (item === null && value[index] !== null) return null;
      output.push(item);
    }
    return output as T;
  }
  const row = record(value);
  if (!row) return null;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    const item = clonePlain(row[key], depth + 1, seen);
    if (item === null && row[key] !== null) return null;
    output[key] = item;
  }
  return output as T;
}

function validClosurePair(value: unknown): value is AgentOsAuthenticatedEpochRuntimeClosureV1 {
  const row = record(value);
  const source = row ? record(row['source']) : null;
  const attempt = row ? record(row['attempt']) : null;
  const snapshot = row ? record(row['snapshot']) : null;
  return Boolean(row && exactKeys(row, ['attempt', 'snapshot', 'source']) && source && attempt && snapshot &&
    source['epoch'] === attempt['epoch'] &&
    source['epochHeadDigest'] === attempt['epochHeadDigest'] &&
    source['epochManifestDigest'] === attempt['epochManifestDigest'] &&
    source['attemptNamespaceDigest'] === attempt['attemptNamespaceDigest'] &&
    source['writerProtocolDigest'] === attempt['writerProtocolDigest'] &&
    attempt['epoch'] === snapshot['epoch'] &&
    attempt['epochHeadDigest'] === snapshot['anchoredHeadDigest'] &&
    attempt['epochManifestDigest'] === snapshot['epochManifestDigest'] &&
    attempt['attemptNamespaceDigest'] === snapshot['attemptNamespaceDigest'] &&
    attempt['sourceBundleDigest'] === snapshot['sourceBundleDigest'] &&
    attempt['trustPolicyDigest'] === snapshot['trustPolicyDigest'] &&
    attempt['writerProtocolDigest'] === snapshot['writerProtocolDigest']);
}

function sameRuntimeEpochIdentity(
  left: AgentOsAuthenticatedEpochRuntimeClosureV1,
  right: AgentOsAuthenticatedEpochRuntimeClosureV1,
): boolean {
  return left.attempt.epoch === right.attempt.epoch &&
    left.attempt.epochHeadDigest === right.attempt.epochHeadDigest &&
    left.attempt.epochManifestDigest === right.attempt.epochManifestDigest &&
    left.attempt.attemptNamespaceDigest === right.attempt.attemptNamespaceDigest &&
    left.attempt.writerProtocolDigest === right.attempt.writerProtocolDigest &&
    left.attempt.sourceBundleDigest === right.attempt.sourceBundleDigest &&
    left.attempt.trustPolicyDigest === right.attempt.trustPolicyDigest &&
    left.snapshot.snapshotBasePreviousEnvelopeDigest === right.snapshot.snapshotBasePreviousEnvelopeDigest &&
    left.snapshot.expectedProducerIdentityDigest === right.snapshot.expectedProducerIdentityDigest &&
    left.snapshot.expectedAuthenticatorKeyId === right.snapshot.expectedAuthenticatorKeyId &&
    left.snapshot.expectedAuthenticatorKeyGeneration === right.snapshot.expectedAuthenticatorKeyGeneration;
}

function readRuntimeClosure(
  dependencies: AgentOsEpochRuntimeDependenciesV1,
): Readonly<AgentOsAuthenticatedEpochRuntimeClosureV1> | null {
  try {
    const read = dependencies.authenticatedClosureProvider.readAuthenticatedClosure();
    if (!read || read.state !== 'authenticated' || !validClosurePair(read.closure)) return null;
    const cloned = clonePlain(read.closure);
    return cloned ? freeze(cloned) : null;
  } catch {
    return null;
  }
}

function runtimeResult(
  disposition: AgentOsEpochRuntimeResultV1['disposition'],
  reason: AgentOsEpochRuntimeReasonV1,
  values: Partial<Pick<AgentOsEpochRuntimeResultV1,
    'outcome' | 'attemptId' | 'startReceipt' | 'snapshotEnvelope' | 'terminalReceipt' | 'durable'>> = {},
): AgentOsEpochRuntimeResultV1 {
  return freeze({
    disposition,
    reason,
    outcome: values.outcome ?? null,
    attemptId: values.attemptId ?? null,
    startReceipt: values.startReceipt ?? null,
    snapshotEnvelope: values.snapshotEnvelope ?? null,
    terminalReceipt: values.terminalReceipt ?? null,
    durable: values.durable ?? false,
    ...AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
    writesAuthorized: false as const,
    pointerMutationAuthorized: false as const,
    anchorMutationAuthority: false as const,
  });
}

export function createAgentOsEpochRuntimeStoresV1(
  dependencies: AgentOsEpochRuntimeDependenciesV1,
): AgentOsEpochRuntimeStoresV1 | null {
  if (!validDependencies(dependencies)) return null;
  const stores = buildStores(dependencies, Object.freeze({
    isCommitAuthorized: () => false,
  }));
  const historical = stores.attempt.historicalSourceLineageProvider;
  const attempt: AgentOsEpochAttemptStoreDependenciesV1 = Object.freeze({
    ...stores.attempt,
    signer: null,
    historicalSourceLineageProvider: Object.freeze({
      resolveAuthenticatedHistoricalSources(request: Parameters<
        typeof historical.resolveAuthenticatedHistoricalSources
      >[0]) {
        return historical.resolveAuthenticatedHistoricalSources(request);
      },
      resolveAuthenticatedHistoricalSource(lineage: Parameters<
        typeof historical.resolveAuthenticatedHistoricalSource
      >[0]) {
        const resolution = historical.resolveAuthenticatedHistoricalSource(lineage);
        return resolution.state === 'authenticated'
          ? Object.freeze({ ...resolution, signer: null })
          : resolution;
      },
    }),
  });
  const snapshot: AgentOsEpochSnapshotStoreDependenciesV1 = Object.freeze({
    ...stores.snapshot,
    signer: null,
  });
  return Object.freeze({ attempt, snapshot });
}

function buildStores(
  dependencies: AgentOsEpochRuntimeDependenciesV1,
  runtimeCommitGuard?: { isCommitAuthorized(): boolean },
): AgentOsEpochRuntimeStoresV1 {
  const coupled: { snapshot: AgentOsEpochSnapshotStoreDependenciesV1 | null } = { snapshot: null };
  const attemptClosureProvider = Object.freeze({
    readAuthenticatedClosure() {
      const closure = readRuntimeClosure(dependencies);
      return closure
        ? { state: 'authenticated' as const, closure: closure.attempt }
        : { state: 'degraded' as const };
    },
  });
  const snapshotClosureProvider = Object.freeze({
    readAuthenticatedClosure() {
      const closure = readRuntimeClosure(dependencies);
      return closure
        ? { state: 'authenticated' as const, closure: closure.snapshot }
        : { state: 'degraded' as const };
    },
  });
  const snapshotExistenceVerifier: AgentOsEpochSnapshotV2ExistenceVerifierV1 = Object.freeze({
    verifyExactBindings(
      request: Readonly<AgentOsEpochSnapshotBindingBatchRequestV1>,
    ): AgentOsEpochSnapshotBindingBatchResultV1 {
      return coupled.snapshot === null
        ? { state: 'degraded' as const }
        : createAgentOsEpochSnapshotV2ExistenceVerifierV1(coupled.snapshot)
            .verifyExactBindings(request);
    },
  });
  const attempt: AgentOsEpochAttemptStoreDependenciesV1 = {
    anchorPath: dependencies.anchorPath,
    epochStoreRootPath: dependencies.epochStoreRootPath,
    writerProtocolDigest: dependencies.writerProtocolDigest,
    activeClosureProvider: attemptClosureProvider,
    historicalSourceLineageProvider: dependencies.attemptHistoricalSourceLineageProvider,
    signer: dependencies.attemptSigner,
    ...(runtimeCommitGuard === undefined ? {} : { runtimeCommitGuard }),
    snapshotV2ExistenceVerifier: snapshotExistenceVerifier,
    ...(dependencies.maxAttemptRecords === undefined
      ? {} : { maxRecords: dependencies.maxAttemptRecords }),
  };
  const snapshot: AgentOsEpochSnapshotStoreDependenciesV1 = {
    anchorPath: dependencies.anchorPath,
    epochStoreRootPath: dependencies.epochStoreRootPath,
    writerProtocolDigest: dependencies.writerProtocolDigest,
    activeClosureProvider: snapshotClosureProvider,
    historicalContextProvider: dependencies.snapshotHistoricalContextProvider,
    startReceiptProvider: createAgentOsEpochAttemptStartReceiptProviderV1(attempt),
    signer: dependencies.snapshotSigner,
    verifier: dependencies.snapshotVerifier,
    ...(runtimeCommitGuard === undefined ? {} : { runtimeCommitGuard }),
    ...(dependencies.maxSnapshotRecords === undefined
      ? {} : { maxRecords: dependencies.maxSnapshotRecords }),
  };
  coupled.snapshot = snapshot;
  return Object.freeze({ attempt: Object.freeze(attempt), snapshot: Object.freeze(snapshot) });
}

function readClock(clock: AgentOsEpochRuntimeClockV1): { unixMs: number; iso: string } | null {
  try {
    const value = clock.now();
    const row = record(value);
    if (!row || !exactKeys(row, ['iso', 'unixMs']) || !Number.isSafeInteger(row['unixMs']) ||
      typeof row['iso'] !== 'string' || !Number.isFinite(Date.parse(row['iso'])) ||
      Date.parse(row['iso']) !== row['unixMs']) return null;
    return { unixMs: row['unixMs'] as number, iso: row['iso'] };
  } catch {
    return null;
  }
}

function stopOutcome(
  input: RunAgentOsEpochObservationV1Input,
  clock: AgentOsEpochRuntimeClockV1,
): 'cancelled' | 'deadline-exceeded' | null {
  try {
    if (input.cancellation?.isCancellationRequested() === true) return 'cancelled';
  } catch {
    return 'cancelled';
  }
  const now = readClock(clock);
  if (!now) return 'deadline-exceeded';
  return input.deadlineUnixMs !== null && now.unixMs >= input.deadlineUnixMs
    ? 'deadline-exceeded'
    : null;
}

function validInput(value: unknown): value is RunAgentOsEpochObservationV1Input {
  const row = record(value);
  if (!row || !exactKeys(row, ['cancellation', 'deadlineUnixMs', 'durableTickDigest', 'observe']) ||
    !isAgentOsPrefixedSha256DigestV1(row['durableTickDigest']) ||
    (row['deadlineUnixMs'] !== null && !Number.isSafeInteger(row['deadlineUnixMs'])) ||
    typeof row['observe'] !== 'function') return false;
  if (row['cancellation'] === null) return true;
  const cancellation = record(row['cancellation']);
  return Boolean(cancellation && exactKeys(cancellation, ['isCancellationRequested']) &&
    typeof cancellation['isCancellationRequested'] === 'function');
}

function validDependencies(value: unknown): value is AgentOsEpochRuntimeDependenciesV1 {
  const row = record(value);
  if (!row) return false;
  const optional = ['maxAttemptRecords', 'maxSnapshotRecords', 'trustReadSession'];
  const required = [
    'anchorPath', 'attemptHistoricalSourceLineageProvider', 'attemptSigner',
    'authenticatedClosureProvider', 'clock', 'epochStoreRootPath',
    'snapshotHistoricalContextProvider', 'snapshotSigner', 'snapshotVerifier', 'sourceStore',
    'writerProtocolDigest',
  ];
  const expected = [...required, ...optional.filter((key) => Object.hasOwn(row, key))];
  return exactKeys(row, expected) && typeof row['anchorPath'] === 'string' &&
    typeof row['epochStoreRootPath'] === 'string' &&
    isAgentOsPrefixedSha256DigestV1(row['writerProtocolDigest']) &&
    typeof record(row['authenticatedClosureProvider'])?.['readAuthenticatedClosure'] === 'function' &&
    record(row['sourceStore']) !== null &&
    typeof record(row['attemptHistoricalSourceLineageProvider'])?.['resolveAuthenticatedHistoricalSource'] === 'function' &&
    typeof record(row['attemptHistoricalSourceLineageProvider'])?.['resolveAuthenticatedHistoricalSources'] === 'function' &&
    typeof record(row['snapshotHistoricalContextProvider'])?.['readAuthenticatedHistoricalContext'] === 'function' &&
    typeof record(row['clock'])?.['now'] === 'function' &&
    (row['trustReadSession'] === undefined ||
      (typeof record(row['trustReadSession'])?.['begin'] === 'function' &&
       typeof record(row['trustReadSession'])?.['end'] === 'function'));
}

function validObservationMaterial(value: unknown): value is AgentOsEpochObservationMaterialV1 {
  const row = record(value);
  return Boolean(row && exactKeys(row, [
    'capabilityProjectionDigest', 'kernelCycleDigest', 'observedAt', 'portfolioDigest',
    'renderedAt', 'snapshot', 'snapshotDigest',
  ]) && typeof row['renderedAt'] === 'string' && typeof row['observedAt'] === 'string' &&
    typeof row['kernelCycleDigest'] === 'string' &&
    typeof row['capabilityProjectionDigest'] === 'string' &&
    typeof row['portfolioDigest'] === 'string' && typeof row['snapshotDigest'] === 'string' &&
    record(row['snapshot']) !== null);
}

function complete(
  stores: AgentOsEpochRuntimeStoresV1,
  capabilities: { lease: AgentOsEpochCoordinationLeaseV1; lock: LocalStoreLock },
  tick: string,
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'deadline-exceeded',
  snapshotEnvelopeDigest: string | null,
  completedAt: string,
) {
  return completeAgentOsEpochAttemptV2({
    durableTickDigest: tick,
    outcome,
    snapshotEnvelopeDigest,
    completedAt,
    coordinationLease: capabilities.lease,
    observationLock: capabilities.lock,
  }, stores.attempt);
}

function recoveryIdentity(
  closure: Readonly<AgentOsAuthenticatedEpochRuntimeClosureV1>,
): AgentOsEpochRecoveryIdentityV1 {
  return Object.freeze({
    epoch: closure.attempt.epoch,
    epochHeadDigest: closure.attempt.epochHeadDigest,
    epochManifestDigest: closure.attempt.epochManifestDigest,
    attemptNamespaceDigest: closure.attempt.attemptNamespaceDigest,
    writerProtocolDigest: closure.attempt.writerProtocolDigest,
  });
}

/**
 * Runs exactly one durable observation transaction. A snapshot is never
 * published before its authenticated start receipt, and success is never
 * published until M557 verifies the reciprocal M560 snapshot binding.
 */
export function runAgentOsEpochObservationV1(
  input: RunAgentOsEpochObservationV1Input,
  dependencies: AgentOsEpochRuntimeDependenciesV1,
): AgentOsEpochRuntimeResultV1 {
  if (!validInput(input) || !validDependencies(dependencies)) {
    return runtimeResult('withheld', 'invalid-input');
  }
  const runtimeRoot = canonicalRuntimeRoot(dependencies.epochStoreRootPath);
  if (!runtimeRoot) return runtimeResult('withheld', 'invalid-input');
  const operation = enterRuntime(runtimeRoot);
  if (!operation) return runtimeResult('withheld', 'reentrant-call');
  let lease: AgentOsEpochCoordinationLeaseV1 | null = null;
  let lock: LocalStoreLock | null = null;
  let trustReadSessionBegun = false;
  try {
    const leaseRead = acquireAgentOsEpochCoordinationLeaseV1({
      rootPath: dependencies.epochStoreRootPath,
      writerProtocolDigest: dependencies.writerProtocolDigest,
    });
    if (leaseRead.state !== 'acquired') {
      return runtimeResult('withheld', 'coordination-contended');
    }
    lease = leaseRead.lease;
    lock = acquireAgentOsObservationLockV1(dependencies.anchorPath);
    if (!lock) return runtimeResult('withheld', 'observation-lock-contended');
    if (dependencies.trustReadSession) {
      const token = mintTrustReadSessionToken(dependencies.trustReadSession);
      try { trustReadSessionBegun = dependencies.trustReadSession.begin(token) === true; }
      catch { trustReadSessionBegun = false; }
      finally { revokeTrustReadSessionToken(token); }
      if (!trustReadSessionBegun) return runtimeResult('withheld', 'closure-unavailable');
    }
    const lockedClosure = readRuntimeClosure(dependencies);
    if (!lockedClosure) {
      return runtimeResult('withheld', 'closure-unavailable');
    }
    const capabilities = { lease, lock };
    let commitPhase: 'start' | 'snapshot' | 'success' | 'non-success' | 'recovery' = 'recovery';
    const runtimeCommitGuard = Object.freeze({
      isCommitAuthorized() {
        return commitPhase === 'non-success' || commitPhase === 'recovery' ||
          (!operation.reentered && stopOutcome(input, dependencies.clock) === null);
      },
    });
    const stores = buildStores(dependencies, runtimeCommitGuard);
    const recovery = recoverAgentOsEpochStagesV1({
      expectedIdentity: recoveryIdentity(lockedClosure),
      coordinationLease: lease,
      observationLock: lock,
      isRecoveryAuthorized: () => !operation.reentered &&
        stopOutcome(input, dependencies.clock) === null,
      readRecoveryStopReason: () => stopOutcome(input, dependencies.clock),
    }, {
      anchorPath: dependencies.anchorPath,
      epochStoreRootPath: dependencies.epochStoreRootPath,
      writerProtocolDigest: dependencies.writerProtocolDigest,
      authenticatedIdentityProvider: {
        readAuthenticatedFixedEpochIdentity() {
          const closure = readRuntimeClosure(dependencies);
          return closure
            ? { state: 'authenticated' as const, identity: recoveryIdentity(closure) }
            : { state: 'degraded' as const };
        },
      },
      sourceStore: dependencies.sourceStore,
      snapshotStore: stores.snapshot,
      attemptStore: stores.attempt,
    });
    if (recovery.disposition !== 'clean' && recovery.disposition !== 'recovered') {
      const stopped = stopOutcome(input, dependencies.clock);
      return runtimeResult(
        'withheld', operation.reentered ? 'reentrant-call' : stopped ?? 'stage-recovery-unavailable',
        { outcome: stopped },
      );
    }
    const candidateAttemptId = agentOsEpochAttemptIdV1({
      epoch: lockedClosure.attempt.epoch,
      attemptNamespaceDigest: lockedClosure.attempt.attemptNamespaceDigest,
      durableTickDigest: input.durableTickDigest,
    });
    if (!candidateAttemptId) return runtimeResult('withheld', 'invalid-input');
    const preflightAttempts = readAgentOsEpochAttemptReceiptsV2(
      stores.attempt, { requireComplete: true },
    );
    const existingStart = preflightAttempts.complete
      ? preflightAttempts.records.find((receipt) =>
          receipt.attemptId === candidateAttemptId && receipt.transitionOrdinal === 1) ?? null
      : null;
    const initialStop = stopOutcome(input, dependencies.clock);
    if (initialStop && !existingStart) {
      return runtimeResult('withheld', initialStop, { outcome: initialStop });
    }
    commitPhase = existingStart ? 'recovery' : 'start';
    const started = readClock(dependencies.clock);
    if (!started) return runtimeResult('withheld', 'invalid-input');
    const start = beginAgentOsEpochAttemptV2({
      durableTickDigest: input.durableTickDigest,
      startedAt: existingStart?.startedAt ?? started.iso,
      coordinationLease: lease,
      observationLock: lock,
    }, stores.attempt);
    if (!start.durable || !start.receipt || start.receipt.transitionOrdinal !== 1) {
      const stopped = stopOutcome(input, dependencies.clock);
      return runtimeResult(start.durable ? 'open' : 'withheld', operation.reentered ? 'reentrant-call'
        : stopped ?? 'attempt-start-unavailable', {
        outcome: stopped,
        attemptId: start.durable ? candidateAttemptId : null,
        durable: start.durable,
      });
    }
    const attemptId = start.receipt.attemptId;
    const reconciled = readRuntimeClosure(dependencies);
    const reconciledAttemptId = reconciled ? agentOsEpochAttemptIdV1({
      epoch: reconciled.attempt.epoch,
      attemptNamespaceDigest: reconciled.attempt.attemptNamespaceDigest,
      durableTickDigest: input.durableTickDigest,
    }) : null;
    if (!reconciled || reconciledAttemptId !== attemptId ||
      start.receipt.epoch !== reconciled.attempt.epoch ||
      start.receipt.attemptNamespaceDigest !== reconciled.attempt.attemptNamespaceDigest) {
      return runtimeResult('open', 'closure-unavailable', {
        attemptId, startReceipt: start.receipt, durable: true,
      });
    }
    const base = { attemptId, startReceipt: start.receipt, durable: true };
    const attempts = readAgentOsEpochAttemptReceiptsV2(stores.attempt, { requireComplete: true });
    const snapshots = readAgentOsEpochSnapshotsV2(stores.snapshot, { requireComplete: true });
    if (!attempts.complete || !snapshots.complete || operation.reentered) {
      return runtimeResult('open', operation.reentered ? 'reentrant-call' : 'attempt-chain-unavailable', base);
    }
    const postReadClosure = readRuntimeClosure(dependencies);
    if (!postReadClosure || !sameRuntimeEpochIdentity(reconciled, postReadClosure)) {
      return runtimeResult('open', 'closure-unavailable', base);
    }
    const terminal = attempts.records.find((receipt) =>
      receipt.attemptId === attemptId && receipt.transitionOrdinal === 2) ?? null;
    const existingSnapshot = snapshots.records.find((envelope) =>
      envelope.producerAttemptId === attemptId &&
      envelope.durableTickDigest === input.durableTickDigest &&
      envelope.producerStartReceiptDigest === start.receipt!.receiptDigest) ?? null;
    if (terminal) {
      if (terminal.outcome === 'succeeded' && (!existingSnapshot ||
        terminal.snapshotEnvelopeDigest !== existingSnapshot.envelopeDigest)) {
        return runtimeResult('open', 'attempt-chain-unavailable', base);
      }
      return runtimeResult('completed', 'terminal-replay', {
        ...base,
        outcome: terminal.outcome,
        snapshotEnvelope: terminal.outcome === 'succeeded' ? existingSnapshot : null,
        terminalReceipt: terminal,
      });
    }
    if (existingSnapshot) {
      commitPhase = 'recovery';
      const completed = readClock(dependencies.clock);
      if (!completed) return runtimeResult('open', 'terminal-unavailable', {
        ...base, snapshotEnvelope: existingSnapshot,
      });
      const recovered = complete(
        stores, capabilities, input.durableTickDigest, 'succeeded',
        existingSnapshot.envelopeDigest, completed.iso,
      );
      return recovered.durable && recovered.receipt
        ? runtimeResult('recovered', 'recovered-snapshot', {
            ...base, outcome: 'succeeded', snapshotEnvelope: existingSnapshot,
            terminalReceipt: recovered.receipt,
          })
        : runtimeResult('open', 'terminal-unavailable', {
            ...base, snapshotEnvelope: existingSnapshot,
          });
    }
    const earlyStop = stopOutcome(input, dependencies.clock);
    if (earlyStop) {
      commitPhase = 'non-success';
      const completed = readClock(dependencies.clock);
      if (!completed) return runtimeResult('open', 'terminal-unavailable', base);
      const stopped = complete(stores, capabilities, input.durableTickDigest, earlyStop, null, completed.iso);
      return stopped.durable && stopped.receipt
        ? runtimeResult('completed', earlyStop, {
            ...base, outcome: earlyStop, terminalReceipt: stopped.receipt,
          })
        : runtimeResult('open', 'terminal-unavailable', base);
    }
    const context = freeze({
      protocol: AGENT_OS_EPOCH_RUNTIME_PROTOCOL_V1,
      epoch: start.receipt.epoch,
      durableTickDigest: input.durableTickDigest,
      attemptId,
      startReceiptDigest: start.receipt.receiptDigest,
      authority: 'observation-only' as const,
      executionAuthority: false as const,
      effectAuthority: false as const,
      externalMutationAuthority: false as const,
    });
    let material: AgentOsEpochObservationMaterialV1 | null = null;
    try {
      const observed = input.observe(context);
      material = validObservationMaterial(observed) ? clonePlain(observed) : null;
    } catch {
      material = null;
    }
    const stop = operation.reentered ? 'failed' : stopOutcome(input, dependencies.clock);
    if (!material || stop) {
      commitPhase = 'non-success';
      const completed = readClock(dependencies.clock);
      if (!completed) return runtimeResult('open', 'terminal-unavailable', base);
      const outcome = stop ?? 'failed';
      const ended = complete(stores, capabilities, input.durableTickDigest, outcome, null, completed.iso);
      const reason = operation.reentered ? 'reentrant-call'
        : outcome === 'failed' ? 'observation-failed' : outcome;
      return ended.durable && ended.receipt
        ? runtimeResult(reason === 'reentrant-call' ? 'failed' : 'completed', reason, {
            ...base, outcome, terminalReceipt: ended.receipt,
          })
        : runtimeResult('open', 'terminal-unavailable', base);
    }
    const snapshotInput: WriteAgentOsEpochSnapshotV2Input = {
      ...material,
      durableTickDigest: input.durableTickDigest,
      coordinationLease: lease,
      observationLock: lock,
    };
    commitPhase = 'snapshot';
    const written = writeAgentOsEpochSnapshotV2(snapshotInput, stores.snapshot);
    if (!written.durable || !written.envelope) {
      const lateStop = stopOutcome(input, dependencies.clock);
      if (lateStop) {
        commitPhase = 'non-success';
        const completed = readClock(dependencies.clock);
        const stopped = completed ? complete(
          stores, capabilities, input.durableTickDigest, lateStop, null, completed.iso,
        ) : null;
        if (stopped?.durable && stopped.receipt) {
          return runtimeResult('completed', lateStop, {
            ...base, outcome: lateStop, terminalReceipt: stopped.receipt,
          });
        }
      }
      return runtimeResult('open', 'snapshot-unavailable', base);
    }
    const completed = readClock(dependencies.clock);
    if (!completed) return runtimeResult('open', 'terminal-unavailable', {
      ...base, snapshotEnvelope: written.envelope,
    });
    commitPhase = 'success';
    const ended = complete(
      stores, capabilities, input.durableTickDigest, 'succeeded',
      written.envelope.envelopeDigest, completed.iso,
    );
    if (ended.durable && ended.receipt) {
      return runtimeResult('completed', 'succeeded', {
        ...base, outcome: 'succeeded', snapshotEnvelope: written.envelope,
        terminalReceipt: ended.receipt,
      });
    }
    const terminalStop = stopOutcome(input, dependencies.clock);
    return runtimeResult('open', terminalStop ?? 'terminal-unavailable', {
      ...base, snapshotEnvelope: written.envelope,
    });
  } catch {
    return runtimeResult('failed', operation.reentered ? 'reentrant-call' : 'observation-failed');
  } finally {
    if (trustReadSessionBegun) {
      try { dependencies.trustReadSession?.end(); } catch { /* fail closed on the next admission */ }
    }
    if (lock) releaseAgentOsObservationLockV1(lock);
    if (lease) releaseAgentOsEpochCoordinationLeaseV1(lease);
    leaveRuntime(runtimeRoot, operation);
  }
}
