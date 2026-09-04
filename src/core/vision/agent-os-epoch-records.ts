/**
 * Epoch-aware Agent OS record contracts (M555).
 *
 * Existing source, snapshot, and attempt V1 records use raw 64-character
 * SHA-256 values. M550 control-plane identities use an explicit `sha256:`
 * prefix. These contracts keep those representations distinct and bind the
 * first source plus every attempt to one exact epoch. This module performs no
 * I/O, loads no keys, and grants no operational authority.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { AGENT_OS_SOURCE_BUNDLE_GENESIS_DIGEST_V1 } from './agent-os-rollover-protocol.js';

export const AGENT_OS_EPOCH_SOURCE_PROTOCOL_V2 =
  'ashlr-agent-os-epoch-source-bundle-v2' as const;
export const AGENT_OS_EPOCH_ATTEMPT_PROTOCOL_V2 =
  'ashlr-agent-os-epoch-attempt-receipt-v2' as const;
export const AGENT_OS_EPOCH_SOURCE_SIGNATURE_ALGORITHM_V2 = 'ed25519' as const;
export const AGENT_OS_EPOCH_SOURCE_SIGNATURE_DOMAIN_V2 =
  'ashlr:agent-os:epoch-source-bundle:signature:v2\0' as const;
export const AGENT_OS_EPOCH_SOURCE_BUNDLE_DOMAIN_V2 =
  'ashlr:agent-os:epoch-source-bundle:digest:v2\0' as const;
export const AGENT_OS_EPOCH_ATTEMPT_ID_DOMAIN_V1 =
  'ashlr:agent-os:epoch-attempt-id:v1\0' as const;
export const AGENT_OS_EPOCH_ATTEMPT_RECEIPT_DOMAIN_V2 =
  'ashlr:agent-os:epoch-attempt-receipt:digest:v2\0' as const;
export const AGENT_OS_EPOCH_ATTEMPT_AUTHENTICATOR_DOMAIN_V2 =
  'ashlr:agent-os:epoch-attempt-receipt:authenticator:v2\0' as const;
/**
 * Compatibility alias for the single source-lineage genesis committed by the
 * M550 epoch manifest. A second sentinel would make epoch one impossible to
 * satisfy across the two protocols.
 */
export const AGENT_OS_EPOCH_SOURCE_RAW_GENESIS_DIGEST_V2 =
  AGENT_OS_SOURCE_BUNDLE_GENESIS_DIGEST_V1;
export const AGENT_OS_EPOCH_ATTEMPT_RAW_GENESIS_DIGEST_V2 = createHash('sha256')
  .update('ashlr:agent-os:epoch-attempt:genesis:v2\0', 'utf8').digest('hex');

const RAW_DIGEST_RE = /^[a-f0-9]{64}$/;
const PREFIXED_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_EPOCH = 999_999_999_999;
const MAX_POLICY_GENERATION = 1_000_000;
const MAX_SOURCE_PAYLOAD_BYTES = 768 * 1024;
const MAX_SOURCE_LIFETIME_MS = 5 * 60_000;
const MAX_SOURCE_FUTURE_SKEW_MS = 60_000;
const MAX_CANONICAL_BYTES = 1024 * 1024;
const MAX_CANONICAL_DEPTH = 32;
const MAX_CANONICAL_NODES = 100_000;
const MAX_OUTCOME_PRINCIPALS = 12;

export type AgentOsRawSha256DigestV1 = string;
export type AgentOsPrefixedSha256DigestV1 = string;

export function isAgentOsRawSha256DigestV1(value: unknown): value is AgentOsRawSha256DigestV1 {
  return typeof value === 'string' && RAW_DIGEST_RE.test(value);
}

export function isAgentOsPrefixedSha256DigestV1(
  value: unknown,
): value is AgentOsPrefixedSha256DigestV1 {
  return typeof value === 'string' && PREFIXED_DIGEST_RE.test(value);
}

export interface AgentOsEpochRecordAuthorityV1 {
  authority: 'observation-only';
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

export const AGENT_OS_EPOCH_RECORD_AUTHORITY_V1: Readonly<AgentOsEpochRecordAuthorityV1> =
  Object.freeze({
    authority: 'observation-only',
    planningAuthority: false,
    executionAuthority: false,
    effectAuthority: false,
    proposalAuthority: false,
    learningAuthority: false,
    promotionAuthority: false,
    mergeAuthority: false,
    releaseAuthority: false,
    deployAuthority: false,
    publicationAuthority: false,
    budgetAuthority: false,
    credentialAuthority: false,
    externalMutationAuthority: false,
    rollbackProtected: false,
    sameUserTamperResistant: false,
  });

type Canonical = null | boolean | number | string | Canonical[] | { [key: string]: Canonical };

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

function prefixedDigest(domain: string, value: unknown): string | null {
  const bytes = canonicalBytes(value);
  return bytes ? `sha256:${rawDigest(domain, bytes)}` : null;
}

function validEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_EPOCH;
}

function validPolicyGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_POLICY_GENERATION;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !TIMESTAMP_RE.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function decodedBase64url(value: unknown, minimum: number, maximum: number): Buffer | null {
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

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (ArrayBuffer.isView(value)) return value;
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
    Object.freeze(value);
  }
  return value;
}

function canonicalClone<T>(value: T): T | null {
  const bytes = canonicalBytes(value);
  if (!bytes) return null;
  try { return JSON.parse(bytes.toString('utf8')) as T; } catch { return null; }
}

