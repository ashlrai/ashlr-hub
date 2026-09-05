/**
 * Canonical signed source-renewal records for an active Agent OS epoch (M559).
 *
 * M555 deliberately defines only epoch sequence one. This module extends that
 * lineage with renewals numbered 2..4096. It performs no I/O, chooses no trust
 * root, and grants no operational authority. Verification obtains the active
 * epoch closure from an internally supplied provider and rereads it after the
 * signature callback so callback reentrancy cannot silently change context.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import {
  AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
  AGENT_OS_EPOCH_SOURCE_RAW_GENESIS_DIGEST_V2,
  type AgentOsEpochRecordAuthorityV1,
  type AgentOsPrefixedSha256DigestV1,
  type AgentOsRawSha256DigestV1,
} from './agent-os-epoch-records.js';

export const AGENT_OS_EPOCH_SOURCE_RENEWAL_PROTOCOL_V1 =
  'ashlr-agent-os-epoch-source-renewal-v1' as const;
export const AGENT_OS_EPOCH_SOURCE_RENEWAL_SIGNATURE_ALGORITHM_V1 = 'ed25519' as const;
export const AGENT_OS_EPOCH_SOURCE_RENEWAL_SIGNATURE_DOMAIN_V1 =
  'ashlr:agent-os:epoch-source-renewal:signature:v1\0' as const;
export const AGENT_OS_EPOCH_SOURCE_RENEWAL_DIGEST_DOMAIN_V1 =
  'ashlr:agent-os:epoch-source-renewal:digest:v1\0' as const;
export const AGENT_OS_EPOCH_SOURCE_RENEWAL_PAYLOAD_DOMAIN_V1 =
  'ashlr:agent-os:epoch-source-renewal:payload:v1\0' as const;

const RAW_DIGEST_RE = /^[a-f0-9]{64}$/u;
const PREFIXED_DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/u;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_EPOCH = 999_999_999_999;
const MAX_EPOCH_SEQUENCE = 4_096;
const MAX_POLICY_GENERATION = 1_000_000;
const MAX_PAYLOAD_BYTES = 768 * 1_024;
const MAX_CANONICAL_BYTES = 1_024 * 1_024;
const MAX_CANONICAL_DEPTH = 32;
const MAX_CANONICAL_NODES = 100_000;
const MAX_OUTCOME_PRINCIPALS = 12;
const MAX_SOURCE_LIFETIME_MS = 5 * 60_000;
const MAX_SOURCE_FUTURE_SKEW_MS = 60_000;

type Canonical = null | boolean | number | string | Canonical[] | { [key: string]: Canonical };

export interface AgentOsEpochSourceRenewalInputV1 {
  epoch: number;
  epochSequence: number;
  epochHeadDigest: AgentOsPrefixedSha256DigestV1;
  epochManifestDigest: AgentOsPrefixedSha256DigestV1;
  attemptNamespaceDigest: AgentOsPrefixedSha256DigestV1;
  previousBundleDigest: AgentOsRawSha256DigestV1;
  trustPolicyDigest: AgentOsRawSha256DigestV1;
  policyGeneration: number;
  sourceKeyId: AgentOsRawSha256DigestV1;
  sourcePrincipalDigest: AgentOsPrefixedSha256DigestV1;
  evidencePrincipalDigest: AgentOsPrefixedSha256DigestV1;
  outcomePrincipalDigests: AgentOsPrefixedSha256DigestV1[];
  issuedAt: string;
  expiresAt: string;
  sourcePayloadBytes: Uint8Array;
}

export interface AgentOsEpochSourceRenewalV1 extends AgentOsEpochRecordAuthorityV1 {
  schemaVersion: 1;
  protocol: typeof AGENT_OS_EPOCH_SOURCE_RENEWAL_PROTOCOL_V1;
  recordType: 'agent-os-epoch-source-renewal';
  epoch: number;
  epochSequence: number;
  epochHeadDigest: AgentOsPrefixedSha256DigestV1;
  epochManifestDigest: AgentOsPrefixedSha256DigestV1;
  attemptNamespaceDigest: AgentOsPrefixedSha256DigestV1;
  previousBundleDigest: AgentOsRawSha256DigestV1;
  trustPolicyDigest: AgentOsRawSha256DigestV1;
  policyGeneration: number;
  sourceKeyId: AgentOsRawSha256DigestV1;
  sourcePrincipalDigest: AgentOsPrefixedSha256DigestV1;
  evidencePrincipalDigest: AgentOsPrefixedSha256DigestV1;
  outcomePrincipalDigests: AgentOsPrefixedSha256DigestV1[];
  issuedAt: string;
  expiresAt: string;
  sourcePayload: string;
  sourcePayloadDigest: AgentOsPrefixedSha256DigestV1;
  signatureAlgorithm: typeof AGENT_OS_EPOCH_SOURCE_RENEWAL_SIGNATURE_ALGORITHM_V1;
  signature: string;
  bundleDigest: AgentOsRawSha256DigestV1;
}

type UnsignedRenewal = Omit<AgentOsEpochSourceRenewalV1, 'signature' | 'bundleDigest'>;

export interface AgentOsEpochSourceRenewalSignerV1 {
  readonly keyId: AgentOsRawSha256DigestV1;
  readonly principalDigest: AgentOsPrefixedSha256DigestV1;
  sign(canonicalDomainSeparatedPayload: Uint8Array): Uint8Array | null;
}

export interface AgentOsEpochSourceRenewalSignatureVerifierV1 {
  verify(input: Readonly<{
    keyId: AgentOsRawSha256DigestV1;
    principalDigest: AgentOsPrefixedSha256DigestV1;
    canonicalDomainSeparatedPayload: Uint8Array;
    signature: Uint8Array;
  }>): boolean;
}

export interface AgentOsEpochSourceRenewalActiveContextV1 {
  epoch: number;
  expectedEpochSequence: number;
  epochHeadDigest: AgentOsPrefixedSha256DigestV1;
  epochManifestDigest: AgentOsPrefixedSha256DigestV1;
  attemptNamespaceDigest: AgentOsPrefixedSha256DigestV1;
  currentSourceBundleDigest: AgentOsRawSha256DigestV1;
  trustPolicyDigest: AgentOsRawSha256DigestV1;
  policyGeneration: number;
  expectedSourceKeyId: AgentOsRawSha256DigestV1;
  expectedSourcePrincipalDigest: AgentOsPrefixedSha256DigestV1;
  observedAt: string;
}

/**
 * Trusted runtime seam. Implementations must return a context authenticated
 * from the exact live anchor/manifest/source closure while the runtime's
 * transaction fences are held. This interface is not itself authority and
 * must never be selected by an untrusted caller.
 */
