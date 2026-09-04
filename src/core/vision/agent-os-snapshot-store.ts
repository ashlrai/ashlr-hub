/**
 * Authenticated, append-only persistence for Agent OS read-model snapshots.
 *
 * This module is deliberately internal. It grants no runtime authority and is
 * absent from public API exports. Immutable records use the shared hardened
 * private-record store; the default authenticator reuses the existing foundry
 * provenance key rather than creating another credential store.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  type BigIntStats,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

import {
  loadExistingProvenanceKey,
  loadExistingProvenanceKeyReadOnly,
} from '../foundry/provenance.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import {
  readImmutablePrivateRecords,
  recoverImmutablePrivateRecordStore,
  writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec,
  type ImmutablePrivateRecordReadStopReason,
  type ImmutablePrivateRecordStoreConfig,
} from '../util/immutable-private-record-store.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { fsyncDirectory } from '../util/durability.js';
import {
  buildAgentOsReadModelV1,
  type AgentOsReadModelInputV1,
  type AgentOsReadModelV1,
  type AgentOsReadModelVerifierV1,
} from './agent-os-read-model.js';

const PROTOCOL = 'agent-os-snapshot-envelope-v1' as const;
const CHECKPOINT_PROTOCOL = 'agent-os-snapshot-tip-v1' as const;
const GENESIS_DIGEST = '0'.repeat(64);
const SHA256_RE = /^[a-f0-9]{64}$/;
const LINEAGE_DIGEST_RE = /^(?:sha256:)?[a-f0-9]{64}$/;
const RECORD_FILE_RE = /^([0-9]{12})\.json$/;
const MAX_SEQUENCE = 4_096;
const MAX_RECORD_BYTES = 128 * 1_024;
const DEFAULT_MAX_BYTES = 64 * 1_024 * 1_024;
const HARD_MAX_BYTES = 128 * 1_024 * 1_024;
const MAX_LOCK_WAIT_MS = 2_000;
const MAX_TEXT_BYTES = 512;
const ATTEMPT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const AGENT_OS_SNAPSHOT_GENESIS_DIGEST = GENESIS_DIGEST;

type Digest = string;

export interface AgentOsSnapshotPayloadV1 {
  snapshot: AgentOsReadModelV1;
  snapshotDigest: Digest;
}

export interface AgentOsSnapshotEnvelopeV1 {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  recordType: 'agent-os-snapshot';
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
  sequence: number;
  previousEnvelopeDigest: Digest;
  observedAt: string;
  producerIdentityDigest: Digest;
  keyId: Digest;
  sourceDigest: Digest;
  /** Durable observer attempt that produced this exact snapshot. */
  producerAttemptId: string;
  kernelCycleDigest: Digest;
  capabilityProjectionDigest: Digest;
  portfolioDigest: Digest;
  payload: AgentOsSnapshotPayloadV1;
  payloadDigest: Digest;
  envelopeDigest: Digest;
  authenticator: Digest;
}

export interface AgentOsSnapshotSignerV1 {
  readonly producerIdentityDigest: Digest;
  readonly keyId: Digest;
  sign(envelopeDigest: Digest): Digest | null;
}

export interface AgentOsSnapshotVerifierV1 {
  verify(input: {
    producerIdentityDigest: Digest;
    keyId: Digest;
    envelopeDigest: Digest;
    authenticator: Digest;
  }): boolean;
}

/**
 * A verifier pinned to one already-authenticated immutable source bundle.
 * Keeping the bundle digest beside the closed verifier removes caller control
 * over the source identity persisted in the snapshot envelope.
 */
export interface AgentOsAuthenticatedReadModelVerifierV1 {
  bundleDigest: Digest;
  verifier: AgentOsReadModelVerifierV1;
}

export interface AgentOsSnapshotStoreDependenciesV1 {
  /** Existing trusted directory that directly contains `rootPath`. */
  anchorPath: string;
  rootPath: string;
  signer: AgentOsSnapshotSignerV1 | null;
  verifier: AgentOsSnapshotVerifierV1 | null;
  readModelVerifier: AgentOsAuthenticatedReadModelVerifierV1 | null;
  clock: () => Date;
  /** Final synchronous fence checked immediately before immutable publication. */
  commitGuard?: () => 'allow' | 'cancelled-before-commit' | 'deadline-before-commit';
}

export interface AgentOsSnapshotAppendInputV1 {
  readModelInput: AgentOsReadModelInputV1;
  producerAttemptId: string;
}

export type AgentOsSnapshotIntegrityStateV1 = 'valid' | 'invalid';
export type AgentOsSnapshotAuthenticityStateV1 = 'authenticated' | 'invalid' | 'unavailable';

export interface AgentOsSnapshotInspectionV1 {
  integrity: AgentOsSnapshotIntegrityStateV1;
  authenticity: AgentOsSnapshotAuthenticityStateV1;
  envelope: AgentOsSnapshotEnvelopeV1 | null;
  issues: Array<'invalid-structure' | 'payload-integrity-failed' | 'envelope-integrity-failed' | 'authenticator-unavailable' | 'authenticator-invalid'>;
}

export type AgentOsSnapshotReadStopReasonV1 =
  | ImmutablePrivateRecordReadStopReason
  | 'platform-unsupported'
  | 'duplicate-sequence'
  | 'sequence-gap'
  | 'broken-predecessor'
  | 'non-monotonic-time'
  | 'checkpoint-missing'
  | 'checkpoint-orphaned'
  | 'checkpoint-invalid'
  | 'checkpoint-behind'
  | 'checkpoint-mismatch';