const AUTHORITY_KEYS = Object.keys(AGENT_OS_EPOCH_RECORD_AUTHORITY_V1);

export interface AgentOsEpochSourceBundleInputV2 {
  epoch: number;
  previousEpochHeadDigest: AgentOsPrefixedSha256DigestV1;
  previousEpochSourceTipDigest: AgentOsRawSha256DigestV1 | null;
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

export interface AgentOsEpochSourceBundleV2 extends AgentOsEpochRecordAuthorityV1 {
  schemaVersion: 2;
  protocol: typeof AGENT_OS_EPOCH_SOURCE_PROTOCOL_V2;
  recordType: 'agent-os-epoch-source-bundle';
  epoch: number;
  epochSequence: 1;
  previousEpochHeadDigest: AgentOsPrefixedSha256DigestV1;
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
  signatureAlgorithm: typeof AGENT_OS_EPOCH_SOURCE_SIGNATURE_ALGORITHM_V2;
  signature: string;
  bundleDigest: AgentOsRawSha256DigestV1;
}

type AgentOsEpochSourceBundleUnsignedV2 = Omit<AgentOsEpochSourceBundleV2, 'signature' | 'bundleDigest'>;

export interface AgentOsEpochSourceSignerV2 {
  readonly keyId: AgentOsRawSha256DigestV1;
  readonly principalDigest: AgentOsPrefixedSha256DigestV1;
  sign(canonicalDomainSeparatedPayload: Uint8Array): Uint8Array | null;
}

export interface AgentOsEpochSourceSignatureVerifierV2 {
  verify(input: Readonly<{
    keyId: AgentOsRawSha256DigestV1;
    principalDigest: AgentOsPrefixedSha256DigestV1;
    canonicalDomainSeparatedPayload: Uint8Array;
    signature: Uint8Array;
  }>): boolean;
}

export interface AgentOsEpochSourceClosureContextV1 {
  epoch: number;
  previousEpochHeadDigest: AgentOsPrefixedSha256DigestV1;
  previousEpochSourceTipDigest: AgentOsRawSha256DigestV1 | null;
  trustPolicyDigest: AgentOsRawSha256DigestV1;
  policyGeneration: number;
  expectedSourceKeyId: AgentOsRawSha256DigestV1;
  expectedSourcePrincipalDigest: AgentOsPrefixedSha256DigestV1;
  observedAt: string;
}

export interface AgentOsEpochSourceClosureContextVerifierV1 {
  verify(context: Readonly<AgentOsEpochSourceClosureContextV1>): boolean;
}

export type AgentOsEpochSourceVerificationIssueV2 =
  | 'invalid-input'
  | 'closure-context-unauthenticated'
  | 'closure-context-mismatch'
  | 'source-not-current'
  | 'role-separation-failed'
  | 'signature-invalid';

export type AgentOsEpochSourceVerificationResultV2 =
  | (AgentOsEpochRecordAuthorityV1 & {
      ok: true;
      envelope: Readonly<AgentOsEpochSourceBundleV2>;
      sourcePayloadBytes: Uint8Array;
      issues: readonly [];
    })
  | (AgentOsEpochRecordAuthorityV1 & {
      ok: false;
      envelope: null;
      sourcePayloadBytes: null;
      issues: readonly [AgentOsEpochSourceVerificationIssueV2];
    });

const SOURCE_INPUT_KEYS = [
  'epoch', 'previousEpochHeadDigest', 'previousEpochSourceTipDigest', 'trustPolicyDigest',
  'policyGeneration', 'sourceKeyId', 'sourcePrincipalDigest', 'evidencePrincipalDigest',
  'outcomePrincipalDigests', 'issuedAt', 'expiresAt', 'sourcePayloadBytes',
] as const;
const SOURCE_UNSIGNED_KEYS = [
  ...AUTHORITY_KEYS, 'schemaVersion', 'protocol', 'recordType', 'epoch', 'epochSequence',
  'previousEpochHeadDigest', 'previousBundleDigest', 'trustPolicyDigest', 'policyGeneration',
  'sourceKeyId', 'sourcePrincipalDigest', 'evidencePrincipalDigest', 'outcomePrincipalDigests',
  'issuedAt', 'expiresAt', 'sourcePayload', 'sourcePayloadDigest', 'signatureAlgorithm',
] as const;
const SOURCE_KEYS = [...SOURCE_UNSIGNED_KEYS, 'signature', 'bundleDigest'] as const;
const SOURCE_CONTEXT_KEYS = [
  'epoch', 'previousEpochHeadDigest', 'previousEpochSourceTipDigest', 'trustPolicyDigest',
  'policyGeneration', 'expectedSourceKeyId', 'expectedSourcePrincipalDigest', 'observedAt',
] as const;

function validDistinctPrincipals(
  source: unknown,
  evidence: unknown,
  outcomes: unknown,
): outcomes is string[] {
  if (!isAgentOsPrefixedSha256DigestV1(source) ||
    !isAgentOsPrefixedSha256DigestV1(evidence) || source === evidence ||
    !Array.isArray(outcomes) || outcomes.length > MAX_OUTCOME_PRINCIPALS ||
    outcomes.some((entry) => !isAgentOsPrefixedSha256DigestV1(entry))) return false;
  const all = [source, evidence, ...outcomes];
  return new Set(all).size === all.length;
}

function validSourceUnsigned(value: unknown): value is AgentOsEpochSourceBundleUnsignedV2 {
  const row = record(value);
  if (!row || !exactKeys(row, SOURCE_UNSIGNED_KEYS) || !validAuthority(row) ||
    row['schemaVersion'] !== 2 || row['protocol'] !== AGENT_OS_EPOCH_SOURCE_PROTOCOL_V2 ||
    row['recordType'] !== 'agent-os-epoch-source-bundle' || !validEpoch(row['epoch']) ||
    row['epochSequence'] !== 1 || !isAgentOsPrefixedSha256DigestV1(row['previousEpochHeadDigest']) ||
    !isAgentOsRawSha256DigestV1(row['previousBundleDigest']) ||
    !isAgentOsRawSha256DigestV1(row['trustPolicyDigest']) ||
    !validPolicyGeneration(row['policyGeneration']) || !isAgentOsRawSha256DigestV1(row['sourceKeyId']) ||
    !validDistinctPrincipals(
      row['sourcePrincipalDigest'], row['evidencePrincipalDigest'], row['outcomePrincipalDigests'],
    ) || !validTimestamp(row['issuedAt']) || !validTimestamp(row['expiresAt']) ||
    !isAgentOsPrefixedSha256DigestV1(row['sourcePayloadDigest']) ||
    row['signatureAlgorithm'] !== AGENT_OS_EPOCH_SOURCE_SIGNATURE_ALGORITHM_V2) return false;
  const payload = decodedBase64url(row['sourcePayload'], 2, MAX_SOURCE_PAYLOAD_BYTES);
  return (row['epoch'] === 1) ===
      (row['previousBundleDigest'] === AGENT_OS_EPOCH_SOURCE_RAW_GENESIS_DIGEST_V2) &&
    (row['outcomePrincipalDigests'] as string[]).every((entry, index, values) =>
      entry === [...values].sort()[index]) &&
    payload !== null && row['sourcePayloadDigest'] ===
    `sha256:${rawDigest('ashlr:agent-os:epoch-source-payload:v2\0', payload)}`;
}

function sourceSignaturePayload(value: AgentOsEpochSourceBundleUnsignedV2): Buffer | null {
  const canonical = canonicalBytes(value);
  return canonical
    ? Buffer.concat([Buffer.from(AGENT_OS_EPOCH_SOURCE_SIGNATURE_DOMAIN_V2, 'utf8'), canonical])
    : null;
}

function validSourceEnvelope(value: unknown): value is AgentOsEpochSourceBundleV2 {
  const row = record(value);
  if (!row || !exactKeys(row, SOURCE_KEYS)) return false;
  const unsigned = Object.fromEntries(SOURCE_UNSIGNED_KEYS.map((key) => [key, row[key]]));
  const signature = decodedBase64url(row['signature'], 64, 64);
  if (!validSourceUnsigned(unsigned) || !signature || !isAgentOsRawSha256DigestV1(row['bundleDigest'])) {
    return false;
  }
  const unsignedBytes = canonicalBytes(unsigned);
  return unsignedBytes !== null && row['bundleDigest'] === rawDigest(
    AGENT_OS_EPOCH_SOURCE_BUNDLE_DOMAIN_V2,
    Buffer.concat([unsignedBytes, signature]),
  );
}

function validSourceContext(value: unknown): value is AgentOsEpochSourceClosureContextV1 {
  const row = record(value);
  return row !== null && exactKeys(row, SOURCE_CONTEXT_KEYS) && validEpoch(row['epoch']) &&
    isAgentOsPrefixedSha256DigestV1(row['previousEpochHeadDigest']) &&
    (row['previousEpochSourceTipDigest'] === null ||
      isAgentOsRawSha256DigestV1(row['previousEpochSourceTipDigest'])) &&
    (row['epoch'] === 1) === (row['previousEpochSourceTipDigest'] === null) &&
    (row['epoch'] === 1 ||
      row['previousEpochSourceTipDigest'] !== AGENT_OS_EPOCH_SOURCE_RAW_GENESIS_DIGEST_V2) &&
    isAgentOsRawSha256DigestV1(row['trustPolicyDigest']) &&
    validPolicyGeneration(row['policyGeneration']) &&
    isAgentOsRawSha256DigestV1(row['expectedSourceKeyId']) &&
    isAgentOsPrefixedSha256DigestV1(row['expectedSourcePrincipalDigest']) &&
    validTimestamp(row['observedAt']);
}

function sourceFail(issue: AgentOsEpochSourceVerificationIssueV2): AgentOsEpochSourceVerificationResultV2 {
  return Object.freeze({
    ok: false, envelope: null, sourcePayloadBytes: null,
    issues: Object.freeze([issue]) as readonly [AgentOsEpochSourceVerificationIssueV2],
    ...AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
  });
}

export function createAgentOsEpochSourceBundleV2(
  input: AgentOsEpochSourceBundleInputV2,
  signer: AgentOsEpochSourceSignerV2,
): AgentOsEpochSourceBundleV2 | null {
  try {
    const row = record(input);
    const signerRow = record(signer);
    if (!row || !exactKeys(row, SOURCE_INPUT_KEYS) || !signerRow ||
      !exactKeys(signerRow, ['keyId', 'principalDigest', 'sign']) ||
      typeof signer.sign !== 'function' || signer.keyId !== row['sourceKeyId'] ||
      signer.principalDigest !== row['sourcePrincipalDigest'] || !validEpoch(row['epoch']) ||
      !isAgentOsPrefixedSha256DigestV1(row['previousEpochHeadDigest']) ||
      (row['previousEpochSourceTipDigest'] !== null &&
        !isAgentOsRawSha256DigestV1(row['previousEpochSourceTipDigest'])) ||
      !isAgentOsRawSha256DigestV1(row['trustPolicyDigest']) ||
      !validPolicyGeneration(row['policyGeneration']) || !isAgentOsRawSha256DigestV1(row['sourceKeyId']) ||
      !validDistinctPrincipals(
        row['sourcePrincipalDigest'], row['evidencePrincipalDigest'], row['outcomePrincipalDigests'],
      ) || !validTimestamp(row['issuedAt']) || !validTimestamp(row['expiresAt']) ||
      !(row['sourcePayloadBytes'] instanceof Uint8Array) ||
      ((row['epoch'] === 1) !== (row['previousEpochSourceTipDigest'] === null))) return null;
    const payload = Buffer.from(row['sourcePayloadBytes']);
    if (payload.length < 2 || payload.length > MAX_SOURCE_PAYLOAD_BYTES) return null;
    const outcomes = [...row['outcomePrincipalDigests'] as string[]].sort();
    const unsigned: AgentOsEpochSourceBundleUnsignedV2 = {
      schemaVersion: 2,
      protocol: AGENT_OS_EPOCH_SOURCE_PROTOCOL_V2,
      recordType: 'agent-os-epoch-source-bundle',
      ...AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
      epoch: row['epoch'],
      epochSequence: 1,
      previousEpochHeadDigest: row['previousEpochHeadDigest'],
      previousBundleDigest: row['previousEpochSourceTipDigest'] ?? AGENT_OS_EPOCH_SOURCE_RAW_GENESIS_DIGEST_V2,
      trustPolicyDigest: row['trustPolicyDigest'],
      policyGeneration: row['policyGeneration'],
      sourceKeyId: row['sourceKeyId'],
      sourcePrincipalDigest: row['sourcePrincipalDigest'],
      evidencePrincipalDigest: row['evidencePrincipalDigest'] as string,
      outcomePrincipalDigests: outcomes,
      issuedAt: row['issuedAt'],
      expiresAt: row['expiresAt'],
      sourcePayload: payload.toString('base64url'),
      sourcePayloadDigest: `sha256:${rawDigest('ashlr:agent-os:epoch-source-payload:v2\0', payload)}`,
      signatureAlgorithm: AGENT_OS_EPOCH_SOURCE_SIGNATURE_ALGORITHM_V2,
    };
    if (!validSourceUnsigned(unsigned)) return null;
    const signaturePayload = sourceSignaturePayload(unsigned);
    if (!signaturePayload) return null;
    const signingRequest = Buffer.from(signaturePayload);
    const signingRequestBefore = Buffer.from(signingRequest);
    const signature = signer.sign(signingRequest);
    if (!exactBytes(signingRequest, signingRequestBefore)) return null;
    if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) return null;
    const signatureBytes = Buffer.from(signature);
    const unsignedBytes = canonicalBytes(unsigned);
    if (!unsignedBytes) return null;
    const envelope = {
      ...unsigned,
      signature: signatureBytes.toString('base64url'),
      bundleDigest: rawDigest(
        AGENT_OS_EPOCH_SOURCE_BUNDLE_DOMAIN_V2,
        Buffer.concat([unsignedBytes, signatureBytes]),
      ),
    };
    return validSourceEnvelope(envelope)
      ? deepFreeze(canonicalClone(envelope) as AgentOsEpochSourceBundleV2)
      : null;
  } catch {
    return null;
  }
}

