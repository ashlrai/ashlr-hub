/**
 * Signed, replay-resistant observation records for a future local-container broker.
 *
 * These pure records bind pre-start and post-run claims to one request nonce,
 * container identity, immutable implementation/configuration digests, resource
 * limits, and removal evidence. They do not contact Docker, provision keys,
 * launch work, or establish that a broker's claims are independently true.
 */

import { createHash } from 'node:crypto';

import {
  isAgentOsLocalContainerLimitsV1,
  type AgentOsLocalContainerLimitsV1,
} from './agent-os-local-container-policy.js';

export const AGENT_OS_OBSERVATION_ISOLATION_PROTOCOL_V2 =
  'ashlr-agent-os-observation-isolation-v2' as const;
export const AGENT_OS_OBSERVATION_ISOLATION_SIGNATURE_ALGORITHM_V2 = 'ed25519' as const;
export const AGENT_OS_OBSERVATION_ISOLATION_MAX_ATTESTATION_LIFETIME_MS_V2 = 5 * 60_000;
export const AGENT_OS_OBSERVATION_ISOLATION_MAX_FUTURE_SKEW_MS_V2 = 5_000;

const PREPARE_SIGNATURE_DOMAIN = 'ashlr:agent-os:observation-isolation:prepare-signature:v2\0';
const PREPARE_DIGEST_DOMAIN = 'ashlr:agent-os:observation-isolation:prepare-digest:v2\0';
const FINALIZE_SIGNATURE_DOMAIN = 'ashlr:agent-os:observation-isolation:finalize-signature:v2\0';
const FINALIZE_DIGEST_DOMAIN = 'ashlr:agent-os:observation-isolation:finalize-digest:v2\0';
const RAW_SHA256_RE = /^[a-f0-9]{64}$/u;
const CONTAINER_ID_RE = /^[a-f0-9]{64}$/u;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/u;

export const AGENT_OS_OBSERVATION_ISOLATION_NO_AUTHORITY_V2 = Object.freeze({
  authority: 'observation-only' as const,
  executionAuthority: false as const,
  effectAuthority: false as const,
  externalMutationAuthority: false as const,
  credentialAuthority: false as const,
  commissioningAuthority: false as const,
  activationAuthority: false as const,
  containerProvisioningAuthority: false as const,
  isolationEnforcementAuthority: false as const,
});

export interface AgentOsObservationIsolationBindingsV2 {
  requestNonce: string;
  requestDigest: string;
  containerId: string;
  brokerDigest: string;
  engineDigest: string;
  imageDigest: string;
  producerDigest: string;
  seccompDigest: string;
  createConfigDigest: string;
  limits: AgentOsLocalContainerLimitsV1;
}

export interface AgentOsObservationIsolationPostRunEvidenceV2 {
  requestDigest: string;
  responseDigest: string;
  inspectDigest: string;
  exitEvidenceDigest: string;
  removalEvidenceDigest: string;
  exitCode: number;
  oomKilled: boolean;
  timedOut: boolean;
  finishedAt: string;
  removalConfirmed: true;
  containerAbsentAfterRemoval: true;
  removedAt: string;
}

interface AgentOsObservationIsolationAuthorityV2 {
  authority: 'observation-only';
  executionAuthority: false;
  effectAuthority: false;
  externalMutationAuthority: false;
  credentialAuthority: false;
  commissioningAuthority: false;
  activationAuthority: false;
  containerProvisioningAuthority: false;
  isolationEnforcementAuthority: false;
}

export interface AgentOsObservationIsolationPrepareInputV2
  extends AgentOsObservationIsolationBindingsV2 {
  issuedAt: string;
  expiresAt: string;
}

export interface AgentOsObservationIsolationPrepareAttestationV2
  extends AgentOsObservationIsolationPrepareInputV2, AgentOsObservationIsolationAuthorityV2 {
  schemaVersion: 2;
  protocol: typeof AGENT_OS_OBSERVATION_ISOLATION_PROTOCOL_V2;
  phase: 'prepared';
  attestationKeyId: string;
  signatureAlgorithm: typeof AGENT_OS_OBSERVATION_ISOLATION_SIGNATURE_ALGORITHM_V2;
  attestationDigest: string;
  signature: string;
}

