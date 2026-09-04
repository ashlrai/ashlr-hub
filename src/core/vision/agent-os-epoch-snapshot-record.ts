/**
 * Pure epoch-aware Agent OS snapshot record contract (M558).
 *
 * This module canonicalizes and authenticates inert observation records only.
 * It performs no I/O, owns no key material, and grants no runtime authority.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import type { AgentOsReadModelV1 } from './agent-os-read-model.js';
import {
  AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
  agentOsEpochAttemptIdV1,
  isAgentOsPrefixedSha256DigestV1,
  isAgentOsRawSha256DigestV1,
  type AgentOsEpochRecordAuthorityV1,
} from './agent-os-epoch-records.js';
import { AGENT_OS_EPOCH_GENESIS_V1 } from './agent-os-rollover-protocol.js';

export const AGENT_OS_EPOCH_SNAPSHOT_PROTOCOL_V2 =
  'ashlr-agent-os-epoch-snapshot-envelope-v2' as const;
export const AGENT_OS_EPOCH_SNAPSHOT_AUTHENTICATOR_ALGORITHM_V2 = 'hmac-sha256' as const;
export const AGENT_OS_EPOCH_SNAPSHOT_PAYLOAD_DOMAIN_V2 =
  'ashlr:agent-os:epoch-snapshot:payload:v2\0' as const;
export const AGENT_OS_EPOCH_SNAPSHOT_ENVELOPE_DOMAIN_V2 =
  'ashlr:agent-os:epoch-snapshot:envelope:v2\0' as const;
export const AGENT_OS_EPOCH_SNAPSHOT_AUTHENTICATOR_DOMAIN_V2 =
  'ashlr:agent-os:epoch-snapshot:authenticator:v2\0' as const;

const MAX_EPOCH = 999_999_999_999;
const MAX_SEQUENCE = 4_096;
const MAX_KEY_GENERATION = 1_000_000;
const MAX_CANONICAL_BYTES = 1024 * 1024;
const MAX_CANONICAL_DEPTH = 32;
const MAX_CANONICAL_NODES = 100_000;
const MAX_TEXT_BYTES = 512;
const MAX_RENDER_LAG_MS = 5 * 60_000;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type Canonical = null | boolean | number | string | Canonical[] | { [key: string]: Canonical };

export interface AgentOsEpochSnapshotPayloadV2 {
  snapshot: AgentOsReadModelV1;
  snapshotDigest: string;
}

export interface AgentOsEpochSnapshotInputV2 {
  epoch: number;
  epochSequence: number;
  anchoredHeadDigest: string;
  epochManifestDigest: string;
  attemptNamespaceDigest: string;
  producerAttemptId: string;
  producerStartReceiptDigest: string;
  durableTickDigest: string;
  sourceBundleDigest: string;
  trustPolicyDigest: string;
  previousEnvelopeDigest: string;
  renderedAt: string;
  observedAt: string;
  kernelCycleDigest: string;
  capabilityProjectionDigest: string;
  portfolioDigest: string;
  snapshot: AgentOsReadModelV1;
  snapshotDigest: string;
}

export interface AgentOsEpochSnapshotEnvelopeV2 extends AgentOsEpochRecordAuthorityV1 {
  schemaVersion: 2;
  protocol: typeof AGENT_OS_EPOCH_SNAPSHOT_PROTOCOL_V2;
  recordType: 'agent-os-epoch-snapshot';
  epoch: number;
  epochSequence: number;
  anchoredHeadDigest: string;
  epochManifestDigest: string;
  attemptNamespaceDigest: string;
  producerAttemptId: string;
  producerStartReceiptDigest: string;
  durableTickDigest: string;
  sourceBundleDigest: string;
  trustPolicyDigest: string;
  previousEnvelopeDigest: string;
  renderedAt: string;
  observedAt: string;
  producerIdentityDigest: string;
  authenticatorKeyId: string;
  authenticatorKeyGeneration: number;
  authenticatorAlgorithm: typeof AGENT_OS_EPOCH_SNAPSHOT_AUTHENTICATOR_ALGORITHM_V2;
  kernelCycleDigest: string;
  capabilityProjectionDigest: string;
  portfolioDigest: string;
  payload: AgentOsEpochSnapshotPayloadV2;
  payloadDigest: string;
  envelopeDigest: string;
  authenticator: string;
}

type AgentOsEpochSnapshotUnsignedV2 = Omit<
  AgentOsEpochSnapshotEnvelopeV2,
  'envelopeDigest' | 'authenticator'
>;

export interface AgentOsEpochSnapshotSignerV2 {
  readonly producerIdentityDigest: string;
  readonly keyId: string;
  readonly keyGeneration: number;
  sign(canonicalDomainSeparatedEnvelope: Uint8Array): string | null;
}

export interface AgentOsEpochSnapshotVerifierV2 {
  readonly producerIdentityDigest: string;
  readonly keyId: string;
  readonly keyGeneration: number;
  verify(input: Readonly<{
    producerIdentityDigest: string;
    keyId: string;
    keyGeneration: number;
    canonicalDomainSeparatedEnvelope: Uint8Array;
    authenticator: string;
  }>): boolean;
}

/** Authenticated active-epoch facts selected by the future runtime composition root. */
export interface AgentOsEpochSnapshotClosureContextV2 {
  epoch: number;
  anchoredHeadDigest: string;
  epochManifestDigest: string;
  attemptNamespaceDigest: string;
  producerAttemptId: string;
  producerStartReceiptDigest: string;
  durableTickDigest: string;
  sourceBundleDigest: string;
  trustPolicyDigest: string;
  snapshotBasePreviousEnvelopeDigest: string;
  expectedSequence: number;
  expectedPreviousEnvelopeDigest: string;
  expectedProducerIdentityDigest: string;
  expectedAuthenticatorKeyId: string;
  expectedAuthenticatorKeyGeneration: number;
}