export function canonicalAgentOsEpochSourceBundleBytesV2(value: unknown): Buffer | null {
  return validSourceEnvelope(value) ? canonicalBytes(value) : null;
}

export function parseAgentOsEpochSourceBundleV2(bytes: Uint8Array): AgentOsEpochSourceBundleV2 | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > MAX_CANONICAL_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    const canonical = canonicalAgentOsEpochSourceBundleBytesV2(parsed);
    return canonical && exactBytes(bytes, canonical)
      ? deepFreeze(parsed as AgentOsEpochSourceBundleV2)
      : null;
  } catch {
    return null;
  }
}

export function verifyAgentOsEpochSourceBundleV2(
  value: unknown,
  context: AgentOsEpochSourceClosureContextV1,
  signatureVerifier: AgentOsEpochSourceSignatureVerifierV2,
  contextVerifier: AgentOsEpochSourceClosureContextVerifierV1,
): AgentOsEpochSourceVerificationResultV2 {
  try {
    const canonical = canonicalAgentOsEpochSourceBundleBytesV2(value);
    const clonedContext = canonicalClone(context);
    const contextClone = clonedContext ? deepFreeze(clonedContext) : null;
    const signatureVerifierRow = record(signatureVerifier);
    const contextVerifierRow = record(contextVerifier);
    if (!canonical || !contextClone || !validSourceContext(contextClone) || !signatureVerifierRow ||
      !exactKeys(signatureVerifierRow, ['verify']) || typeof signatureVerifier.verify !== 'function' ||
      !contextVerifierRow || !exactKeys(contextVerifierRow, ['verify']) ||
      typeof contextVerifier.verify !== 'function') return sourceFail('invalid-input');
    let contextAuthenticated = false;
    try { contextAuthenticated = contextVerifier.verify(contextClone) === true; } catch { /* fail closed */ }
    if (!contextAuthenticated) return sourceFail('closure-context-unauthenticated');
    const envelope = parseAgentOsEpochSourceBundleV2(canonical);
    if (!envelope) return sourceFail('invalid-input');
    const expectedPrevious = contextClone.previousEpochSourceTipDigest ??
      AGENT_OS_EPOCH_SOURCE_RAW_GENESIS_DIGEST_V2;
    if (envelope.epoch !== contextClone.epoch ||
      envelope.previousEpochHeadDigest !== contextClone.previousEpochHeadDigest ||
      envelope.previousBundleDigest !== expectedPrevious ||
      envelope.trustPolicyDigest !== contextClone.trustPolicyDigest ||
      envelope.policyGeneration !== contextClone.policyGeneration ||
      envelope.sourceKeyId !== contextClone.expectedSourceKeyId ||
      envelope.sourcePrincipalDigest !== contextClone.expectedSourcePrincipalDigest ||
      (envelope.epoch === 1) !== (contextClone.previousEpochSourceTipDigest === null)) {
      return sourceFail('closure-context-mismatch');
    }
    const observedAt = Date.parse(contextClone.observedAt);
    const issuedAt = Date.parse(envelope.issuedAt);
    const expiresAt = Date.parse(envelope.expiresAt);
    if (issuedAt > observedAt + MAX_SOURCE_FUTURE_SKEW_MS || expiresAt <= issuedAt ||
      expiresAt - issuedAt > MAX_SOURCE_LIFETIME_MS || expiresAt <= observedAt) {
      return sourceFail('source-not-current');
    }
    if (!validDistinctPrincipals(
      envelope.sourcePrincipalDigest,
      envelope.evidencePrincipalDigest,
      envelope.outcomePrincipalDigests,
    )) return sourceFail('role-separation-failed');
    const envelopeRow = envelope as unknown as Record<string, unknown>;
    const unsigned = Object.fromEntries(SOURCE_UNSIGNED_KEYS.map((key) => [key, envelopeRow[key]]));
    if (!validSourceUnsigned(unsigned)) return sourceFail('invalid-input');
    const signaturePayload = sourceSignaturePayload(unsigned);
    const signature = decodedBase64url(envelope.signature, 64, 64);
    if (!signaturePayload || !signature) return sourceFail('signature-invalid');
    const request = deepFreeze({
      keyId: envelope.sourceKeyId,
      principalDigest: envelope.sourcePrincipalDigest,
      canonicalDomainSeparatedPayload: Buffer.from(signaturePayload),
      signature: Buffer.from(signature),
    });
    const requestPayloadBefore = Buffer.from(request.canonicalDomainSeparatedPayload);
    const requestSignatureBefore = Buffer.from(request.signature);
    let authenticated = false;
    try { authenticated = signatureVerifier.verify(request) === true; } catch { /* fail closed */ }
    if (!authenticated || !exactBytes(request.canonicalDomainSeparatedPayload, requestPayloadBefore) ||
      !exactBytes(request.signature, requestSignatureBefore)) return sourceFail('signature-invalid');
    const reparsed = parseAgentOsEpochSourceBundleV2(canonical);
    if (!reparsed || reparsed.bundleDigest !== envelope.bundleDigest) return sourceFail('signature-invalid');
    return Object.freeze({
      ok: true,
      envelope: reparsed,
      sourcePayloadBytes: Buffer.from(reparsed.sourcePayload, 'base64url'),
      issues: Object.freeze([]) as readonly [],
      ...AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
    });
  } catch {
    return sourceFail('invalid-input');
  }
}