export interface AgentOsObservationIsolationFinalizeInputV2
  extends AgentOsObservationIsolationBindingsV2 {
  prepareAttestationDigest: string;
  issuedAt: string;
  expiresAt: string;
  postRun: AgentOsObservationIsolationPostRunEvidenceV2;
}

export interface AgentOsObservationIsolationFinalizeAttestationV2
  extends AgentOsObservationIsolationFinalizeInputV2, AgentOsObservationIsolationAuthorityV2 {
  schemaVersion: 2;
  protocol: typeof AGENT_OS_OBSERVATION_ISOLATION_PROTOCOL_V2;
  phase: 'finalized';
  attestationKeyId: string;
  signatureAlgorithm: typeof AGENT_OS_OBSERVATION_ISOLATION_SIGNATURE_ALGORITHM_V2;
  attestationDigest: string;
  signature: string;
}

export interface AgentOsObservationIsolationSignerV2 {
  readonly keyId: string;
  sign(canonicalDomainSeparatedAttestation: Uint8Array): Uint8Array | null;
}

export interface AgentOsObservationIsolationVerifierV2 {
  readonly keyId: string;
  verify(input: Readonly<{
    canonicalDomainSeparatedAttestation: Uint8Array;
    signature: Uint8Array;
  }>): boolean;
}

export type AgentOsObservationIsolationReasonV2 =
  | 'attestation-verified'
  | 'invalid-attestation'
  | 'invalid-expected-bindings'
  | 'binding-mismatch'
  | 'post-run-evidence-mismatch'
  | 'attestation-future'
  | 'attestation-expired'
  | 'attestation-lifetime-invalid'
  | 'attestation-key-mismatch'
  | 'signature-invalid'
  | 'verifier-mutated-input'
  | 'prepare-unverified'
  | 'prepare-link-mismatch'
  | 'phase-time-invalid';

export interface AgentOsObservationIsolationInspectionV2 {
  schemaVersion: 2;
  mode: 'agent-os-observation-isolation-inspection-v2';
  state: 'verified' | 'withheld';
  reason: AgentOsObservationIsolationReasonV2;
  phase: 'prepared' | 'finalized' | null;
  attestationDigest: string | null;
  prepareAttestationDigest: string | null;
  signatureVerified: boolean;
  bindingsVerified: boolean;
  postRunEvidenceVerified: boolean;
  removalEvidencePresent: boolean;
  brokerTruthIndependentlyVerified: false;
  dockerEnforcementVerified: false;
  authority: 'observation-only';
  executionAuthority: false;
  effectAuthority: false;
  externalMutationAuthority: false;
  credentialAuthority: false;
  commissioningAuthority: false;
  activationAuthority: false;
  containerProvisioningAuthority: false;
  isolationEnforcementAuthority: false;
}

const AUTHORITY_KEYS = Object.keys(AGENT_OS_OBSERVATION_ISOLATION_NO_AUTHORITY_V2);
const LIMIT_KEYS = [
  'cpuNanoCpus', 'maxDurationMs', 'maxOutputBytes', 'memoryBytes', 'memorySwapBytes', 'pidsLimit',
] as const;
const BINDING_KEYS = [
  'brokerDigest', 'containerId', 'createConfigDigest', 'engineDigest', 'imageDigest', 'limits',
  'producerDigest', 'requestDigest', 'requestNonce', 'seccompDigest',
] as const;
const POST_RUN_KEYS = [
  'containerAbsentAfterRemoval', 'exitCode', 'exitEvidenceDigest', 'finishedAt', 'inspectDigest',
  'oomKilled', 'removalConfirmed', 'removalEvidenceDigest', 'removedAt', 'requestDigest',
  'responseDigest', 'timedOut',
] as const;
const PREPARE_INPUT_KEYS = [...BINDING_KEYS, 'expiresAt', 'issuedAt'] as const;
const PREPARE_UNSIGNED_KEYS = [
  ...AUTHORITY_KEYS, ...PREPARE_INPUT_KEYS, 'attestationKeyId', 'phase', 'protocol',
  'schemaVersion', 'signatureAlgorithm',
] as const;
const PREPARE_KEYS = [...PREPARE_UNSIGNED_KEYS, 'attestationDigest', 'signature'] as const;
const FINALIZE_INPUT_KEYS = [
  ...BINDING_KEYS, 'expiresAt', 'issuedAt', 'postRun', 'prepareAttestationDigest',
] as const;
const FINALIZE_UNSIGNED_KEYS = [
  ...AUTHORITY_KEYS, ...FINALIZE_INPUT_KEYS, 'attestationKeyId', 'phase', 'protocol',
  'schemaVersion', 'signatureAlgorithm',
] as const;
const FINALIZE_KEYS = [...FINALIZE_UNSIGNED_KEYS, 'attestationDigest', 'signature'] as const;

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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}