export interface AgentOsSnapshotReadResultV1 {
  sourceState: 'missing' | 'healthy' | 'degraded';
  availability: 'available' | 'unavailable';
  sourcePresent: boolean;
  complete: boolean;
  envelopes: AgentOsSnapshotEnvelopeV1[];
  current: AgentOsSnapshotEnvelopeV1 | null;
  stopReasons: AgentOsSnapshotReadStopReasonV1[];
  filesRead: number;
  bytesRead: number;
  invalidFiles: number;
  limitExceeded: boolean;
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

export type AgentOsSnapshotAppendResultV1 = {
  disposition: 'recorded' | 'replayed' | 'rejected' | 'unavailable' | 'failed';
  reason: 'recorded' | 'snapshot-replay' | 'clock-rollback' | 'invalid-input' | 'platform-unsupported' | 'authenticator-unavailable' | 'chain-unavailable' | 'capacity-exhausted' | 'publication-failed' | 'checkpoint-failed' | 'cancelled-before-commit' | 'deadline-before-commit';
  envelope: AgentOsSnapshotEnvelopeV1 | null;
  current: AgentOsSnapshotEnvelopeV1 | null;
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
};

interface AgentOsSnapshotTipV1 {
  schemaVersion: 1;
  protocol: typeof CHECKPOINT_PROTOCOL;
  sequence: number;
  envelopeDigest: Digest;
  producerIdentityDigest: Digest;
  keyId: Digest;
  checkpointDigest: Digest;
  authenticator: Digest;
}

const AUTHORITY = Object.freeze({
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

const ENVELOPE_KEYS = [
  'schemaVersion', 'protocol', 'recordType', 'authority', 'sameUserTamperResistant', 'rollbackProtected',
  'historicalAuthority', 'executionAuthority',
  'proposalAuthority', 'mergeAuthority', 'deployAuthority', 'publicationAuthority',
  'externalMutationAuthority', 'sequence', 'previousEnvelopeDigest', 'observedAt',
  'producerIdentityDigest', 'keyId', 'sourceDigest', 'producerAttemptId', 'kernelCycleDigest',
  'capabilityProjectionDigest', 'portfolioDigest', 'payload', 'payloadDigest',
  'envelopeDigest', 'authenticator',
] as const;
const PAYLOAD_KEYS = ['snapshot', 'snapshotDigest'] as const;
const SNAPSHOT_KEYS = ['sourceState', 'livingEndState', 'capabilitySpectrum', 'activeValueBets', 'nextAction'] as const;
const END_STATE_KEYS = ['northStar', 'currentBottleneck', 'revisionLabel', 'evidenceState'] as const;
const CAPABILITY_KEYS = ['lane', 'label', 'state', 'headroom', 'resetUrgency', 'resetLabel', 'allocationLabel'] as const;
const BET_KEYS = ['key', 'title', 'valueCase', 'allocationLabel', 'decision', 'assurance', 'outcome', 'evidence'] as const;
const OUTCOME_KEYS = ['state', 'label'] as const;
const EVIDENCE_KEYS = ['state', 'label'] as const;
const NEXT_ACTION_KEYS = ['kind', 'title', 'reason', 'evidenceState'] as const;
const TIP_KEYS = ['schemaVersion', 'protocol', 'sequence', 'envelopeDigest', 'producerIdentityDigest', 'keyId', 'checkpointDigest', 'authenticator'] as const;

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

function record(value: unknown): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' ||
      !descriptors[String(key)]?.enumerable || !('value' in descriptors[String(key)]!))) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function canonicalize(value: unknown, ancestors = new Set<object>()): CanonicalJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('non-json value');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => {
        if (!Object.hasOwn(value, index)) throw new TypeError('sparse array');
        return canonicalize(entry, ancestors);
      });
    }
    if (!record(value)) throw new TypeError('non-plain object');
    const output: { [key: string]: CanonicalJson } = Object.create(null) as { [key: string]: CanonicalJson };
    for (const key of Object.keys(value).sort()) {
      output[key] = canonicalize((value as Record<string, unknown>)[key], ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha(domain: string, value: unknown): Digest {
  return createHash('sha256').update(domain, 'utf8').update('\0').update(canonicalJson(value), 'utf8').digest('hex');
}

function hmac(key: Buffer, domain: string, value: unknown): Digest {
  return createHmac('sha256', key).update(domain, 'utf8').update('\0').update(canonicalJson(value), 'utf8').digest('hex');
}

function sameDigest(left: unknown, right: unknown): boolean {
  return typeof left === 'string' && typeof right === 'string' && SHA256_RE.test(left) && SHA256_RE.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function sameLineageDigest(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string' ||
    !LINEAGE_DIGEST_RE.test(left) || !LINEAGE_DIGEST_RE.test(right)) return false;
  return sameDigest(left.replace(/^sha256:/u, ''), right.replace(/^sha256:/u, ''));
}

function digest(value: unknown): value is Digest {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function lineageDigest(value: unknown): value is Digest {
  return typeof value === 'string' && LINEAGE_DIGEST_RE.test(value);
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 40) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function sequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_SEQUENCE;
}

function safeText(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES || [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })) return false;
  return !(
    /(?:^|[\s('"`])(?:\/Users\/|\/home\/|\/private\/|\/var\/|\/tmp\/|\/etc\/|~\/|[A-Za-z]:\\)/u.test(value) ||
    /\b(?:CODEX_HOME|CLAUDE_CONFIG_DIR|identityRef|accountRef|runtimeLocator|system prompt)\b/iu.test(value) ||
    /\b(?:access[_-]?token|api[_-]?key|client[_-]?secret|password|private[_-]?key)\s*[:=]/iu.test(value) ||
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/u.test(value) ||
    /\bsk-[A-Za-z0-9_-]{12,}\b/u.test(value) ||
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(value) ||
    /\b(?:https?|file):\/\//iu.test(value)
  );
}

function enumValue(value: unknown, values: readonly string[]): boolean {
  return typeof value === 'string' && values.includes(value);
}

function validSnapshot(value: unknown): value is AgentOsReadModelV1 {
  const snapshot = record(value);
  if (!snapshot || !exactKeys(snapshot, SNAPSHOT_KEYS) ||
    !enumValue(snapshot['sourceState'], ['healthy', 'degraded', 'unknown'])) return false;
  const endState = record(snapshot['livingEndState']);
  if (!endState || !exactKeys(endState, END_STATE_KEYS) ||
    !safeText(endState['northStar']) || !safeText(endState['currentBottleneck']) ||
    !safeText(endState['revisionLabel']) ||
    !enumValue(endState['evidenceState'], ['complete', 'pending', 'incomplete', 'unknown'])) return false;

  const capabilitySpectrum = snapshot['capabilitySpectrum'];
  if (!Array.isArray(capabilitySpectrum) || capabilitySpectrum.length > 3 || capabilitySpectrum.some((entry) => {
    const lane = record(entry);
    return !lane || !exactKeys(lane, CAPABILITY_KEYS) ||
      !enumValue(lane['lane'], ['codex', 'claude', 'local']) || !safeText(lane['label']) ||
      !enumValue(lane['state'], ['ready', 'tight', 'unavailable', 'unknown']) ||
      !enumValue(lane['headroom'], ['ample', 'usable', 'tight', 'none', 'unknown']) ||
      !enumValue(lane['resetUrgency'], ['now', 'soon', 'later', 'none', 'unknown']) ||
      !safeText(lane['resetLabel']) || !safeText(lane['allocationLabel']);
  })) return false;

  const activeValueBets = snapshot['activeValueBets'];
  if (!Array.isArray(activeValueBets) || activeValueBets.length > 3 || activeValueBets.some((entry) => {
    const bet = record(entry);
    const outcome = bet ? record(bet['outcome']) : null;
    const evidence = bet ? record(bet['evidence']) : null;
    return !bet || !exactKeys(bet, BET_KEYS) || !safeText(bet['key']) || !safeText(bet['title']) ||
      !safeText(bet['valueCase']) || !safeText(bet['allocationLabel']) ||
      !enumValue(bet['decision'], ['continue', 'observing', 'hold']) ||
      !enumValue(bet['assurance'], ['fast-path', 'targeted', 'deep']) ||
      !outcome || !exactKeys(outcome, OUTCOME_KEYS) ||
      !enumValue(outcome['state'], ['pending', 'effective', 'refuted', 'unknown']) || !safeText(outcome['label']) ||
      !evidence || !exactKeys(evidence, EVIDENCE_KEYS) ||
      !enumValue(evidence['state'], ['complete', 'pending', 'incomplete', 'unknown']) || !safeText(evidence['label']);
  })) return false;

  const nextAction = record(snapshot['nextAction']);
  return Boolean(nextAction && exactKeys(nextAction, NEXT_ACTION_KEYS) &&
    enumValue(nextAction['kind'], ['exception', 'attention', 'clear']) &&
    safeText(nextAction['title']) && safeText(nextAction['reason']) &&
    enumValue(nextAction['evidenceState'], ['complete', 'pending', 'incomplete', 'unknown']));
}

function validPayload(value: unknown): value is AgentOsSnapshotPayloadV1 {
  const payload = record(value);
  return Boolean(payload && exactKeys(payload, PAYLOAD_KEYS) && lineageDigest(payload['snapshotDigest']) &&
    validSnapshot(payload['snapshot']));
}

function unsignedEnvelopeFields(envelope: Omit<AgentOsSnapshotEnvelopeV1, 'envelopeDigest' | 'authenticator'>): unknown {
  return envelope;
}

function buildEnvelope(
  input: AgentOsSnapshotPayloadV1 & {
    sourceDigest: Digest;
    producerAttemptId: string;
    kernelCycleDigest: Digest;
    capabilityProjectionDigest: Digest;
    portfolioDigest: Digest;
  },
  sequenceNumber: number,
  previousEnvelopeDigest: Digest,
  observedAt: string,
  signer: AgentOsSnapshotSignerV1,
): AgentOsSnapshotEnvelopeV1 | null {
  try {
    if (!validSnapshot(input.snapshot) || !lineageDigest(input.snapshotDigest) || !lineageDigest(input.sourceDigest) ||
      !ATTEMPT_ID_RE.test(input.producerAttemptId) ||
      !lineageDigest(input.kernelCycleDigest) || !lineageDigest(input.capabilityProjectionDigest) ||
      !lineageDigest(input.portfolioDigest) || !sequence(sequenceNumber) ||
      !digest(previousEnvelopeDigest) || !timestamp(observedAt) ||
      !digest(signer.producerIdentityDigest) || !digest(signer.keyId)) return null;
    const payload = { snapshot: input.snapshot, snapshotDigest: input.snapshotDigest };
    const payloadDigest = sha('ashlr:agent-os-snapshot:payload:v1', payload);
    const unsigned = {
      schemaVersion: 1 as const,
      protocol: PROTOCOL,
      recordType: 'agent-os-snapshot' as const,
      ...AUTHORITY,
      sequence: sequenceNumber,
      previousEnvelopeDigest,
      observedAt,
      producerIdentityDigest: signer.producerIdentityDigest,
      keyId: signer.keyId,
      sourceDigest: input.sourceDigest,
      producerAttemptId: input.producerAttemptId,
      kernelCycleDigest: input.kernelCycleDigest,
      capabilityProjectionDigest: input.capabilityProjectionDigest,
      portfolioDigest: input.portfolioDigest,
      payload,
      payloadDigest,
    };
    const envelopeDigest = sha('ashlr:agent-os-snapshot:envelope:v1', unsignedEnvelopeFields(unsigned));
    const authenticator = signer.sign(envelopeDigest);
    if (!digest(authenticator)) return null;
    return { ...unsigned, envelopeDigest, authenticator };
  } catch {
    return null;
  }
}

function structurallyValidEnvelope(value: unknown): AgentOsSnapshotEnvelopeV1 | null {
  const envelope = record(value);
  if (!envelope || !exactKeys(envelope, ENVELOPE_KEYS) || envelope['schemaVersion'] !== 1 ||
    envelope['protocol'] !== PROTOCOL || envelope['recordType'] !== 'agent-os-snapshot' ||
    envelope['authority'] !== 'observation-only' || envelope['executionAuthority'] !== false ||
    envelope['sameUserTamperResistant'] !== false ||
    envelope['rollbackProtected'] !== false || envelope['historicalAuthority'] !== false ||
    envelope['proposalAuthority'] !== false || envelope['mergeAuthority'] !== false ||
    envelope['deployAuthority'] !== false || envelope['publicationAuthority'] !== false ||
    envelope['externalMutationAuthority'] !== false || !sequence(envelope['sequence']) ||
    !digest(envelope['previousEnvelopeDigest']) || !timestamp(envelope['observedAt']) ||
    !digest(envelope['producerIdentityDigest']) || !digest(envelope['keyId']) ||
    !lineageDigest(envelope['sourceDigest']) || typeof envelope['producerAttemptId'] !== 'string' ||
    !ATTEMPT_ID_RE.test(envelope['producerAttemptId']) || !lineageDigest(envelope['kernelCycleDigest']) ||
    !lineageDigest(envelope['capabilityProjectionDigest']) || !lineageDigest(envelope['portfolioDigest']) ||
    !validPayload(envelope['payload']) || !digest(envelope['payloadDigest']) ||
    !digest(envelope['envelopeDigest']) || !digest(envelope['authenticator'])) return null;
  return envelope as unknown as AgentOsSnapshotEnvelopeV1;
}

export function inspectAgentOsSnapshotEnvelopeV1(
  value: unknown,
  verifier: AgentOsSnapshotVerifierV1 | null,
): AgentOsSnapshotInspectionV1 {
  try {
    const envelope = structurallyValidEnvelope(value);
    if (!envelope) return { integrity: 'invalid', authenticity: 'invalid', envelope: null, issues: ['invalid-structure'] };
    const expectedPayloadDigest = sha('ashlr:agent-os-snapshot:payload:v1', envelope.payload);
    if (!sameDigest(envelope.payloadDigest, expectedPayloadDigest)) {
      return { integrity: 'invalid', authenticity: 'invalid', envelope: null, issues: ['payload-integrity-failed'] };
    }
    const { envelopeDigest: _envelopeDigest, authenticator: _authenticator, ...unsigned } = envelope;
    const expectedEnvelopeDigest = sha('ashlr:agent-os-snapshot:envelope:v1', unsigned);
    if (!sameDigest(envelope.envelopeDigest, expectedEnvelopeDigest)) {
      return { integrity: 'invalid', authenticity: 'invalid', envelope: null, issues: ['envelope-integrity-failed'] };
    }
    if (!verifier) {
      return { integrity: 'valid', authenticity: 'unavailable', envelope, issues: ['authenticator-unavailable'] };
    }
    let authenticated = false;
    try {
      authenticated = verifier.verify({
        producerIdentityDigest: envelope.producerIdentityDigest,
        keyId: envelope.keyId,
        envelopeDigest: envelope.envelopeDigest,
        authenticator: envelope.authenticator,
      });
    } catch {
      authenticated = false;
    }
    return authenticated
      ? { integrity: 'valid', authenticity: 'authenticated', envelope, issues: [] }
      : { integrity: 'valid', authenticity: 'invalid', envelope, issues: ['authenticator-invalid'] };
  } catch {
    return { integrity: 'invalid', authenticity: 'invalid', envelope: null, issues: ['invalid-structure'] };
  }
}

function defaultAuthenticator(key: Buffer): { signer: AgentOsSnapshotSignerV1; verifier: AgentOsSnapshotVerifierV1 } {
  const producerIdentityDigest = hmac(key, 'ashlr:agent-os-snapshot:producer:v1', ['producer']);
  const keyId = hmac(key, 'ashlr:agent-os-snapshot:key-id:v1', ['generation', 1]);
  return {
    signer: {
      producerIdentityDigest,
      keyId,
      sign: (envelopeDigest) => digest(envelopeDigest)
        ? hmac(key, 'ashlr:agent-os-snapshot:authenticator:v1', [envelopeDigest])
        : null,
    },
    verifier: {
      verify: (input) => sameDigest(input.producerIdentityDigest, producerIdentityDigest) &&
        sameDigest(input.keyId, keyId) && digest(input.envelopeDigest) &&
        sameDigest(input.authenticator, hmac(key, 'ashlr:agent-os-snapshot:authenticator:v1', [input.envelopeDigest])),
    },
  };
}

function defaultPaths(): { anchorPath: string; rootPath: string } | null {
  try {
    const home = resolve(homedir());
    if (!isAbsolute(home) || home === parse(home).root) return null;
    const anchorPath = join(home, '.ashlr');
    return { anchorPath, rootPath: join(anchorPath, 'agent-os-snapshots-v1') };
  } catch {
    return null;
  }
}

export function defaultAgentOsSnapshotStoreDependenciesV1(
  access: 'read' | 'write',
): AgentOsSnapshotStoreDependenciesV1 | null {
  const paths = defaultPaths();
  if (!paths) return null;
  try {
    const key = access === 'write' ? loadExistingProvenanceKey() : loadExistingProvenanceKeyReadOnly();
    const authenticator = key?.length === 32 ? defaultAuthenticator(key) : null;
    return {
      ...paths,
      signer: access === 'write' ? authenticator?.signer ?? null : null,
      verifier: authenticator?.verifier ?? null,
      readModelVerifier: null,
      clock: () => new Date(),
    };
  } catch {
    return { ...paths, signer: null, verifier: null, readModelVerifier: null, clock: () => new Date() };
  }
}

function validDependencies(value: AgentOsSnapshotStoreDependenciesV1): boolean {
  try {
    const anchor = resolve(value.anchorPath);
    const root = resolve(value.rootPath);
    return value.anchorPath === anchor && value.rootPath === root &&
      isAbsolute(anchor) && isAbsolute(root) && anchor !== parse(anchor).root &&
      root !== anchor && dirname(root) === anchor && typeof value.clock === 'function' &&
      (value.commitGuard === undefined || typeof value.commitGuard === 'function');
  } catch {
    return false;
  }
}

function sequenceToken(value: number): string {
  return String(value).padStart(12, '0');
}

function codec(verifier: AgentOsSnapshotVerifierV1): ImmutablePrivateRecordCodec<AgentOsSnapshotEnvelopeV1> {
  return {
    parse: (value) => {
      const inspection = inspectAgentOsSnapshotEnvelopeV1(value, verifier);
      return inspection.authenticity === 'authenticated' ? inspection.envelope : null;
    },
    serialize: (value) => `${canonicalJson(value)}\n`,
    recordId: (value) => sequenceToken(value.sequence),
    recordFileName: (value) => `${sequenceToken(value.sequence)}.json`,
    isRecordFileName: (value) => RECORD_FILE_RE.test(value),
    stageToken: (value) => value.authenticator.slice(0, 32),
    equivalent: (left, right) => left.sequence === right.sequence &&
      sameDigest(left.envelopeDigest, right.envelopeDigest) &&
      sameDigest(left.authenticator, right.authenticator),
    compare: (left, right) => left.sequence - right.sequence,
  };
}

function storeConfig(
  dependencies: AgentOsSnapshotStoreDependenciesV1,
): ImmutablePrivateRecordStoreConfig<AgentOsSnapshotEnvelopeV1> | null {
  if (!validDependencies(dependencies)) return null;
  return {
    label: 'agent os snapshot',
    anchorPath: dependencies.anchorPath,
    rootPath: dependencies.rootPath,
    lockFileName: '.agent-os-snapshot.lock',
    maxRecordBytes: MAX_RECORD_BYTES,
    defaultMaxFiles: MAX_SEQUENCE,
    hardMaxFiles: MAX_SEQUENCE,
    defaultMaxBytes: DEFAULT_MAX_BYTES,
    hardMaxBytes: HARD_MAX_BYTES,
    codecForWrite: () => dependencies.verifier ? codec(dependencies.verifier) : null,
    codecForRead: () => dependencies.verifier ? codec(dependencies.verifier) : null,
  };
}

function tipPayload(value: Omit<AgentOsSnapshotTipV1, 'checkpointDigest' | 'authenticator'>): unknown {
  return value;
}

function buildTip(envelope: AgentOsSnapshotEnvelopeV1, signer: AgentOsSnapshotSignerV1): AgentOsSnapshotTipV1 | null {
  if (!digest(signer.producerIdentityDigest) || !digest(signer.keyId) ||
    !sameDigest(signer.producerIdentityDigest, envelope.producerIdentityDigest) ||
    !sameDigest(signer.keyId, envelope.keyId)) return null;
  const unsigned = {
    schemaVersion: 1 as const,
    protocol: CHECKPOINT_PROTOCOL,
    sequence: envelope.sequence,
    envelopeDigest: envelope.envelopeDigest,
    producerIdentityDigest: envelope.producerIdentityDigest,
    keyId: envelope.keyId,
  };
  const checkpointDigest = sha('ashlr:agent-os-snapshot:tip:v1', tipPayload(unsigned));
  const authenticator = signer.sign(checkpointDigest);
  return digest(authenticator) ? { ...unsigned, checkpointDigest, authenticator } : null;
}

function parseTip(value: unknown, verifier: AgentOsSnapshotVerifierV1 | null): AgentOsSnapshotTipV1 | null {
  const tip = record(value);
  if (!tip || !exactKeys(tip, TIP_KEYS) || tip['schemaVersion'] !== 1 ||
    tip['protocol'] !== CHECKPOINT_PROTOCOL || !sequence(tip['sequence']) ||
    !digest(tip['envelopeDigest']) || !digest(tip['producerIdentityDigest']) ||
    !digest(tip['keyId']) || !digest(tip['checkpointDigest']) || !digest(tip['authenticator']) ||
    !verifier) return null;
  const unsigned = {
    schemaVersion: 1 as const,
    protocol: CHECKPOINT_PROTOCOL,
    sequence: tip['sequence'],
    envelopeDigest: tip['envelopeDigest'],
    producerIdentityDigest: tip['producerIdentityDigest'],
    keyId: tip['keyId'],
  };
  const checkpointDigest = sha('ashlr:agent-os-snapshot:tip:v1', tipPayload(unsigned));
  if (!sameDigest(checkpointDigest, tip['checkpointDigest']) || !verifier.verify({
    producerIdentityDigest: tip['producerIdentityDigest'],
    keyId: tip['keyId'],
    envelopeDigest: tip['checkpointDigest'],
    authenticator: tip['authenticator'],
  })) return null;
  return tip as unknown as AgentOsSnapshotTipV1;
}

function readPrivateJson(path: string, anchorPath: string, maxBytes: number): unknown | null {
  let fd: number | undefined;
  try {
    if (!assurePrivateStoragePath(path, 'file', 'inspect-existing', { anchorPath }).ok) return null;
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 2n ||
      before.size > BigInt(maxBytes) || (typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid())) ||
      (process.platform !== 'win32' && (before.mode & 0o777n) !== 0o600n)) return null;
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return null;
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) return null;
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (!sameFileSnapshot(before, after) || !sameFileSnapshot(before, named)) return null;
    const text = bytes.toString('utf8');
    if (!bytes.equals(Buffer.from(text, 'utf8')) || !text.endsWith('\n') || text.slice(0, -1).includes('\n')) return null;
    return JSON.parse(text);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

function ownedByCurrentUser(stat: BigIntStats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid());
}

function exactPrivateFile(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && ownedByCurrentUser(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o777n) === 0o600n);
}