export interface AgentOsEpochSourceRenewalActiveContextProviderV1 {
  readAuthenticatedActiveEpochContext(): AgentOsEpochSourceRenewalActiveContextV1 | null;
}

export type AgentOsEpochSourceRenewalVerificationIssueV1 =
  | 'invalid-input'
  | 'active-context-unavailable'
  | 'active-context-changed'
  | 'active-context-mismatch'
  | 'source-not-current'
  | 'role-separation-failed'
  | 'signature-invalid'
  | 'verifier-mutated';

export type AgentOsEpochSourceRenewalVerificationResultV1 =
  | (AgentOsEpochRecordAuthorityV1 & {
      ok: true;
      renewal: Readonly<AgentOsEpochSourceRenewalV1>;
      issues: readonly [];
    })
  | (AgentOsEpochRecordAuthorityV1 & {
      ok: false;
      renewal: null;
      issues: readonly [AgentOsEpochSourceRenewalVerificationIssueV1];
    });

const AUTHORITY_KEYS = Object.keys(AGENT_OS_EPOCH_RECORD_AUTHORITY_V1);
const INPUT_KEYS = [
  'epoch', 'epochSequence', 'epochHeadDigest', 'epochManifestDigest', 'attemptNamespaceDigest',
  'previousBundleDigest', 'trustPolicyDigest', 'policyGeneration', 'sourceKeyId',
  'sourcePrincipalDigest', 'evidencePrincipalDigest', 'outcomePrincipalDigests',
  'issuedAt', 'expiresAt', 'sourcePayloadBytes',
] as const;
const UNSIGNED_KEYS = [
  ...AUTHORITY_KEYS, 'schemaVersion', 'protocol', 'recordType', 'epoch', 'epochSequence',
  'epochHeadDigest', 'epochManifestDigest', 'attemptNamespaceDigest', 'previousBundleDigest',
  'trustPolicyDigest', 'policyGeneration', 'sourceKeyId', 'sourcePrincipalDigest',
  'evidencePrincipalDigest', 'outcomePrincipalDigests', 'issuedAt', 'expiresAt',
  'sourcePayload', 'sourcePayloadDigest', 'signatureAlgorithm',
] as const;
const RENEWAL_KEYS = [...UNSIGNED_KEYS, 'signature', 'bundleDigest'] as const;
const CONTEXT_KEYS = [
  'epoch', 'expectedEpochSequence', 'epochHeadDigest', 'epochManifestDigest',
  'attemptNamespaceDigest', 'currentSourceBundleDigest', 'trustPolicyDigest',
  'policyGeneration', 'expectedSourceKeyId', 'expectedSourcePrincipalDigest', 'observedAt',
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
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalize(
  value: unknown,
  state = { depth: 0, nodes: 0, ancestors: new Set<object>() },
): Canonical {
  state.nodes += 1;
  if (state.depth > MAX_CANONICAL_DEPTH || state.nodes > MAX_CANONICAL_NODES) {
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
    return bytes.length >= 2 && bytes.length <= MAX_CANONICAL_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

function canonicalClone<T>(value: T): T | null {
  const bytes = canonicalBytes(value);
  if (!bytes) return null;
  try { return JSON.parse(bytes.toString('utf8')) as T; } catch { return null; }
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

function exactBytes(left: Uint8Array, right: Uint8Array): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function rawDigest(domain: string, bytes: Uint8Array): string {
  return createHash('sha256').update(domain, 'utf8').update(bytes).digest('hex');
}

function rawDigestValue(value: unknown): value is AgentOsRawSha256DigestV1 {
  return typeof value === 'string' && RAW_DIGEST_RE.test(value);
}

function prefixedDigestValue(value: unknown): value is AgentOsPrefixedSha256DigestV1 {
  return typeof value === 'string' && PREFIXED_DIGEST_RE.test(value);
}

function validEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_EPOCH;
}

function validEpochSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 2 && Number(value) <= MAX_EPOCH_SEQUENCE;
}

function validPolicyGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_POLICY_GENERATION;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !TIMESTAMP_RE.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function decodeBase64url(value: unknown, minimum: number, maximum: number): Buffer | null {
  if (typeof value !== 'string' || !BASE64URL_RE.test(value)) return null;
  try {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length >= minimum && bytes.length <= maximum && bytes.toString('base64url') === value
      ? bytes
      : null;
  } catch {
    return null;
  }
}

function validAuthority(value: Record<string, unknown>): boolean {
  return Object.entries(AGENT_OS_EPOCH_RECORD_AUTHORITY_V1)
    .every(([key, expected]) => value[key] === expected);
}

function validDistinctPrincipals(source: unknown, evidence: unknown, outcomes: unknown): outcomes is string[] {
  if (!prefixedDigestValue(source) || !prefixedDigestValue(evidence) || source === evidence ||
    !Array.isArray(outcomes) || outcomes.length > MAX_OUTCOME_PRINCIPALS ||
    outcomes.some((entry) => !prefixedDigestValue(entry))) return false;
  const all = [source, evidence, ...outcomes];
  return new Set(all).size === all.length;
}

function canonicallyOrdered(values: readonly string[]): boolean {
  const ordered = [...values].sort();
  return values.every((value, index) => value === ordered[index]);
}

function validUnsigned(value: unknown): value is UnsignedRenewal {
  const row = record(value);
  if (!row || !exactKeys(row, UNSIGNED_KEYS) || !validAuthority(row) || row['schemaVersion'] !== 1 ||
    row['protocol'] !== AGENT_OS_EPOCH_SOURCE_RENEWAL_PROTOCOL_V1 ||
    row['recordType'] !== 'agent-os-epoch-source-renewal' || !validEpoch(row['epoch']) ||
    !validEpochSequence(row['epochSequence']) || !prefixedDigestValue(row['epochHeadDigest']) ||
    !prefixedDigestValue(row['epochManifestDigest']) || !prefixedDigestValue(row['attemptNamespaceDigest']) ||
    !rawDigestValue(row['previousBundleDigest']) ||
    row['previousBundleDigest'] === AGENT_OS_EPOCH_SOURCE_RAW_GENESIS_DIGEST_V2 ||
    !rawDigestValue(row['trustPolicyDigest']) || !validPolicyGeneration(row['policyGeneration']) ||
    !rawDigestValue(row['sourceKeyId']) || !validDistinctPrincipals(
      row['sourcePrincipalDigest'], row['evidencePrincipalDigest'], row['outcomePrincipalDigests'],
    ) || !canonicallyOrdered(row['outcomePrincipalDigests']) ||
    !validTimestamp(row['issuedAt']) || !validTimestamp(row['expiresAt']) ||
    !prefixedDigestValue(row['sourcePayloadDigest']) ||
    row['signatureAlgorithm'] !== AGENT_OS_EPOCH_SOURCE_RENEWAL_SIGNATURE_ALGORITHM_V1) return false;
  const payload = decodeBase64url(row['sourcePayload'], 2, MAX_PAYLOAD_BYTES);
  return payload !== null && row['sourcePayloadDigest'] ===
    `sha256:${rawDigest(AGENT_OS_EPOCH_SOURCE_RENEWAL_PAYLOAD_DOMAIN_V1, payload)}`;
}

function signaturePayload(value: UnsignedRenewal): Buffer | null {
  const canonical = canonicalBytes(value);
  return canonical
    ? Buffer.concat([Buffer.from(AGENT_OS_EPOCH_SOURCE_RENEWAL_SIGNATURE_DOMAIN_V1, 'utf8'), canonical])
    : null;
}

function validRenewal(value: unknown): value is AgentOsEpochSourceRenewalV1 {
  const row = record(value);
  if (!row || !exactKeys(row, RENEWAL_KEYS) || !rawDigestValue(row['bundleDigest'])) return false;
  const unsigned = Object.fromEntries(UNSIGNED_KEYS.map((key) => [key, row[key]]));
  const signature = decodeBase64url(row['signature'], 64, 64);
  const unsignedBytes = validUnsigned(unsigned) ? canonicalBytes(unsigned) : null;
  return signature !== null && unsignedBytes !== null && row['bundleDigest'] === rawDigest(
    AGENT_OS_EPOCH_SOURCE_RENEWAL_DIGEST_DOMAIN_V1,
    Buffer.concat([unsignedBytes, signature]),
  );
}

function validContext(value: unknown): value is AgentOsEpochSourceRenewalActiveContextV1 {
  const row = record(value);
  return Boolean(row && exactKeys(row, CONTEXT_KEYS) && validEpoch(row['epoch']) &&
    validEpochSequence(row['expectedEpochSequence']) && prefixedDigestValue(row['epochHeadDigest']) &&
    prefixedDigestValue(row['epochManifestDigest']) && prefixedDigestValue(row['attemptNamespaceDigest']) &&
    rawDigestValue(row['currentSourceBundleDigest']) &&
    row['currentSourceBundleDigest'] !== AGENT_OS_EPOCH_SOURCE_RAW_GENESIS_DIGEST_V2 &&
    rawDigestValue(row['trustPolicyDigest']) && validPolicyGeneration(row['policyGeneration']) &&
    rawDigestValue(row['expectedSourceKeyId']) && prefixedDigestValue(row['expectedSourcePrincipalDigest']) &&
    validTimestamp(row['observedAt']));
}

function verificationFailure(
  issue: AgentOsEpochSourceRenewalVerificationIssueV1,
): AgentOsEpochSourceRenewalVerificationResultV1 {
  return Object.freeze({
    ok: false,
    renewal: null,
    issues: Object.freeze([issue]) as readonly [AgentOsEpochSourceRenewalVerificationIssueV1],
    ...AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
  });
}

function readAuthenticatedContext(
  provider: AgentOsEpochSourceRenewalActiveContextProviderV1,
): { context: Readonly<AgentOsEpochSourceRenewalActiveContextV1>; bytes: Buffer } | null {
  try {
    const supplied = provider.readAuthenticatedActiveEpochContext();
    const cloned = supplied ? canonicalClone(supplied) : null;
    const bytes = cloned ? canonicalBytes(cloned) : null;
    return cloned && bytes && validContext(cloned)
      ? { context: deepFreeze(cloned), bytes }
      : null;
  } catch {
    return null;
  }
}

export function createAgentOsEpochSourceRenewalV1(
  input: AgentOsEpochSourceRenewalInputV1,
  signer: AgentOsEpochSourceRenewalSignerV1,
): AgentOsEpochSourceRenewalV1 | null {
  try {
    const row = record(input);
    const signerRow = record(signer);
    if (!row || !exactKeys(row, INPUT_KEYS) || !signerRow ||
      !exactKeys(signerRow, ['keyId', 'principalDigest', 'sign']) || typeof signer.sign !== 'function' ||
      signer.keyId !== row['sourceKeyId'] || signer.principalDigest !== row['sourcePrincipalDigest'] ||
      !validEpoch(row['epoch']) || !validEpochSequence(row['epochSequence']) ||
      !prefixedDigestValue(row['epochHeadDigest']) || !prefixedDigestValue(row['epochManifestDigest']) ||
      !prefixedDigestValue(row['attemptNamespaceDigest']) || !rawDigestValue(row['previousBundleDigest']) ||
      row['previousBundleDigest'] === AGENT_OS_EPOCH_SOURCE_RAW_GENESIS_DIGEST_V2 ||
      !rawDigestValue(row['trustPolicyDigest']) || !validPolicyGeneration(row['policyGeneration']) ||
      !rawDigestValue(row['sourceKeyId']) || !validDistinctPrincipals(
        row['sourcePrincipalDigest'], row['evidencePrincipalDigest'], row['outcomePrincipalDigests'],
      ) || !validTimestamp(row['issuedAt']) || !validTimestamp(row['expiresAt']) ||
      !(row['sourcePayloadBytes'] instanceof Uint8Array)) return null;
    const payload = Buffer.from(row['sourcePayloadBytes']);
    if (payload.length < 2 || payload.length > MAX_PAYLOAD_BYTES) return null;
    const unsigned: UnsignedRenewal = {
      schemaVersion: 1,
      protocol: AGENT_OS_EPOCH_SOURCE_RENEWAL_PROTOCOL_V1,
      recordType: 'agent-os-epoch-source-renewal',
      ...AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
      epoch: row['epoch'],
      epochSequence: row['epochSequence'],
      epochHeadDigest: row['epochHeadDigest'],
      epochManifestDigest: row['epochManifestDigest'],
      attemptNamespaceDigest: row['attemptNamespaceDigest'],
      previousBundleDigest: row['previousBundleDigest'],
      trustPolicyDigest: row['trustPolicyDigest'],
      policyGeneration: row['policyGeneration'],
      sourceKeyId: row['sourceKeyId'],
      sourcePrincipalDigest: row['sourcePrincipalDigest'],
      evidencePrincipalDigest: row['evidencePrincipalDigest'] as string,
      outcomePrincipalDigests: [...row['outcomePrincipalDigests'] as string[]].sort(),
      issuedAt: row['issuedAt'],
      expiresAt: row['expiresAt'],
      sourcePayload: payload.toString('base64url'),
      sourcePayloadDigest: `sha256:${rawDigest(AGENT_OS_EPOCH_SOURCE_RENEWAL_PAYLOAD_DOMAIN_V1, payload)}`,
      signatureAlgorithm: AGENT_OS_EPOCH_SOURCE_RENEWAL_SIGNATURE_ALGORITHM_V1,
    };
    if (!validUnsigned(unsigned)) return null;
    const toSign = signaturePayload(unsigned);
    if (!toSign) return null;
    const callbackBytes = Buffer.from(toSign);
    const beforeCallback = Buffer.from(callbackBytes);
    const signature = signer.sign(callbackBytes);
    if (!exactBytes(callbackBytes, beforeCallback) || !(signature instanceof Uint8Array) ||
      signature.byteLength !== 64) return null;
    const signatureBytes = Buffer.from(signature);
    const unsignedBytes = canonicalBytes(unsigned);
    if (!unsignedBytes) return null;
    const renewal = {
      ...unsigned,
      signature: signatureBytes.toString('base64url'),
      bundleDigest: rawDigest(
        AGENT_OS_EPOCH_SOURCE_RENEWAL_DIGEST_DOMAIN_V1,
        Buffer.concat([unsignedBytes, signatureBytes]),
      ),
    };
    return validRenewal(renewal)
      ? deepFreeze(canonicalClone(renewal) as AgentOsEpochSourceRenewalV1)
      : null;
  } catch {
    return null;
  }
}

export function canonicalAgentOsEpochSourceRenewalBytesV1(value: unknown): Buffer | null {
  return validRenewal(value) ? canonicalBytes(value) : null;
}

export function parseAgentOsEpochSourceRenewalV1(bytes: Uint8Array): AgentOsEpochSourceRenewalV1 | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > MAX_CANONICAL_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    const canonical = canonicalAgentOsEpochSourceRenewalBytesV1(parsed);
    return canonical && exactBytes(bytes, canonical)
      ? deepFreeze(parsed as AgentOsEpochSourceRenewalV1)
      : null;
  } catch {
    return null;
  }
}