function domainBytes(domain: string, value: unknown): Buffer {
  return Buffer.concat([Buffer.from(domain, 'utf8'), canonicalBytes(value)]);
}

function digest(domain: string, value: unknown): string {
  return createHash('sha256').update(domain, 'utf8').update(canonicalJson(value), 'utf8').digest('hex');
}

function exactBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.compare(
    Buffer.from(left.buffer, left.byteOffset, left.byteLength),
    Buffer.from(right.buffer, right.byteOffset, right.byteLength),
  ) === 0;
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

function owned<T>(value: T): T | null {
  try { return deepFreeze(JSON.parse(canonicalJson(value)) as T); } catch { return null; }
}

function rawDigest(value: unknown): value is string {
  return typeof value === 'string' && RAW_SHA256_RE.test(value);
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function requestNonce(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 128 || !BASE64URL_RE.test(value)) return false;
  try {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.byteLength >= 16 && bytes.byteLength <= 64 && bytes.toString('base64url') === value;
  } catch {
    return false;
  }
}

function authority(value: Record<string, unknown>): boolean {
  return AUTHORITY_KEYS.every((key) => value[key] ===
    AGENT_OS_OBSERVATION_ISOLATION_NO_AUTHORITY_V2[
      key as keyof typeof AGENT_OS_OBSERVATION_ISOLATION_NO_AUTHORITY_V2
    ]);
}

function bindings(value: unknown): value is AgentOsObservationIsolationBindingsV2 {
  const row = record(value);
  if (!row || !exactKeys(row, BINDING_KEYS) || !requestNonce(row['requestNonce']) ||
    !rawDigest(row['requestDigest']) || typeof row['containerId'] !== 'string' ||
    !CONTAINER_ID_RE.test(row['containerId']) || !isAgentOsLocalContainerLimitsV1(row['limits'])) return false;
  return ['brokerDigest', 'engineDigest', 'imageDigest', 'producerDigest', 'seccompDigest',
    'createConfigDigest'].every((key) => rawDigest(row[key]));
}

function bindingsEqual(
  left: AgentOsObservationIsolationBindingsV2,
  right: AgentOsObservationIsolationBindingsV2,
): boolean {
  return BINDING_KEYS.every((key) => key === 'limits'
    ? LIMIT_KEYS.every((limit) => left.limits[limit] === right.limits[limit])
    : left[key] === right[key]);
}

function postRun(value: unknown): value is AgentOsObservationIsolationPostRunEvidenceV2 {
  const row = record(value);
  if (!row || !exactKeys(row, POST_RUN_KEYS) || !rawDigest(row['requestDigest']) ||
    !rawDigest(row['responseDigest']) || !rawDigest(row['inspectDigest']) ||
    !rawDigest(row['exitEvidenceDigest']) || !rawDigest(row['removalEvidenceDigest']) ||
    !Number.isSafeInteger(row['exitCode']) || (row['exitCode'] as number) < 0 ||
    (row['exitCode'] as number) > 255 || typeof row['oomKilled'] !== 'boolean' ||
    typeof row['timedOut'] !== 'boolean' || !timestamp(row['finishedAt']) ||
    row['removalConfirmed'] !== true || row['containerAbsentAfterRemoval'] !== true ||
    !timestamp(row['removedAt'])) return false;
  return Date.parse(row['removedAt']) >= Date.parse(row['finishedAt']);
}

function postRunEqual(
  left: AgentOsObservationIsolationPostRunEvidenceV2,
  right: AgentOsObservationIsolationPostRunEvidenceV2,
): boolean {
  return POST_RUN_KEYS.every((key) => left[key] === right[key]);
}