export interface AgentOsEpochSnapshotClosureContextVerifierV2 {
  verify(context: Readonly<AgentOsEpochSnapshotClosureContextV2>): boolean;
}

const AUTHORITY_KEYS = Object.keys(AGENT_OS_EPOCH_RECORD_AUTHORITY_V1);
const INPUT_KEYS = [
  'epoch', 'epochSequence', 'anchoredHeadDigest', 'epochManifestDigest',
  'attemptNamespaceDigest', 'producerAttemptId', 'producerStartReceiptDigest',
  'durableTickDigest', 'sourceBundleDigest',
  'trustPolicyDigest', 'previousEnvelopeDigest', 'renderedAt', 'observedAt',
  'kernelCycleDigest', 'capabilityProjectionDigest', 'portfolioDigest', 'snapshot', 'snapshotDigest',
] as const;
const PAYLOAD_KEYS = ['snapshot', 'snapshotDigest'] as const;
const UNSIGNED_KEYS = [
  ...AUTHORITY_KEYS, 'schemaVersion', 'protocol', 'recordType', 'epoch', 'epochSequence',
  'anchoredHeadDigest', 'epochManifestDigest', 'attemptNamespaceDigest', 'producerAttemptId',
  'producerStartReceiptDigest', 'durableTickDigest', 'sourceBundleDigest',
  'trustPolicyDigest', 'previousEnvelopeDigest',
  'renderedAt', 'observedAt', 'producerIdentityDigest', 'authenticatorKeyId',
  'authenticatorKeyGeneration', 'authenticatorAlgorithm', 'kernelCycleDigest',
  'capabilityProjectionDigest', 'portfolioDigest', 'payload', 'payloadDigest',
] as const;
const ENVELOPE_KEYS = [...UNSIGNED_KEYS, 'envelopeDigest', 'authenticator'] as const;
const CONTEXT_KEYS = [
  'epoch', 'anchoredHeadDigest', 'epochManifestDigest', 'attemptNamespaceDigest',
  'producerAttemptId', 'producerStartReceiptDigest', 'durableTickDigest',
  'sourceBundleDigest', 'trustPolicyDigest',
  'snapshotBasePreviousEnvelopeDigest', 'expectedSequence', 'expectedPreviousEnvelopeDigest',
  'expectedProducerIdentityDigest', 'expectedAuthenticatorKeyId',
  'expectedAuthenticatorKeyGeneration',
] as const;
const SNAPSHOT_KEYS = [
  'sourceState', 'livingEndState', 'capabilitySpectrum', 'activeValueBets', 'nextAction',
] as const;
const END_STATE_KEYS = ['northStar', 'currentBottleneck', 'revisionLabel', 'evidenceState'] as const;
const CAPABILITY_KEYS = [
  'lane', 'label', 'state', 'headroom', 'resetUrgency', 'resetLabel', 'allocationLabel',
] as const;
const BET_KEYS = [
  'key', 'title', 'valueCase', 'allocationLabel', 'decision', 'assurance', 'outcome', 'evidence',
] as const;
const OUTCOME_KEYS = ['state', 'label'] as const;
const EVIDENCE_KEYS = ['state', 'label'] as const;
const NEXT_ACTION_KEYS = ['kind', 'title', 'reason', 'evidenceState'] as const;

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