export interface AgentOsEpochAttemptIdInputV1 {
  epoch: number;
  attemptNamespaceDigest: AgentOsPrefixedSha256DigestV1;
  durableTickDigest: AgentOsPrefixedSha256DigestV1;
}

const ATTEMPT_ID_INPUT_KEYS = ['epoch', 'attemptNamespaceDigest', 'durableTickDigest'] as const;

export function agentOsEpochAttemptIdV1(input: AgentOsEpochAttemptIdInputV1): string | null {
  const row = record(input);
  if (!row || !exactKeys(row, ATTEMPT_ID_INPUT_KEYS) || !validEpoch(row['epoch']) ||
    !isAgentOsPrefixedSha256DigestV1(row['attemptNamespaceDigest']) ||
    !isAgentOsPrefixedSha256DigestV1(row['durableTickDigest'])) return null;
  return prefixedDigest(AGENT_OS_EPOCH_ATTEMPT_ID_DOMAIN_V1, row);
}

export type AgentOsEpochAttemptOutcomeV2 =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'deadline-exceeded';

export interface AgentOsEpochAttemptReceiptInputV2 {
  epoch: number;
  attemptNamespaceDigest: AgentOsPrefixedSha256DigestV1;
  durableTickDigest: AgentOsPrefixedSha256DigestV1;
  transitionOrdinal: 1 | 2;
  previousReceiptDigest: AgentOsRawSha256DigestV1;
  outcome: AgentOsEpochAttemptOutcomeV2 | null;
  sourceBundleDigest: AgentOsRawSha256DigestV1;
  trustPolicyDigest: AgentOsRawSha256DigestV1;
  snapshotEnvelopeDigest: AgentOsRawSha256DigestV1 | null;
  startedAt: string;
  completedAt: string | null;
}