function validSigner(value: unknown): value is AgentOsObservationIsolationSignerV2 {
  const signer = record(value);
  return Boolean(signer && exactKeys(signer, ['keyId', 'sign']) && rawDigest(signer['keyId']) &&
    typeof signer['sign'] === 'function');
}

function validVerifier(value: unknown): value is AgentOsObservationIsolationVerifierV2 {
  const verifier = record(value);
  return Boolean(verifier && exactKeys(verifier, ['keyId', 'verify']) && rawDigest(verifier['keyId']) &&
    typeof verifier['verify'] === 'function');
}

function validPrepareInput(value: unknown): value is AgentOsObservationIsolationPrepareInputV2 {
  const row = record(value);
  if (!row || !exactKeys(row, PREPARE_INPUT_KEYS) || !timestamp(row['issuedAt']) ||
    !timestamp(row['expiresAt'])) return false;
  const selected = Object.fromEntries(BINDING_KEYS.map((key) => [key, row[key]]));
  const lifetime = Date.parse(row['expiresAt']) - Date.parse(row['issuedAt']);
  return bindings(selected) && lifetime > 0 &&
    lifetime <= AGENT_OS_OBSERVATION_ISOLATION_MAX_ATTESTATION_LIFETIME_MS_V2;
}

function validFinalizeInput(value: unknown): value is AgentOsObservationIsolationFinalizeInputV2 {
  const row = record(value);
  if (!row || !exactKeys(row, FINALIZE_INPUT_KEYS) || !rawDigest(row['prepareAttestationDigest']) ||
    !timestamp(row['issuedAt']) || !timestamp(row['expiresAt']) || !postRun(row['postRun'])) return false;
  const selected = Object.fromEntries(BINDING_KEYS.map((key) => [key, row[key]]));
  const lifetime = Date.parse(row['expiresAt']) - Date.parse(row['issuedAt']);
  return bindings(selected) && row['postRun'].requestDigest === row['requestDigest'] &&
    lifetime > 0 && lifetime <= AGENT_OS_OBSERVATION_ISOLATION_MAX_ATTESTATION_LIFETIME_MS_V2 &&
    Date.parse(row['postRun'].removedAt) <= Date.parse(row['issuedAt']);
}

type PrepareUnsigned = Omit<AgentOsObservationIsolationPrepareAttestationV2,
'attestationDigest' | 'signature'>;
type FinalizeUnsigned = Omit<AgentOsObservationIsolationFinalizeAttestationV2,
'attestationDigest' | 'signature'>;

function validPrepareUnsigned(value: unknown): value is PrepareUnsigned {
  const row = record(value);
  if (!row || !exactKeys(row, PREPARE_UNSIGNED_KEYS) || row['schemaVersion'] !== 2 ||
    row['protocol'] !== AGENT_OS_OBSERVATION_ISOLATION_PROTOCOL_V2 || row['phase'] !== 'prepared' ||
    !authority(row) || !rawDigest(row['attestationKeyId']) ||
    row['signatureAlgorithm'] !== AGENT_OS_OBSERVATION_ISOLATION_SIGNATURE_ALGORITHM_V2) return false;
  const selected = Object.fromEntries(PREPARE_INPUT_KEYS.map((key) => [key, row[key]]));
  return validPrepareInput(selected);
}

function validFinalizeUnsigned(value: unknown): value is FinalizeUnsigned {
  const row = record(value);
  if (!row || !exactKeys(row, FINALIZE_UNSIGNED_KEYS) || row['schemaVersion'] !== 2 ||
    row['protocol'] !== AGENT_OS_OBSERVATION_ISOLATION_PROTOCOL_V2 || row['phase'] !== 'finalized' ||
    !authority(row) || !rawDigest(row['attestationKeyId']) ||
    row['signatureAlgorithm'] !== AGENT_OS_OBSERVATION_ISOLATION_SIGNATURE_ALGORITHM_V2) return false;
  const selected = Object.fromEntries(FINALIZE_INPUT_KEYS.map((key) => [key, row[key]]));
  return validFinalizeInput(selected);
}

function canonicalSignature(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !BASE64URL_RE.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.byteLength === 64 && decoded.toString('base64url') === value ? decoded : null;
  } catch {
    return null;
  }
}

