/**
 * Commissioned trust composition for the authenticated epoch runtime (M564).
 *
 * This module selects no anchor implementation and provisions no key. It
 * composes injected, purpose-separated trust services with the exact M553 and
 * M561 artifacts. Every runtime closure is rebuilt from a fresh anchor read.
 * The resulting authority is observation-only and the public closure facade
 * contains identities, never signing material.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';

import type {
  AgentOsEpochAttemptSignerV2,
  AgentOsEpochSourceSignatureVerifierV2,
} from './agent-os-epoch-records.js';
import {
  isAgentOsPrefixedSha256DigestV1,
  isAgentOsRawSha256DigestV1,
  parseAgentOsEpochSourceBundleV2,
  verifyAgentOsEpochSourceBundleV2,
} from './agent-os-epoch-records.js';
import type {
  AgentOsEpochSnapshotSignerV2,
  AgentOsEpochSnapshotVerifierV2,
} from './agent-os-epoch-snapshot-record.js';
import type {
  AgentOsEpochSourceRenewalSignatureVerifierV1,
  AgentOsEpochSourceRenewalSignerV1,
} from './agent-os-epoch-source-ledger.js';
import {
  readAgentOsEpochSourceStoreForRecoveryAdmissionV1,
  type AgentOsAuthenticatedActiveEpochSourceContextV1,
  type AgentOsEpochAuthenticatedSourceAttemptAuthenticatorInputV1,
  type AgentOsEpochAuthenticatedSourceAttemptAuthenticatorReadV1,
  type AgentOsEpochAuthenticatedSourceAttemptAuthenticatorResolverV1,
  type AgentOsEpochSourceStoreDependenciesV1,
} from './agent-os-epoch-source-store.js';
import {
  readAgentOsActiveEpochArtifactsV1,
  type AgentOsEpochStoreDependenciesV1,
} from './agent-os-epoch-store.js';
import {
  AGENT_OS_EPOCH_HISTORICAL_SOURCE_BATCH_PROTOCOL_V1,
  agentOsEpochAttemptHistoricalSourceLineageDigestV1,
  agentOsEpochAttemptHistoricalSourceSetDigestV1,
  type AgentOsEpochAttemptHistoricalSourceLineageResolutionV1,
  type AgentOsEpochAttemptHistoricalSourceBatchRequestV1,
  type AgentOsEpochAttemptHistoricalSourceLineageV1,
  type AgentOsEpochAttemptHistoricalSourceLineageProviderV1,
} from './agent-os-epoch-attempt-store.js';
import type {
  AgentOsEpochSnapshotHistoricalContextQueryV1,
  AgentOsEpochSnapshotHistoricalContextProviderV1,
} from './agent-os-epoch-snapshot-store.js';
import type {
  AgentOsAuthenticatedEpochRuntimeClosureProviderV1,
  AgentOsAuthenticatedEpochRuntimeClosureV1,
  AgentOsEpochRuntimeClockV1,
  AgentOsEpochRuntimeDependenciesV1,
  AgentOsEpochRuntimeTrustReadSessionTokenV1,
} from './agent-os-epoch-runtime.js';
import { consumeAgentOsEpochRuntimeTrustReadSessionTokenV1 } from './agent-os-epoch-runtime.js';
import {
  canonicalAgentOsObservationEpochHeadBytesV1,
  canonicalAgentOsObservationEpochManifestBytesV1,
  parseAgentOsObservationEpochHeadV1,
  parseAgentOsObservationEpochManifestV1,
  type AgentOsManifestAuthenticatorVerifierV1,
  type AgentOsPreparedEpochEvidenceVerifierV1,
} from './agent-os-rollover-protocol.js';

export const AGENT_OS_EPOCH_TRUST_COMPOSITION_PROTOCOL_V1 =
  'ashlr-agent-os-epoch-trust-composition-v1' as const;

export interface AgentOsManifestFixedSnapshotAuthenticatorRequestV1 {
  protocol: typeof AGENT_OS_EPOCH_TRUST_COMPOSITION_PROTOCOL_V1;
  epoch: number;
  epochHeadDigest: string;
  epochManifestDigest: string;
  canonicalManifestBytes: Uint8Array;
}

export type AgentOsManifestFixedSnapshotAuthenticatorReadV1 =
  | {
      state: 'authenticated';
      epochManifestDigest: string;
      signer: AgentOsEpochSnapshotSignerV2 | null;
      verifier: AgentOsEpochSnapshotVerifierV2;
    }
  | { state: 'missing' | 'unavailable' | 'degraded' };

export interface AgentOsManifestFixedSnapshotAuthenticatorResolverV1 {
  resolveManifestFixedSnapshotAuthenticator(
    request: Readonly<AgentOsManifestFixedSnapshotAuthenticatorRequestV1>,
  ): AgentOsManifestFixedSnapshotAuthenticatorReadV1;
}

/**
 * A commissioned trust snapshot. `commissioningDigest` is an authenticated
 * generation token, not a caller-supplied yes/no claim. All key-bearing
 * services remain behind purpose-specific interfaces.
 */
export interface AgentOsCommissionedEpochTrustV1 {
  commissioningDigest: string;
  manifestAuthenticatorVerifier: AgentOsManifestAuthenticatorVerifierV1;
  preparedEpochEvidenceVerifier: AgentOsPreparedEpochEvidenceVerifierV1;
  firstSourceSignatureVerifier: AgentOsEpochSourceSignatureVerifierV2;
  renewalSignatureVerifier: AgentOsEpochSourceRenewalSignatureVerifierV1;
  renewalSigner: AgentOsEpochSourceRenewalSignerV1 | null;
  attemptAuthenticatorResolver: AgentOsEpochAuthenticatedSourceAttemptAuthenticatorResolverV1;
  snapshotAuthenticatorResolver: AgentOsManifestFixedSnapshotAuthenticatorResolverV1;
}

export type AgentOsCommissionedEpochTrustReadV1 =
  | { state: 'commissioned'; trust: AgentOsCommissionedEpochTrustV1 }
  | { state: 'uncommissioned' | 'unavailable' | 'degraded' };

export interface AgentOsCommissionedEpochTrustProviderV1 {
  readCommissionedEpochTrust(): AgentOsCommissionedEpochTrustReadV1;
}

export type AgentOsFreshAnchorHeadReadV1 =
  | { state: 'present'; canonicalHeadBytes: Uint8Array }
  | { state: 'missing' | 'unavailable' | 'degraded' };