function exactPrivateDirectory(stat: BigIntStats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && ownedByCurrentUser(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o777n) === 0o700n);
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function samePublishedFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.gid === right.gid &&
    exactPrivateDirectory(right);
}

function stablePrivateAnchor(anchorPath: string): BigIntStats | null {
  try {
    const identity = lstatSync(anchorPath, { bigint: true });
    return exactPrivateDirectory(identity) ? identity : null;
  } catch {
    return null;
  }
}

/** Remove only the exact inode observed at the one fixed checkpoint-temp path. */
function removeExactCheckpointTemporary(
  temporaryPath: string,
  expected: BigIntStats,
  anchorPath: string,
): boolean {
  try {
    const anchorBefore = stablePrivateAnchor(anchorPath);
    if (!anchorBefore || (!expected.isFile() && !expected.isSymbolicLink()) || !ownedByCurrentUser(expected)) {
      return false;
    }
    const current = lstatSync(temporaryPath, { bigint: true });
    if (!sameFileSnapshot(expected, current)) return false;
    unlinkSync(temporaryPath);
    const anchorAfter = lstatSync(anchorPath, { bigint: true });
    try {
      lstatSync(temporaryPath, { bigint: true });
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    if (!sameDirectoryIdentity(anchorBefore, anchorAfter)) return false;
    fsyncDirectory(anchorPath, { expectedIdentity: anchorBefore });
    return true;
  } catch {
    return false;
  }
}

function installExactCheckpointTemporary(
  dependencies: AgentOsSnapshotStoreDependenciesV1,
  temporaryPath: string,
  temporaryIdentity: BigIntStats,
  expectedTargetIdentity: BigIntStats | null,
  current: AgentOsSnapshotEnvelopeV1,
): boolean {
  try {
    const anchorBefore = stablePrivateAnchor(dependencies.anchorPath);
    if (!anchorBefore || !exactPrivateFile(temporaryIdentity)) return false;
    const currentTemporary = lstatSync(temporaryPath, { bigint: true });
    if (!sameFileSnapshot(temporaryIdentity, currentTemporary)) return false;
    const targetPath = checkpointPath(dependencies);
    if (expectedTargetIdentity === null) {
      if (existsSync(targetPath)) return false;
    } else {
      const currentTarget = lstatSync(targetPath, { bigint: true });
      if (!sameFileSnapshot(expectedTargetIdentity, currentTarget)) return false;
    }
    renameSync(temporaryPath, targetPath);
    const installed = lstatSync(targetPath, { bigint: true });
    const anchorAfter = lstatSync(dependencies.anchorPath, { bigint: true });
    if (!exactPrivateFile(installed) || !samePublishedFile(temporaryIdentity, installed) ||
      !sameDirectoryIdentity(anchorBefore, anchorAfter)) return false;
    fsyncDirectory(dependencies.anchorPath, { expectedIdentity: anchorBefore });
    const tip = readTip(dependencies);
    return Boolean(tip && tip.sequence === current.sequence &&
      sameDigest(tip.envelopeDigest, current.envelopeDigest));
  } catch {
    return false;
  }
}

function checkpointPath(dependencies: AgentOsSnapshotStoreDependenciesV1): string {
  return join(dependencies.anchorPath, '.agent-os-snapshot-tip-v1.json');
}

function readTip(dependencies: AgentOsSnapshotStoreDependenciesV1): AgentOsSnapshotTipV1 | null {
  const path = checkpointPath(dependencies);
  return existsSync(path) ? parseTip(readPrivateJson(path, dependencies.anchorPath, 8 * 1_024), dependencies.verifier) : null;
}

function writeTip(dependencies: AgentOsSnapshotStoreDependenciesV1, envelope: AgentOsSnapshotEnvelopeV1): boolean {
  try {
    if (!dependencies.signer) return false;
    const tip = buildTip(envelope, dependencies.signer);
    if (!tip) return false;
    const path = checkpointPath(dependencies);
    writePrivateFileAtomically(
      `${path}.tmp`,
      path,
      `${canonicalJson(tip)}\n`,
      { anchorPath: dependencies.anchorPath, label: 'agent os snapshot tip' },
    );
    const installed = readTip(dependencies);
    return Boolean(installed && installed.sequence === envelope.sequence &&
      sameDigest(installed.envelopeDigest, envelope.envelopeDigest));
  } catch {
    return false;
  }
}

function internallyCoherentChain(records: readonly AgentOsSnapshotEnvelopeV1[]): boolean {
  let expectedSequence = 1;
  let expectedPredecessor = GENESIS_DIGEST;
  let previousTime = -1;
  for (const envelope of records) {
    const observedTime = Date.parse(envelope.observedAt);
    if (envelope.sequence !== expectedSequence ||
      !sameDigest(envelope.previousEnvelopeDigest, expectedPredecessor) ||
      observedTime <= previousTime) return false;
    expectedSequence += 1;
    expectedPredecessor = envelope.envelopeDigest;
    previousTime = observedTime;
  }
  return true;
}

/**
 * Recover only the fixed checkpoint temporary while the transaction lock is
 * held. A valid authenticated temp may advance an absent or older authentic
 * tip to the fully authenticated chain head. Every other file is removed only
 * after re-checking the exact inode observed at that explicit temp path.
 */
function recoverCheckpointTemporary(
  dependencies: AgentOsSnapshotStoreDependenciesV1,
  current: AgentOsSnapshotEnvelopeV1,
  tipPresent: boolean,
  tip: AgentOsSnapshotTipV1 | null,
): boolean {
  const targetPath = checkpointPath(dependencies);
  const temporaryPath = `${targetPath}.tmp`;
  let temporaryIdentity: BigIntStats;
  try {
    temporaryIdentity = lstatSync(temporaryPath, { bigint: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }

  const parsed = exactPrivateFile(temporaryIdentity)
    ? parseTip(readPrivateJson(temporaryPath, dependencies.anchorPath, 8 * 1_024), dependencies.verifier)
    : null;
  let stableIdentity = false;
  try {
    stableIdentity = sameFileSnapshot(temporaryIdentity, lstatSync(temporaryPath, { bigint: true }));
  } catch {
    return false;
  }
  if (!stableIdentity) return false;

  const matchesCurrent = parsed !== null && parsed.sequence === current.sequence &&
    sameDigest(parsed.envelopeDigest, current.envelopeDigest) &&
    sameDigest(parsed.producerIdentityDigest, current.producerIdentityDigest) &&
    sameDigest(parsed.keyId, current.keyId);
  if (matchesCurrent && (!tipPresent || (tip !== null && tip.sequence < current.sequence))) {
    let targetIdentity: BigIntStats | null = null;
    if (tipPresent) {
      try { targetIdentity = lstatSync(targetPath, { bigint: true }); } catch { return false; }
    }
    return installExactCheckpointTemporary(
      dependencies,
      temporaryPath,
      temporaryIdentity,
      targetIdentity,
      current,
    );
  }

  // A current installed tip makes any residue unnecessary. Invalid, stale, or
  // conflicting residue is discarded so writeTip can rebuild the exact head.
  return removeExactCheckpointTemporary(temporaryPath, temporaryIdentity, dependencies.anchorPath);
}

/** Writer-only repair for the one safe torn state: an authenticated record ahead of its tip. */
function reconcileCheckpoint(
  dependencies: AgentOsSnapshotStoreDependenciesV1,
  config: ImmutablePrivateRecordStoreConfig<AgentOsSnapshotEnvelopeV1>,
): boolean {
  const raw = readImmutablePrivateRecords(config, { requireComplete: true });
  if (!raw.complete || raw.sourceState === 'degraded' || !internallyCoherentChain(raw.records)) return false;
  const path = checkpointPath(dependencies);
  const present = existsSync(path);
  const tip = present ? readTip(dependencies) : null;
  const current = raw.records.at(-1);
  if (!current) return !present;
  if (!recoverCheckpointTemporary(dependencies, current, present, tip)) return false;
  const recoveredPresent = existsSync(path);
  const recoveredTip = recoveredPresent ? readTip(dependencies) : null;
  if (!recoveredTip) return !recoveredPresent && writeTip(dependencies, current);
  if (recoveredTip.sequence === current.sequence &&
    sameDigest(recoveredTip.envelopeDigest, current.envelopeDigest)) return true;
  // Only advance an authentic older tip. Never overwrite a tip that is ahead
  // or conflicts at the same sequence; those are not attributable to a torn write.
  return recoveredTip.sequence < current.sequence && writeTip(dependencies, current);
}

function unavailableRead(
  reasons: AgentOsSnapshotReadStopReasonV1[],
  sourceState: AgentOsSnapshotReadResultV1['sourceState'] = 'degraded',
): AgentOsSnapshotReadResultV1 {
  return {
    sourceState,
    availability: 'unavailable',
    sourcePresent: sourceState !== 'missing',
    complete: false,
    envelopes: [],
    current: null,
    stopReasons: reasons,
    filesRead: 0,
    bytesRead: 0,
    invalidFiles: 0,
    limitExceeded: false,
    ...AUTHORITY,
  };
}

export function readAgentOsSnapshotsV1(
  dependencies: AgentOsSnapshotStoreDependenciesV1,
): AgentOsSnapshotReadResultV1 {
  try {
    if (process.platform === 'win32') return unavailableRead(['platform-unsupported']);
    const config = storeConfig(dependencies);
    if (!config) return unavailableRead(['invalid-options']);
    const raw = readImmutablePrivateRecords(config, { requireComplete: false });
    if (raw.sourceState === 'missing' && !raw.sourcePresent) {
      return existsSync(checkpointPath(dependencies))
        ? unavailableRead(['checkpoint-orphaned'])
        : unavailableRead([], 'missing');
    }
    const stopReasons = new Set<AgentOsSnapshotReadStopReasonV1>(raw.stopReasons);
    let expectedSequence = 1;
    let expectedPredecessor = GENESIS_DIGEST;
    let previousTime = -1;
    const seen = new Set<number>();
    for (const envelope of raw.records) {
      if (seen.has(envelope.sequence)) stopReasons.add('duplicate-sequence');
      if (envelope.sequence !== expectedSequence) stopReasons.add('sequence-gap');
      if (!sameDigest(envelope.previousEnvelopeDigest, expectedPredecessor)) stopReasons.add('broken-predecessor');
      const observedTime = Date.parse(envelope.observedAt);
      if (observedTime <= previousTime) stopReasons.add('non-monotonic-time');
      seen.add(envelope.sequence);
      expectedSequence = envelope.sequence + 1;
      expectedPredecessor = envelope.envelopeDigest;
      previousTime = observedTime;
    }
    const tipPath = checkpointPath(dependencies);
    const tipPresent = existsSync(tipPath);
    const tip = tipPresent ? readTip(dependencies) : null;
    if (raw.records.length > 0 && !tipPresent) {
      stopReasons.add('checkpoint-missing');
    } else if (tipPresent && !tip) {
      stopReasons.add('checkpoint-invalid');
    } else if (tip) {
      const current = raw.records.at(-1);
      if (!current || tip.sequence > current.sequence) stopReasons.add('checkpoint-mismatch');
      else if (tip.sequence < current.sequence) stopReasons.add('checkpoint-behind');
      else if (!sameDigest(tip.envelopeDigest, current.envelopeDigest)) stopReasons.add('checkpoint-mismatch');
    }
    const complete = raw.sourceState === 'healthy' && raw.complete && stopReasons.size === 0;
    return {
      sourceState: complete ? 'healthy' : 'degraded',
      availability: complete ? 'available' : 'unavailable',
      sourcePresent: raw.sourcePresent,
      complete,
      envelopes: complete ? raw.records : [],
      current: complete ? raw.records.at(-1) ?? null : null,
      stopReasons: [...stopReasons],
      filesRead: raw.filesRead,
      bytesRead: raw.bytesRead,
      invalidFiles: raw.invalidFiles,
      limitExceeded: raw.limitExceeded,
      ...AUTHORITY,
    };
  } catch {
    return unavailableRead(['io-error']);
  }
}

function appendResult(
  disposition: AgentOsSnapshotAppendResultV1['disposition'],
  reason: AgentOsSnapshotAppendResultV1['reason'],
  envelope: AgentOsSnapshotEnvelopeV1 | null,
  current: AgentOsSnapshotEnvelopeV1 | null,
): AgentOsSnapshotAppendResultV1 {
  return { disposition, reason, envelope, current, ...AUTHORITY };
}

export function appendAgentOsSnapshotV1(
  input: AgentOsSnapshotAppendInputV1,
  dependencies: AgentOsSnapshotStoreDependenciesV1,
): AgentOsSnapshotAppendResultV1 {
  if (process.platform === 'win32') return appendResult('unavailable', 'platform-unsupported', null, null);
  if (!validDependencies(dependencies) || !dependencies.signer || !dependencies.verifier ||
    !dependencies.readModelVerifier ||
    !record(input) || !exactKeys(input as unknown as Record<string, unknown>, [
      'readModelInput', 'producerAttemptId',
    ]) || !record(dependencies.readModelVerifier) ||
    !exactKeys(dependencies.readModelVerifier as unknown as Record<string, unknown>, ['bundleDigest', 'verifier']) ||
    !lineageDigest(dependencies.readModelVerifier.bundleDigest) ||
    !ATTEMPT_ID_RE.test(input.producerAttemptId)) {
    return appendResult('rejected', 'invalid-input', null, null);
  }
  const readModel = buildAgentOsReadModelV1(input.readModelInput, dependencies.readModelVerifier.verifier);
  if (!readModel.ok) return appendResult('rejected', 'invalid-input', null, null);
  const normalized = {
    snapshot: readModel.snapshot,
    snapshotDigest: readModel.snapshotDigest,
    sourceDigest: dependencies.readModelVerifier.bundleDigest,
    producerAttemptId: input.producerAttemptId,
    kernelCycleDigest: input.readModelInput.kernel.cycleDigest,
    capabilityProjectionDigest: input.readModelInput.capabilitySpectrum.projectionDigest,
    portfolioDigest: input.readModelInput.portfolio.portfolioDigest,
  };
  if (!lineageDigest(normalized.snapshotDigest) || !lineageDigest(normalized.kernelCycleDigest) ||
    !lineageDigest(normalized.capabilityProjectionDigest) || !lineageDigest(normalized.portfolioDigest)) {
    return appendResult('rejected', 'invalid-input', null, null);
  }
  let anchorAvailable = false;
  try { anchorAvailable = existsSync(dependencies.anchorPath) && statSync(dependencies.anchorPath).isDirectory(); } catch { /* fail closed */ }
  if (!anchorAvailable) {
    return appendResult('unavailable', 'chain-unavailable', null, null);
  }
  const lock = acquireLocalStoreLock(
    join(dependencies.anchorPath, '.agent-os-snapshot-transaction.lock'),
    MAX_LOCK_WAIT_MS,
    { anchorPath: dependencies.anchorPath, exactPrivateStorage: true },
  );
  if (!lock) return appendResult('failed', 'publication-failed', null, null);
  try {
    const config = storeConfig(dependencies);
    if (!config) return appendResult('rejected', 'invalid-input', null, null);
    const recovery = recoverImmutablePrivateRecordStore(config, { lockWaitMs: MAX_LOCK_WAIT_MS });
    if (!['clean', 'recovered', 'missing'].includes(recovery)) {
      return appendResult('failed', 'chain-unavailable', null, null);
    }
    if (recovery !== 'missing' && !reconcileCheckpoint(dependencies, config)) {
      return appendResult('unavailable', 'chain-unavailable', null, null);
    }
    const before = readAgentOsSnapshotsV1(dependencies);
    if (before.sourceState !== 'missing' && !before.complete) {
      return appendResult('unavailable', 'chain-unavailable', null, null);
    }
    const replay = before.envelopes.find((entry) =>
      sameLineageDigest(entry.sourceDigest, normalized.sourceDigest) &&
      sameLineageDigest(entry.payload.snapshotDigest, normalized.snapshotDigest) &&
      entry.producerAttemptId === normalized.producerAttemptId);
    if (replay) return appendResult('replayed', 'snapshot-replay', null, replay);
    const nextSequence = (before.current?.sequence ?? 0) + 1;
    if (nextSequence > MAX_SEQUENCE) return appendResult('rejected', 'capacity-exhausted', null, before.current);
    let now: Date;
    try { now = dependencies.clock(); } catch { return appendResult('rejected', 'invalid-input', null, before.current); }
    const observedAt = now instanceof Date && Number.isFinite(now.getTime()) ? now.toISOString() : '';
    if (!timestamp(observedAt)) return appendResult('rejected', 'invalid-input', null, before.current);
    if (before.current && Date.parse(observedAt) <= Date.parse(before.current.observedAt)) {
      return appendResult('rejected', 'clock-rollback', null, before.current);
    }
    const envelope = buildEnvelope(
      normalized,
      nextSequence,
      before.current?.envelopeDigest ?? GENESIS_DIGEST,
      observedAt,
      dependencies.signer,
    );
    if (!envelope) return appendResult('unavailable', 'authenticator-unavailable', null, before.current);
    if (dependencies.commitGuard) {
      let decision: ReturnType<NonNullable<AgentOsSnapshotStoreDependenciesV1['commitGuard']>>;
      try { decision = dependencies.commitGuard(); }
      catch { decision = 'cancelled-before-commit'; }
      if (decision !== 'allow') return appendResult('rejected', decision, null, before.current);
    }
    let commitDecision: 'allow' | 'cancelled-before-commit' | 'deadline-before-commit' = 'allow';
    const publication = writeImmutablePrivateRecord(config, envelope, {
      lockWaitMs: MAX_LOCK_WAIT_MS,
      prepublish: () => {
        if (!dependencies.commitGuard) return true;
        try { commitDecision = dependencies.commitGuard(); }
        catch { commitDecision = 'cancelled-before-commit'; }
        return commitDecision === 'allow';
      },
    });
    if (commitDecision !== 'allow') return appendResult('rejected', commitDecision, null, before.current);
    if (publication !== 'recorded' && publication !== 'replayed') {
      return appendResult('failed', 'publication-failed', envelope, before.current);
    }
    if (!writeTip(dependencies, envelope)) {
      return appendResult('failed', 'checkpoint-failed', envelope, before.current);
    }
    const after = readAgentOsSnapshotsV1(dependencies);
    return after.complete && after.current && sameDigest(after.current.envelopeDigest, envelope.envelopeDigest)
      ? appendResult('recorded', 'recorded', envelope, after.current)
      : appendResult('failed', 'checkpoint-failed', envelope, null);
  } catch {
    return appendResult('failed', 'publication-failed', null, null);
  } finally {
    releaseLocalStoreLock(lock);
  }
}