function canonicalize(
  value: unknown,
  state = { depth: 0, nodes: 0, ancestors: new Set<object>() },
): Canonical {
  state.nodes += 1;
  if (state.nodes > MAX_CANONICAL_NODES || state.depth > MAX_CANONICAL_DEPTH) {
    throw new TypeError('canonical value exceeds bounds');
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new TypeError('non-canonical number');
    return value;
  }
  if (typeof value !== 'object' || state.ancestors.has(value)) throw new TypeError('non-json value');
  state.ancestors.add(value);
  state.depth += 1;
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol' ||
        (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key)))) throw new TypeError('invalid array');
      return value.map((entry, index) => {
        if (!Object.hasOwn(value, index)) throw new TypeError('sparse array');
        return canonicalize(entry, state);
      });
    }
    const row = record(value);
    if (!row) throw new TypeError('non-plain object');
    const output: { [key: string]: Canonical } = Object.create(null) as { [key: string]: Canonical };
    for (const key of Object.keys(row).sort()) output[key] = canonicalize(row[key], state);
    return output;
  } finally {
    state.depth -= 1;
    state.ancestors.delete(value);
  }
}

function canonicalBytes(value: unknown): Buffer | null {
  try {
    const bytes = Buffer.from(JSON.stringify(canonicalize(value)), 'utf8');
    return bytes.length > 1 && bytes.length <= MAX_CANONICAL_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

function exactBytes(left: Uint8Array, right: Uint8Array): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function rawDigest(domain: string, bytes: Uint8Array): string {
  return createHash('sha256').update(domain, 'utf8').update(bytes).digest('hex');
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && TIMESTAMP_RE.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function safeText(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES;
}

function enumValue(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === 'string' && allowed.includes(value);
}

function validAuthority(value: Record<string, unknown>): boolean {
  return AUTHORITY_KEYS.every((key) => value[key] ===
    AGENT_OS_EPOCH_RECORD_AUTHORITY_V1[key as keyof AgentOsEpochRecordAuthorityV1]);
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
  const spectrum = snapshot['capabilitySpectrum'];
  if (!Array.isArray(spectrum) || spectrum.length > 3 || spectrum.some((entry) => {
    const lane = record(entry);
    return !lane || !exactKeys(lane, CAPABILITY_KEYS) ||
      !enumValue(lane['lane'], ['codex', 'claude', 'local']) || !safeText(lane['label']) ||
      !enumValue(lane['state'], ['ready', 'tight', 'unavailable', 'unknown']) ||
      !enumValue(lane['headroom'], ['ample', 'usable', 'tight', 'none', 'unknown']) ||
      !enumValue(lane['resetUrgency'], ['now', 'soon', 'later', 'none', 'unknown']) ||
      !safeText(lane['resetLabel']) || !safeText(lane['allocationLabel']);
  })) return false;
  const bets = snapshot['activeValueBets'];
  if (!Array.isArray(bets) || bets.length > 3 || bets.some((entry) => {
    const bet = record(entry);
    const outcome = bet ? record(bet['outcome']) : null;
    const evidence = bet ? record(bet['evidence']) : null;
    return !bet || !exactKeys(bet, BET_KEYS) || !safeText(bet['key']) || !safeText(bet['title']) ||
      !safeText(bet['valueCase']) || !safeText(bet['allocationLabel']) ||
      !enumValue(bet['decision'], ['continue', 'observing', 'hold']) ||
      !enumValue(bet['assurance'], ['fast-path', 'targeted', 'deep']) ||
      !outcome || !exactKeys(outcome, OUTCOME_KEYS) ||
      !enumValue(outcome['state'], ['pending', 'effective', 'refuted', 'unknown']) ||
      !safeText(outcome['label']) || !evidence || !exactKeys(evidence, EVIDENCE_KEYS) ||
      !enumValue(evidence['state'], ['complete', 'pending', 'incomplete', 'unknown']) ||
      !safeText(evidence['label']);
  })) return false;
  const next = record(snapshot['nextAction']);
  return Boolean(next && exactKeys(next, NEXT_ACTION_KEYS) &&
    enumValue(next['kind'], ['exception', 'attention', 'clear']) && safeText(next['title']) &&
    safeText(next['reason']) &&
    enumValue(next['evidenceState'], ['complete', 'pending', 'incomplete', 'unknown']));
}

function validPayload(value: unknown): value is AgentOsEpochSnapshotPayloadV2 {
  const payload = record(value);
  return Boolean(payload && exactKeys(payload, PAYLOAD_KEYS) &&
    validSnapshot(payload['snapshot']) && isAgentOsPrefixedSha256DigestV1(payload['snapshotDigest']));
}

function validSigner(value: unknown): value is AgentOsEpochSnapshotSignerV2 {
  const signer = record(value);
  return Boolean(signer && exactKeys(signer, ['producerIdentityDigest', 'keyId', 'keyGeneration', 'sign']) &&
    isAgentOsPrefixedSha256DigestV1(signer['producerIdentityDigest']) &&
    isAgentOsRawSha256DigestV1(signer['keyId']) &&
    boundedInteger(signer['keyGeneration'], 0, MAX_KEY_GENERATION) && typeof signer['sign'] === 'function');
}

function validInput(value: unknown): value is AgentOsEpochSnapshotInputV2 {
  const input = record(value);
  if (!input || !exactKeys(input, INPUT_KEYS) || !boundedInteger(input['epoch'], 1, MAX_EPOCH) ||
    !boundedInteger(input['epochSequence'], 1, MAX_SEQUENCE) ||
    !isAgentOsPrefixedSha256DigestV1(input['anchoredHeadDigest']) ||
    !isAgentOsPrefixedSha256DigestV1(input['epochManifestDigest']) ||
    !isAgentOsPrefixedSha256DigestV1(input['attemptNamespaceDigest']) ||
    !isAgentOsPrefixedSha256DigestV1(input['producerAttemptId']) ||
    !isAgentOsRawSha256DigestV1(input['producerStartReceiptDigest']) ||
    !isAgentOsPrefixedSha256DigestV1(input['durableTickDigest']) ||
    !isAgentOsRawSha256DigestV1(input['sourceBundleDigest']) ||
    !isAgentOsRawSha256DigestV1(input['trustPolicyDigest']) ||
    !isAgentOsRawSha256DigestV1(input['previousEnvelopeDigest']) ||
    !timestamp(input['renderedAt']) || !timestamp(input['observedAt']) ||
    !isAgentOsRawSha256DigestV1(input['kernelCycleDigest']) ||
    !isAgentOsPrefixedSha256DigestV1(input['capabilityProjectionDigest']) ||
    !isAgentOsRawSha256DigestV1(input['portfolioDigest']) ||
    !validSnapshot(input['snapshot']) ||
    !isAgentOsPrefixedSha256DigestV1(input['snapshotDigest'])) return false;
  const renderedAt = Date.parse(input['renderedAt']);
  const observedAt = Date.parse(input['observedAt']);
  if (observedAt < renderedAt || observedAt - renderedAt > MAX_RENDER_LAG_MS) return false;
  if (input['producerAttemptId'] !== agentOsEpochAttemptIdV1({
    epoch: input['epoch'] as number,
    attemptNamespaceDigest: input['attemptNamespaceDigest'] as string,
    durableTickDigest: input['durableTickDigest'] as string,
  })) return false;
  return input['epochSequence'] === 1 ||
    input['previousEnvelopeDigest'] !== AGENT_OS_EPOCH_GENESIS_V1.snapshotTipDigest;
}

function validUnsigned(value: unknown): value is AgentOsEpochSnapshotUnsignedV2 {
  const row = record(value);
  if (!row || !exactKeys(row, UNSIGNED_KEYS) || !validAuthority(row) || row['schemaVersion'] !== 2 ||
    row['protocol'] !== AGENT_OS_EPOCH_SNAPSHOT_PROTOCOL_V2 ||
    row['recordType'] !== 'agent-os-epoch-snapshot' ||
    !isAgentOsPrefixedSha256DigestV1(row['producerIdentityDigest']) ||
    !isAgentOsRawSha256DigestV1(row['authenticatorKeyId']) ||
    !boundedInteger(row['authenticatorKeyGeneration'], 0, MAX_KEY_GENERATION) ||
    row['authenticatorAlgorithm'] !== AGENT_OS_EPOCH_SNAPSHOT_AUTHENTICATOR_ALGORITHM_V2 ||
    !validPayload(row['payload']) || !isAgentOsRawSha256DigestV1(row['payloadDigest'])) return false;
  const payloadBytes = canonicalBytes(row['payload']);
  if (!payloadBytes || row['payloadDigest'] !== rawDigest(AGENT_OS_EPOCH_SNAPSHOT_PAYLOAD_DOMAIN_V2, payloadBytes)) {
    return false;
  }
  const input = {
    epoch: row['epoch'], epochSequence: row['epochSequence'], anchoredHeadDigest: row['anchoredHeadDigest'],
    epochManifestDigest: row['epochManifestDigest'], attemptNamespaceDigest: row['attemptNamespaceDigest'],
    producerAttemptId: row['producerAttemptId'],
    producerStartReceiptDigest: row['producerStartReceiptDigest'],
    durableTickDigest: row['durableTickDigest'],
    sourceBundleDigest: row['sourceBundleDigest'], trustPolicyDigest: row['trustPolicyDigest'],
    previousEnvelopeDigest: row['previousEnvelopeDigest'], renderedAt: row['renderedAt'],
    observedAt: row['observedAt'], kernelCycleDigest: row['kernelCycleDigest'],
    capabilityProjectionDigest: row['capabilityProjectionDigest'], portfolioDigest: row['portfolioDigest'],
    snapshot: row['payload'].snapshot, snapshotDigest: row['payload'].snapshotDigest,
  };
  return validInput(input);
}

function validEnvelope(value: unknown): value is AgentOsEpochSnapshotEnvelopeV2 {
  const row = record(value);
  if (!row || !exactKeys(row, ENVELOPE_KEYS) || !isAgentOsRawSha256DigestV1(row['envelopeDigest']) ||
    !isAgentOsRawSha256DigestV1(row['authenticator'])) return false;
  const unsigned = Object.fromEntries(UNSIGNED_KEYS.map((key) => [key, row[key]]));
  const unsignedBytes = canonicalBytes(unsigned);
  return validUnsigned(unsigned) && unsignedBytes !== null &&
    row['envelopeDigest'] === rawDigest(AGENT_OS_EPOCH_SNAPSHOT_ENVELOPE_DOMAIN_V2, unsignedBytes);
}

function authenticatorPayload(unsigned: AgentOsEpochSnapshotUnsignedV2): Buffer | null {
  const bytes = canonicalBytes(unsigned);
  return bytes
    ? Buffer.concat([Buffer.from(AGENT_OS_EPOCH_SNAPSHOT_AUTHENTICATOR_DOMAIN_V2, 'utf8'), bytes])
    : null;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (ArrayBuffer.isView(value)) return value;
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
    Object.freeze(value);
  }
  return value;
}

function ownedFrozen<T>(value: T): T | null {
  const bytes = canonicalBytes(value);
  if (!bytes) return null;
  try { return deepFreeze(JSON.parse(bytes.toString('utf8')) as T); } catch { return null; }
}

export function createAgentOsEpochSnapshotEnvelopeV2(
  input: AgentOsEpochSnapshotInputV2,
  signer: AgentOsEpochSnapshotSignerV2,
): AgentOsEpochSnapshotEnvelopeV2 | null {
  try {
    if (!validInput(input) || !validSigner(signer)) return null;
    const ownedInput = ownedFrozen(input);
    if (!ownedInput) return null;
    const payload: AgentOsEpochSnapshotPayloadV2 = {
      snapshot: ownedInput.snapshot,
      snapshotDigest: ownedInput.snapshotDigest,
    };
    const payloadBytes = canonicalBytes(payload);
    if (!payloadBytes) return null;
    const unsigned: AgentOsEpochSnapshotUnsignedV2 = {
      schemaVersion: 2,
      protocol: AGENT_OS_EPOCH_SNAPSHOT_PROTOCOL_V2,
      recordType: 'agent-os-epoch-snapshot',
      ...AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
      epoch: ownedInput.epoch,
      epochSequence: ownedInput.epochSequence,
      anchoredHeadDigest: ownedInput.anchoredHeadDigest,
      epochManifestDigest: ownedInput.epochManifestDigest,
      attemptNamespaceDigest: ownedInput.attemptNamespaceDigest,
      producerAttemptId: ownedInput.producerAttemptId,
      producerStartReceiptDigest: ownedInput.producerStartReceiptDigest,
      durableTickDigest: ownedInput.durableTickDigest,
      sourceBundleDigest: ownedInput.sourceBundleDigest,
      trustPolicyDigest: ownedInput.trustPolicyDigest,
      previousEnvelopeDigest: ownedInput.previousEnvelopeDigest,
      renderedAt: ownedInput.renderedAt,
      observedAt: ownedInput.observedAt,
      producerIdentityDigest: signer.producerIdentityDigest,
      authenticatorKeyId: signer.keyId,
      authenticatorKeyGeneration: signer.keyGeneration,
      authenticatorAlgorithm: AGENT_OS_EPOCH_SNAPSHOT_AUTHENTICATOR_ALGORITHM_V2,
      kernelCycleDigest: ownedInput.kernelCycleDigest,
      capabilityProjectionDigest: ownedInput.capabilityProjectionDigest,
      portfolioDigest: ownedInput.portfolioDigest,
      payload,
      payloadDigest: rawDigest(AGENT_OS_EPOCH_SNAPSHOT_PAYLOAD_DOMAIN_V2, payloadBytes),
    };
    if (!validUnsigned(unsigned)) return null;
    const unsignedBytes = canonicalBytes(unsigned);
    const signedBytes = authenticatorPayload(unsigned);
    if (!unsignedBytes || !signedBytes) return null;
    const envelopeDigest = rawDigest(AGENT_OS_EPOCH_SNAPSHOT_ENVELOPE_DOMAIN_V2, unsignedBytes);
    const callbackBytes = Buffer.from(signedBytes);
    const callbackBytesBefore = Buffer.from(callbackBytes);
    const authenticator = signer.sign(callbackBytes);
    if (!exactBytes(callbackBytes, callbackBytesBefore) ||
      !isAgentOsRawSha256DigestV1(authenticator)) return null;
    const envelope = { ...unsigned, envelopeDigest, authenticator };
    return validEnvelope(envelope) ? ownedFrozen(envelope) : null;
  } catch {
    return null;
  }
}

export function canonicalAgentOsEpochSnapshotEnvelopeBytesV2(value: unknown): Buffer | null {
  return validEnvelope(value) ? canonicalBytes(value) : null;
}

export function parseAgentOsEpochSnapshotEnvelopeV2(
  bytes: Uint8Array,
): AgentOsEpochSnapshotEnvelopeV2 | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > MAX_CANONICAL_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    const canonical = canonicalAgentOsEpochSnapshotEnvelopeBytesV2(parsed);
    return canonical && exactBytes(bytes, canonical)
      ? ownedFrozen(parsed as AgentOsEpochSnapshotEnvelopeV2)
      : null;
  } catch {
    return null;
  }
}