export interface AgentOsEpochAttemptReceiptV2 extends AgentOsEpochRecordAuthorityV1 {
  schemaVersion: 2;
  protocol: typeof AGENT_OS_EPOCH_ATTEMPT_PROTOCOL_V2;
  recordType: 'agent-os-epoch-attempt';
  epoch: number;
  attemptNamespaceDigest: AgentOsPrefixedSha256DigestV1;
  durableTickDigest: AgentOsPrefixedSha256DigestV1;
  attemptId: AgentOsPrefixedSha256DigestV1;
  transitionOrdinal: 1 | 2;
  previousReceiptDigest: AgentOsRawSha256DigestV1;
  outcome: AgentOsEpochAttemptOutcomeV2 | null;
  sourceBundleDigest: AgentOsRawSha256DigestV1;
  trustPolicyDigest: AgentOsRawSha256DigestV1;
  snapshotEnvelopeDigest: AgentOsRawSha256DigestV1 | null;
  startedAt: string;
  completedAt: string | null;
  authenticatorKeyId: AgentOsRawSha256DigestV1;
  receiptDigest: AgentOsRawSha256DigestV1;
  authenticator: AgentOsRawSha256DigestV1;
}

type AgentOsEpochAttemptReceiptUnsignedV2 = Omit<
  AgentOsEpochAttemptReceiptV2,
  'receiptDigest' | 'authenticator'