function validPrepare(value: unknown): value is AgentOsObservationIsolationPrepareAttestationV2 {
  const row = record(value);
  if (!row || !exactKeys(row, PREPARE_KEYS) || !rawDigest(row['attestationDigest']) ||
    canonicalSignature(row['signature']) === null) return false;
  const unsigned = Object.fromEntries(PREPARE_UNSIGNED_KEYS.map((key) => [key, row[key]]));
  return validPrepareUnsigned(unsigned) &&
    digest(PREPARE_DIGEST_DOMAIN, unsigned) === row['attestationDigest'];
}

function validFinalize(value: unknown): value is AgentOsObservationIsolationFinalizeAttestationV2 {
  const row = record(value);
  if (!row || !exactKeys(row, FINALIZE_KEYS) || !rawDigest(row['attestationDigest']) ||
    canonicalSignature(row['signature']) === null) return false;
  const unsigned = Object.fromEntries(FINALIZE_UNSIGNED_KEYS.map((key) => [key, row[key]]));
  return validFinalizeUnsigned(unsigned) &&
    digest(FINALIZE_DIGEST_DOMAIN, unsigned) === row['attestationDigest'];
}

/** Canonical domain-separated bytes an external prepare signer authenticates. */
export function canonicalAgentOsObservationIsolationPreparePayloadV2(value: unknown): Buffer | null {
  return validPrepareUnsigned(value) ? domainBytes(PREPARE_SIGNATURE_DOMAIN, value) : null;
}

/** Canonical domain-separated bytes an external finalize signer authenticates. */
export function canonicalAgentOsObservationIsolationFinalizePayloadV2(value: unknown): Buffer | null {
  return validFinalizeUnsigned(value) ? domainBytes(FINALIZE_SIGNATURE_DOMAIN, value) : null;
}

function signUnsigned<T extends PrepareUnsigned | FinalizeUnsigned>(
  unsigned: T,
  signer: AgentOsObservationIsolationSignerV2,
  phase: 'prepared' | 'finalized',
): (T & { attestationDigest: string; signature: string }) | null {
  const payload = phase === 'prepared'
    ? canonicalAgentOsObservationIsolationPreparePayloadV2(unsigned)
    : canonicalAgentOsObservationIsolationFinalizePayloadV2(unsigned);
  if (!payload) return null;
  const callbackBytes = Buffer.from(payload);
  const before = Buffer.from(callbackBytes);
  try {
    const signature = signer.sign(callbackBytes);
    if (!(signature instanceof Uint8Array) || signature.byteLength !== 64 ||
      !exactBytes(callbackBytes, before)) return null;
    const attestationDigest = digest(
      phase === 'prepared' ? PREPARE_DIGEST_DOMAIN : FINALIZE_DIGEST_DOMAIN,
      unsigned,
    );
    return {
      ...unsigned,
      attestationDigest,
      signature: Buffer.from(signature).toString('base64url'),
    };
  } catch {
    return null;
  }
}

export function createAgentOsObservationIsolationPrepareAttestationV2(
  input: unknown,
  signer: AgentOsObservationIsolationSignerV2,
): AgentOsObservationIsolationPrepareAttestationV2 | null {
  try {
    if (!validPrepareInput(input) || !validSigner(signer)) return null;
    const ownedInput = owned(input);
    if (!ownedInput) return null;
    const unsigned: PrepareUnsigned = {
      schemaVersion: 2,
      protocol: AGENT_OS_OBSERVATION_ISOLATION_PROTOCOL_V2,
      phase: 'prepared',
      ...AGENT_OS_OBSERVATION_ISOLATION_NO_AUTHORITY_V2,
      ...ownedInput,
      attestationKeyId: signer.keyId,
      signatureAlgorithm: AGENT_OS_OBSERVATION_ISOLATION_SIGNATURE_ALGORITHM_V2,
    };
    const signed = signUnsigned(unsigned, signer, 'prepared');
    return signed && validPrepare(signed) ? owned(signed) : null;
  } catch {
    return null;
  }
}