export interface AgentOsFreshAnchorHeadProviderV1 {
  readFreshAnchorHead(): AgentOsFreshAnchorHeadReadV1;
}

export interface AgentOsEpochTrustCompositionInputV1 {
  anchorPath: string;
  epochStoreRootPath: string;
  writerProtocolDigest: string;
  freshAnchorHeadProvider: AgentOsFreshAnchorHeadProviderV1;
  commissionedTrustProvider: AgentOsCommissionedEpochTrustProviderV1;
  clock: AgentOsEpochRuntimeClockV1;
  maxSources?: number;
  maxAttemptRecords?: number;
  maxSnapshotRecords?: number;
}

export interface AgentOsEpochTrustCompositionV1 {
  protocol: typeof AGENT_OS_EPOCH_TRUST_COMPOSITION_PROTOCOL_V1;
  runtimeDependencies: AgentOsEpochRuntimeDependenciesV1;
  /** Read-only facade: authenticated identities only, no signer or verifier. */
  authenticatedClosureProvider: AgentOsAuthenticatedEpochRuntimeClosureProviderV1;
  authority: 'observation-only';
  writesAuthorized: false;
  pointerMutationAuthorized: false;
  anchorMutationAuthority: false;
  executionAuthority: false;
  effectAuthority: false;
  externalMutationAuthority: false;
}

interface FixedEpoch {
  manifestBytes: Buffer;
  headBytes: Buffer;
  manifest: NonNullable<ReturnType<typeof parseAgentOsObservationEpochManifestV1>>;
  head: NonNullable<ReturnType<typeof parseAgentOsObservationEpochHeadV1>>;
  firstSource: NonNullable<ReturnType<typeof parseAgentOsEpochSourceBundleV2>>;
  trust: AgentOsCommissionedEpochTrustV1;
}

interface ResolvedState {
  fixed: FixedEpoch;
  coreFingerprint: string;
  sourceLedgerFingerprint: string;
  closure: AgentOsAuthenticatedEpochRuntimeClosureV1;
  sourceStore: AgentOsEpochSourceStoreDependenciesV1;
  historicalAttemptIndex: ReadonlyMap<string, AgentOsEpochAttemptHistoricalSourceLineageResolutionV1>;
  sourceMembership: ReadonlyArray<Readonly<{ bundleDigest: string; trustPolicyDigest: string }>>;
  currentSourceWindow: Readonly<{ issuedAt: string; expiresAt: string }>;
  attemptSigner: AgentOsEpochAttemptSignerV2;
  snapshotSigner: AgentOsEpochSnapshotSignerV2;
  snapshotVerifier: AgentOsEpochSnapshotVerifierV2;
}

function coreFingerprint(rootPath: string, epoch: number): string | null {
  const epochRoot = join(rootPath, 'epochs', `epoch-${String(epoch).padStart(12, '0')}`);
  try {
    const entries = [
      ['manifest.json', join(epochRoot, 'manifest.json')],
      ['head.json', join(epochRoot, 'head.json')],
      ['first-source.json', join(epochRoot, 'first-source.json')],
      ['prepared-evidence.json', join(epochRoot, 'prepared-evidence.json')],
      ['recovery-marker.json', join(epochRoot, 'recovery-marker.json')],
      ['active-pointer.json', join(rootPath, 'active-pointer.json')],
    ] as const;
    const rows = entries.map(([name, path]) => {
      const stat = lstatSync(path, { bigint: true });
      return `${name}\0${stat.dev}\0${stat.ino}\0${stat.mode}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}`;
    });
    return createHash('sha256').update(rows.join('\n'), 'utf8').digest('hex');
  } catch { return null; }
}