>;

export interface AgentOsEpochAttemptSignerV2 {
  readonly keyId: AgentOsRawSha256DigestV1;
  authenticate(canonicalDomainSeparatedReceipt: Uint8Array): AgentOsRawSha256DigestV1 | null;
}

export interface AgentOsEpochAttemptVerifierV2 {
  readonly keyId: AgentOsRawSha256DigestV1;
  verify(input: Readonly<{
    keyId: AgentOsRawSha256DigestV1;
    canonicalDomainSeparatedReceipt: Uint8Array;
    authenticator: AgentOsRawSha256DigestV1;
  }>): boolean;
}

export interface AgentOsEpochAttemptClosureContextV2 {
  epoch: number;
  attemptNamespaceDigest: AgentOsPrefixedSha256DigestV1;
  sourceBundleDigest: AgentOsRawSha256DigestV1;
  trustPolicyDigest: AgentOsRawSha256DigestV1;
}

export interface AgentOsEpochAttemptClosureContextVerifierV2 {
  verify(context: Readonly<AgentOsEpochAttemptClosureContextV2>): boolean;
}

const ATTEMPT_INPUT_KEYS = [
  'epoch', 'attemptNamespaceDigest', 'durableTickDigest', 'transitionOrdinal',
  'previousReceiptDigest', 'outcome', 'sourceBundleDigest', 'trustPolicyDigest', 'snapshotEnvelopeDigest',
  'startedAt', 'completedAt',
] as const;
const ATTEMPT_UNSIGNED_KEYS = [
  ...AUTHORITY_KEYS, 'schemaVersion', 'protocol', 'recordType', 'epoch',
  'attemptNamespaceDigest', 'durableTickDigest', 'attemptId', 'transitionOrdinal',
  'previousReceiptDigest', 'outcome', 'sourceBundleDigest', 'trustPolicyDigest', 'snapshotEnvelopeDigest',
  'startedAt', 'completedAt', 'authenticatorKeyId',
] as const;
const ATTEMPT_CLOSURE_CONTEXT_KEYS = [
  'epoch', 'attemptNamespaceDigest', 'sourceBundleDigest', 'trustPolicyDigest',
] as const;
const ATTEMPT_KEYS = [...ATTEMPT_UNSIGNED_KEYS, 'receiptDigest', 'authenticator'] as const;
const ATTEMPT_OUTCOMES = new Set<AgentOsEpochAttemptOutcomeV2>([
  'succeeded', 'failed', 'cancelled', 'deadline-exceeded',
]);

function validAttemptUnsigned(value: unknown): value is AgentOsEpochAttemptReceiptUnsignedV2 {
  const row = record(value);
  if (!row || !exactKeys(row, ATTEMPT_UNSIGNED_KEYS) || !validAuthority(row) ||
    row['schemaVersion'] !== 2 || row['protocol'] !== AGENT_OS_EPOCH_ATTEMPT_PROTOCOL_V2 ||
    row['recordType'] !== 'agent-os-epoch-attempt' || !validEpoch(row['epoch']) ||
    !isAgentOsPrefixedSha256DigestV1(row['attemptNamespaceDigest']) ||
    !isAgentOsPrefixedSha256DigestV1(row['durableTickDigest']) ||
    !isAgentOsPrefixedSha256DigestV1(row['attemptId']) ||
    !isAgentOsRawSha256DigestV1(row['previousReceiptDigest']) ||
    !isAgentOsRawSha256DigestV1(row['sourceBundleDigest']) ||
    !isAgentOsRawSha256DigestV1(row['trustPolicyDigest']) ||
    (row['snapshotEnvelopeDigest'] !== null &&
      !isAgentOsRawSha256DigestV1(row['snapshotEnvelopeDigest'])) ||
    !validTimestamp(row['startedAt']) ||
    (row['completedAt'] !== null && !validTimestamp(row['completedAt'])) ||
    !isAgentOsRawSha256DigestV1(row['authenticatorKeyId'])) return false;
  if (row['attemptId'] !== agentOsEpochAttemptIdV1({
    epoch: row['epoch'] as number,
    attemptNamespaceDigest: row['attemptNamespaceDigest'] as string,
    durableTickDigest: row['durableTickDigest'] as string,
  })) return false;
  if (row['transitionOrdinal'] === 1) {
    return row['previousReceiptDigest'] === AGENT_OS_EPOCH_ATTEMPT_RAW_GENESIS_DIGEST_V2 &&
      row['outcome'] === null && row['snapshotEnvelopeDigest'] === null && row['completedAt'] === null;
  }
  return row['transitionOrdinal'] === 2 && typeof row['outcome'] === 'string' &&
    ATTEMPT_OUTCOMES.has(row['outcome'] as AgentOsEpochAttemptOutcomeV2) &&
    row['previousReceiptDigest'] !== AGENT_OS_EPOCH_ATTEMPT_RAW_GENESIS_DIGEST_V2 &&
    row['completedAt'] !== null && Date.parse(row['completedAt'] as string) >= Date.parse(row['startedAt'] as string) &&
    (row['outcome'] === 'succeeded'
      ? row['snapshotEnvelopeDigest'] !== null
      : row['snapshotEnvelopeDigest'] === null);
}