export function createAgentOsObservationIsolationFinalizeAttestationV2(
  input: unknown,
  signer: AgentOsObservationIsolationSignerV2,
): AgentOsObservationIsolationFinalizeAttestationV2 | null {
  try {
    if (!validFinalizeInput(input) || !validSigner(signer)) return null;
    const ownedInput = owned(input);
    if (!ownedInput) return null;
    const unsigned: FinalizeUnsigned = {
      schemaVersion: 2,
      protocol: AGENT_OS_OBSERVATION_ISOLATION_PROTOCOL_V2,
      phase: 'finalized',
      ...AGENT_OS_OBSERVATION_ISOLATION_NO_AUTHORITY_V2,
      ...ownedInput,
      attestationKeyId: signer.keyId,
      signatureAlgorithm: AGENT_OS_OBSERVATION_ISOLATION_SIGNATURE_ALGORITHM_V2,
    };
    const signed = signUnsigned(unsigned, signer, 'finalized');
    return signed && validFinalize(signed) ? owned(signed) : null;
  } catch {
    return null;
  }
}

function withheld(
  reason: Exclude<AgentOsObservationIsolationReasonV2, 'attestation-verified'>,
  phase: 'prepared' | 'finalized' | null = null,
  prepareAttestationDigest: string | null = null,
): AgentOsObservationIsolationInspectionV2 {
  return Object.freeze({
    schemaVersion: 2,
    mode: 'agent-os-observation-isolation-inspection-v2',
    state: 'withheld',
    reason,
    phase,
    attestationDigest: null,
    prepareAttestationDigest,
    signatureVerified: false,
    bindingsVerified: false,
    postRunEvidenceVerified: false,
    removalEvidencePresent: false,
    brokerTruthIndependentlyVerified: false,
    dockerEnforcementVerified: false,
    ...AGENT_OS_OBSERVATION_ISOLATION_NO_AUTHORITY_V2,
  });
}

function timeReason(
  issuedAt: string,
  expiresAt: string,
  nowMs: number,
): 'attestation-future' | 'attestation-expired' | 'attestation-lifetime-invalid' | null {
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  if (issued > nowMs + AGENT_OS_OBSERVATION_ISOLATION_MAX_FUTURE_SKEW_MS_V2) {
    return 'attestation-future';
  }
  if (expires <= nowMs) return 'attestation-expired';
  return expires <= issued ||
    expires - issued > AGENT_OS_OBSERVATION_ISOLATION_MAX_ATTESTATION_LIFETIME_MS_V2
    ? 'attestation-lifetime-invalid' : null;
}

function verifySignature(
  unsigned: PrepareUnsigned | FinalizeUnsigned,
  signature: string,
  verifier: AgentOsObservationIsolationVerifierV2,
  phase: 'prepared' | 'finalized',
): 'verified' | 'attestation-key-mismatch' | 'signature-invalid' | 'verifier-mutated-input' {
  if (!validVerifier(verifier) || unsigned.attestationKeyId !== verifier.keyId) {
    return 'attestation-key-mismatch';
  }
  const payload = phase === 'prepared'
    ? canonicalAgentOsObservationIsolationPreparePayloadV2(unsigned)
    : canonicalAgentOsObservationIsolationFinalizePayloadV2(unsigned);
  const signatureBytes = canonicalSignature(signature);
  if (!payload || !signatureBytes) return 'signature-invalid';
  const callbackBytes = Buffer.from(payload);
  const before = Buffer.from(callbackBytes);
  const callbackSignature = Buffer.from(signatureBytes);
  const signatureBefore = Buffer.from(callbackSignature);
  let verified = false;
  try {
    verified = verifier.verify(deepFreeze({
      canonicalDomainSeparatedAttestation: callbackBytes,
      signature: callbackSignature,
    })) === true;
  } catch {
    verified = false;
  }
  if (!exactBytes(callbackBytes, before) || !exactBytes(callbackSignature, signatureBefore)) {
    return 'verifier-mutated-input';
  }
  return verified ? 'verified' : 'signature-invalid';
}

function verified(
  phase: 'prepared' | 'finalized',
  attestationDigest: string,
  prepareAttestationDigest: string | null,
): AgentOsObservationIsolationInspectionV2 {
  return Object.freeze({
    schemaVersion: 2,
    mode: 'agent-os-observation-isolation-inspection-v2',
    state: 'verified',
    reason: 'attestation-verified',
    phase,
    attestationDigest,
    prepareAttestationDigest,
    signatureVerified: true,
    bindingsVerified: true,
    postRunEvidenceVerified: phase === 'finalized',
    removalEvidencePresent: phase === 'finalized',
    brokerTruthIndependentlyVerified: false,
    dockerEnforcementVerified: false,
    ...AGENT_OS_OBSERVATION_ISOLATION_NO_AUTHORITY_V2,
  });
}

