/**
 * Privacy-safe, host-local binding capability for the Locus observation
 * boundary. Raw audience labels and workspace locators are private caller
 * labels, not canonical filesystem identity or workspace-truth evidence. They
 * are used only as context-separated HMAC inputs and are never returned or
 * persisted here.
 *
 * This capability supplies M547 expectation values. It grants no truth,
 * policy, release, execution, or effect authority, and a shared host key does
 * not protect it from a malicious process running as the same OS user.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { loadExistingProvenanceKeyReadOnly } from '../foundry/provenance.js';
import {
  LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST,
  LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_FUTURE_SKEW_MS,
  LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_LIFETIME_MS,
  LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_SEQUENCE,
  type ExternalLocusWorkspaceIdentityExpectationsV1,
} from './external-locus-workspace-identity.js';

export const LOCUS_BINDING_CAPABILITY_PROTOCOL = 'ashlr-locus-binding-capability-v1' as const;
export const LOCUS_BINDING_CAPABILITY_PURPOSE = 'locus-workspace-identity-observation' as const;
export const LOCUS_BINDING_CAPABILITY_MAX_BYTES = 8 * 1024;
export const LOCUS_BINDING_CAPABILITY_MAX_AUDIENCE_BYTES = 512;
export const LOCUS_BINDING_CAPABILITY_MAX_WORKSPACE_BYTES = 4 * 1024;
export const LOCUS_BINDING_CAPABILITY_NONCE_BYTES = 32;
export const LOCUS_BINDING_CAPABILITY_MIN_LIFETIME_MS = 1_000;

const RECORD_TYPE = 'locus-binding-capability' as const;
const PRIVACY_CLASS = 'keyed-opaque-digests-only' as const;
const AUDIENCE_DOMAIN = 'ashlr:locus-binding-capability:audience:v1\0';
const WORKSPACE_DOMAIN = 'ashlr:locus-binding-capability:workspace:v1\0';
const IDENTITY_DOMAIN = 'ashlr:locus-binding-capability:identity:v1\0';
const ATTESTATION_DOMAIN = 'ashlr:locus-binding-capability:attestation:v1\0';
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const CAPABILITY_ID_RE = /^hmac-sha256:[a-f0-9]{64}$/;
const ATTESTATION_RE = /^hmac-sha256:[a-f0-9]{64}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_CANONICAL_DEPTH = 4;
const MAX_CANONICAL_NODES = 64;

const CAPABILITY_KEYS = [
  'schemaVersion', 'protocol', 'recordType', 'authority', 'capabilityScope', 'sourceState', 'purpose',
  'privacyClass', 'policyGeneration', 'issuedAt', 'expiresAt', 'sequence',
  'previousObservationDigest', 'audienceDigest', 'workspaceDigest', 'nonce',
  'sameUserTamperResistant', 'rollbackProtected', 'truthVerified',
  'releaseProvenanceVerified', 'policyGenerationVerified', 'trusted', 'planningAuthority',
  'executionAuthority', 'effectAuthority', 'proposalAuthority', 'routingAuthority',
  'reservationAuthority', 'budgetAuthority', 'credentialAuthority', 'learningAuthority',
  'policyAuthority', 'promotionAuthority', 'verificationAuthority', 'mergeAuthority',
  'releaseAuthority', 'deployAuthority', 'publicationAuthority', 'externalMutationAuthority',
  'policyEligible', 'promotionEligible', 'capabilityId', 'attestation',
] as const;
const UNSIGNED_KEYS = CAPABILITY_KEYS.filter((key) => key !== 'capabilityId' && key !== 'attestation');

export interface MintLocusBindingCapabilityInputV1 {
  /** Private human/audience label. It is never returned or persisted. */
  audienceLabel: string;
  /** Private path or workspace locator. It is never returned or persisted. */
  workspaceLocator: string;
  purpose: typeof LOCUS_BINDING_CAPABILITY_PURPOSE;
  policyGeneration: number;
  sequence: number;
  previousObservationDigest: string;
  lifetimeMs: number;
}