function sourceLedgerFingerprint(rootPath: string, epoch: number): string | null {
  const sourceRoot = join(rootPath, 'epochs', `epoch-${String(epoch).padStart(12, '0')}`, 'sources');
  try {
    const rows: string[] = [];
    const recordsPath = join(sourceRoot, 'records');
    try {
      const sourceRootStat = lstatSync(sourceRoot, { bigint: true });
      const recordsStat = lstatSync(recordsPath, { bigint: true });
      if (!sourceRootStat.isDirectory() || sourceRootStat.isSymbolicLink() ||
        !recordsStat.isDirectory() || recordsStat.isSymbolicLink()) return null;
      for (const name of readdirSync(recordsPath).sort()) {
        if (!/^[0-9]{12}\.json$/u.test(name)) return null;
        const path = join(recordsPath, name);
        const before = lstatSync(path, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink()) return null;
        const bytes = readFileSync(path);
        const after = lstatSync(path, { bigint: true });
        if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev ||
          before.ino !== after.ino || before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return null;
        rows.push(`${name}\0${createHash('sha256').update(bytes).digest('hex')}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
    return createHash('sha256').update(rows.join('\n'), 'utf8').digest('hex');
  } catch { return null; }
}

interface CompositionOperation { reentered: boolean }
const ACTIVE_COMPOSITIONS = new Map<string, CompositionOperation>();

function exactBytes(left: Uint8Array, right: Uint8Array): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
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

function canonicalOwned(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown | undefined {
  if (depth > 32) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : undefined;
  if (typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' ||
      (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key)))) return undefined;
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return undefined;
      const item = canonicalOwned(descriptor.value, depth + 1, seen);
      if (item === undefined) return undefined;
      output.push(item);
    }
    return output;
  }
  const row = record(value);
  if (!row) return undefined;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) {
    const item = canonicalOwned(row[key], depth + 1, seen);
    if (item === undefined) return undefined;
    output[key] = item;
  }
  return output;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  const a = canonicalOwned(left);
  const b = canonicalOwned(right);
  return a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

function validTrust(value: unknown): value is AgentOsCommissionedEpochTrustV1 {
  const row = record(value);
  return Boolean(row && exactKeys(row, [
    'attemptAuthenticatorResolver', 'commissioningDigest', 'firstSourceSignatureVerifier',
    'manifestAuthenticatorVerifier', 'preparedEpochEvidenceVerifier', 'renewalSignatureVerifier',
    'renewalSigner', 'snapshotAuthenticatorResolver',
  ]) && isAgentOsPrefixedSha256DigestV1(row['commissioningDigest']) &&
    typeof row['manifestAuthenticatorVerifier'] === 'function' &&
    typeof row['preparedEpochEvidenceVerifier'] === 'function' &&
    typeof record(row['firstSourceSignatureVerifier'])?.['verify'] === 'function' &&
    typeof record(row['renewalSignatureVerifier'])?.['verify'] === 'function' &&
    (row['renewalSigner'] === null || typeof record(row['renewalSigner'])?.['sign'] === 'function') &&
    typeof record(row['attemptAuthenticatorResolver'])?.['resolveAuthenticatedAttemptAuthenticator'] === 'function' &&
    typeof record(row['snapshotAuthenticatorResolver'])?.['resolveManifestFixedSnapshotAuthenticator'] === 'function');
}

function readTrust(provider: AgentOsCommissionedEpochTrustProviderV1) {
  try {
    const read = provider.readCommissionedEpochTrust();
    const row = record(read);
    return row && exactKeys(row, ['state', 'trust']) && row['state'] === 'commissioned' &&
      validTrust(row['trust']) ? row['trust'] : null;
  } catch { return null; }
}

function readClock(clock: AgentOsEpochRuntimeClockV1): { unixMs: number; iso: string } | null {
  try {
    const value = clock.now();
    return Number.isSafeInteger(value?.unixMs) && typeof value?.iso === 'string' &&
      Date.parse(value.iso) === value.unixMs
      ? { unixMs: value.unixMs, iso: value.iso }
      : null;
  } catch { return null; }
}

function safeBooleanCallback(
  callback: (...arguments_: never[]) => boolean,
  arguments_: unknown[],
  mutableBytes: Uint8Array[],
  mutableValues: unknown[],
): boolean {
  const byteCopies = mutableBytes.map((value) => Buffer.from(value));
  const valueCopies = mutableValues.map((value) => {
    try { return structuredClone(value); } catch { return null; }
  });
  try {
    const accepted = callback(...arguments_ as never[]) === true;
    return accepted && mutableBytes.every((value, index) => exactBytes(value, byteCopies[index]!)) &&
      mutableValues.every((value, index) => valueCopies[index] !== null &&
        canonicalEqual(value, valueCopies[index]));
  } catch { return false; }
}

function snapshotBinding(
  fixed: FixedEpoch,
): (Extract<AgentOsManifestFixedSnapshotAuthenticatorReadV1, { state: 'authenticated' }> & {
  signer: AgentOsEpochSnapshotSignerV2;
}) | null {
  const request: AgentOsManifestFixedSnapshotAuthenticatorRequestV1 = Object.freeze({
    protocol: AGENT_OS_EPOCH_TRUST_COMPOSITION_PROTOCOL_V1,
    epoch: fixed.head.epoch,
    epochHeadDigest: fixed.head.headDigest,
    epochManifestDigest: fixed.manifest.manifestDigest,
    canonicalManifestBytes: Buffer.from(fixed.manifestBytes),
  });
  const before = Buffer.from(request.canonicalManifestBytes);
  try {
    const read = fixed.trust.snapshotAuthenticatorResolver
      .resolveManifestFixedSnapshotAuthenticator(request);
    const readRow = record(read);
    if (!exactBytes(request.canonicalManifestBytes, before) || !readRow ||
      !exactKeys(readRow, ['epochManifestDigest', 'signer', 'state', 'verifier']) ||
      read?.state !== 'authenticated' ||
      read.epochManifestDigest !== fixed.manifest.manifestDigest || !read.signer ||
      read.signer.producerIdentityDigest !== read.verifier.producerIdentityDigest ||
      read.signer.keyId !== read.verifier.keyId ||
      read.signer.keyGeneration !== read.verifier.keyGeneration ||
      !isAgentOsPrefixedSha256DigestV1(read.signer.producerIdentityDigest) ||
      !isAgentOsRawSha256DigestV1(read.signer.keyId) ||
      !Number.isSafeInteger(read.signer.keyGeneration) || read.signer.keyGeneration < 1 ||
      typeof read.signer.sign !== 'function' || typeof read.verifier.verify !== 'function') return null;
    return { ...read, signer: read.signer };
  } catch { return null; }
}

function fixedIdentity(left: FixedEpoch, right: FixedEpoch): boolean {
  return exactBytes(left.headBytes, right.headBytes) && exactBytes(left.manifestBytes, right.manifestBytes) &&
    left.trust.commissioningDigest === right.trust.commissioningDigest;
}

function sourceContext(fixed: FixedEpoch, observedAt: string): AgentOsAuthenticatedActiveEpochSourceContextV1 {
  return Object.freeze({
    epoch: fixed.head.epoch,
    epochHeadDigest: fixed.head.headDigest,
    epochManifestDigest: fixed.manifest.manifestDigest,
    previousEpochHeadDigest: fixed.manifest.previousEpochHeadDigest,
    previousEpochSourceTipDigest: fixed.manifest.previousSourceTip?.bundleDigest ?? null,
    attemptNamespaceDigest: fixed.manifest.attemptNamespaceDigest,
    firstSourceBundleDigest: fixed.firstSource.bundleDigest,
    trustPolicyDigest: fixed.firstSource.trustPolicyDigest,
    policyGeneration: fixed.firstSource.policyGeneration,
    expectedSourceKeyId: fixed.firstSource.sourceKeyId,
    expectedSourcePrincipalDigest: fixed.firstSource.sourcePrincipalDigest,
    epochCreatedAt: fixed.manifest.createdAt,
    observedAt,
    writerProtocolDigest: fixed.head.writerProtocolDigest,
  });
}

export function createAgentOsEpochTrustCompositionV1(
  input: AgentOsEpochTrustCompositionInputV1,
): AgentOsEpochTrustCompositionV1 | null {
  const row = record(input);
  const optionalKeys = ['maxSources', 'maxAttemptRecords', 'maxSnapshotRecords'];
  const expectedKeys = [
    'anchorPath', 'clock', 'commissionedTrustProvider', 'epochStoreRootPath',
    'freshAnchorHeadProvider', 'writerProtocolDigest',
    ...optionalKeys.filter((key) => row && Object.hasOwn(row, key)),
  ];
  if (!row || !exactKeys(row, expectedKeys) || typeof input.anchorPath !== 'string' ||
    typeof input.epochStoreRootPath !== 'string' ||
    !isAgentOsPrefixedSha256DigestV1(input.writerProtocolDigest) ||
    typeof record(input.freshAnchorHeadProvider)?.['readFreshAnchorHead'] !== 'function' ||
    typeof record(input.commissionedTrustProvider)?.['readCommissionedEpochTrust'] !== 'function' ||
    typeof record(input.clock)?.['now'] !== 'function') return null;
  const anchorPath = resolve(input.anchorPath);
  const epochStoreRootPath = resolve(input.epochStoreRootPath);
  if (!isAbsolute(input.anchorPath) || !isAbsolute(input.epochStoreRootPath) ||
    input.anchorPath !== anchorPath || input.epochStoreRootPath !== epochStoreRootPath ||
    anchorPath === parse(anchorPath).root || dirname(epochStoreRootPath) !== anchorPath ||
    basename(epochStoreRootPath) !== 'agent-os-epochs') return null;

  let activeOperation: CompositionOperation | null = null;

  const readFixedEpoch = (): FixedEpoch | null => {
    const trust = readTrust(input.commissionedTrustProvider);
    if (!trust) return null;
    let authenticatedManifest: unknown = null;
    const storeDependencies: AgentOsEpochStoreDependenciesV1 = {
      anchorPath: input.anchorPath,
      rootPath: input.epochStoreRootPath,
      writerProtocolDigest: input.writerProtocolDigest,
      manifestAuthenticatorVerifier(bytes, manifest) {
        const accepted = safeBooleanCallback(
          trust.manifestAuthenticatorVerifier as (...arguments_: never[]) => boolean,
          [bytes, manifest], [bytes], [manifest],
        );
        if (accepted) authenticatedManifest = structuredClone(manifest);
        return accepted;
      },
      preparedEpochEvidenceVerifier(evidence) {
        const accepted = safeBooleanCallback(
          trust.preparedEpochEvidenceVerifier as (...arguments_: never[]) => boolean,
          [evidence], [], [evidence],
        );
        return accepted;
      },
      firstSourceBundleVerifier(bytes, expectedDigest) {
        const parsed = parseAgentOsEpochSourceBundleV2(bytes);
        if (!parsed || parsed.bundleDigest !== expectedDigest) return false;
        const manifest = authenticatedManifest as ReturnType<
          typeof parseAgentOsObservationEpochManifestV1
        >;
        if (!manifest || manifest.firstSourceBundle.bundleDigest !== parsed.bundleDigest) return false;
        const observed = readClock(input.clock);
        if (!observed) return false;
        const expectedContext = Object.freeze({
          epoch: manifest.epoch,
          previousEpochHeadDigest: manifest.previousEpochHeadDigest,
          previousEpochSourceTipDigest: manifest.previousSourceTip?.bundleDigest ?? null,
          trustPolicyDigest: manifest.firstSourceBundle.trustPolicyDigest,
          policyGeneration: manifest.firstSourceBundle.policyGeneration,
          expectedSourceKeyId: parsed.sourceKeyId,
          expectedSourcePrincipalDigest: parsed.sourcePrincipalDigest,
          observedAt: observed.iso,
        });
        const result = verifyAgentOsEpochSourceBundleV2(
          parsed,
          expectedContext,
          trust.firstSourceSignatureVerifier,
          { verify: (candidate) => canonicalEqual(candidate, expectedContext) },
        );
        return result.ok;
      },
      readAnchorHead: () => {
        try { return input.freshAnchorHeadProvider.readFreshAnchorHead(); }
        catch { return { state: 'unavailable' as const }; }
      },
    };
    const artifacts = readAgentOsActiveEpochArtifactsV1(storeDependencies);
    if (artifacts.state !== 'accepted' || artifacts.phase !== 'active' ||
      !artifacts.canonicalManifestBytes || !artifacts.canonicalHeadBytes ||
      !artifacts.canonicalFirstSourceBundleBytes) return null;
    const manifestBytes = Buffer.from(artifacts.canonicalManifestBytes);
    const headBytes = Buffer.from(artifacts.canonicalHeadBytes);
    const manifest = parseAgentOsObservationEpochManifestV1(manifestBytes);
    const head = parseAgentOsObservationEpochHeadV1(headBytes);
    const firstSource = parseAgentOsEpochSourceBundleV2(artifacts.canonicalFirstSourceBundleBytes);
    if (!manifest || !head || !firstSource ||
      !exactBytes(manifestBytes, canonicalAgentOsObservationEpochManifestBytesV1(manifest) ?? Buffer.alloc(0)) ||
      !exactBytes(headBytes, canonicalAgentOsObservationEpochHeadBytesV1(head) ?? Buffer.alloc(0)) ||
      head.headDigest !== artifacts.headDigest || manifest.manifestDigest !== artifacts.manifestDigest ||
      head.epochManifestDigest !== manifest.manifestDigest || head.firstSourceBundleDigest !== firstSource.bundleDigest ||
      manifest.firstSourceBundle.bundleDigest !== firstSource.bundleDigest ||
      manifest.firstSourceBundle.trustPolicyDigest !== firstSource.trustPolicyDigest ||
      manifest.firstSourceBundle.policyGeneration !== firstSource.policyGeneration ||
      manifest.attemptNamespaceDigest !== artifacts.attemptNamespaceDigest ||
      manifest.snapshotBase.previousEnvelopeDigest !== artifacts.snapshotBasePreviousEnvelopeDigest ||
      head.writerProtocolDigest !== input.writerProtocolDigest) return null;
    let anchor: AgentOsFreshAnchorHeadReadV1;
    try { anchor = input.freshAnchorHeadProvider.readFreshAnchorHead(); }
    catch { return null; }
    if (anchor.state !== 'present') return null;
    const anchorBytes = Buffer.from(anchor.canonicalHeadBytes);
    if (!exactBytes(anchorBytes, headBytes) ||
      !exactBytes(anchorBytes, canonicalAgentOsObservationEpochHeadBytesV1(head) ?? Buffer.alloc(0))) return null;
    const afterTrust = readTrust(input.commissionedTrustProvider);
    if (!afterTrust || afterTrust.commissioningDigest !== trust.commissioningDigest ||
      activeOperation?.reentered) return null;
    return { manifestBytes, headBytes, manifest, head, firstSource, trust };
  };

  const buildSourceStore = (
    fixed: FixedEpoch,
    context: AgentOsAuthenticatedActiveEpochSourceContextV1,
  ): AgentOsEpochSourceStoreDependenciesV1 => {
    const trustToken = fixed.trust.commissioningDigest;
    const unchanged = () => readTrust(input.commissionedTrustProvider)?.commissioningDigest === trustToken;
    const assertFixed = () => {
      let anchor: AgentOsFreshAnchorHeadReadV1;
      try { anchor = input.freshAnchorHeadProvider.readFreshAnchorHead(); }
      catch { return false; }
      const row = record(anchor);
      return Boolean(row && exactKeys(row, ['canonicalHeadBytes', 'state']) &&
        anchor.state === 'present' && exactBytes(anchor.canonicalHeadBytes, fixed.headBytes) && unchanged());
    };
    const attemptResolver: AgentOsEpochAuthenticatedSourceAttemptAuthenticatorResolverV1 = Object.freeze({
      resolveAuthenticatedAttemptAuthenticator(
        source: Readonly<AgentOsEpochAuthenticatedSourceAttemptAuthenticatorInputV1>,
      ): AgentOsEpochAuthenticatedSourceAttemptAuthenticatorReadV1 {
        const before = structuredClone(source);
        try {
          const result = fixed.trust.attemptAuthenticatorResolver
            .resolveAuthenticatedAttemptAuthenticator(source);
          return canonicalEqual(source, before) && unchanged() && !activeOperation?.reentered
            ? result : { state: 'degraded' as const };
        } catch { return { state: 'degraded' as const }; }
      },
    });
    const firstVerifier: AgentOsEpochSourceSignatureVerifierV2 = Object.freeze({
      verify(request: Parameters<AgentOsEpochSourceSignatureVerifierV2['verify']>[0]) {
        const payload = Buffer.from(request.canonicalDomainSeparatedPayload);
        const signature = Buffer.from(request.signature);
        try {
          const accepted = fixed.trust.firstSourceSignatureVerifier.verify(request) === true;
          return accepted && exactBytes(payload, request.canonicalDomainSeparatedPayload) &&
            exactBytes(signature, request.signature) && unchanged() && !activeOperation?.reentered;
        } catch { return false; }
      },
    });
    const renewalVerifier: AgentOsEpochSourceRenewalSignatureVerifierV1 = Object.freeze({
      verify(request: Parameters<AgentOsEpochSourceRenewalSignatureVerifierV1['verify']>[0]) {
        const payload = Buffer.from(request.canonicalDomainSeparatedPayload);
        const signature = Buffer.from(request.signature);
        try {
          const accepted = fixed.trust.renewalSignatureVerifier.verify(request) === true;
          return accepted && exactBytes(payload, request.canonicalDomainSeparatedPayload) &&
            exactBytes(signature, request.signature) && unchanged() && !activeOperation?.reentered;
        } catch { return false; }
      },
    });
    const renewalSigner = fixed.trust.renewalSigner;
    const guardedRenewalSigner: AgentOsEpochSourceRenewalSignerV1 | null = renewalSigner === null ? null : {
      keyId: renewalSigner.keyId,
      principalDigest: renewalSigner.principalDigest,
      sign(bytes) {
        const before = Buffer.from(bytes);
        try {
          const signature = renewalSigner.sign(bytes);
          return exactBytes(before, bytes) && unchanged() && !activeOperation?.reentered ? signature : null;
        } catch { return null; }
      },
    };
    return Object.freeze({
      anchorPath: input.anchorPath,
      epochStoreRootPath: input.epochStoreRootPath,
      writerProtocolDigest: input.writerProtocolDigest,
      activeContextProvider: Object.freeze({
        readAuthenticatedActiveEpochSourceContext() {
          return unchanged() && assertFixed() && !activeOperation?.reentered
            ? { state: 'authenticated' as const, context }
            : { state: 'degraded' as const };
        },
      }),
      firstSourceSignatureVerifier: firstVerifier,
      renewalSignatureVerifier: renewalVerifier,
      renewalSigner: guardedRenewalSigner,
      attemptAuthenticatorResolver: attemptResolver,
      ...(input.maxSources === undefined ? {} : { maxSources: input.maxSources }),
    });
  };

  const resolveState = (): ResolvedState | null => {
    const fixed = readFixedEpoch();
    const clock = readClock(input.clock);
    if (!fixed || !clock || activeOperation?.reentered) return null;
    const context = sourceContext(fixed, clock.iso);
    const sourceStore = buildSourceStore(fixed, context);
    const sources = readAgentOsEpochSourceStoreForRecoveryAdmissionV1(
      sourceStore,
      { requireComplete: true },
    );
    if (!sources.complete || sources.currentness !== 'current' || !sources.current ||
      !sources.firstSource || activeOperation?.reentered) return null;
    const allSources = [sources.firstSource, ...sources.renewals];
    const current = allSources.find((source) => source.bundleDigest === sources.current?.bundleDigest);
    if (!current) return null;
    const historicalAttemptIndex = new Map<
      string, AgentOsEpochAttemptHistoricalSourceLineageResolutionV1
    >();
    let attemptAuth: AgentOsEpochAuthenticatedSourceAttemptAuthenticatorReadV1 = { state: 'missing' };
    for (const source of allSources) {
      const sourceInput: AgentOsEpochAuthenticatedSourceAttemptAuthenticatorInputV1 = Object.freeze({
        epoch: source.epoch,
        epochSequence: source.epochSequence,
        epochHeadDigest: fixed.head.headDigest,
        epochManifestDigest: fixed.manifest.manifestDigest,
        attemptNamespaceDigest: fixed.manifest.attemptNamespaceDigest,
        sourceBundleDigest: source.bundleDigest,
        trustPolicyDigest: source.trustPolicyDigest,
        sourcePayloadDigest: source.sourcePayloadDigest,
        sourcePayload: source.sourcePayload,
      });
      let selected: AgentOsEpochAuthenticatedSourceAttemptAuthenticatorReadV1;
      try { selected = sourceStore.attemptAuthenticatorResolver.resolveAuthenticatedAttemptAuthenticator(sourceInput); }
      catch { return null; }
      if (selected.state !== 'authenticated' || selected.verifier.keyId !== selected.keyId ||
        (selected.signer !== null && selected.signer.keyId !== selected.keyId)) return null;
      const lineage: AgentOsEpochAttemptHistoricalSourceLineageV1 = {
        epoch: source.epoch,
        epochHeadDigest: fixed.head.headDigest,
        epochManifestDigest: fixed.manifest.manifestDigest,
        attemptNamespaceDigest: fixed.manifest.attemptNamespaceDigest,
        sourceBundleDigest: source.bundleDigest,
        trustPolicyDigest: source.trustPolicyDigest,
        attemptAuthenticatorKeyId: selected.keyId,
      };
      const lineageDigest = agentOsEpochAttemptHistoricalSourceLineageDigestV1(lineage);
      if (!lineageDigest) return null;
      historicalAttemptIndex.set(lineageDigest, Object.freeze({
        state: 'authenticated' as const,
        lineage: Object.freeze({ ...lineage, attemptAuthenticatorGeneration: selected.generation }),
        verifier: selected.verifier,
        signer: selected.signer,
      }));
      if (source.bundleDigest === current.bundleDigest) attemptAuth = selected;
    }
    if (attemptAuth.state !== 'authenticated' || !attemptAuth.signer ||
      attemptAuth.keyId !== attemptAuth.signer.keyId || attemptAuth.keyId !== attemptAuth.verifier.keyId ||
      !isAgentOsRawSha256DigestV1(attemptAuth.keyId) || !Number.isSafeInteger(attemptAuth.generation) ||
      attemptAuth.generation < 1) return null;
    const snapshot = snapshotBinding(fixed);
    if (!snapshot || snapshot.signer.keyId === attemptAuth.keyId ||
      snapshot.signer.keyId === current.sourceKeyId || attemptAuth.keyId === current.sourceKeyId) return null;
    const finalFixed = readFixedEpoch();
    const finalSnapshot = finalFixed ? snapshotBinding(finalFixed) : null;
    const fixedCoreFingerprint = coreFingerprint(input.epochStoreRootPath, fixed.head.epoch);
    const sourceFingerprint = sourceLedgerFingerprint(input.epochStoreRootPath, fixed.head.epoch);
    if (!finalFixed || !finalSnapshot || !fixedIdentity(fixed, finalFixed) ||
      !fixedCoreFingerprint || !sourceFingerprint ||
      snapshot.signer.producerIdentityDigest !== finalSnapshot.signer.producerIdentityDigest ||
      snapshot.signer.keyId !== finalSnapshot.signer.keyId ||
      snapshot.signer.keyGeneration !== finalSnapshot.signer.keyGeneration || activeOperation?.reentered) return null;
    return {
      fixed,
      coreFingerprint: fixedCoreFingerprint,
      sourceLedgerFingerprint: sourceFingerprint,
      closure: Object.freeze({
        source: context,
        attempt: Object.freeze({
          epoch: fixed.head.epoch,
          epochHeadDigest: fixed.head.headDigest,
          epochManifestDigest: fixed.manifest.manifestDigest,
          attemptNamespaceDigest: fixed.manifest.attemptNamespaceDigest,
          sourceBundleDigest: current.bundleDigest,
          trustPolicyDigest: current.trustPolicyDigest,
          attemptAuthenticatorKeyId: attemptAuth.keyId,
          attemptAuthenticatorGeneration: attemptAuth.generation,
          writerProtocolDigest: input.writerProtocolDigest,
        }),
        snapshot: Object.freeze({
          epoch: fixed.head.epoch,
          anchoredHeadDigest: fixed.head.headDigest,
          epochManifestDigest: fixed.manifest.manifestDigest,
          attemptNamespaceDigest: fixed.manifest.attemptNamespaceDigest,
          sourceBundleDigest: current.bundleDigest,
          trustPolicyDigest: current.trustPolicyDigest,
          snapshotBasePreviousEnvelopeDigest: fixed.manifest.snapshotBase.previousEnvelopeDigest,
          writerProtocolDigest: input.writerProtocolDigest,
          expectedProducerIdentityDigest: snapshot.signer.producerIdentityDigest,
          expectedAuthenticatorKeyId: snapshot.signer.keyId,
          expectedAuthenticatorKeyGeneration: snapshot.signer.keyGeneration,
        }),
      }),
      sourceStore,
      historicalAttemptIndex,
      sourceMembership: allSources.map((source) => Object.freeze({
        bundleDigest: source.bundleDigest,
        trustPolicyDigest: source.trustPolicyDigest,
      })),
      currentSourceWindow: Object.freeze({ issuedAt: current.issuedAt, expiresAt: current.expiresAt }),
      attemptSigner: attemptAuth.signer,
      snapshotSigner: snapshot.signer,
      snapshotVerifier: snapshot.verifier,
    };
  };

  const withOperation = <T>(work: () => T, failure: T): T => {
    const existing = ACTIVE_COMPOSITIONS.get(input.epochStoreRootPath);
    if (existing) {
      existing.reentered = true;
      return failure;
    }
    const operation = { reentered: false };
    ACTIVE_COMPOSITIONS.set(input.epochStoreRootPath, operation);
    activeOperation = operation;
    try {
      const result = work();
      return operation.reentered ? failure : result;
    } catch { return failure; }
    finally {
      activeOperation = null;
      if (ACTIVE_COMPOSITIONS.get(input.epochStoreRootPath) === operation) {
        ACTIVE_COMPOSITIONS.delete(input.epochStoreRootPath);
      }
    }
  };

  let pinnedState: ResolvedState | null = null;
  let trustReadSessionActive = false;
  let trustReadSessionFirstRead = false;
  const authenticatedClosureProvider: AgentOsAuthenticatedEpochRuntimeClosureProviderV1 = Object.freeze({
    readAuthenticatedClosure() {
      return withOperation(() => {
        const bindingRequired = !trustReadSessionActive || trustReadSessionFirstRead;
        const freshTrust = fixedFenceTrust();
        const verified = Boolean(pinnedState && freshTrust && coreEvidenceUnchanged() &&
          (!bindingRequired || (sourceEvidenceUnchanged() && manifestBindingUnchanged(freshTrust))));
        if (verified && trustReadSessionActive) trustReadSessionFirstRead = false;
        return pinnedState && verified
          ? { state: 'authenticated' as const, closure: pinnedState.closure }
          : { state: 'degraded' as const };
      }, { state: 'degraded' as const });
    },
  });

  const currentState = (): ResolvedState | null => withOperation(resolveState, null);
  pinnedState = currentState();
  if (!pinnedState) return null;
  const pinnedAttemptKeyId = pinnedState.attemptSigner.keyId;
  const pinnedSnapshotProducer = pinnedState.snapshotSigner.producerIdentityDigest;
  const pinnedSnapshotKeyId = pinnedState.snapshotSigner.keyId;
  const pinnedSnapshotGeneration = pinnedState.snapshotSigner.keyGeneration;
  const fixedFenceTrust = (): AgentOsCommissionedEpochTrustV1 | null => {
    let anchor: AgentOsFreshAnchorHeadReadV1;
    try { anchor = input.freshAnchorHeadProvider.readFreshAnchorHead(); }
    catch { return null; }
    const anchorRow = record(anchor);
    const trust = readTrust(input.commissionedTrustProvider);
    const now = readClock(input.clock);
    const issuedAt = pinnedState ? Date.parse(pinnedState.currentSourceWindow.issuedAt) : Number.NaN;
    const expiresAt = pinnedState ? Date.parse(pinnedState.currentSourceWindow.expiresAt) : Number.NaN;
    return anchorRow && exactKeys(anchorRow, ['canonicalHeadBytes', 'state']) &&
      anchor.state === 'present' && exactBytes(anchor.canonicalHeadBytes, pinnedState!.fixed.headBytes) &&
      trust?.commissioningDigest === pinnedState!.fixed.trust.commissioningDigest &&
      now && issuedAt <= now.unixMs + 60_000 && expiresAt > now.unixMs &&
      !activeOperation?.reentered
      ? trust
      : null;
  };
  const fixedFence = (): boolean => fixedFenceTrust() !== null;
  const sourceEvidenceUnchanged = (): boolean => Boolean(pinnedState &&
    sourceLedgerFingerprint(input.epochStoreRootPath, pinnedState.closure.source.epoch) ===
      pinnedState.sourceLedgerFingerprint);
  const localEvidenceUnchanged = (): boolean => Boolean(pinnedState &&
    coreFingerprint(input.epochStoreRootPath, pinnedState.closure.source.epoch) ===
      pinnedState.coreFingerprint &&
    sourceLedgerFingerprint(input.epochStoreRootPath, pinnedState.closure.source.epoch) ===
      pinnedState.sourceLedgerFingerprint);
  const coreEvidenceUnchanged = (): boolean => Boolean(pinnedState &&
    coreFingerprint(input.epochStoreRootPath, pinnedState.closure.source.epoch) ===
      pinnedState.coreFingerprint);
  const manifestBindingUnchanged = (providedTrust?: AgentOsCommissionedEpochTrustV1): boolean => {
    if (!pinnedState) return false;
    const trust = providedTrust ?? readTrust(input.commissionedTrustProvider);
    const binding = trust?.commissioningDigest === pinnedState.fixed.trust.commissioningDigest
      ? snapshotBinding({ ...pinnedState.fixed, trust }) : null;
    return Boolean(binding && binding.signer.producerIdentityDigest === pinnedSnapshotProducer &&
      binding.signer.keyId === pinnedSnapshotKeyId &&
      binding.signer.keyGeneration === pinnedSnapshotGeneration);
  };
  const strongFence = (): boolean => fixedFence() && localEvidenceUnchanged();
  const contextFence = (): boolean => strongFence();
  const sourcePublicationFence = (): boolean => fixedFence() && coreEvidenceUnchanged();
  const attemptSigner: AgentOsEpochAttemptSignerV2 = {
    keyId: pinnedAttemptKeyId,
    authenticate(bytes) {
      const before = Buffer.from(bytes);
      return withOperation(() => {
        if (!trustReadSessionActive || !strongFence()) return null;
        const authenticator = pinnedState!.attemptSigner.authenticate(bytes);
        return exactBytes(before, bytes) && trustReadSessionActive && strongFence()
          ? authenticator
          : null;
      }, null);
    },
  };
  const snapshotSigner: AgentOsEpochSnapshotSignerV2 = {
    producerIdentityDigest: pinnedSnapshotProducer,
    keyId: pinnedSnapshotKeyId,
    keyGeneration: pinnedSnapshotGeneration,
    sign(bytes) {
      const before = Buffer.from(bytes);
      return withOperation(() => {
        if (!trustReadSessionActive || !strongFence()) return null;
        const signature = pinnedState!.snapshotSigner.sign(bytes);
        return exactBytes(before, bytes) && trustReadSessionActive && strongFence()
          ? signature
          : null;
      }, null);
    },
  };
  const snapshotVerifier: AgentOsEpochSnapshotVerifierV2 = {
    producerIdentityDigest: pinnedSnapshotProducer,
    keyId: pinnedSnapshotKeyId,
    keyGeneration: pinnedSnapshotGeneration,
    verify(request) {
      const bytes = Buffer.from(request.canonicalDomainSeparatedEnvelope);
      const before = structuredClone({
        producerIdentityDigest: request.producerIdentityDigest,
        keyId: request.keyId,
        keyGeneration: request.keyGeneration,
        authenticator: request.authenticator,
      });
      return withOperation(() => {
        const accepted = pinnedState!.snapshotVerifier.verify(request) === true;
        return accepted && exactBytes(bytes, request.canonicalDomainSeparatedEnvelope) &&
          canonicalEqual(before, {
            producerIdentityDigest: request.producerIdentityDigest,
            keyId: request.keyId,
            keyGeneration: request.keyGeneration,
            authenticator: request.authenticator,
          });
      }, false);
    },
  };

  const historicalSources: AgentOsEpochAttemptHistoricalSourceLineageProviderV1 = Object.freeze({
    resolveAuthenticatedHistoricalSource(
      lineage: Readonly<AgentOsEpochAttemptHistoricalSourceLineageV1>,
    ) {
      return withOperation(() => {
        if (!trustReadSessionActive || !pinnedState || !contextFence()) {
          return { state: 'degraded' as const };
        }
        const digest = agentOsEpochAttemptHistoricalSourceLineageDigestV1(lineage);
        const result = digest ? pinnedState.historicalAttemptIndex.get(digest) : null;
        if (!result) return { state: 'missing' as const };
        return contextFence() ? result : { state: 'degraded' as const };
      }, { state: 'degraded' as const });
    },
    resolveAuthenticatedHistoricalSources(
      request: Readonly<AgentOsEpochAttemptHistoricalSourceBatchRequestV1>,
    ) {
      return withOperation(() => {
        if (!pinnedState || !contextFence()) return { state: 'degraded' as const };
        if (request.protocol !== AGENT_OS_EPOCH_HISTORICAL_SOURCE_BATCH_PROTOCOL_V1) {
          return { state: 'degraded' as const };
        }
        const digests = request.lineages.map((lineage) =>
          agentOsEpochAttemptHistoricalSourceLineageDigestV1(lineage) ?? '');
        if (agentOsEpochAttemptHistoricalSourceSetDigestV1(digests) !== request.inputSetDigest) {
          return { state: 'degraded' as const };
        }
        const resolutions = request.lineages.map((_lineage, index) => {
          const cached = pinnedState!.historicalAttemptIndex.get(digests[index]!);
          return {
            lineageDigest: digests[index]!,
            resolution: cached?.state === 'authenticated'
              ? {
                  state: 'authenticated' as const,
                  lineage: cached.lineage,
                  verifier: cached.verifier,
                }
              : { state: 'missing' as const },
          };
        });
        return contextFence() ? {
          state: 'authenticated' as const,
          inputSetDigest: request.inputSetDigest,
          resolutions,
        } : { state: 'degraded' as const };
      }, { state: 'degraded' as const });
    },
  });
  const historicalSnapshots: AgentOsEpochSnapshotHistoricalContextProviderV1 = Object.freeze({
    readAuthenticatedHistoricalContext(query: Readonly<AgentOsEpochSnapshotHistoricalContextQueryV1>) {
      return withOperation(() => {
        if (!pinnedState || !contextFence()) return { state: 'degraded' as const };
        const fixed = pinnedState.closure.snapshot;
        if (query.epoch !== fixed.epoch || query.anchoredHeadDigest !== fixed.anchoredHeadDigest ||
          query.epochManifestDigest !== fixed.epochManifestDigest ||
          query.attemptNamespaceDigest !== fixed.attemptNamespaceDigest ||
          query.producerIdentityDigest !== fixed.expectedProducerIdentityDigest ||
          query.authenticatorKeyId !== fixed.expectedAuthenticatorKeyId ||
          query.authenticatorKeyGeneration !== fixed.expectedAuthenticatorKeyGeneration) {
          return { state: 'missing' as const };
        }
        if (!pinnedState.sourceMembership.some((source) =>
          source.bundleDigest === query.sourceBundleDigest &&
          source.trustPolicyDigest === query.trustPolicyDigest)) return { state: 'missing' as const };
        if (!contextFence()) return { state: 'degraded' as const };
        return {
          state: 'authenticated' as const,
          context: Object.freeze({
            ...query,
            snapshotBasePreviousEnvelopeDigest: fixed.snapshotBasePreviousEnvelopeDigest,
          }),
          verifier: snapshotVerifier,
        };
      }, { state: 'degraded' as const });
    },
  });

  const sourceStore: AgentOsEpochSourceStoreDependenciesV1 = {
    anchorPath: input.anchorPath,
    epochStoreRootPath: input.epochStoreRootPath,
    writerProtocolDigest: input.writerProtocolDigest,
    activeContextProvider: {
      readAuthenticatedActiveEpochSourceContext() {
        return pinnedState && sourcePublicationFence()
          ? { state: 'authenticated' as const, context: pinnedState.closure.source }
          : { state: 'degraded' as const };
      },
    },
    firstSourceSignatureVerifier: {
      verify(request) {
        return withOperation(() => pinnedState?.sourceStore.firstSourceSignatureVerifier
          .verify(request) === true, false);
      },
    },
    renewalSignatureVerifier: {
      verify(request) {
        return withOperation(() => pinnedState?.sourceStore.renewalSignatureVerifier
          .verify(request) === true, false);
      },
    },
    renewalSigner: pinnedState.sourceStore.renewalSigner === null ? null : {
      keyId: pinnedState.sourceStore.renewalSigner.keyId,
      principalDigest: pinnedState.sourceStore.renewalSigner.principalDigest,
      sign(bytes) {
        const before = Buffer.from(bytes);
        return withOperation(() => {
          if (!pinnedState || !sourcePublicationFence()) return null;
          const signature = pinnedState.sourceStore.renewalSigner?.sign(bytes) ?? null;
          return signature && exactBytes(before, bytes) && sourcePublicationFence()
            ? signature
            : null;
        }, null);
      },
    },
    attemptAuthenticatorResolver: {
      resolveAuthenticatedAttemptAuthenticator(source) {
        return withOperation(() => trustReadSessionActive
          ? pinnedState?.sourceStore.attemptAuthenticatorResolver
              .resolveAuthenticatedAttemptAuthenticator(source) ?? { state: 'degraded' as const }
          : { state: 'degraded' as const },
        { state: 'degraded' as const });
      },
    },
    ...(input.maxSources === undefined ? {} : { maxSources: input.maxSources }),
  };

  const trustReadSession: NonNullable<AgentOsEpochRuntimeDependenciesV1['trustReadSession']> =
    Object.freeze({
    begin(token: AgentOsEpochRuntimeTrustReadSessionTokenV1) {
      if (!consumeAgentOsEpochRuntimeTrustReadSessionTokenV1(token, trustReadSession) ||
        trustReadSessionActive) return false;
      const admitted = withOperation(
        () => strongFence() && manifestBindingUnchanged(),
        false,
      );
      if (!admitted) return false;
      trustReadSessionActive = true;
      trustReadSessionFirstRead = true;
      return true;
    },
    end() {
      trustReadSessionFirstRead = false;
      trustReadSessionActive = false;
    },
    });

  const runtimeDependencies = Object.freeze({
    anchorPath: input.anchorPath,
    epochStoreRootPath: input.epochStoreRootPath,
    writerProtocolDigest: input.writerProtocolDigest,
    authenticatedClosureProvider,
    sourceStore: Object.freeze(sourceStore),
    attemptHistoricalSourceLineageProvider: historicalSources,
    attemptSigner,
    snapshotHistoricalContextProvider: historicalSnapshots,
    snapshotSigner,
    snapshotVerifier,
    clock: input.clock,
    trustReadSession,
    ...(input.maxAttemptRecords === undefined ? {} : { maxAttemptRecords: input.maxAttemptRecords }),
    ...(input.maxSnapshotRecords === undefined ? {} : { maxSnapshotRecords: input.maxSnapshotRecords }),
  }) as AgentOsEpochRuntimeDependenciesV1;

  return Object.freeze({
    protocol: AGENT_OS_EPOCH_TRUST_COMPOSITION_PROTOCOL_V1,
    runtimeDependencies,
    authenticatedClosureProvider,
    authority: 'observation-only' as const,
    writesAuthorized: false as const,
    pointerMutationAuthorized: false as const,
    anchorMutationAuthority: false as const,
    executionAuthority: false as const,
    effectAuthority: false as const,
    externalMutationAuthority: false as const,
  });
}