export function verifyAgentOsObservationIsolationPrepareAttestationV2(
  value: unknown,
  expectedBindings: unknown,
  verifier: AgentOsObservationIsolationVerifierV2,
  nowMs: number,
): AgentOsObservationIsolationInspectionV2 {
  if (!validPrepare(value)) return withheld('invalid-attestation', 'prepared');
  if (!bindings(expectedBindings) || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    return withheld('invalid-expected-bindings', 'prepared');
  }
  if (!bindingsEqual(value, expectedBindings)) return withheld('binding-mismatch', 'prepared');
  const timing = timeReason(value.issuedAt, value.expiresAt, nowMs);
  if (timing) return withheld(timing, 'prepared');
  const row = value as unknown as Record<string, unknown>;
  const unsigned = Object.fromEntries(PREPARE_UNSIGNED_KEYS.map((key) => [key, row[key]])) as PrepareUnsigned;
  const signatureState = verifySignature(unsigned, value.signature, verifier, 'prepared');
  if (signatureState !== 'verified') return withheld(signatureState, 'prepared');
  return verified('prepared', value.attestationDigest, null);
}

export function verifyAgentOsObservationIsolationFinalizeAttestationV2(
  value: unknown,
  prepare: unknown,
  expectedBindings: unknown,
  expectedPostRun: unknown,
  verifier: AgentOsObservationIsolationVerifierV2,
  nowMs: number,
): AgentOsObservationIsolationInspectionV2 {
  if (!validFinalize(value)) return withheld('invalid-attestation', 'finalized');
  if (!bindings(expectedBindings) || !postRun(expectedPostRun) ||
    !Number.isSafeInteger(nowMs) || nowMs < 0) {
    return withheld('invalid-expected-bindings', 'finalized');
  }
  if (!validPrepare(prepare)) {
    return withheld('prepare-unverified', 'finalized', value.prepareAttestationDigest);
  }
  const prepareInspection = verifyAgentOsObservationIsolationPrepareAttestationV2(
    prepare,
    expectedBindings,
    verifier,
    nowMs,
  );
  if (prepareInspection.state !== 'verified') {
    return withheld('prepare-unverified', 'finalized', value.prepareAttestationDigest);
  }
  if (value.prepareAttestationDigest !== prepare.attestationDigest) {
    return withheld('prepare-link-mismatch', 'finalized', value.prepareAttestationDigest);
  }
  if (!bindingsEqual(value, expectedBindings)) {
    return withheld('binding-mismatch', 'finalized', value.prepareAttestationDigest);
  }
  if (!postRunEqual(value.postRun, expectedPostRun)) {
    return withheld('post-run-evidence-mismatch', 'finalized', value.prepareAttestationDigest);
  }
  const timing = timeReason(value.issuedAt, value.expiresAt, nowMs);
  if (timing) return withheld(timing, 'finalized', value.prepareAttestationDigest);
  if (Date.parse(value.issuedAt) < Date.parse(prepare.issuedAt) ||
    Date.parse(value.issuedAt) > Date.parse(prepare.expiresAt) ||
    Date.parse(value.postRun.finishedAt) < Date.parse(prepare.issuedAt) ||
    Date.parse(value.postRun.finishedAt) - Date.parse(prepare.issuedAt) > value.limits.maxDurationMs) {
    return withheld('phase-time-invalid', 'finalized', value.prepareAttestationDigest);
  }
  const row = value as unknown as Record<string, unknown>;
  const unsigned = Object.fromEntries(FINALIZE_UNSIGNED_KEYS.map((key) => [key, row[key]])) as FinalizeUnsigned;
  const signatureState = verifySignature(unsigned, value.signature, verifier, 'finalized');
  if (signatureState !== 'verified') {
    return withheld(signatureState, 'finalized', value.prepareAttestationDigest);
  }
  return verified('finalized', value.attestationDigest, value.prepareAttestationDigest);
}