export interface LocusBindingCapabilityV1 {
  schemaVersion: 1;
  protocol: typeof LOCUS_BINDING_CAPABILITY_PROTOCOL;
  recordType: typeof RECORD_TYPE;
  authority: 'observation-only';
  capabilityScope: 'expectation-only';
  sourceState: 'host-local-unverified';
  purpose: typeof LOCUS_BINDING_CAPABILITY_PURPOSE;
  privacyClass: typeof PRIVACY_CLASS;
  policyGeneration: number;
  issuedAt: string;
  expiresAt: string;
  sequence: number;
  previousObservationDigest: string;
  audienceDigest: string;
  workspaceDigest: string;
  nonce: string;
  sameUserTamperResistant: false;
  rollbackProtected: false;
  truthVerified: false;
  releaseProvenanceVerified: false;
  policyGenerationVerified: false;
  trusted: false;
  planningAuthority: false;
  executionAuthority: false;
  effectAuthority: false;
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
  capabilityId: string;
  attestation: string;
}

export interface LocusBindingCapabilityVerificationContextV1 {
  capabilityId: string;
  purpose: typeof LOCUS_BINDING_CAPABILITY_PURPOSE;
  policyGeneration: number;
}

export interface LocusBindingCapabilityDependenciesV1 {
  /** Existing 32-byte host provenance key. The default creates nothing. */
  key: () => Buffer | null;
  now: () => Date;
  randomBytes: (size: number) => Buffer;
}

export type LocusBindingCapabilityIssueV1 =
  | 'invalid-input'
  | 'key-unavailable'
  | 'entropy-unavailable'
  | 'invalid-bytes'
  | 'oversized-capability'
  | 'non-canonical-json'
  | 'invalid-capability'
  | 'context-mismatch'
  | 'future-capability'
  | 'expired-capability'
  | 'capability-id-mismatch'
  | 'attestation-mismatch';

export type MintLocusBindingCapabilityResultV1 =
  | { ok: true; capability: LocusBindingCapabilityV1; issue: null }
  | { ok: false; capability: null; issue: LocusBindingCapabilityIssueV1 };

export type VerifyLocusBindingCapabilityResultV1 =
  | { ok: true; expectations: ExternalLocusWorkspaceIdentityExpectationsV1; issue: null }
  | { ok: false; expectations: null; issue: LocusBindingCapabilityIssueV1 };

const DEFAULT_DEPENDENCIES: LocusBindingCapabilityDependenciesV1 = {
  key: () => loadExistingProvenanceKeyReadOnly(),
  now: () => new Date(),
  randomBytes: (size) => randomBytes(size),
};

type Canonical = null | boolean | number | string | Canonical[] | { [key: string]: Canonical };

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || !descriptors[String(key)]?.enumerable ||
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
    throw new TypeError('value exceeds bounds');
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || state.ancestors.has(value)) throw new TypeError('non-json value');
  state.ancestors.add(value);
  state.depth += 1;
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol' ||
        (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key)))) throw new TypeError('invalid array');
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

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function hmac(key: Buffer, domain: string, value: unknown): string {
  return createHmac('sha256', key).update(domain, 'utf8').update(canonicalJson(value), 'utf8').digest('hex');
}

function keyedDigest(key: Buffer, domain: string, value: unknown): string {
  return `sha256:${hmac(key, domain, value)}`;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function boundedPrivateString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.normalize('NFC') &&
    value === value.trim() && ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    }) &&
    Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function validKey(value: unknown): value is Buffer {
  return Buffer.isBuffer(value) && value.length === 32;
}