function validAttemptClosureContext(value: unknown): value is AgentOsEpochAttemptClosureContextV2 {
  const row = record(value);
  return Boolean(row && exactKeys(row, ATTEMPT_CLOSURE_CONTEXT_KEYS) &&
    validEpoch(row['epoch']) &&
    isAgentOsPrefixedSha256DigestV1(row['attemptNamespaceDigest']) &&
    isAgentOsRawSha256DigestV1(row['sourceBundleDigest']) &&
    isAgentOsRawSha256DigestV1(row['trustPolicyDigest']));
}

function attemptAuthenticatorPayload(value: AgentOsEpochAttemptReceiptUnsignedV2): Buffer | null {
  const canonical = canonicalBytes(value);
  return canonical
    ? Buffer.concat([Buffer.from(AGENT_OS_EPOCH_ATTEMPT_AUTHENTICATOR_DOMAIN_V2, 'utf8'), canonical])
    : null;
}

function validAttemptReceipt(value: unknown): value is AgentOsEpochAttemptReceiptV2 {
  const row = record(value);
  if (!row || !exactKeys(row, ATTEMPT_KEYS) ||
    !isAgentOsRawSha256DigestV1(row['receiptDigest']) ||
    !isAgentOsRawSha256DigestV1(row['authenticator'])) return false;
  const unsigned = Object.fromEntries(ATTEMPT_UNSIGNED_KEYS.map((key) => [key, row[key]]));
  const bytes = canonicalBytes(unsigned);
  return validAttemptUnsigned(unsigned) && bytes !== null && row['receiptDigest'] ===
    rawDigest(AGENT_OS_EPOCH_ATTEMPT_RECEIPT_DOMAIN_V2, bytes);
}

export function createAgentOsEpochAttemptReceiptV2(
  input: AgentOsEpochAttemptReceiptInputV2,
  signer: AgentOsEpochAttemptSignerV2,
): AgentOsEpochAttemptReceiptV2 | null {
  try {
    const row = record(input);
    const authRow = record(signer);
    if (!row || !exactKeys(row, ATTEMPT_INPUT_KEYS) || !authRow ||
      !exactKeys(authRow, ['keyId', 'authenticate']) ||
      typeof signer.authenticate !== 'function' ||
      !isAgentOsRawSha256DigestV1(signer.keyId)) return null;
    const attemptId = agentOsEpochAttemptIdV1({
      epoch: row['epoch'] as number,
      attemptNamespaceDigest: row['attemptNamespaceDigest'] as string,
      durableTickDigest: row['durableTickDigest'] as string,
    });
    if (!attemptId) return null;
    const cloned = canonicalClone(row);
    if (!cloned) return null;
    const unsigned = {
      schemaVersion: 2 as const,
      protocol: AGENT_OS_EPOCH_ATTEMPT_PROTOCOL_V2,
      recordType: 'agent-os-epoch-attempt' as const,
      ...AGENT_OS_EPOCH_RECORD_AUTHORITY_V1,
      ...cloned,
      attemptId,
      authenticatorKeyId: signer.keyId,
    } as AgentOsEpochAttemptReceiptUnsignedV2;
    if (!validAttemptUnsigned(unsigned)) return null;
    const unsignedBytes = canonicalBytes(unsigned);
    const authenticatorPayload = attemptAuthenticatorPayload(unsigned);
    if (!unsignedBytes || !authenticatorPayload) return null;
    const receiptDigest = rawDigest(AGENT_OS_EPOCH_ATTEMPT_RECEIPT_DOMAIN_V2, unsignedBytes);
    const authenticatorRequest = Buffer.from(authenticatorPayload);
    const authenticatorRequestBefore = Buffer.from(authenticatorRequest);
    const tag = signer.authenticate(authenticatorRequest);
    if (!exactBytes(authenticatorRequest, authenticatorRequestBefore)) return null;
    if (!isAgentOsRawSha256DigestV1(tag)) return null;
    const receipt = { ...unsigned, receiptDigest, authenticator: tag };
    return validAttemptReceipt(receipt)
      ? deepFreeze(canonicalClone(receipt) as AgentOsEpochAttemptReceiptV2)
      : null;
  } catch {
    return null;
  }
}

export function canonicalAgentOsEpochAttemptReceiptBytesV2(value: unknown): Buffer | null {
  return validAttemptReceipt(value) ? canonicalBytes(value) : null;
}

export function parseAgentOsEpochAttemptReceiptV2(
  bytes: Uint8Array,
): AgentOsEpochAttemptReceiptV2 | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > MAX_CANONICAL_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    const canonical = canonicalAgentOsEpochAttemptReceiptBytesV2(parsed);
    return canonical && exactBytes(bytes, canonical)
      ? deepFreeze(parsed as AgentOsEpochAttemptReceiptV2)
      : null;
  } catch {
    return null;
  }
}