function validContext(value: unknown): value is AgentOsEpochSnapshotClosureContextV2 {
  const context = record(value);
  if (!context || !exactKeys(context, CONTEXT_KEYS) || !boundedInteger(context['epoch'], 1, MAX_EPOCH) ||
    !isAgentOsPrefixedSha256DigestV1(context['anchoredHeadDigest']) ||
    !isAgentOsPrefixedSha256DigestV1(context['epochManifestDigest']) ||
    !isAgentOsPrefixedSha256DigestV1(context['attemptNamespaceDigest']) ||
    !isAgentOsPrefixedSha256DigestV1(context['producerAttemptId']) ||
    !isAgentOsRawSha256DigestV1(context['producerStartReceiptDigest']) ||
    !isAgentOsPrefixedSha256DigestV1(context['durableTickDigest']) ||
    !isAgentOsRawSha256DigestV1(context['sourceBundleDigest']) ||
    !isAgentOsRawSha256DigestV1(context['trustPolicyDigest']) ||
    !isAgentOsRawSha256DigestV1(context['snapshotBasePreviousEnvelopeDigest']) ||
    !boundedInteger(context['expectedSequence'], 1, MAX_SEQUENCE) ||
    !isAgentOsRawSha256DigestV1(context['expectedPreviousEnvelopeDigest']) ||
    !isAgentOsPrefixedSha256DigestV1(context['expectedProducerIdentityDigest']) ||
    !isAgentOsRawSha256DigestV1(context['expectedAuthenticatorKeyId']) ||
    !boundedInteger(context['expectedAuthenticatorKeyGeneration'], 0, MAX_KEY_GENERATION)) return false;
  if (context['producerAttemptId'] !== agentOsEpochAttemptIdV1({
    epoch: context['epoch'] as number,
    attemptNamespaceDigest: context['attemptNamespaceDigest'] as string,
    durableTickDigest: context['durableTickDigest'] as string,
  })) return false;
  return context['expectedSequence'] === 1
    ? context['expectedPreviousEnvelopeDigest'] === context['snapshotBasePreviousEnvelopeDigest']
    : context['expectedPreviousEnvelopeDigest'] !== AGENT_OS_EPOCH_GENESIS_V1.snapshotTipDigest;
}