function safeEqualHex(left: string, right: string): boolean {
  const first = Buffer.from(left, 'hex');
  const second = Buffer.from(right, 'hex');
  return first.length === 32 && second.length === 32 && timingSafeEqual(first, second);
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function failure(issue: LocusBindingCapabilityIssueV1): MintLocusBindingCapabilityResultV1 {
  return deepFreeze({ ok: false as const, capability: null, issue });
}

function verifyFailure(issue: LocusBindingCapabilityIssueV1): VerifyLocusBindingCapabilityResultV1 {
  return deepFreeze({ ok: false as const, expectations: null, issue });
}

function validLineage(sequence: unknown, previous: unknown): sequence is number {
  return Number.isSafeInteger(sequence) && Number(sequence) >= 1 &&
    Number(sequence) <= LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_SEQUENCE &&
    typeof previous === 'string' && DIGEST_RE.test(previous) &&
    ((sequence === 1) === (previous === LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST));
}

function unsignedCapability(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(UNSIGNED_KEYS.map((key) => [key, value[key]]));
}

function validCapability(
  value: Record<string, unknown>,
): value is Record<string, unknown> & LocusBindingCapabilityV1 {
  if (!exactKeys(value, CAPABILITY_KEYS) || value['schemaVersion'] !== 1 ||
      value['protocol'] !== LOCUS_BINDING_CAPABILITY_PROTOCOL || value['recordType'] !== RECORD_TYPE ||
      value['authority'] !== 'observation-only' || value['capabilityScope'] !== 'expectation-only' ||
      value['sourceState'] !== 'host-local-unverified' ||
      value['purpose'] !== LOCUS_BINDING_CAPABILITY_PURPOSE || value['privacyClass'] !== PRIVACY_CLASS ||
      !Number.isSafeInteger(value['policyGeneration']) || Number(value['policyGeneration']) < 1 ||
      !canonicalTimestamp(value['issuedAt']) || !canonicalTimestamp(value['expiresAt']) ||
      !validLineage(value['sequence'], value['previousObservationDigest']) ||
      typeof value['audienceDigest'] !== 'string' || !DIGEST_RE.test(value['audienceDigest']) ||
      typeof value['workspaceDigest'] !== 'string' || !DIGEST_RE.test(value['workspaceDigest']) ||
      typeof value['nonce'] !== 'string' || !NONCE_RE.test(value['nonce']) ||
      typeof value['capabilityId'] !== 'string' || !CAPABILITY_ID_RE.test(value['capabilityId']) ||
      typeof value['attestation'] !== 'string' || !ATTESTATION_RE.test(value['attestation'])) return false;
  for (const key of [
    'sameUserTamperResistant', 'rollbackProtected', 'truthVerified',
    'releaseProvenanceVerified', 'policyGenerationVerified', 'trusted', 'planningAuthority',
    'executionAuthority', 'effectAuthority', 'proposalAuthority', 'routingAuthority',
    'reservationAuthority', 'budgetAuthority', 'credentialAuthority', 'learningAuthority',
    'policyAuthority', 'promotionAuthority', 'verificationAuthority', 'mergeAuthority',
    'releaseAuthority', 'deployAuthority', 'publicationAuthority', 'externalMutationAuthority',
    'policyEligible', 'promotionEligible',
  ] as const) if (value[key] !== false) return false;
  const issuedAt = Date.parse(value['issuedAt'] as string);
  const expiresAt = Date.parse(value['expiresAt'] as string);
  return expiresAt > issuedAt &&
    expiresAt - issuedAt >= LOCUS_BINDING_CAPABILITY_MIN_LIFETIME_MS &&
    expiresAt - issuedAt <= LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_LIFETIME_MS;
}

/** Mint an opaque binding from private inputs using only an already-existing key. */
export function mintLocusBindingCapabilityV1(
  candidate: MintLocusBindingCapabilityInputV1,
  dependencies: LocusBindingCapabilityDependenciesV1 = DEFAULT_DEPENDENCIES,
): MintLocusBindingCapabilityResultV1 {
  const input = record(candidate);
  if (!input || !exactKeys(input, [
    'audienceLabel', 'workspaceLocator', 'purpose', 'policyGeneration', 'sequence',
    'previousObservationDigest', 'lifetimeMs',
  ]) || !boundedPrivateString(input['audienceLabel'], LOCUS_BINDING_CAPABILITY_MAX_AUDIENCE_BYTES) ||
      !boundedPrivateString(input['workspaceLocator'], LOCUS_BINDING_CAPABILITY_MAX_WORKSPACE_BYTES) ||
      input['purpose'] !== LOCUS_BINDING_CAPABILITY_PURPOSE ||
      !Number.isSafeInteger(input['policyGeneration']) || Number(input['policyGeneration']) < 1 ||
      !validLineage(input['sequence'], input['previousObservationDigest']) ||
      !Number.isSafeInteger(input['lifetimeMs']) ||
      Number(input['lifetimeMs']) < LOCUS_BINDING_CAPABILITY_MIN_LIFETIME_MS ||
      Number(input['lifetimeMs']) > LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_LIFETIME_MS) {
    return failure('invalid-input');
  }

  let key: Buffer | null;
  try { key = dependencies.key(); } catch { key = null; }
  if (!validKey(key)) return failure('key-unavailable');
  key = Buffer.from(key);

  let nonce: Buffer;
  try { nonce = Buffer.from(dependencies.randomBytes(LOCUS_BINDING_CAPABILITY_NONCE_BYTES)); } catch {
    return failure('entropy-unavailable');
  }
  if (nonce.length !== LOCUS_BINDING_CAPABILITY_NONCE_BYTES) return failure('entropy-unavailable');

  let issuedAtMs: number;
  let issuedAt: string;
  let expiresAt: string;
  try {
    issuedAtMs = dependencies.now().getTime();
    issuedAt = new Date(issuedAtMs).toISOString();
    expiresAt = new Date(issuedAtMs + Number(input['lifetimeMs'])).toISOString();
  } catch {
    return failure('invalid-input');
  }

  const unsigned = {
    schemaVersion: 1 as const,
    protocol: LOCUS_BINDING_CAPABILITY_PROTOCOL,
    recordType: RECORD_TYPE,
    authority: 'observation-only' as const,
    capabilityScope: 'expectation-only' as const,
    sourceState: 'host-local-unverified' as const,
    purpose: LOCUS_BINDING_CAPABILITY_PURPOSE,
    privacyClass: PRIVACY_CLASS,
    policyGeneration: input['policyGeneration'] as number,
    issuedAt,
    expiresAt,
    sequence: input['sequence'] as number,
    previousObservationDigest: input['previousObservationDigest'] as string,
    audienceDigest: keyedDigest(key, AUDIENCE_DOMAIN, [
      LOCUS_BINDING_CAPABILITY_PURPOSE,
      input['policyGeneration'],
      input['audienceLabel'],
    ]),
    workspaceDigest: '',
    nonce: nonce.toString('base64url'),
    sameUserTamperResistant: false as const,
    rollbackProtected: false as const,
    truthVerified: false as const,
    releaseProvenanceVerified: false as const,
    policyGenerationVerified: false as const,
    trusted: false as const,
    planningAuthority: false as const,
    executionAuthority: false as const,
    effectAuthority: false as const,
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
  };
  unsigned.workspaceDigest = keyedDigest(key, WORKSPACE_DOMAIN, [
    LOCUS_BINDING_CAPABILITY_PURPOSE,
    input['policyGeneration'],
    unsigned.audienceDigest,
    input['workspaceLocator'],
  ]);
  const capabilityId = `hmac-sha256:${hmac(key, IDENTITY_DOMAIN, unsigned)}`;
  const capability: LocusBindingCapabilityV1 = {
    ...unsigned,
    capabilityId,
    attestation: `hmac-sha256:${hmac(key, ATTESTATION_DOMAIN, [capabilityId, unsigned])}`,
  };
  if (Buffer.byteLength(canonicalJson(capability), 'utf8') > LOCUS_BINDING_CAPABILITY_MAX_BYTES) {
    return failure('invalid-input');
  }
  return deepFreeze({ ok: true as const, capability: deepFreeze(capability), issue: null });
}

/** Return the one canonical UTF-8 representation accepted by the verifier. */
export function canonicalLocusBindingCapabilityBytesV1(value: unknown): Buffer | null {
  const candidate = record(value);
  if (!candidate || !validCapability(candidate)) return null;
  try {
    const bytes = Buffer.from(canonicalJson(candidate), 'utf8');
    return bytes.length <= LOCUS_BINDING_CAPABILITY_MAX_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Verify one exact capability and reveal only the four expectation values M547
 * accepts. Exact replay is idempotent only for the same capability id, purpose,
 * policy generation, and validity window; downstream lineage provides durable
 * replay/fork rejection for accepted observations.
 */
export function verifyLocusBindingCapabilityV1(
  bytes: Uint8Array,
  context: LocusBindingCapabilityVerificationContextV1,
  dependencies: Pick<LocusBindingCapabilityDependenciesV1, 'key' | 'now'> = DEFAULT_DEPENDENCIES,
): VerifyLocusBindingCapabilityResultV1 {
  if (!(bytes instanceof Uint8Array)) return verifyFailure('invalid-bytes');
  const owned = Buffer.from(bytes);
  if (owned.length === 0) return verifyFailure('invalid-bytes');
  if (owned.length > LOCUS_BINDING_CAPABILITY_MAX_BYTES) return verifyFailure('oversized-capability');

  let parsed: unknown;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(owned);
    parsed = JSON.parse(text);
  } catch {
    return verifyFailure('invalid-bytes');
  }
  const candidate = record(parsed);
  if (!candidate || !validCapability(candidate)) return verifyFailure('invalid-capability');
  let canonical: string;
  try { canonical = canonicalJson(candidate); } catch { return verifyFailure('invalid-capability'); }
  if (!Buffer.from(canonical, 'utf8').equals(owned)) return verifyFailure('non-canonical-json');

  const verificationContext = record(context);
  if (!verificationContext || !exactKeys(verificationContext, ['capabilityId', 'purpose', 'policyGeneration']) ||
      typeof verificationContext['capabilityId'] !== 'string' ||
      !CAPABILITY_ID_RE.test(verificationContext['capabilityId']) ||
      verificationContext['purpose'] !== LOCUS_BINDING_CAPABILITY_PURPOSE ||
      !Number.isSafeInteger(verificationContext['policyGeneration']) ||
      Number(verificationContext['policyGeneration']) < 1 ||
      candidate['capabilityId'] !== verificationContext['capabilityId'] ||
      candidate['purpose'] !== verificationContext['purpose'] ||
      candidate['policyGeneration'] !== verificationContext['policyGeneration']) {
    return verifyFailure('context-mismatch');
  }

  let nowMs: number;
  try { nowMs = dependencies.now().getTime(); } catch { return verifyFailure('invalid-capability'); }
  if (!Number.isFinite(nowMs)) return verifyFailure('invalid-capability');
  const issuedAtMs = Date.parse(candidate['issuedAt'] as string);
  const expiresAtMs = Date.parse(candidate['expiresAt'] as string);
  if (issuedAtMs > nowMs + LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_FUTURE_SKEW_MS) {
    return verifyFailure('future-capability');
  }
  if (expiresAtMs <= nowMs) return verifyFailure('expired-capability');

  let key: Buffer | null;
  try { key = dependencies.key(); } catch { key = null; }
  if (!validKey(key)) return verifyFailure('key-unavailable');
  key = Buffer.from(key);

  const unsigned = unsignedCapability(candidate);
  const expectedId = hmac(key, IDENTITY_DOMAIN, unsigned);
  const actualId = (candidate['capabilityId'] as string).slice('hmac-sha256:'.length);
  if (!safeEqualHex(actualId, expectedId)) return verifyFailure('capability-id-mismatch');
  const expectedAttestation = hmac(key, ATTESTATION_DOMAIN, [candidate['capabilityId'], unsigned]);
  const actualAttestation = (candidate['attestation'] as string).slice('hmac-sha256:'.length);
  if (!safeEqualHex(actualAttestation, expectedAttestation)) return verifyFailure('attestation-mismatch');

  return deepFreeze({
    ok: true as const,
    expectations: deepFreeze({
      audienceDigest: candidate['audienceDigest'] as string,
      workspaceDigest: candidate['workspaceDigest'] as string,
      sequence: candidate['sequence'] as number,
      previousObservationDigest: candidate['previousObservationDigest'] as string,
    }),
    issue: null,
  });
}
