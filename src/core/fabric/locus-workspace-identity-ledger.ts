/**
 * Durable, bounded continuity for already-compiled Locus workspace identity
 * observations. This authenticates a local append history under the existing
 * host-shared HMAC. It does not authenticate Locus, the workspace claim, a
 * release, or any effect authority.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

import { loadExistingProvenanceKeyReadOnly } from '../foundry/provenance.js';
import {
  acquireLocalStoreLock,
  ownsLocalStoreLock,
  releaseLocalStoreLock,
} from '../fleet/local-store-lock.js';
import {
  readImmutablePrivateRecords,
  recoverImmutablePrivateRecordStore,
  writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec,
  type ImmutablePrivateRecordReadOptions,
  type ImmutablePrivateRecordReadStopReason,
  type ImmutablePrivateRecordStoreConfig,
} from '../util/immutable-private-record-store.js';
import {
  compileExternalLocusWorkspaceIdentityObservationV1,
  EXTERNAL_LOCUS_WORKSPACE_IDENTITY_PROTOCOL,
  LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST,
  LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_FUTURE_SKEW_MS,
  LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_LIFETIME_MS,
  LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_SEQUENCE,
  type ExternalLocusWorkspaceIdentityObservationV1,
} from './external-locus-workspace-identity.js';
import {
  canonicalLocusBindingCapabilityBytesV1,
  LOCUS_BINDING_CAPABILITY_MIN_LIFETIME_MS,
  LOCUS_BINDING_CAPABILITY_PURPOSE,
  verifyLocusBindingCapabilityV1,
  type LocusBindingCapabilityV1,
  type LocusBindingCapabilityVerificationContextV1,
} from './locus-binding-capability.js';

const PROTOCOL = 'ashlr-locus-workspace-identity-ledger-v1' as const;
const RECORD_TYPE = 'locus-workspace-identity-ledger-record' as const;
const RECORD_DIGEST_DOMAIN = 'ashlr:locus-workspace-identity-ledger:record:v1\0';
const ATTESTATION_DOMAIN = 'ashlr:locus-workspace-identity-ledger:attestation:v1\0';
const CHAIN_KEY_DOMAIN = 'ashlr:locus-workspace-identity-ledger:chain-key:v1\0';
const STAGE_DOMAIN = 'ashlr:locus-workspace-identity-ledger:stage:v1\0';
const LOCUS_SOURCE_DIGEST_DOMAIN = 'ashlr:locus-workspace-identity-observation:v1\0';
const EXTERNAL_DIGEST_DOMAIN = 'ashlr:external-locus-workspace-identity-observation:v1\0';
const GENESIS_RECORD_DIGEST = `sha256:${'0'.repeat(64)}`;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const PLAIN_DIGEST_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const LOCUS_VERSION_RE = /^0\.5\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const RECORD_FILE_RE = /^[a-f0-9]{64}\.[0-9]{16}\.[a-f0-9]{64}\.json$/;
const MAX_RECORD_BYTES = 32 * 1024;
const MAX_RECORDS = 4_096;
const MAX_AGGREGATE_BYTES = 128 * 1024 * 1024;
const MAX_LOCK_WAIT_MS = 2_000;
const MAX_AGGREGATE_COUNT = 1_000_000;

export const LOCUS_WORKSPACE_IDENTITY_LEDGER_PROTOCOL = PROTOCOL;
export const LOCUS_WORKSPACE_IDENTITY_LEDGER_MAX_RECORDS = MAX_RECORDS;
export const LOCUS_WORKSPACE_IDENTITY_LEDGER_GENESIS_RECORD_DIGEST = GENESIS_RECORD_DIGEST;

export interface LocusWorkspaceIdentityChainV1 {
  audienceDigest: string;
  workspaceDigest: string;
}

export interface LocusWorkspaceIdentityLedgerDependenciesV1 {
  /** Existing trusted directory that directly contains rootPath. */
  anchorPath: string;
  rootPath: string;
  /** Existing 32-byte host provenance HMAC. This module never creates it. */
  key: Buffer | null;
  /** Hermetic capacity seam. Production leaves this unset. */
  maxRecords?: number;
  now?: () => Date;
}

export interface LocusWorkspaceIdentityLedgerRecordV1 {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  recordType: typeof RECORD_TYPE;
  authority: 'observation-only';
  effectAuthority: 'none';
  consistencyAssurance: 'host-authenticated-local-lineage-only';
  identityAssurance: 'opaque-digest-claim-only';
  attestationAuthority: 'host-shared-hmac';
  localIntegrityAuthenticated: true;
  verifierIsolated: false;
  sameUserTamperResistant: false;
  rollbackProtected: false;
  originAuthenticated: false;
  truthVerified: false;
  releaseProvenanceVerified: false;
  trusted: false;
  planningAuthority: false;
  executionAuthority: false;
  effectAuthorityGranted: false;
  proposalAuthority: false;
  routingAuthority: false;
  reservationAuthority: false;
  budgetAuthority: false;
  credentialAuthority: false;
  learningAuthority: false;
  policyAuthority: false;
  promotionAuthority: false;
  verificationAuthority: false;
  mergeAuthority: false;
  releaseAuthority: false;
  deployAuthority: false;
  publicationAuthority: false;
  externalMutationAuthority: false;
  policyEligible: false;
  promotionEligible: false;
  chainKey: string;
  audienceDigest: string;
  workspaceDigest: string;
  sequence: number;
  previousSourceObservationDigest: string;
  sourceObservationDigest: string;
  externalObservationDigest: string;
  acceptedAt: string;
  previousRecordDigest: string;
  bindingAdmission: LocusWorkspaceIdentityBindingAdmissionV1;
  observation: ExternalLocusWorkspaceIdentityObservationV1;
  recordDigest: string;
  attestation: string;
}

export type LocusWorkspaceIdentityBindingAdmissionV1 =
  | {
    mode: 'direct-unverified';
    capabilityId: null;
    purpose: null;
    policyGeneration: null;
    issuedAt: null;
    expiresAt: null;
  }
  | {
    mode: 'privacy-provenance-verified';
    capabilityId: string;
    purpose: typeof LOCUS_BINDING_CAPABILITY_PURPOSE;
    policyGeneration: number;
    issuedAt: string;
    expiresAt: string;
  };

export type LocusWorkspaceIdentityLedgerWriteDispositionV1 =
  | 'recorded'
  | 'invalid-capability'
  | 'invalid-observation'
  | 'cross-audience'
  | 'cross-workspace'
  | 'stale-observation'
  | 'future-observation'
  | 'observation-replay'
  | 'sequence-gap'
  | 'fork-detected'
  | 'predecessor-mismatch'
  | 'clock-regression'
  | 'capability-replay'
  | 'cross-capability-replay'
  | 'capability-expired'
  | 'capability-window-mismatch'
  | 'generation-mismatch'
  | 'unverified-lineage'
  | 'capacity-exhausted'
  | 'key-unavailable'
  | 'store-unavailable'
  | 'persistence-failed';