export function verifyAgentOsEpochSourceRenewalV1(
  value: unknown,
  signatureVerifier: AgentOsEpochSourceRenewalSignatureVerifierV1,
  activeContextProvider: AgentOsEpochSourceRenewalActiveContextProviderV1,
): AgentOsEpochSourceRenewalVerificationResultV1 {
  try {
    const canonical = canonicalAgentOsEpochSourceRenewalBytesV1(value);
    const verifierRow = record(signatureVerifier);
    const providerRow = record(activeContextProvider);
    if (!canonical || !verifierRow || !exactKeys(verifierRow, ['verify']) ||
      typeof signatureVerifier.verify !== 'function' || !providerRow ||
      !exactKeys(providerRow, ['readAuthenticatedActiveEpochContext']) ||
      typeof activeContextProvider.readAuthenticatedActiveEpochContext !== 'function') {
      return verificationFailure('invalid-input');
    }
    const firstContext = readAuthenticatedContext(activeContextProvider);
    if (!firstContext) return verificationFailure('active-context-unavailable');
    const renewal = parseAgentOsEpochSourceRenewalV1(canonical);
    if (!renewal) return verificationFailure('invalid-input');
    const context = firstContext.context;
    if (renewal.epoch !== context.epoch || renewal.epochSequence !== context.expectedEpochSequence ||
      renewal.epochHeadDigest !== context.epochHeadDigest ||
      renewal.epochManifestDigest !== context.epochManifestDigest ||
      renewal.attemptNamespaceDigest !== context.attemptNamespaceDigest ||
      renewal.previousBundleDigest !== context.currentSourceBundleDigest ||
      renewal.trustPolicyDigest !== context.trustPolicyDigest ||
      renewal.policyGeneration !== context.policyGeneration || renewal.sourceKeyId !== context.expectedSourceKeyId ||
      renewal.sourcePrincipalDigest !== context.expectedSourcePrincipalDigest) {
      return verificationFailure('active-context-mismatch');
    }
    const observedAt = Date.parse(context.observedAt);
    const issuedAt = Date.parse(renewal.issuedAt);
    const expiresAt = Date.parse(renewal.expiresAt);
    if (issuedAt > observedAt + MAX_SOURCE_FUTURE_SKEW_MS || expiresAt <= issuedAt ||
      expiresAt - issuedAt > MAX_SOURCE_LIFETIME_MS || expiresAt <= observedAt) {
      return verificationFailure('source-not-current');
    }
    if (!validDistinctPrincipals(
      renewal.sourcePrincipalDigest,
      renewal.evidencePrincipalDigest,
      renewal.outcomePrincipalDigests,
    )) return verificationFailure('role-separation-failed');
    const renewalRow = renewal as unknown as Record<string, unknown>;
    const unsigned = Object.fromEntries(UNSIGNED_KEYS.map((key) => [key, renewalRow[key]]));
    if (!validUnsigned(unsigned)) return verificationFailure('invalid-input');
    const payload = signaturePayload(unsigned);
    const signature = decodeBase64url(renewal.signature, 64, 64);
    if (!payload || !signature) return verificationFailure('signature-invalid');
    const requestPayload = Buffer.from(payload);
    const requestSignature = Buffer.from(signature);
    const expectedPayload = Buffer.from(requestPayload);
    const expectedSignature = Buffer.from(requestSignature);
    const request = Object.freeze({
      keyId: renewal.sourceKeyId,
      principalDigest: renewal.sourcePrincipalDigest,
      canonicalDomainSeparatedPayload: requestPayload,
      signature: requestSignature,
    });
    let authenticated = false;
    try { authenticated = signatureVerifier.verify(request) === true; } catch { /* fail closed */ }
    if (!exactBytes(requestPayload, expectedPayload) || !exactBytes(requestSignature, expectedSignature)) {
      return verificationFailure('verifier-mutated');
    }
    if (!authenticated) return verificationFailure('signature-invalid');
    const secondContext = readAuthenticatedContext(activeContextProvider);
    if (!secondContext) return verificationFailure('active-context-unavailable');
    if (!exactBytes(firstContext.bytes, secondContext.bytes)) {
      return verificationFailure('active-context-changed');
    }
    const reparsed = parseAgentOsEpochSourceRenewalV1(canonical);
    if (!reparsed || reparsed.bundleDigest !== renewal.bundleDigest) {
      return verificationFailure('signature-invalid');
    }
    return Object.freeze({
      ok: true,
      renewal: reparsed,
      issues: Object.freeze([]) as readonly [],
      ...AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
    });
  } catch {
    return verificationFailure('invalid-input');
  }
}