function validVerifier(value: unknown): value is AgentOsEpochSnapshotVerifierV2 {
  const verifier = record(value);
  return Boolean(verifier && exactKeys(verifier, [
    'producerIdentityDigest', 'keyId', 'keyGeneration', 'verify',
  ]) && isAgentOsPrefixedSha256DigestV1(verifier['producerIdentityDigest']) &&
    isAgentOsRawSha256DigestV1(verifier['keyId']) &&
    boundedInteger(verifier['keyGeneration'], 0, MAX_KEY_GENERATION) && typeof verifier['verify'] === 'function');
}

export function verifyAgentOsEpochSnapshotEnvelopeV2(
  value: unknown,
  context: AgentOsEpochSnapshotClosureContextV2,
  verifier: AgentOsEpochSnapshotVerifierV2,
  contextVerifier: AgentOsEpochSnapshotClosureContextVerifierV2,
): AgentOsEpochSnapshotEnvelopeV2 | null {
  try {
    const canonical = canonicalAgentOsEpochSnapshotEnvelopeBytesV2(value);
    const contextRow = record(contextVerifier);
    if (!canonical || !validContext(context) || !validVerifier(verifier) || !contextRow ||
      !exactKeys(contextRow, ['verify']) || typeof contextVerifier.verify !== 'function') return null;
    const ownedContext = ownedFrozen(context);
    if (!ownedContext || contextVerifier.verify(ownedContext) !== true) return null;
    const envelope = parseAgentOsEpochSnapshotEnvelopeV2(canonical);
    if (!envelope || envelope.epoch !== ownedContext.epoch ||
      envelope.anchoredHeadDigest !== ownedContext.anchoredHeadDigest ||
      envelope.epochManifestDigest !== ownedContext.epochManifestDigest ||
      envelope.attemptNamespaceDigest !== ownedContext.attemptNamespaceDigest ||
      envelope.producerAttemptId !== ownedContext.producerAttemptId ||
      envelope.producerStartReceiptDigest !== ownedContext.producerStartReceiptDigest ||
      envelope.durableTickDigest !== ownedContext.durableTickDigest ||
      envelope.sourceBundleDigest !== ownedContext.sourceBundleDigest ||
      envelope.trustPolicyDigest !== ownedContext.trustPolicyDigest ||
      envelope.epochSequence !== ownedContext.expectedSequence ||
      envelope.previousEnvelopeDigest !== ownedContext.expectedPreviousEnvelopeDigest ||
      envelope.producerIdentityDigest !== ownedContext.expectedProducerIdentityDigest ||
      envelope.authenticatorKeyId !== ownedContext.expectedAuthenticatorKeyId ||
      envelope.authenticatorKeyGeneration !== ownedContext.expectedAuthenticatorKeyGeneration ||
      verifier.producerIdentityDigest !== envelope.producerIdentityDigest ||
      verifier.keyId !== envelope.authenticatorKeyId ||
      verifier.keyGeneration !== envelope.authenticatorKeyGeneration) return null;
    const envelopeRow = envelope as unknown as Record<string, unknown>;
    const unsigned = Object.fromEntries(UNSIGNED_KEYS.map((key) => [key, envelopeRow[key]]));
    if (!validUnsigned(unsigned)) return null;
    const signedBytes = authenticatorPayload(unsigned);
    if (!signedBytes) return null;
    const callbackBytes = Buffer.from(signedBytes);
    const callbackBytesBefore = Buffer.from(callbackBytes);
    const request = deepFreeze({
      producerIdentityDigest: envelope.producerIdentityDigest,
      keyId: envelope.authenticatorKeyId,
      keyGeneration: envelope.authenticatorKeyGeneration,
      canonicalDomainSeparatedEnvelope: callbackBytes,
      authenticator: envelope.authenticator,
    });
    let authenticated = false;
    try { authenticated = verifier.verify(request) === true; } catch { /* fail closed */ }
    if (!authenticated || !exactBytes(callbackBytes, callbackBytesBefore)) return null;
    const reparsed = parseAgentOsEpochSnapshotEnvelopeV2(canonical);
    return reparsed?.envelopeDigest === envelope.envelopeDigest ? reparsed : null;
  } catch {
    return null;
  }
}