export type LocusWorkspaceIdentityLedgerWriteResultV1 =
  | { disposition: 'recorded'; record: LocusWorkspaceIdentityLedgerRecordV1 }
  | { disposition: Exclude<LocusWorkspaceIdentityLedgerWriteDispositionV1, 'recorded'>; record: null };

export type LocusWorkspaceIdentityLedgerStopReasonV1 =
  | ImmutablePrivateRecordReadStopReason
  | 'key-unavailable'
  | 'invalid-chain'
  | 'lineage-gap'
  | 'lineage-fork'
  | 'lineage-replay'
  | 'predecessor-mismatch'
  | 'clock-regression'
  | 'cross-chain-record'
  | 'capability-replay'
  | 'generation-mismatch'
  | 'unverified-lineage'
  | 'capacity-exhausted'
  | 'rollover-unimplemented';

export interface LocusWorkspaceIdentityLedgerReadResultV1 {
  records: LocusWorkspaceIdentityLedgerRecordV1[];
  tip: LocusWorkspaceIdentityLedgerRecordV1 | null;
  sourceState: 'missing' | 'healthy' | 'degraded';
  chainState: 'missing' | 'healthy' | 'degraded' | 'capacity-exhausted';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: LocusWorkspaceIdentityLedgerStopReasonV1[];
  filesRead: number;
  bytesRead: number;
  invalidFiles: number;
  limitExceeded: boolean;
  totalRecords: number;
  capacity: number;
  capacityExhausted: boolean;
  rollover: 'unimplemented';
  tipFresh: boolean;
  authority: 'observation-only';
  effectAuthority: 'none';
  originAuthenticated: false;
  truthVerified: false;
  releaseProvenanceVerified: false;
  trusted: false;
  planningAuthority: false;
  executionAuthority: false;
  policyEligible: false;
  promotionEligible: false;
}

const RECORD_KEYS = [
  'schemaVersion', 'protocol', 'recordType', 'authority', 'effectAuthority',
  'consistencyAssurance', 'identityAssurance', 'attestationAuthority',
  'localIntegrityAuthenticated', 'verifierIsolated', 'sameUserTamperResistant',
  'rollbackProtected', 'originAuthenticated', 'truthVerified',
  'releaseProvenanceVerified', 'trusted', 'planningAuthority', 'executionAuthority',
  'effectAuthorityGranted', 'proposalAuthority', 'routingAuthority',
  'reservationAuthority', 'budgetAuthority', 'credentialAuthority',
  'learningAuthority', 'policyAuthority', 'promotionAuthority',
  'verificationAuthority', 'mergeAuthority', 'releaseAuthority', 'deployAuthority',
  'publicationAuthority', 'externalMutationAuthority', 'policyEligible',
  'promotionEligible', 'chainKey', 'audienceDigest', 'workspaceDigest', 'sequence',
  'previousSourceObservationDigest', 'sourceObservationDigest',
  'externalObservationDigest', 'acceptedAt', 'previousRecordDigest', 'bindingAdmission', 'observation',
  'recordDigest', 'attestation',
] as const;

const EXTERNAL_KEYS = [
  'schemaVersion', 'protocol', 'recordType', 'authority', 'sourceState', 'verification',
  'canonicalBytesVerified', 'digestVerified', 'freshnessVerified', 'originAuthenticated',
  'truthVerified', 'releaseProvenanceVerified', 'trusted', 'producer', 'observedAt',
  'expiresAt', 'sequence', 'previousObservationDigest', 'audienceDigest',
  'workspaceDigest', 'sourceObservationDigest', 'reportedPosture', 'mcpRegistered',
  'adapterManifestDigest', 'phantomAvailable', 'unresolvedCredentials', 'approvalStore',
  'planningAuthority', 'executionAuthority', 'effectAuthority', 'proposalAuthority',
  'routingAuthority', 'reservationAuthority', 'budgetAuthority', 'credentialAuthority',
  'learningAuthority', 'policyAuthority', 'promotionAuthority', 'verificationAuthority',
  'mergeAuthority', 'releaseAuthority', 'deployAuthority', 'publicationAuthority',
  'externalMutationAuthority', 'policyEligible', 'promotionEligible', 'effects',
  'observationDigest',
] as const;

const FALSE_EXTERNAL_FLAGS = [
  'originAuthenticated', 'truthVerified', 'releaseProvenanceVerified', 'trusted',
  'planningAuthority', 'executionAuthority', 'effectAuthority', 'proposalAuthority',
  'routingAuthority', 'reservationAuthority', 'budgetAuthority', 'credentialAuthority',
  'learningAuthority', 'policyAuthority', 'promotionAuthority', 'verificationAuthority',
  'mergeAuthority', 'releaseAuthority', 'deployAuthority', 'publicationAuthority',
  'externalMutationAuthority', 'policyEligible', 'promotionEligible',
] as const;
const EFFECT_KEYS = [
  'files', 'models', 'providers', 'processes', 'network', 'credentials', 'secrets',
  'pins', 'approvals', 'dispatches', 'goals', 'proposals', 'merges', 'releases',
  'deployments', 'publications', 'externalMutations', 'budgets', 'learning',
] as const;
const RECORD_FALSE_FLAGS = [
  'verifierIsolated', 'sameUserTamperResistant', 'rollbackProtected',
  'originAuthenticated', 'truthVerified', 'releaseProvenanceVerified', 'trusted',
  'planningAuthority', 'executionAuthority', 'effectAuthorityGranted',
  'proposalAuthority', 'routingAuthority', 'reservationAuthority', 'budgetAuthority',
  'credentialAuthority', 'learningAuthority', 'policyAuthority', 'promotionAuthority',
  'verificationAuthority', 'mergeAuthority', 'releaseAuthority', 'deployAuthority',
  'publicationAuthority', 'externalMutationAuthority', 'policyEligible',
  'promotionEligible',
] as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type UnsignedRecord = Omit<LocusWorkspaceIdentityLedgerRecordV1, 'recordDigest' | 'attestation'>;

function object(value: unknown): Record<string, unknown> | null {
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

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonical(value: unknown, ancestors = new Set<object>(), depth = 0): Json {
  if (depth > 16) throw new TypeError('canonical depth exceeded');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('non-json value');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => canonical(entry, ancestors, depth + 1));
    const row = object(value);
    if (!row) throw new TypeError('non-plain object');
    return Object.fromEntries(Object.keys(row).sort().map((key) => [key, canonical(row[key], ancestors, depth + 1)]));
  } finally {
    ancestors.delete(value);
  }
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(canonical(value)), 'utf8');
}