function authenticateAttemptClosureContextV2(
  context: AgentOsEpochAttemptClosureContextV2,
  contextVerifier: AgentOsEpochAttemptClosureContextVerifierV2,
): Readonly<AgentOsEpochAttemptClosureContextV2> | null {
  try {
    const cloned = canonicalClone(context);
    const frozen = cloned ? deepFreeze(cloned) : null;
    const verifierRow = record(contextVerifier);
    if (!frozen || !validAttemptClosureContext(frozen) || !verifierRow ||
      !exactKeys(verifierRow, ['verify']) || typeof contextVerifier.verify !== 'function') return null;
    return contextVerifier.verify(frozen) === true ? frozen : null;
  } catch {
    return null;
  }
}

function verifyAgentOsEpochAttemptReceiptAuthenticityV2(
  value: unknown,
  verifier: AgentOsEpochAttemptVerifierV2,
): AgentOsEpochAttemptReceiptV2 | null {
  try {
    const canonical = canonicalAgentOsEpochAttemptReceiptBytesV2(value);
    const authRow = record(verifier);
    if (!canonical || !authRow || !exactKeys(authRow, ['keyId', 'verify']) ||
      typeof verifier.verify !== 'function' ||
      !isAgentOsRawSha256DigestV1(verifier.keyId)) return null;
    const receipt = parseAgentOsEpochAttemptReceiptV2(canonical);
    if (!receipt || receipt.authenticatorKeyId !== verifier.keyId) return null;
    const receiptRow = receipt as unknown as Record<string, unknown>;
    const unsigned = Object.fromEntries(ATTEMPT_UNSIGNED_KEYS.map((key) => [key, receiptRow[key]]));
    if (!validAttemptUnsigned(unsigned)) return null;
    const payload = attemptAuthenticatorPayload(unsigned);
    if (!payload) return null;
    const request = deepFreeze({
      keyId: receipt.authenticatorKeyId,
      canonicalDomainSeparatedReceipt: Buffer.from(payload),
      authenticator: receipt.authenticator,
    });
    const requestPayloadBefore = Buffer.from(request.canonicalDomainSeparatedReceipt);
    let authenticated = false;
    try { authenticated = verifier.verify(request) === true; } catch { /* fail closed */ }
    if (!authenticated || !exactBytes(request.canonicalDomainSeparatedReceipt, requestPayloadBefore)) return null;
    const reparsed = parseAgentOsEpochAttemptReceiptV2(canonical);
    return reparsed?.receiptDigest === receipt.receiptDigest ? reparsed : null;
  } catch {
    return null;
  }
}

function attemptMatchesClosureContextV2(
  receipt: AgentOsEpochAttemptReceiptV2,
  context: Readonly<AgentOsEpochAttemptClosureContextV2>,
): boolean {
  return receipt.epoch === context.epoch &&
    receipt.attemptNamespaceDigest === context.attemptNamespaceDigest &&
    receipt.sourceBundleDigest === context.sourceBundleDigest &&
    receipt.trustPolicyDigest === context.trustPolicyDigest;
}

export function verifyAgentOsEpochAttemptReceiptV2(
  value: unknown,
  context: AgentOsEpochAttemptClosureContextV2,
  verifier: AgentOsEpochAttemptVerifierV2,
  contextVerifier: AgentOsEpochAttemptClosureContextVerifierV2,
): AgentOsEpochAttemptReceiptV2 | null {
  const authenticatedContext = authenticateAttemptClosureContextV2(context, contextVerifier);
  if (!authenticatedContext) return null;
  const receipt = verifyAgentOsEpochAttemptReceiptAuthenticityV2(value, verifier);
  return receipt && attemptMatchesClosureContextV2(receipt, authenticatedContext) ? receipt : null;
}

export function verifyAgentOsEpochAttemptTransitionV2(
  startValue: unknown,
  terminalValue: unknown,
  context: AgentOsEpochAttemptClosureContextV2,
  verifier: AgentOsEpochAttemptVerifierV2,
  contextVerifier: AgentOsEpochAttemptClosureContextVerifierV2,
): Readonly<{ start: AgentOsEpochAttemptReceiptV2; terminal: AgentOsEpochAttemptReceiptV2 }> | null {
  const authenticatedContext = authenticateAttemptClosureContextV2(context, contextVerifier);
  if (!authenticatedContext) return null;
  const start = verifyAgentOsEpochAttemptReceiptAuthenticityV2(startValue, verifier);
  const terminal = verifyAgentOsEpochAttemptReceiptAuthenticityV2(terminalValue, verifier);
  if (!start || !terminal || start.transitionOrdinal !== 1 || terminal.transitionOrdinal !== 2 ||
    !attemptMatchesClosureContextV2(start, authenticatedContext) ||
    !attemptMatchesClosureContextV2(terminal, authenticatedContext) ||
    terminal.previousReceiptDigest !== start.receiptDigest || terminal.attemptId !== start.attemptId ||
    terminal.epoch !== start.epoch ||
    terminal.attemptNamespaceDigest !== start.attemptNamespaceDigest ||
    terminal.durableTickDigest !== start.durableTickDigest ||
    terminal.sourceBundleDigest !== start.sourceBundleDigest || terminal.startedAt !== start.startedAt) return null;
  return deepFreeze({ start, terminal });
}