function sha(domain: string, value: unknown): string {
  return `sha256:${createHash('sha256').update(domain, 'utf8').update(canonicalBytes(value)).digest('hex')}`;
}

function hmac(key: Buffer, domain: string, values: readonly unknown[]): string {
  return createHmac('sha256', key).update(domain, 'utf8').update(canonicalBytes(values)).digest('hex');
}

function same(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function safeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validExternalObservation(value: unknown): value is ExternalLocusWorkspaceIdentityObservationV1 {
  const row = object(value);
  if (!row || !exactKeys(row, EXTERNAL_KEYS) || row['schemaVersion'] !== 1 ||
    row['protocol'] !== EXTERNAL_LOCUS_WORKSPACE_IDENTITY_PROTOCOL ||
    row['recordType'] !== 'external-locus-workspace-identity-observation' ||
    row['authority'] !== 'observation-only' || row['sourceState'] !== 'local-unverified' ||
    row['verification'] !== 'canonical-digest-consistency-only' ||
    row['canonicalBytesVerified'] !== true || row['digestVerified'] !== true ||
    row['freshnessVerified'] !== true || FALSE_EXTERNAL_FLAGS.some((key) => row[key] !== false) ||
    !canonicalIso(row['observedAt']) || !canonicalIso(row['expiresAt']) ||
    !safeInteger(row['sequence'], 1, LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_SEQUENCE) ||
    typeof row['previousObservationDigest'] !== 'string' || !DIGEST_RE.test(row['previousObservationDigest']) ||
    typeof row['audienceDigest'] !== 'string' || !DIGEST_RE.test(row['audienceDigest']) ||
    typeof row['workspaceDigest'] !== 'string' || !DIGEST_RE.test(row['workspaceDigest']) ||
    typeof row['sourceObservationDigest'] !== 'string' || !DIGEST_RE.test(row['sourceObservationDigest']) ||
    typeof row['observationDigest'] !== 'string' || !DIGEST_RE.test(row['observationDigest']) ||
    (row['adapterManifestDigest'] !== null &&
      (typeof row['adapterManifestDigest'] !== 'string' || !DIGEST_RE.test(row['adapterManifestDigest']))) ||
    typeof row['phantomAvailable'] !== 'boolean' ||
    !safeInteger(row['unresolvedCredentials'], 0, MAX_AGGREGATE_COUNT)) return false;

  const producer = object(row['producer']);
  const posture = object(row['reportedPosture']);
  const policy = object(posture?.['workspacePolicy']);
  const mcp = object(row['mcpRegistered']);
  const approval = object(row['approvalStore']);
  const effects = object(row['effects']);
  if (!producer || !exactKeys(producer, ['product', 'version', 'commit']) ||
    producer['product'] !== 'locus' || typeof producer['version'] !== 'string' ||
    producer['version'].length > 32 || !LOCUS_VERSION_RE.test(producer['version']) ||
    typeof producer['commit'] !== 'string' ||
    !COMMIT_RE.test(producer['commit']) || !posture ||
    !exactKeys(posture, ['identity', 'pin', 'authorityAnchor', 'workspacePolicy']) ||
    typeof posture['identity'] !== 'string' || !['ready', 'protected', 'unsafe', 'unknown'].includes(posture['identity']) ||
    typeof posture['pin'] !== 'string' || !['absent', 'valid', 'frozen', 'expired', 'invalid', 'unknown'].includes(posture['pin']) ||
    typeof posture['authorityAnchor'] !== 'string' ||
    !['verified', 'unverified', 'unavailable'].includes(posture['authorityAnchor']) ||
    !policy || !exactKeys(policy, ['state', 'requirePin', 'pinAllowed']) ||
    typeof policy['state'] !== 'string' || !['valid', 'missing', 'invalid'].includes(policy['state']) ||
    typeof policy['requirePin'] !== 'boolean' ||
    (policy['pinAllowed'] !== null && typeof policy['pinAllowed'] !== 'boolean') ||
    !mcp || !exactKeys(mcp, ['claude', 'cursor', 'codex', 'grok']) ||
    Object.values(mcp).some((entry) => typeof entry !== 'boolean') ||
    !approval || !exactKeys(approval, ['state', 'pending', 'dualControlWaiting']) ||
    typeof approval['state'] !== 'string' || !['healthy', 'degraded', 'unavailable'].includes(approval['state']) ||
    !safeInteger(approval['pending'], 0, MAX_AGGREGATE_COUNT) ||
    !safeInteger(approval['dualControlWaiting'], 0, MAX_AGGREGATE_COUNT) ||
    Number(approval['dualControlWaiting']) > Number(approval['pending']) ||
    !effects || !exactKeys(effects, EFFECT_KEYS) || EFFECT_KEYS.some((key) => effects[key] !== false)) return false;

  if ((policy['state'] !== 'valid' &&
      (policy['requirePin'] !== false || policy['pinAllowed'] !== null)) ||
    (posture['identity'] === 'ready' && posture['pin'] !== 'valid') ||
    (posture['identity'] === 'ready' && !Object.values(mcp).some((entry) => entry === true)) ||
    (policy['state'] === 'invalid' && posture['identity'] !== 'unsafe') ||
    (posture['pin'] === 'valid' && posture['authorityAnchor'] === 'unavailable') ||
    (posture['pin'] === 'absent' && posture['authorityAnchor'] !== 'unavailable') ||
    (approval['state'] === 'unavailable' &&
      (approval['pending'] !== 0 || approval['dualControlWaiting'] !== 0)) ||
    (posture['authorityAnchor'] === 'verified' &&
      (posture['pin'] === 'absent' || posture['pin'] === 'unknown'))) return false;

  const observedAt = Date.parse(row['observedAt'] as string);
  const expiresAt = Date.parse(row['expiresAt'] as string);
  if (expiresAt <= observedAt || expiresAt - observedAt > LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_LIFETIME_MS ||
    (row['sequence'] === 1 && row['previousObservationDigest'] !== LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST) ||
    (Number(row['sequence']) > 1 && row['previousObservationDigest'] === LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST)) return false;

  const sourceUnsigned = {
    schemaVersion: 1,
    protocol: 'ashlr-locus-workspace-identity-observation-v1',
    recordType: 'locus-workspace-identity-observation',
    authority: 'observation_only',
    sourceState: 'local_unverified',
    privacyClass: 'metadata_only',
    planningAuthority: false,
    executionAuthority: false,
    effectAuthority: false,
    producer: row['producer'],
    observedAt: row['observedAt'],
    expiresAt: row['expiresAt'],
    sequence: row['sequence'],
    previousObservationDigest: row['previousObservationDigest'],
    audienceDigest: row['audienceDigest'],
    workspaceDigest: row['workspaceDigest'],
    identityPosture: posture['identity'],
    pinPosture: posture['pin'],
    authorityAnchor: posture['authorityAnchor'],
    workspacePolicy: posture['workspacePolicy'],
    mcpRegistered: row['mcpRegistered'],
    adapterManifestDigest: row['adapterManifestDigest'],
    phantomAvailable: row['phantomAvailable'],
    unresolvedCredentials: row['unresolvedCredentials'],
    approvalStore: row['approvalStore'],
    effects: {
      files: false,
      providers: false,
      credentials: false,
      pins: false,
      approvals: false,
      dispatches: false,
      proposals: false,
      merges: false,
      releases: false,
      deployments: false,
      publications: false,
      externalMutations: false,
      budgets: false,
      learning: false,
    },
  };
  if (!same(row['sourceObservationDigest'], sha(LOCUS_SOURCE_DIGEST_DOMAIN, sourceUnsigned))) return false;

  const unsigned = { ...row };
  delete unsigned['observationDigest'];
  return same(row['observationDigest'], sha(EXTERNAL_DIGEST_DOMAIN, unsigned));
}

function validChain(value: unknown): value is LocusWorkspaceIdentityChainV1 {
  const row = object(value);
  return Boolean(row && exactKeys(row, ['audienceDigest', 'workspaceDigest']) &&
    typeof row['audienceDigest'] === 'string' && DIGEST_RE.test(row['audienceDigest']) &&
    typeof row['workspaceDigest'] === 'string' && DIGEST_RE.test(row['workspaceDigest']));
}

function validDependencies(value: LocusWorkspaceIdentityLedgerDependenciesV1): boolean {
  try {
    const anchor = resolve(value.anchorPath);
    const root = resolve(value.rootPath);
    const capacity = value.maxRecords ?? MAX_RECORDS;
    return isAbsolute(anchor) && isAbsolute(root) && anchor !== parse(anchor).root &&
      dirname(root) === anchor && Number.isSafeInteger(capacity) && capacity > 0 && capacity <= MAX_RECORDS &&
      (value.key === null || (Buffer.isBuffer(value.key) && value.key.length === 32)) &&
      (value.now === undefined || typeof value.now === 'function');
  } catch {
    return false;
  }
}

function chainKey(chain: LocusWorkspaceIdentityChainV1, key: Buffer): string {
  return hmac(key, CHAIN_KEY_DOMAIN, [chain.audienceDigest, chain.workspaceDigest]);
}

const RECORD_ASSURANCE = Object.freeze({
  authority: 'observation-only' as const,
  effectAuthority: 'none' as const,
  consistencyAssurance: 'host-authenticated-local-lineage-only' as const,
  identityAssurance: 'opaque-digest-claim-only' as const,
  attestationAuthority: 'host-shared-hmac' as const,
  localIntegrityAuthenticated: true as const,
  verifierIsolated: false as const,
  sameUserTamperResistant: false as const,
  rollbackProtected: false as const,
  originAuthenticated: false as const,
  truthVerified: false as const,
  releaseProvenanceVerified: false as const,
  trusted: false as const,
  planningAuthority: false as const,
  executionAuthority: false as const,
  effectAuthorityGranted: false as const,
  proposalAuthority: false as const,
  routingAuthority: false as const,
  reservationAuthority: false as const,
  budgetAuthority: false as const,
  credentialAuthority: false as const,
  learningAuthority: false as const,
  policyAuthority: false as const,
  promotionAuthority: false as const,
  verificationAuthority: false as const,
  mergeAuthority: false as const,
  releaseAuthority: false as const,
  deployAuthority: false as const,
  publicationAuthority: false as const,
  externalMutationAuthority: false as const,
  policyEligible: false as const,
  promotionEligible: false as const,
});

const DIRECT_UNVERIFIED_ADMISSION = Object.freeze({
  mode: 'direct-unverified' as const,
  capabilityId: null,
  purpose: null,
  policyGeneration: null,
  issuedAt: null,
  expiresAt: null,
});

function validBindingAdmission(value: unknown): value is LocusWorkspaceIdentityBindingAdmissionV1 {
  const row = object(value);
  if (!row || !exactKeys(row, [
    'mode', 'capabilityId', 'purpose', 'policyGeneration', 'issuedAt', 'expiresAt',
  ])) return false;
  if (row['mode'] === 'direct-unverified') {
    return row['capabilityId'] === null && row['purpose'] === null &&
      row['policyGeneration'] === null && row['issuedAt'] === null && row['expiresAt'] === null;
  }
  if (row['mode'] !== 'privacy-provenance-verified' ||
      typeof row['capabilityId'] !== 'string' || !/^hmac-sha256:[a-f0-9]{64}$/.test(row['capabilityId']) ||
      row['purpose'] !== LOCUS_BINDING_CAPABILITY_PURPOSE ||
      !safeInteger(row['policyGeneration'], 1, Number.MAX_SAFE_INTEGER) ||
      !canonicalIso(row['issuedAt']) || !canonicalIso(row['expiresAt'])) return false;
  const issuedAt = Date.parse(row['issuedAt']);
  const expiresAt = Date.parse(row['expiresAt']);
  return expiresAt > issuedAt &&
    expiresAt - issuedAt >= LOCUS_BINDING_CAPABILITY_MIN_LIFETIME_MS &&
    expiresAt - issuedAt <= LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_LIFETIME_MS;
}

function sealRecord(
  observation: ExternalLocusWorkspaceIdentityObservationV1,
  previousRecordDigest: string,
  acceptedAt: string,
  key: Buffer,
  bindingAdmission: LocusWorkspaceIdentityBindingAdmissionV1 = DIRECT_UNVERIFIED_ADMISSION,
): LocusWorkspaceIdentityLedgerRecordV1 {
  const chain = { audienceDigest: observation.audienceDigest, workspaceDigest: observation.workspaceDigest };
  const unsigned: UnsignedRecord = {
    schemaVersion: 1,
    protocol: PROTOCOL,
    recordType: RECORD_TYPE,
    ...RECORD_ASSURANCE,
    chainKey: chainKey(chain, key),
    ...chain,
    sequence: observation.sequence,
    previousSourceObservationDigest: observation.previousObservationDigest,
    sourceObservationDigest: observation.sourceObservationDigest,
    externalObservationDigest: observation.observationDigest,
    acceptedAt,
    previousRecordDigest,
    bindingAdmission: clone(bindingAdmission),
    observation: clone(observation),
  };
  const recordDigest = sha(RECORD_DIGEST_DOMAIN, unsigned);
  return deepFreeze({
    ...unsigned,
    recordDigest,
    attestation: hmac(key, ATTESTATION_DOMAIN, [recordDigest, unsigned.chainKey, unsigned.sequence]),
  });
}

function reconstructRecord(value: unknown, key: Buffer): LocusWorkspaceIdentityLedgerRecordV1 | null {
  const row = object(value);
  if (!row || key.length !== 32 || !exactKeys(row, RECORD_KEYS) || row['schemaVersion'] !== 1 ||
    row['protocol'] !== PROTOCOL || row['recordType'] !== RECORD_TYPE ||
    row['authority'] !== 'observation-only' || row['effectAuthority'] !== 'none' ||
    row['consistencyAssurance'] !== 'host-authenticated-local-lineage-only' ||
    row['identityAssurance'] !== 'opaque-digest-claim-only' ||
    row['attestationAuthority'] !== 'host-shared-hmac' || row['localIntegrityAuthenticated'] !== true ||
    RECORD_FALSE_FLAGS.some((flag) => row[flag] !== false) ||
    typeof row['chainKey'] !== 'string' || !PLAIN_DIGEST_RE.test(row['chainKey']) ||
    typeof row['audienceDigest'] !== 'string' || !DIGEST_RE.test(row['audienceDigest']) ||
    typeof row['workspaceDigest'] !== 'string' || !DIGEST_RE.test(row['workspaceDigest']) ||
    !safeInteger(row['sequence'], 1, LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_SEQUENCE) ||
    typeof row['previousSourceObservationDigest'] !== 'string' || !DIGEST_RE.test(row['previousSourceObservationDigest']) ||
    typeof row['sourceObservationDigest'] !== 'string' || !DIGEST_RE.test(row['sourceObservationDigest']) ||
    typeof row['externalObservationDigest'] !== 'string' || !DIGEST_RE.test(row['externalObservationDigest']) ||
    typeof row['previousRecordDigest'] !== 'string' || !DIGEST_RE.test(row['previousRecordDigest']) ||
    typeof row['recordDigest'] !== 'string' || !DIGEST_RE.test(row['recordDigest']) ||
    typeof row['attestation'] !== 'string' || !PLAIN_DIGEST_RE.test(row['attestation']) ||
    !canonicalIso(row['acceptedAt']) || !validBindingAdmission(row['bindingAdmission']) ||
    !validExternalObservation(row['observation'])) return null;
  const observation = row['observation'];
  const admission = row['bindingAdmission'];
  const expectedChainKey = chainKey({
    audienceDigest: row['audienceDigest'],
    workspaceDigest: row['workspaceDigest'],
  }, key);
  if (!same(row['chainKey'], expectedChainKey) || observation.sequence !== row['sequence'] ||
    !same(observation.audienceDigest, row['audienceDigest']) ||
    !same(observation.workspaceDigest, row['workspaceDigest']) ||
    !same(observation.previousObservationDigest, row['previousSourceObservationDigest']) ||
    !same(observation.sourceObservationDigest, row['sourceObservationDigest']) ||
    !same(observation.observationDigest, row['externalObservationDigest']) ||
    (admission.mode === 'privacy-provenance-verified' &&
      (Date.parse(observation.observedAt) < Date.parse(admission.issuedAt) ||
       Date.parse(observation.expiresAt) > Date.parse(admission.expiresAt)))) return null;
  const unsigned = { ...row };
  delete unsigned['recordDigest'];
  delete unsigned['attestation'];
  const expectedDigest = sha(RECORD_DIGEST_DOMAIN, unsigned);
  const expectedAttestation = hmac(key, ATTESTATION_DOMAIN, [expectedDigest, expectedChainKey, row['sequence']]);
  if (!same(row['recordDigest'], expectedDigest) || !same(row['attestation'], expectedAttestation)) return null;
  return deepFreeze(clone(row as unknown as LocusWorkspaceIdentityLedgerRecordV1));
}

function codec(key: Buffer): ImmutablePrivateRecordCodec<LocusWorkspaceIdentityLedgerRecordV1> {
  return {
    parse: (value) => reconstructRecord(value, key),
    serialize: (record) => `${JSON.stringify(record)}\n`,
    recordId: (record) => record.recordDigest.slice(7),
    recordFileName: (record) => `${record.chainKey}.${String(record.sequence).padStart(16, '0')}.${record.sourceObservationDigest.slice(7)}.json`,
    isRecordFileName: (fileName) => RECORD_FILE_RE.test(fileName),
    stageToken: (record) => hmac(key, STAGE_DOMAIN, [record.recordDigest]).slice(0, 32),
    equivalent: (left, right) => same(left.recordDigest, right.recordDigest) && same(left.attestation, right.attestation),
    compare: (left, right) => left.chainKey.localeCompare(right.chainKey) ||
      left.sequence - right.sequence || left.sourceObservationDigest.localeCompare(right.sourceObservationDigest),
  };
}

function capacity(dependencies: LocusWorkspaceIdentityLedgerDependenciesV1): number {
  return dependencies.maxRecords ?? MAX_RECORDS;
}

function config(
  dependencies: LocusWorkspaceIdentityLedgerDependenciesV1,
): ImmutablePrivateRecordStoreConfig<LocusWorkspaceIdentityLedgerRecordV1> {
  const maxRecords = capacity(dependencies);
  return {
    label: 'Locus workspace identity ledger',
    anchorPath: dependencies.anchorPath,
    rootPath: dependencies.rootPath,
    lockFileName: '.locus-identity-ledger.lock',
    maxRecordBytes: MAX_RECORD_BYTES,
    defaultMaxFiles: maxRecords,
    hardMaxFiles: maxRecords,
    defaultMaxBytes: MAX_AGGREGATE_BYTES,
    hardMaxBytes: MAX_AGGREGATE_BYTES,
    codecForWrite: () => dependencies.key?.length === 32 ? codec(dependencies.key) : null,
    codecForRead: () => dependencies.key?.length === 32 ? codec(dependencies.key) : null,
  };
}

export function locusWorkspaceIdentityLedgerRootPathV1(): string {
  return resolve(join(homedir(), '.ashlr', 'locus-workspace-identity-ledger-v1'));
}

/** Uses only the strict read-only key path for reads and writes; never provisions a key. */
export function defaultLocusWorkspaceIdentityLedgerDependenciesV1(): LocusWorkspaceIdentityLedgerDependenciesV1 | null {
  try {
    const home = resolve(homedir());
    if (!isAbsolute(home) || home === parse(home).root) return null;
    const anchorPath = join(home, '.ashlr');
    const key = loadExistingProvenanceKeyReadOnly();
    return {
      anchorPath,
      rootPath: join(anchorPath, 'locus-workspace-identity-ledger-v1'),
      key: key?.length === 32 ? key : null,
    };
  } catch {
    return null;
  }
}

function validateLineage(
  records: readonly LocusWorkspaceIdentityLedgerRecordV1[],
): LocusWorkspaceIdentityLedgerStopReasonV1[] {
  const reasons = new Set<LocusWorkspaceIdentityLedgerStopReasonV1>();
  const groups = new Map<string, LocusWorkspaceIdentityLedgerRecordV1[]>();
  const capabilityIds = new Set<string>();
  for (const entry of records) {
    if (entry.bindingAdmission.mode === 'privacy-provenance-verified') {
      if (capabilityIds.has(entry.bindingAdmission.capabilityId)) reasons.add('capability-replay');
      capabilityIds.add(entry.bindingAdmission.capabilityId);
    }
    const exact = `${entry.audienceDigest}\0${entry.workspaceDigest}`;
    const current = groups.get(exact) ?? [];
    current.push(entry);
    groups.set(exact, current);
  }
  for (const entries of groups.values()) {
    entries.sort((left, right) => left.sequence - right.sequence || left.recordDigest.localeCompare(right.recordDigest));
    const sourceDigests = new Set<string>();
    for (let index = 0; index < entries.length; index += 1) {
      const current = entries[index]!;
      const previous = entries[index - 1];
      if (sourceDigests.has(current.sourceObservationDigest)) reasons.add('lineage-replay');
      sourceDigests.add(current.sourceObservationDigest);
      if (!previous) {
        if (current.sequence !== 1) reasons.add('lineage-gap');
        if (current.previousSourceObservationDigest !== LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST ||
          current.previousRecordDigest !== GENESIS_RECORD_DIGEST) reasons.add('predecessor-mismatch');
        continue;
      }
      if (current.sequence === previous.sequence) reasons.add('lineage-fork');
      else if (current.sequence !== previous.sequence + 1) reasons.add('lineage-gap');
      if (!same(current.previousSourceObservationDigest, previous.sourceObservationDigest) ||
        !same(current.previousRecordDigest, previous.recordDigest)) reasons.add('predecessor-mismatch');
      if (Date.parse(current.observation.observedAt) < Date.parse(previous.observation.observedAt) ||
        Date.parse(current.acceptedAt) < Date.parse(previous.acceptedAt)) reasons.add('clock-regression');
      if (current.bindingAdmission.mode !== previous.bindingAdmission.mode) reasons.add('unverified-lineage');
      if (current.bindingAdmission.mode === 'privacy-provenance-verified' &&
          previous.bindingAdmission.mode === 'privacy-provenance-verified' &&
          current.bindingAdmission.policyGeneration !== previous.bindingAdmission.policyGeneration) {
        reasons.add('generation-mismatch');
      }
    }
  }
  return [...reasons];
}

function readAssurance() {
  return {
    authority: 'observation-only' as const,
    effectAuthority: 'none' as const,
    originAuthenticated: false as const,
    truthVerified: false as const,
    releaseProvenanceVerified: false as const,
    trusted: false as const,
    planningAuthority: false as const,
    executionAuthority: false as const,
    policyEligible: false as const,
    promotionEligible: false as const,
  };
}

function emptyRead(
  chainState: LocusWorkspaceIdentityLedgerReadResultV1['chainState'],
  reasons: LocusWorkspaceIdentityLedgerStopReasonV1[],
  capacityValue = MAX_RECORDS,
): LocusWorkspaceIdentityLedgerReadResultV1 {
  return deepFreeze({
    records: [], tip: null, sourceState: chainState === 'missing' ? 'missing' as const : 'degraded' as const,
    chainState, sourcePresent: false, complete: chainState === 'missing', stopReasons: reasons,
    filesRead: 0, bytesRead: 0, invalidFiles: 0, limitExceeded: false, totalRecords: 0,
    capacity: capacityValue, capacityExhausted: false, rollover: 'unimplemented' as const,
    tipFresh: false, ...readAssurance(),
  });
}

export function readLocusWorkspaceIdentityLedgerV1(
  chain: LocusWorkspaceIdentityChainV1,
  dependencies: LocusWorkspaceIdentityLedgerDependenciesV1 | null =
    defaultLocusWorkspaceIdentityLedgerDependenciesV1(),
  options: ImmutablePrivateRecordReadOptions = {},
): LocusWorkspaceIdentityLedgerReadResultV1 {
  if (!validChain(chain)) return emptyRead('degraded', ['invalid-chain']);
  if (!dependencies || !validDependencies(dependencies)) return emptyRead('degraded', ['invalid-options']);
  const maxRecords = capacity(dependencies);
  if (!dependencies.key) return emptyRead('degraded', ['key-unavailable'], maxRecords);
  const raw = readImmutablePrivateRecords(config(dependencies), { ...options, requireComplete: false });
  if (raw.sourceState === 'missing') return deepFreeze({
    ...raw, records: [], tip: null, chainState: 'missing' as const, totalRecords: 0,
    capacity: maxRecords, capacityExhausted: false, rollover: 'unimplemented' as const,
    tipFresh: false, ...readAssurance(),
  });

  const lineageReasons = validateLineage(raw.records);
  const selected = raw.records.filter((entry) =>
    same(entry.audienceDigest, chain.audienceDigest) && same(entry.workspaceDigest, chain.workspaceDigest));
  const capacityExhausted = raw.records.length >= maxRecords;
  const stopReasons = [...new Set<LocusWorkspaceIdentityLedgerStopReasonV1>([
    ...raw.stopReasons,
    ...lineageReasons,
    ...(capacityExhausted ? ['capacity-exhausted' as const, 'rollover-unimplemented' as const] : []),
  ])];
  const degraded = raw.sourceState === 'degraded' || stopReasons.length > 0;
  const visible = degraded && options.requireComplete === true ? [] : selected;
  const tip = visible.at(-1) ?? null;
  let now = Number.NaN;
  try { now = (dependencies.now?.() ?? new Date()).getTime(); } catch { /* invalid clock is not fresh */ }
  return deepFreeze({
    ...raw,
    records: clone(visible),
    tip: tip ? clone(tip) : null,
    sourceState: degraded ? 'degraded' as const : 'healthy' as const,
    chainState: capacityExhausted ? 'capacity-exhausted' as const :
      degraded ? 'degraded' as const : selected.length === 0 ? 'missing' as const : 'healthy' as const,
    complete: !degraded,
    stopReasons,
    totalRecords: raw.records.length,
    capacity: maxRecords,
    capacityExhausted,
    rollover: 'unimplemented' as const,
    tipFresh: Boolean(tip && Number.isFinite(now) &&
      Date.parse(tip.observation.expiresAt) > now &&
      Date.parse(tip.observation.observedAt) <= now + LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_FUTURE_SKEW_MS),
    ...readAssurance(),
  });
}

function boundedLockWait(value: number | undefined): number | null {
  if (value === undefined) return MAX_LOCK_WAIT_MS;
  return Number.isFinite(value) ? Math.max(0, Math.min(MAX_LOCK_WAIT_MS, Math.floor(value))) : null;
}

function nowOf(dependencies: LocusWorkspaceIdentityLedgerDependenciesV1): Date | null {
  try {
    const now = dependencies.now?.() ?? new Date();
    return now instanceof Date && Number.isFinite(now.getTime()) ? now : null;
  } catch {
    return null;
  }
}

function failure(
  disposition: Exclude<LocusWorkspaceIdentityLedgerWriteDispositionV1, 'recorded'>,
): LocusWorkspaceIdentityLedgerWriteResultV1 {
  return deepFreeze({ disposition, record: null });
}

export function appendLocusWorkspaceIdentityObservationV1(
  chain: LocusWorkspaceIdentityChainV1,
  observation: ExternalLocusWorkspaceIdentityObservationV1,
  dependencies: LocusWorkspaceIdentityLedgerDependenciesV1 | null =
    defaultLocusWorkspaceIdentityLedgerDependenciesV1(),
  options: { lockWaitMs?: number } = {},
): LocusWorkspaceIdentityLedgerWriteResultV1 {
  return appendLocusWorkspaceIdentityObservationInternalV1(
    chain, observation, dependencies, options, DIRECT_UNVERIFIED_ADMISSION,
  );
}

interface VerifiedAdmissionControlV1 {
  admission: Extract<LocusWorkspaceIdentityBindingAdmissionV1, { mode: 'privacy-provenance-verified' }>;
  verifyAt: (now: Date, key: Buffer) => boolean;
}

function appendLocusWorkspaceIdentityObservationInternalV1(
  chain: LocusWorkspaceIdentityChainV1,
  observation: ExternalLocusWorkspaceIdentityObservationV1,
  dependencies: LocusWorkspaceIdentityLedgerDependenciesV1 | null,
  options: { lockWaitMs?: number },
  admission: LocusWorkspaceIdentityBindingAdmissionV1,
  verifiedControl?: VerifiedAdmissionControlV1,
): LocusWorkspaceIdentityLedgerWriteResultV1 {
  if (!validChain(chain) || !validExternalObservation(observation)) return failure('invalid-observation');
  if (!validBindingAdmission(admission)) return failure('invalid-observation');
  if ((admission.mode === 'privacy-provenance-verified') !== Boolean(verifiedControl) ||
      (verifiedControl && verifiedControl.admission !== admission)) return failure('invalid-observation');
  if (!same(chain.audienceDigest, observation.audienceDigest)) return failure('cross-audience');
  if (!same(chain.workspaceDigest, observation.workspaceDigest)) return failure('cross-workspace');
  if (!dependencies || !validDependencies(dependencies)) return failure('store-unavailable');
  if (!dependencies.key) return failure('key-unavailable');
  const acceptedObservation = deepFreeze(clone(observation));
  const operationDependencies: LocusWorkspaceIdentityLedgerDependenciesV1 = {
    ...dependencies,
    key: Buffer.from(dependencies.key),
  };
  const now = nowOf(operationDependencies);
  const lockWaitMs = boundedLockWait(options.lockWaitMs);
  if (!now || lockWaitMs === null) return failure('store-unavailable');
  if (verifiedControl && !verifiedControl.verifyAt(now, operationDependencies.key!)) {
    return failure(Date.parse(admission.expiresAt!) <= now.getTime() ? 'capability-expired' : 'invalid-observation');
  }
  if (Date.parse(acceptedObservation.expiresAt) <= now.getTime()) return failure('stale-observation');
  if (Date.parse(acceptedObservation.observedAt) > now.getTime() + LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_FUTURE_SKEW_MS) {
    return failure('future-observation');
  }
  if (!existsSync(operationDependencies.anchorPath)) return failure('store-unavailable');

  const transactionLock = acquireLocalStoreLock(
    join(operationDependencies.anchorPath, '.locus-workspace-identity-ledger-transaction.lock'),
    lockWaitMs,
    { anchorPath: operationDependencies.anchorPath, exactPrivateStorage: true },
  );
  if (!transactionLock) return failure('store-unavailable');

  const performAppend = (): LocusWorkspaceIdentityLedgerWriteResultV1 => {
    const recovery = recoverImmutablePrivateRecordStore(config(operationDependencies), { lockWaitMs });
    if (recovery === 'invalid' || recovery === 'failed') return failure('store-unavailable');
    const read = readLocusWorkspaceIdentityLedgerV1(chain, operationDependencies, { requireComplete: true });
    if (read.capacityExhausted) return failure('capacity-exhausted');
    if (read.sourceState === 'degraded') return failure('store-unavailable');
    if (admission.mode === 'privacy-provenance-verified' && read.records.some((entry) =>
      entry.bindingAdmission.mode === 'privacy-provenance-verified' &&
      same(entry.bindingAdmission.capabilityId, admission.capabilityId))) {
      return failure('capability-replay');
    }
    const existingSource = read.records.find((entry) =>
      same(entry.sourceObservationDigest, acceptedObservation.sourceObservationDigest) ||
      same(entry.externalObservationDigest, acceptedObservation.observationDigest));
    if (existingSource) {
      if (admission.mode === 'privacy-provenance-verified' &&
          existingSource.bindingAdmission.mode === 'privacy-provenance-verified' &&
          !same(existingSource.bindingAdmission.capabilityId, admission.capabilityId)) {
        return failure('cross-capability-replay');
      }
      return failure('observation-replay');
    }
    const tip = read.tip;
    if (!tip) {
      if (acceptedObservation.sequence !== 1) return failure('sequence-gap');
      if (acceptedObservation.previousObservationDigest !== LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST) {
        return failure('predecessor-mismatch');
      }
    } else {
      if (admission.mode !== tip.bindingAdmission.mode) {
        return failure('unverified-lineage');
      }
      if (admission.mode === 'privacy-provenance-verified' &&
          tip.bindingAdmission.mode === 'privacy-provenance-verified' &&
          admission.policyGeneration !== tip.bindingAdmission.policyGeneration) {
        return failure('generation-mismatch');
      }
      if (acceptedObservation.sequence <= tip.sequence) return failure('fork-detected');
      if (acceptedObservation.sequence !== tip.sequence + 1) return failure('sequence-gap');
      if (!same(acceptedObservation.previousObservationDigest, tip.sourceObservationDigest)) {
        return failure('predecessor-mismatch');
      }
      if (Date.parse(acceptedObservation.observedAt) < Date.parse(tip.observation.observedAt) ||
        now.getTime() < Date.parse(tip.acceptedAt)) return failure('clock-regression');
    }
    const sealed = sealRecord(
      acceptedObservation,
      tip?.recordDigest ?? GENESIS_RECORD_DIGEST,
      now.toISOString(),
      operationDependencies.key!,
      admission,
    );
    let finalGuardFailure: 'stale-observation' | 'future-observation' |
      'capability-expired' | 'persistence-failed' | null = null;
    const write = writeImmutablePrivateRecord(config(operationDependencies), sealed, {
      lockWaitMs,
      prepublish: () => {
        if (!ownsLocalStoreLock(transactionLock)) {
          finalGuardFailure = 'persistence-failed';
          return false;
        }
        const commitNow = nowOf(operationDependencies);
        if (!commitNow) {
          finalGuardFailure = 'persistence-failed';
          return false;
        }
        if (verifiedControl && !verifiedControl.verifyAt(commitNow, operationDependencies.key!)) {
          finalGuardFailure = Date.parse(admission.expiresAt!) <= commitNow.getTime()
            ? 'capability-expired'
            : 'persistence-failed';
          return false;
        }
        if (Date.parse(acceptedObservation.expiresAt) <= commitNow.getTime()) {
          finalGuardFailure = 'stale-observation';
          return false;
        }
        if (Date.parse(acceptedObservation.observedAt) >
          commitNow.getTime() + LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_FUTURE_SKEW_MS) {
          finalGuardFailure = 'future-observation';
          return false;
        }
        return true;
      },
    });
    if (write === 'recorded') return deepFreeze({ disposition: 'recorded', record: sealed });
    if (finalGuardFailure) return failure(finalGuardFailure);
    if (write === 'replayed') return failure('observation-replay');
    return failure('persistence-failed');
  };

  let outcome: LocusWorkspaceIdentityLedgerWriteResultV1;
  try {
    outcome = performAppend();
  } catch {
    outcome = failure('persistence-failed');
  }
  return releaseLocalStoreLock(transactionLock)
    ? outcome
    : failure('persistence-failed');
}

export function verifyLocusWorkspaceIdentityLedgerRecordV1(
  value: unknown,
  key: Buffer | null,
): LocusWorkspaceIdentityLedgerRecordV1 | null {
  return key?.length === 32 ? reconstructRecord(value, key) : null;
}

export interface AdmitLocusWorkspaceIdentityObservationInputV1 {
  capabilityBytes: Uint8Array;
  capabilityContext: LocusBindingCapabilityVerificationContextV1;
  observationBytes: Uint8Array;
}

function canonicalCapabilityFromBytes(bytes: Uint8Array): LocusBindingCapabilityV1 | null {
  if (!(bytes instanceof Uint8Array)) return null;
  try {
    const owned = Buffer.from(bytes);
    const parsed = JSON.parse(owned.toString('utf8')) as unknown;
    const canonical = canonicalLocusBindingCapabilityBytesV1(parsed);
    return canonical?.equals(owned) ? parsed as LocusBindingCapabilityV1 : null;
  } catch {
    return null;
  }
}

/**
 * The only admission path that establishes privacy-safe binding provenance.
 * It verifies M549 canonical bytes, feeds only their four inert expectations
 * into M547, and commits both the observation and capability provenance through
 * the existing M548 transaction. The lower-level append remains available for
 * explicitly `direct-unverified` records and grants no provenance or authority.
 */
export function admitLocusWorkspaceIdentityObservationV1(
  input: AdmitLocusWorkspaceIdentityObservationInputV1,
  dependencies: LocusWorkspaceIdentityLedgerDependenciesV1 | null =
    defaultLocusWorkspaceIdentityLedgerDependenciesV1(),
  options: { lockWaitMs?: number } = {},
): LocusWorkspaceIdentityLedgerWriteResultV1 {
  const row = object(input);
  if (!row || !exactKeys(row, ['capabilityBytes', 'capabilityContext', 'observationBytes']) ||
      !(row['capabilityBytes'] instanceof Uint8Array) || !(row['observationBytes'] instanceof Uint8Array)) {
    return failure('invalid-capability');
  }
  const capabilityBytes = Buffer.from(row['capabilityBytes']);
  const observationBytes = Buffer.from(row['observationBytes']);
  const capability = canonicalCapabilityFromBytes(capabilityBytes);
  if (!capability) return failure('invalid-capability');
  const context = object(row['capabilityContext']);
  if (!context || !exactKeys(context, ['capabilityId', 'purpose', 'policyGeneration'])) {
    return failure('invalid-capability');
  }
  if (context['policyGeneration'] !== capability.policyGeneration) return failure('generation-mismatch');
  const capabilityContext = deepFreeze({
    capabilityId: context['capabilityId'] as string,
    purpose: context['purpose'] as typeof LOCUS_BINDING_CAPABILITY_PURPOSE,
    policyGeneration: context['policyGeneration'] as number,
  });
  if (!dependencies || !validDependencies(dependencies)) return failure('store-unavailable');
  if (!dependencies.key) return failure('key-unavailable');
  const operationDependencies: LocusWorkspaceIdentityLedgerDependenciesV1 = {
    ...dependencies,
    key: Buffer.from(dependencies.key),
  };
  const now = nowOf(operationDependencies);
  if (!now) return failure('store-unavailable');
  const verification = verifyLocusBindingCapabilityV1(
    capabilityBytes,
    capabilityContext,
    { key: () => operationDependencies.key, now: () => now },
  );
  if (!verification.ok) {
    return failure(verification.issue === 'expired-capability' ? 'capability-expired' : 'invalid-capability');
  }
  const compiled = compileExternalLocusWorkspaceIdentityObservationV1(
    observationBytes, verification.expectations, now,
  );
  if (!compiled.ok) return failure('invalid-observation');
  if (Date.parse(compiled.observation.observedAt) < Date.parse(capability.issuedAt) ||
      Date.parse(compiled.observation.expiresAt) > Date.parse(capability.expiresAt)) {
    return failure('capability-window-mismatch');
  }
  const admission = deepFreeze({
    mode: 'privacy-provenance-verified' as const,
    capabilityId: capability.capabilityId,
    purpose: LOCUS_BINDING_CAPABILITY_PURPOSE,
    policyGeneration: capability.policyGeneration,
    issuedAt: capability.issuedAt,
    expiresAt: capability.expiresAt,
  });
  const verifyAt = (commitNow: Date, key: Buffer): boolean => {
    const fresh = verifyLocusBindingCapabilityV1(capabilityBytes, capabilityContext, {
      key: () => key,
      now: () => commitNow,
    });
    return fresh.ok && same(fresh.expectations.audienceDigest, verification.expectations.audienceDigest) &&
      same(fresh.expectations.workspaceDigest, verification.expectations.workspaceDigest) &&
      fresh.expectations.sequence === verification.expectations.sequence &&
      same(fresh.expectations.previousObservationDigest, verification.expectations.previousObservationDigest);
  };
  return appendLocusWorkspaceIdentityObservationInternalV1(
    {
      audienceDigest: verification.expectations.audienceDigest,
      workspaceDigest: verification.expectations.workspaceDigest,
    },
    compiled.observation,
    operationDependencies,
    options,
    admission,
    { admission, verifyAt },
  );
}
