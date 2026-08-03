/**
 * Crypto-only approval observation for verifier execution trust policies.
 *
 * This module authenticates bounded metadata. It does not sign, persist,
 * execute, merge, activate, deploy, read ambient configuration, or grant any
 * operational authority.
 */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto';
import {
  VERIFIER_EXECUTION_POLICY_APPROVAL_SIGNATURE_ALGORITHM,
  VERIFIER_EXECUTION_POLICY_APPROVAL_TRUST_POLICY,
  VERIFIER_EXECUTION_POLICY_APPROVAL_TRUST_PROTOCOL_V1,
  VERIFIER_EXECUTION_POLICY_APPROVER_ROLE,
  type VerifierExecutionPolicyApprovalRootV1,
  type VerifierExecutionPolicyApprovalTrustPolicyV1,
  type VerifierExecutionPolicyArchitectureV1,
  type VerifierExecutionPolicyBackendV1,
  type VerifierExecutionPolicyPlatformV1,
} from './verifier-execution-policy-trust-roots.js';
import {
  inspectVerifierExecutionAuthorityV2,
  type InspectVerifierExecutionAuthorityV2Input,
  type VerifierExecutionExpectedBindingsV1,
} from './verifier-execution-authority.js';

export const VERIFIER_EXECUTION_POLICY_APPROVAL_PROTOCOL_V1 =
  'ashlr-verifier-execution-policy-approval-v1' as const;

const APPROVAL_ASSURANCE = 'externally-approved-verifier-execution-policy' as const;
const APPROVED_TRUST_PROTOCOL = 'ashlr-verifier-execution-trust-v1' as const;
const SIGNATURE_DOMAIN = 'ashlr:verifier-execution-policy-approval-signature:v1';
const KEY_ID_DOMAIN = 'ashlr:verifier-execution-policy-approver-key-id:v1';
const CAPSULE_KEY_ID_DOMAIN = 'ashlr:verifier-execution-authority-key-id:v1';
const APPROVED_TRUST_POLICY_DIGEST_DOMAIN = 'ashlr:verifier-execution-trust-policy:v1';
const TRUST_POLICY_DIGEST_DOMAIN = 'ashlr:verifier-execution-policy-approval-trust-policy:v1';
const APPROVAL_DIGEST_DOMAIN = 'ashlr:verifier-execution-policy-approval:v1';
const DIGEST = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const POLICY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_ROOTS = 16;
const MAX_CAPSULE_KEYS = 16;
const MAX_LIFETIME_MS = 10 * 60 * 1_000;
const PLATFORMS = ['darwin', 'linux', 'win32'] as const;
const ARCHITECTURES = ['arm64', 'x64'] as const;
const BACKENDS = [
  'linux-namespace-cgroup-broker',
  'macos-virtualization-framework-broker',
  'windows-appcontainer-job-broker',
] as const;

export const VERIFIER_EXECUTION_POLICY_APPROVAL_BLOCKERS_V1 = Object.freeze([
  'clock-authority-unavailable',
  'replay-transparency-unavailable',
  'live-immutability-unproven',
  'execution-wiring-disabled',
  'activation-wiring-disabled',
  'deployment-wiring-disabled',
] as const);

const SCOPE_KEYS = [
  'architecture', 'backend', 'environmentDigest', 'fleetDigest', 'platform', 'repositoryDigest',
] as const;
const INPUT_KEYS = [
  'approval', 'approvedTrustPolicy', 'expectedApprovedTrustPolicyDigest',
  'expectedPolicyGeneration', 'expectedScope', 'nowMs',
] as const;
const APPROVED_POLICY_KEYS = ['keys', 'policyVersion', 'protocol', 'schemaVersion'] as const;
const APPROVED_POLICY_KEY_KEYS = [
  'allowedArchitectures', 'allowedBackends', 'allowedPlatforms', 'keyId', 'notAfter',
  'notBefore', 'publicKeySpki', 'role', 'signatureAlgorithm',
] as const;
const ROOT_KEYS = [
  'allowedArchitectures', 'allowedBackends', 'allowedPlatforms', 'environmentDigest', 'fleetDigest',
  'keyId', 'minimumApprovedPolicyGeneration', 'notAfter', 'notBefore', 'publicKeySpki',
  'repositoryDigest', 'revokedAt', 'role', 'signatureAlgorithm',
] as const;
const TRUST_POLICY_KEYS = ['policyGeneration', 'protocol', 'roots', 'schemaVersion'] as const;
const UNSIGNED_APPROVAL_KEYS = [
  'activationPermitted', 'approvedTrustPolicyDigest', 'approvedTrustProtocol', 'approverKeyId',
  'approverRole', 'architecture', 'assurance', 'authority', 'backend', 'deployPermitted',
  'environmentDigest', 'evidencePermitted', 'executionPermitted', 'expiresAt', 'fleetDigest',
  'issuedAt', 'mergePermitted', 'nonce', 'platform', 'policyGeneration', 'protocol',
  'replayTransparencyVerified', 'repositoryDigest', 'schemaVersion', 'signatureAlgorithm',
] as const;
const APPROVAL_KEYS = [...UNSIGNED_APPROVAL_KEYS, 'signature'] as const;
const TIME_OBSERVATION_KEYS = [
  'authority', 'clockAuthorityVerified', 'observedAt', 'protocol', 'receiptDigest',
  'schemaVersion', 'state',
] as const;
const COMPOSITION_INPUT_KEYS = [
  'executionAuthorityInput', 'expectedIdentity', 'policyApprovalInput', 'timeAuthorityObservation',
] as const;
const COMPOSITION_IDENTITY_KEYS = [
  'architecture', 'backend', 'baseDigest', 'brokerDigest', 'candidateDigest',
  'capsuleTreeDigest', 'commandPlanDigest', 'dependencyDigest', 'executableDigest',
  'isolationPolicyDigest', 'platform', 'ticketDigest',
] as const;

export interface VerifierExecutionPolicyApprovalScopeV1 {
  fleetDigest: string;
  repositoryDigest: string;
  environmentDigest: string;
  platform: VerifierExecutionPolicyPlatformV1;
  architecture: VerifierExecutionPolicyArchitectureV1;
  backend: VerifierExecutionPolicyBackendV1;
}

export interface VerifierExecutionApprovedTrustKeyV1 {
  keyId: string;
  signatureAlgorithm: 'ed25519';
  role: 'verifier-capsule-admission-signer';
  publicKeySpki: string;
  notBefore: string;
  notAfter: string;
  allowedPlatforms: VerifierExecutionPolicyPlatformV1[];
  allowedArchitectures: VerifierExecutionPolicyArchitectureV1[];
  allowedBackends: VerifierExecutionPolicyBackendV1[];
}

export interface VerifierExecutionApprovedTrustPolicyV1 {
  schemaVersion: 1;
  protocol: typeof APPROVED_TRUST_PROTOCOL;
  policyVersion: string;
  keys: VerifierExecutionApprovedTrustKeyV1[];
}

export interface VerifierExecutionPolicyApprovalUnsignedV1
  extends VerifierExecutionPolicyApprovalScopeV1 {
  schemaVersion: 1;
  protocol: typeof VERIFIER_EXECUTION_POLICY_APPROVAL_PROTOCOL_V1;
  assurance: typeof APPROVAL_ASSURANCE;
  approvedTrustPolicyDigest: string;
  approvedTrustProtocol: typeof APPROVED_TRUST_PROTOCOL;
  policyGeneration: number;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  approverKeyId: string;
  approverRole: typeof VERIFIER_EXECUTION_POLICY_APPROVER_ROLE;
  signatureAlgorithm: typeof VERIFIER_EXECUTION_POLICY_APPROVAL_SIGNATURE_ALGORITHM;
  authority: 'observation-only';
  replayTransparencyVerified: false;
  executionPermitted: false;
  evidencePermitted: false;
  mergePermitted: false;
  activationPermitted: false;
  deployPermitted: false;
}

export interface VerifierExecutionPolicyApprovalEnvelopeV1
  extends VerifierExecutionPolicyApprovalUnsignedV1 {
  signature: string;
}

export interface InspectVerifierExecutionPolicyApprovalV1Input {
  approval: VerifierExecutionPolicyApprovalEnvelopeV1;
  approvedTrustPolicy: VerifierExecutionApprovedTrustPolicyV1;
  expectedApprovedTrustPolicyDigest: string;
  expectedPolicyGeneration: number;
  expectedScope: VerifierExecutionPolicyApprovalScopeV1;
  nowMs: number;
}

export type VerifierExecutionPolicyApprovalReasonV1 =
  | 'policy-approval-cryptography-verified'
  | 'invalid-input'
  | 'trust-root-unprovisioned'
  | 'trust-policy-invalid'
  | 'approval-invalid'
  | 'approved-policy-invalid'
  | 'approved-policy-digest-mismatch'
  | 'approved-policy-protocol-mismatch'
  | 'policy-generation-mismatch'
  | 'policy-generation-downgrade'
  | 'scope-mismatch'
  | 'approver-role-invalid'
  | 'approver-key-unknown'
  | 'approver-key-invalid'
  | 'approver-key-inactive'
  | 'approver-key-revoked'
  | 'approver-capsule-role-collision'
  | 'approval-lifetime-invalid'
  | 'signature-invalid';

interface VerifierExecutionPolicyApprovalResultBaseV1 {
  schemaVersion: 1;
  mode: 'verifier-execution-policy-approval-observation-v1';
  authority: 'observation-only';
  executionPermitted: false;
  evidencePermitted: false;
  mergePermitted: false;
  activationPermitted: false;
  deployPermitted: false;
  replayTransparencyVerified: false;
  clockAuthorityVerified: false;
  freshnessState: 'unavailable';
  freshnessObservedAt: null;
  trustPolicyApprovalVerified: false;
  blockers: typeof VERIFIER_EXECUTION_POLICY_APPROVAL_BLOCKERS_V1;
}

export type VerifierExecutionPolicyApprovalResultV1 =
  VerifierExecutionPolicyApprovalResultBaseV1 & (
    | {
      state: 'cryptographically-verified';
      reason: 'policy-approval-cryptography-verified';
      approvalDigest: string;
      approvedTrustPolicyDigest: string;
      approvalTrustPolicyDigest: string;
      policyGeneration: number;
      approvalTrustPolicyGeneration: number;
      approverKeyId: string;
      scope: VerifierExecutionPolicyApprovalScopeV1;
      capsuleStatementVerified: false;
      signatureVerified: true;
      approvalCryptographyVerified: true;
      trustRootProvisioned: true;
    }
    | {
      state: 'withheld';
      reason: Exclude<
      VerifierExecutionPolicyApprovalReasonV1,
      'policy-approval-cryptography-verified'
      >;
      approvalDigest: null;
      approvedTrustPolicyDigest: null;
      approvalTrustPolicyDigest: null;
      policyGeneration: null;
      approvalTrustPolicyGeneration: null;
      approverKeyId: null;
      scope: null;
      capsuleStatementVerified: false;
      signatureVerified: false;
      approvalCryptographyVerified: false;
      trustRootProvisioned: boolean;
    }
  );

/**
 * Reserved input contract for a future independently authenticated clock.
 * V1 accepts only an explicit unavailable observation and grants no authority.
 */
export interface VerifierExecutionTimeAuthorityObservationV1 {
  schemaVersion: 1;
  protocol: 'ashlr-verifier-execution-time-authority-observation-v1';
  state: 'unavailable';
  authority: 'none';
  observedAt: null;
  receiptDigest: null;
  clockAuthorityVerified: false;
}

export interface VerifierExecutionCompositionIdentityV1 {
  ticketDigest: string;
  candidateDigest: string;
  baseDigest: string;
  commandPlanDigest: string;
  capsuleTreeDigest: string;
  executableDigest: string;
  dependencyDigest: string;
  brokerDigest: string;
  isolationPolicyDigest: string;
  platform: VerifierExecutionPolicyPlatformV1;
  architecture: VerifierExecutionPolicyArchitectureV1;
  backend: VerifierExecutionPolicyBackendV1;
}

export interface InspectVerifierExecutionCompositionV1Input {
  policyApprovalInput: InspectVerifierExecutionPolicyApprovalV1Input;
  executionAuthorityInput: InspectVerifierExecutionAuthorityV2Input;
  expectedIdentity: VerifierExecutionCompositionIdentityV1;
  timeAuthorityObservation: VerifierExecutionTimeAuthorityObservationV1;
}

export type VerifierExecutionCompositionReasonV1 =
  | 'clock-authority-unavailable'
  | 'invalid-input'
  | 'policy-approval-unverified'
  | 'capsule-statement-unverified'
  | 'trust-policy-mismatch'
  | 'identity-mismatch'
  | 'scope-mismatch';

export interface VerifierExecutionCompositionResultV1 {
  schemaVersion: 1;
  mode: 'verifier-execution-authority-composition-v1';
  state: 'withheld' | 'freshness-unavailable';
  reason: VerifierExecutionCompositionReasonV1;
  authority: 'observation-only';
  trustPolicyDigest: string | null;
  approvalDigest: string | null;
  statementDigest: string | null;
  bindingDigest: string | null;
  policyApprovalCryptographyVerified: boolean;
  capsuleStatementCryptographyVerified: boolean;
  identityBindingVerified: boolean;
  scopeBindingVerified: boolean;
  trustPolicyApprovalVerified: false;
  clockAuthorityVerified: false;
  freshnessState: 'unavailable';
  freshnessObservedAt: null;
  replayTransparencyVerified: false;
  executionPermitted: false;
  evidencePermitted: false;
  mergePermitted: false;
  activationPermitted: false;
  deployPermitted: false;
  blockers: typeof VERIFIER_EXECUTION_POLICY_APPROVAL_BLOCKERS_V1;
}

function sha256(domain: string, value: Uint8Array): string {
  return createHash('sha256').update(`${domain}\0`, 'utf8').update(value).digest('hex');
}

function exactPlainRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function plainDataGraph(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (depth > 8 || seen.size >= 512 || seen.has(value)) return false;
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || value.length > 128) return false;
  } else if (prototype !== Object.prototype && prototype !== null) return false;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value') || !plainDataGraph(descriptor.value, seen, depth + 1)) {
      return false;
    }
  }
  return true;
}

function denseArray(value: unknown, minimum: number, maximum: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum || value.length > maximum ||
    Object.getOwnPropertyNames(value).length !== value.length + 1 ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => !Object.hasOwn(descriptor, 'value'),
    )) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function canonicalBase64Url(value: unknown, expectedBytes?: number): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || !BASE64URL.test(value)) {
    return null;
  }
  try {
    const bytes = Buffer.from(value, 'base64url');
    const validLength = expectedBytes === undefined
      ? bytes.length >= 32 && bytes.length <= 128
      : bytes.length === expectedBytes;
    return validLength && bytes.toString('base64url') === value ? bytes : null;
  } catch { return null; }
}

function sortedEnumArray<T extends string>(value: unknown, allowed: readonly T[]): value is readonly T[] {
  if (!denseArray(value, 1, allowed.length)) return false;
  let prior = '';
  for (const entry of value) {
    if (typeof entry !== 'string' || !allowed.includes(entry as T) || entry <= prior) return false;
    prior = entry;
  }
  return true;
}

function scopeShape(value: unknown): value is VerifierExecutionPolicyApprovalScopeV1 {
  return exactPlainRecord(value, SCOPE_KEYS) &&
    typeof value['fleetDigest'] === 'string' && DIGEST.test(value['fleetDigest']) &&
    typeof value['repositoryDigest'] === 'string' && DIGEST.test(value['repositoryDigest']) &&
    typeof value['environmentDigest'] === 'string' && DIGEST.test(value['environmentDigest']) &&
    PLATFORMS.includes(value['platform'] as VerifierExecutionPolicyPlatformV1) &&
    ARCHITECTURES.includes(value['architecture'] as VerifierExecutionPolicyArchitectureV1) &&
    BACKENDS.includes(value['backend'] as VerifierExecutionPolicyBackendV1);
}

function scopeMatches(
  approval: VerifierExecutionPolicyApprovalUnsignedV1,
  expected: VerifierExecutionPolicyApprovalScopeV1,
): boolean {
  return SCOPE_KEYS.every((key) => approval[key] === expected[key]);
}

/** Stable role-separated identity for a policy-approver Ed25519 public key. */
export function verifierExecutionPolicyApproverKeyId(publicKeySpki: unknown): string | null {
  const bytes = canonicalBase64Url(publicKeySpki);
  if (!bytes) return null;
  try {
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    const canonical = Buffer.from(key.export({ format: 'der', type: 'spki' }));
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519' || !canonical.equals(bytes)) {
      return null;
    }
    return sha256(KEY_ID_DOMAIN, bytes);
  } catch { return null; }
}

function rootShape(value: unknown): value is VerifierExecutionPolicyApprovalRootV1 {
  return exactPlainRecord(value, ROOT_KEYS) &&
    typeof value['keyId'] === 'string' && DIGEST.test(value['keyId']) &&
    typeof value['publicKeySpki'] === 'string' &&
    verifierExecutionPolicyApproverKeyId(value['publicKeySpki']) === value['keyId'] &&
    value['role'] === VERIFIER_EXECUTION_POLICY_APPROVER_ROLE &&
    value['signatureAlgorithm'] === VERIFIER_EXECUTION_POLICY_APPROVAL_SIGNATURE_ALGORITHM &&
    typeof value['fleetDigest'] === 'string' && DIGEST.test(value['fleetDigest']) &&
    typeof value['repositoryDigest'] === 'string' && DIGEST.test(value['repositoryDigest']) &&
    typeof value['environmentDigest'] === 'string' && DIGEST.test(value['environmentDigest']) &&
    sortedEnumArray(value['allowedPlatforms'], PLATFORMS) &&
    sortedEnumArray(value['allowedArchitectures'], ARCHITECTURES) &&
    sortedEnumArray(value['allowedBackends'], BACKENDS) &&
    Number.isSafeInteger(value['minimumApprovedPolicyGeneration']) &&
    (value['minimumApprovedPolicyGeneration'] as number) >= 0 &&
    canonicalIso(value['notBefore']) && canonicalIso(value['notAfter']) &&
    Date.parse(value['notBefore']) < Date.parse(value['notAfter']) &&
    (value['revokedAt'] === null || (canonicalIso(value['revokedAt']) &&
      Date.parse(value['revokedAt']) > Date.parse(value['notBefore']) &&
      Date.parse(value['revokedAt']) <= Date.parse(value['notAfter'])));
}

function trustPolicyShape(value: unknown): value is VerifierExecutionPolicyApprovalTrustPolicyV1 {
  if (!exactPlainRecord(value, TRUST_POLICY_KEYS) || value['schemaVersion'] !== 1 ||
    value['protocol'] !== VERIFIER_EXECUTION_POLICY_APPROVAL_TRUST_PROTOCOL_V1 ||
    !Number.isSafeInteger(value['policyGeneration']) || (value['policyGeneration'] as number) < 0 ||
    !denseArray(value['roots'], 0, MAX_ROOTS)) return false;
  let prior = '';
  for (const root of value['roots']) {
    if (!rootShape(root) || root.keyId <= prior) return false;
    prior = root.keyId;
  }
  return true;
}

function trustPolicyDigest(policy: VerifierExecutionPolicyApprovalTrustPolicyV1): string {
  return sha256(TRUST_POLICY_DIGEST_DOMAIN, Buffer.from(JSON.stringify([
    policy.schemaVersion,
    policy.protocol,
    policy.policyGeneration,
    policy.roots.map((root) => [
      root.keyId,
      root.publicKeySpki,
      root.role,
      root.signatureAlgorithm,
      root.fleetDigest,
      root.repositoryDigest,
      root.environmentDigest,
      root.allowedPlatforms,
      root.allowedArchitectures,
      root.allowedBackends,
      root.minimumApprovedPolicyGeneration,
      root.notBefore,
      root.notAfter,
      root.revokedAt,
    ]),
  ]), 'utf8'));
}

/** Identity of the code-owned approval policy. There is no caller-supplied variant. */
export function verifierExecutionPolicyApprovalTrustPolicyDigest(): string | null {
  try {
    return trustPolicyShape(VERIFIER_EXECUTION_POLICY_APPROVAL_TRUST_POLICY)
      ? trustPolicyDigest(VERIFIER_EXECUTION_POLICY_APPROVAL_TRUST_POLICY)
      : null;
  } catch { return null; }
}

function approvalShape(value: unknown): value is VerifierExecutionPolicyApprovalUnsignedV1 {
  return exactPlainRecord(value, UNSIGNED_APPROVAL_KEYS) && value['schemaVersion'] === 1 &&
    value['protocol'] === VERIFIER_EXECUTION_POLICY_APPROVAL_PROTOCOL_V1 &&
    value['assurance'] === APPROVAL_ASSURANCE &&
    typeof value['approvedTrustPolicyDigest'] === 'string' &&
    DIGEST.test(value['approvedTrustPolicyDigest']) &&
    value['approvedTrustProtocol'] === APPROVED_TRUST_PROTOCOL &&
    Number.isSafeInteger(value['policyGeneration']) && (value['policyGeneration'] as number) >= 0 &&
    typeof value['fleetDigest'] === 'string' && DIGEST.test(value['fleetDigest']) &&
    typeof value['repositoryDigest'] === 'string' && DIGEST.test(value['repositoryDigest']) &&
    typeof value['environmentDigest'] === 'string' && DIGEST.test(value['environmentDigest']) &&
    PLATFORMS.includes(value['platform'] as VerifierExecutionPolicyPlatformV1) &&
    ARCHITECTURES.includes(value['architecture'] as VerifierExecutionPolicyArchitectureV1) &&
    BACKENDS.includes(value['backend'] as VerifierExecutionPolicyBackendV1) &&
    canonicalIso(value['issuedAt']) && canonicalIso(value['expiresAt']) &&
    canonicalBase64Url(value['nonce'], 24) !== null &&
    typeof value['approverKeyId'] === 'string' && DIGEST.test(value['approverKeyId']) &&
    value['approverRole'] === VERIFIER_EXECUTION_POLICY_APPROVER_ROLE &&
    value['signatureAlgorithm'] === VERIFIER_EXECUTION_POLICY_APPROVAL_SIGNATURE_ALGORITHM &&
    value['authority'] === 'observation-only' && value['replayTransparencyVerified'] === false &&
    value['executionPermitted'] === false && value['evidencePermitted'] === false &&
    value['mergePermitted'] === false && value['activationPermitted'] === false &&
    value['deployPermitted'] === false;
}

/** Canonical bytes an external policy authority signs. This helper never signs. */
export function canonicalVerifierExecutionPolicyApprovalPayloadV1(value: unknown): Buffer | null {
  try {
    if (!plainDataGraph(value)) return null;
    const snapshot = structuredClone(value);
    if (!approvalShape(snapshot)) return null;
    return Buffer.from(JSON.stringify([
      SIGNATURE_DOMAIN,
      snapshot.schemaVersion,
      snapshot.protocol,
      snapshot.assurance,
      snapshot.approvedTrustPolicyDigest,
      snapshot.approvedTrustProtocol,
      snapshot.policyGeneration,
      snapshot.fleetDigest,
      snapshot.repositoryDigest,
      snapshot.environmentDigest,
      snapshot.platform,
      snapshot.architecture,
      snapshot.backend,
      snapshot.issuedAt,
      snapshot.expiresAt,
      snapshot.nonce,
      snapshot.approverKeyId,
      snapshot.approverRole,
      snapshot.signatureAlgorithm,
      snapshot.authority,
      snapshot.replayTransparencyVerified,
      snapshot.executionPermitted,
      snapshot.evidencePermitted,
      snapshot.mergePermitted,
      snapshot.activationPermitted,
      snapshot.deployPermitted,
    ]), 'utf8');
  } catch { return null; }
}

function trustedPublicKey(root: VerifierExecutionPolicyApprovalRootV1): KeyObject | null {
  if (!rootShape(root)) return null;
  const bytes = canonicalBase64Url(root.publicKeySpki);
  if (!bytes) return null;
  try {
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    const canonical = Buffer.from(key.export({ format: 'der', type: 'spki' }));
    return key.type === 'public' && key.asymmetricKeyType === 'ed25519' && canonical.equals(bytes)
      ? key : null;
  } catch { return null; }
}

function withheld(
  reason: Exclude<
  VerifierExecutionPolicyApprovalReasonV1,
  'policy-approval-cryptography-verified'
  >,
  trustRootProvisioned = VERIFIER_EXECUTION_POLICY_APPROVAL_TRUST_POLICY.roots.length > 0,
): VerifierExecutionPolicyApprovalResultV1 {
  return {
    schemaVersion: 1,
    mode: 'verifier-execution-policy-approval-observation-v1',
    state: 'withheld',
    reason,
    authority: 'observation-only',
    approvalDigest: null,
    approvedTrustPolicyDigest: null,
    approvalTrustPolicyDigest: null,
    policyGeneration: null,
    approvalTrustPolicyGeneration: null,
    approverKeyId: null,
    scope: null,
    capsuleStatementVerified: false,
    signatureVerified: false,
    approvalCryptographyVerified: false,
    trustPolicyApprovalVerified: false,
    trustRootProvisioned,
    replayTransparencyVerified: false,
    clockAuthorityVerified: false,
    freshnessState: 'unavailable',
    freshnessObservedAt: null,
    executionPermitted: false,
    evidencePermitted: false,
    mergePermitted: false,
    activationPermitted: false,
    deployPermitted: false,
    blockers: VERIFIER_EXECUTION_POLICY_APPROVAL_BLOCKERS_V1,
  };
}

function capsuleKeyId(publicKeySpki: unknown): string | null {
  const bytes = canonicalBase64Url(publicKeySpki);
  if (!bytes) return null;
  try {
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    const canonical = Buffer.from(key.export({ format: 'der', type: 'spki' }));
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519' || !canonical.equals(bytes)) {
      return null;
    }
    return sha256(CAPSULE_KEY_ID_DOMAIN, bytes);
  } catch { return null; }
}

function approvedPolicyKeyShape(value: unknown): value is VerifierExecutionApprovedTrustKeyV1 {
  return exactPlainRecord(value, APPROVED_POLICY_KEY_KEYS) &&
    typeof value['keyId'] === 'string' && DIGEST.test(value['keyId']) &&
    value['signatureAlgorithm'] === 'ed25519' &&
    value['role'] === 'verifier-capsule-admission-signer' &&
    typeof value['publicKeySpki'] === 'string' && capsuleKeyId(value['publicKeySpki']) === value['keyId'] &&
    canonicalIso(value['notBefore']) && canonicalIso(value['notAfter']) &&
    Date.parse(value['notBefore']) < Date.parse(value['notAfter']) &&
    sortedEnumArray(value['allowedPlatforms'], PLATFORMS) &&
    sortedEnumArray(value['allowedArchitectures'], ARCHITECTURES) &&
    sortedEnumArray(value['allowedBackends'], BACKENDS);
}

function approvedPolicyShape(value: unknown): value is VerifierExecutionApprovedTrustPolicyV1 {
  if (!exactPlainRecord(value, APPROVED_POLICY_KEYS) || value['schemaVersion'] !== 1 ||
    value['protocol'] !== APPROVED_TRUST_PROTOCOL || typeof value['policyVersion'] !== 'string' ||
    !POLICY_VERSION.test(value['policyVersion']) ||
    !denseArray(value['keys'], 1, MAX_CAPSULE_KEYS)) return false;
  let prior = '';
  for (const key of value['keys']) {
    if (!approvedPolicyKeyShape(key) || key.keyId <= prior) return false;
    prior = key.keyId;
  }
  return true;
}

/** Exact canonical identity used by the isolated #202 policy contract. */
export function verifierExecutionApprovedTrustPolicyDigestV1(value: unknown): string | null {
  try {
    if (!plainDataGraph(value)) return null;
    const policy = structuredClone(value);
    if (!approvedPolicyShape(policy)) return null;
    return createHash('sha256').update(JSON.stringify([
      APPROVED_TRUST_POLICY_DIGEST_DOMAIN,
      policy.schemaVersion,
      policy.protocol,
      policy.policyVersion,
      policy.keys.map((key) => [
        key.keyId,
        key.signatureAlgorithm,
        key.role,
        key.publicKeySpki,
        key.notBefore,
        key.notAfter,
        key.allowedPlatforms,
        key.allowedArchitectures,
        key.allowedBackends,
      ]),
    ])).digest('hex');
  } catch { return null; }
}

function inspectUnsafe(input: unknown): VerifierExecutionPolicyApprovalResultV1 {
  if (!plainDataGraph(input)) return withheld('invalid-input');
  const snapshot = structuredClone(input);
  if (!exactPlainRecord(snapshot, INPUT_KEYS) ||
    !Number.isSafeInteger(snapshot['nowMs']) || (snapshot['nowMs'] as number) < 0 ||
    !Number.isSafeInteger(snapshot['expectedPolicyGeneration']) ||
    (snapshot['expectedPolicyGeneration'] as number) < 0 || !scopeShape(snapshot['expectedScope'])) {
    return withheld('invalid-input');
  }

  if (VERIFIER_EXECUTION_POLICY_APPROVAL_TRUST_POLICY.roots.length === 0) {
    return withheld('trust-root-unprovisioned', false);
  }
  if (!trustPolicyShape(VERIFIER_EXECUTION_POLICY_APPROVAL_TRUST_POLICY)) {
    return withheld('trust-policy-invalid');
  }
  const approvalTrustPolicyDigest = trustPolicyDigest(
    VERIFIER_EXECUTION_POLICY_APPROVAL_TRUST_POLICY,
  );

  const approvalValue = snapshot['approval'];
  if (!exactPlainRecord(approvalValue, APPROVAL_KEYS)) return withheld('approval-invalid');
  const { signature, ...unsignedValue } = approvalValue;
  if (!approvalShape(unsignedValue)) return withheld('approval-invalid');
  const approval = unsignedValue;

  const approvedPolicy = snapshot['approvedTrustPolicy'];
  if (!approvedPolicyShape(approvedPolicy)) return withheld('approved-policy-invalid');
  const approvedPolicyDigest = verifierExecutionApprovedTrustPolicyDigestV1(approvedPolicy);
  if (!approvedPolicyDigest || approval.approvedTrustPolicyDigest !== approvedPolicyDigest ||
    snapshot['expectedApprovedTrustPolicyDigest'] !== approvedPolicyDigest) {
    return withheld('approved-policy-digest-mismatch');
  }
  if (approval.approvedTrustProtocol !== approvedPolicy.protocol) {
    return withheld('approved-policy-protocol-mismatch');
  }
  if (approval.policyGeneration !== snapshot['expectedPolicyGeneration']) {
    return withheld('policy-generation-mismatch');
  }
  if (!scopeMatches(approval, snapshot['expectedScope'])) return withheld('scope-mismatch');

  if (approval.approverRole !== VERIFIER_EXECUTION_POLICY_APPROVER_ROLE) {
    return withheld('approver-role-invalid');
  }
  const root = VERIFIER_EXECUTION_POLICY_APPROVAL_TRUST_POLICY.roots.find(
    (candidate) => candidate.keyId === approval.approverKeyId,
  );
  if (!root) return withheld('approver-key-unknown');
  const publicKey = trustedPublicKey(root);
  if (!publicKey) return withheld('approver-key-invalid');
  if (approvedPolicy.keys.some((key) => key.publicKeySpki === root.publicKeySpki)) {
    return withheld('approver-capsule-role-collision');
  }
  if (approval.policyGeneration < root.minimumApprovedPolicyGeneration) {
    return withheld('policy-generation-downgrade');
  }
  if (approval.fleetDigest !== root.fleetDigest ||
    approval.repositoryDigest !== root.repositoryDigest ||
    approval.environmentDigest !== root.environmentDigest ||
    !root.allowedPlatforms.includes(approval.platform) ||
    !root.allowedArchitectures.includes(approval.architecture) ||
    !root.allowedBackends.includes(approval.backend)) return withheld('scope-mismatch');

  const issuedAt = Date.parse(approval.issuedAt);
  const expiresAt = Date.parse(approval.expiresAt);
  const rootNotBefore = Date.parse(root.notBefore);
  const rootNotAfter = Date.parse(root.notAfter);
  if (issuedAt < rootNotBefore || expiresAt > rootNotAfter) {
    return withheld('approver-key-inactive');
  }
  if (root.revokedAt !== null) return withheld('approver-key-revoked');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_LIFETIME_MS) {
    return withheld('approval-lifetime-invalid');
  }

  const payload = canonicalVerifierExecutionPolicyApprovalPayloadV1(approval);
  const signatureBytes = canonicalBase64Url(signature, 64);
  if (!payload || !signatureBytes) return withheld('signature-invalid');
  let signatureVerified = false;
  try { signatureVerified = verifySignature(null, payload, publicKey, signatureBytes); } catch { /* withheld */ }
  if (!signatureVerified) return withheld('signature-invalid');

  return {
    schemaVersion: 1,
    mode: 'verifier-execution-policy-approval-observation-v1',
    state: 'cryptographically-verified',
    reason: 'policy-approval-cryptography-verified',
    authority: 'observation-only',
    approvalDigest: sha256(APPROVAL_DIGEST_DOMAIN, Buffer.concat([payload, signatureBytes])),
    approvedTrustPolicyDigest: approvedPolicyDigest,
    approvalTrustPolicyDigest,
    policyGeneration: approval.policyGeneration,
    approvalTrustPolicyGeneration: VERIFIER_EXECUTION_POLICY_APPROVAL_TRUST_POLICY.policyGeneration,
    approverKeyId: approval.approverKeyId,
    scope: {
      fleetDigest: approval.fleetDigest,
      repositoryDigest: approval.repositoryDigest,
      environmentDigest: approval.environmentDigest,
      platform: approval.platform,
      architecture: approval.architecture,
      backend: approval.backend,
    },
    capsuleStatementVerified: false,
    signatureVerified: true,
    approvalCryptographyVerified: true,
    trustPolicyApprovalVerified: false,
    trustRootProvisioned: true,
    replayTransparencyVerified: false,
    clockAuthorityVerified: false,
    freshnessState: 'unavailable',
    freshnessObservedAt: null,
    executionPermitted: false,
    evidencePermitted: false,
    mergePermitted: false,
    activationPermitted: false,
    deployPermitted: false,
    blockers: VERIFIER_EXECUTION_POLICY_APPROVAL_BLOCKERS_V1,
  };
}

/** Verify exact #202 policy-approval cryptography without establishing freshness or authority. */
export function inspectVerifierExecutionPolicyApprovalV1(
  input: unknown,
): VerifierExecutionPolicyApprovalResultV1 {
  try { return inspectUnsafe(input); } catch { return withheld('invalid-input'); }
}

function timeAuthorityObservationShape(
  value: unknown,
): value is VerifierExecutionTimeAuthorityObservationV1 {
  return exactPlainRecord(value, TIME_OBSERVATION_KEYS) && value['schemaVersion'] === 1 &&
    value['protocol'] === 'ashlr-verifier-execution-time-authority-observation-v1' &&
    value['state'] === 'unavailable' && value['authority'] === 'none' &&
    value['observedAt'] === null && value['receiptDigest'] === null &&
    value['clockAuthorityVerified'] === false;
}

function compositionIdentityShape(value: unknown): value is VerifierExecutionCompositionIdentityV1 {
  if (!exactPlainRecord(value, COMPOSITION_IDENTITY_KEYS)) return false;
  for (const key of COMPOSITION_IDENTITY_KEYS) {
    if (key.endsWith('Digest') && (typeof value[key] !== 'string' || !DIGEST.test(value[key]))) {
      return false;
    }
  }
  return PLATFORMS.includes(value['platform'] as VerifierExecutionPolicyPlatformV1) &&
    ARCHITECTURES.includes(value['architecture'] as VerifierExecutionPolicyArchitectureV1) &&
    BACKENDS.includes(value['backend'] as VerifierExecutionPolicyBackendV1);
}

function identityMatchesBindings(
  identity: VerifierExecutionCompositionIdentityV1,
  bindings: VerifierExecutionExpectedBindingsV1,
): boolean {
  return COMPOSITION_IDENTITY_KEYS.every((key) => identity[key] === bindings[key]);
}

function identityMatchesStatement(
  identity: VerifierExecutionCompositionIdentityV1,
  statement: InspectVerifierExecutionAuthorityV2Input['statement'],
): boolean {
  return COMPOSITION_IDENTITY_KEYS.every((key) => identity[key] === statement[key]);
}

function compositionWithheld(
  reason: Exclude<VerifierExecutionCompositionReasonV1, 'clock-authority-unavailable'>,
): VerifierExecutionCompositionResultV1 {
  return {
    schemaVersion: 1,
    mode: 'verifier-execution-authority-composition-v1',
    state: 'withheld',
    reason,
    authority: 'observation-only',
    trustPolicyDigest: null,
    approvalDigest: null,
    statementDigest: null,
    bindingDigest: null,
    policyApprovalCryptographyVerified: false,
    capsuleStatementCryptographyVerified: false,
    identityBindingVerified: false,
    scopeBindingVerified: false,
    trustPolicyApprovalVerified: false,
    clockAuthorityVerified: false,
    freshnessState: 'unavailable',
    freshnessObservedAt: null,
    replayTransparencyVerified: false,
    executionPermitted: false,
    evidencePermitted: false,
    mergePermitted: false,
    activationPermitted: false,
    deployPermitted: false,
    blockers: VERIFIER_EXECUTION_POLICY_APPROVAL_BLOCKERS_V1,
  };
}

function inspectCompositionUnsafe(input: unknown): VerifierExecutionCompositionResultV1 {
  if (!plainDataGraph(input)) return compositionWithheld('invalid-input');
  const snapshot = structuredClone(input);
  if (!exactPlainRecord(snapshot, COMPOSITION_INPUT_KEYS) ||
    !compositionIdentityShape(snapshot['expectedIdentity']) ||
    !timeAuthorityObservationShape(snapshot['timeAuthorityObservation'])) {
    return compositionWithheld('invalid-input');
  }

  const policyApprovalInput = snapshot['policyApprovalInput'];
  const policyResult = inspectVerifierExecutionPolicyApprovalV1(policyApprovalInput);
  if (policyResult.state !== 'cryptographically-verified') {
    return compositionWithheld('policy-approval-unverified');
  }

  const executionAuthorityInput = snapshot['executionAuthorityInput'];
  const statementResult = inspectVerifierExecutionAuthorityV2(executionAuthorityInput);
  if (statementResult.state !== 'statement-verified') {
    return compositionWithheld('capsule-statement-unverified');
  }

  const policyInput = policyApprovalInput as InspectVerifierExecutionPolicyApprovalV1Input;
  const executionInput = executionAuthorityInput as InspectVerifierExecutionAuthorityV2Input;
  const expectedIdentity = snapshot['expectedIdentity'];
  if (policyResult.approvedTrustPolicyDigest !== statementResult.trustPolicyDigest ||
    policyInput.expectedApprovedTrustPolicyDigest !== statementResult.trustPolicyDigest ||
    executionInput.expectedPolicyDigest !== statementResult.trustPolicyDigest ||
    executionInput.statement.trustPolicyDigest !== statementResult.trustPolicyDigest) {
    return compositionWithheld('trust-policy-mismatch');
  }

  if (!identityMatchesBindings(expectedIdentity, executionInput.expectedBindings) ||
    !identityMatchesStatement(expectedIdentity, executionInput.statement)) {
    return compositionWithheld('identity-mismatch');
  }

  const scope = policyResult.scope;
  if (scope.platform !== expectedIdentity.platform ||
    scope.architecture !== expectedIdentity.architecture ||
    scope.backend !== expectedIdentity.backend ||
    statementResult.platform !== expectedIdentity.platform ||
    statementResult.architecture !== expectedIdentity.architecture ||
    statementResult.backend !== expectedIdentity.backend) {
    return compositionWithheld('scope-mismatch');
  }

  const bindingDigest = sha256(
    'ashlr:verifier-execution-authority-composition-binding:v1',
    Buffer.from(JSON.stringify([
      statementResult.trustPolicyDigest,
      expectedIdentity.ticketDigest,
      expectedIdentity.candidateDigest,
      expectedIdentity.baseDigest,
      expectedIdentity.commandPlanDigest,
      expectedIdentity.capsuleTreeDigest,
      expectedIdentity.executableDigest,
      expectedIdentity.dependencyDigest,
      expectedIdentity.brokerDigest,
      expectedIdentity.isolationPolicyDigest,
      scope.fleetDigest,
      scope.repositoryDigest,
      scope.environmentDigest,
      expectedIdentity.platform,
      expectedIdentity.architecture,
      expectedIdentity.backend,
      policyResult.approvalDigest,
      statementResult.statementDigest,
    ]), 'utf8'),
  );

  return {
    schemaVersion: 1,
    mode: 'verifier-execution-authority-composition-v1',
    state: 'freshness-unavailable',
    reason: 'clock-authority-unavailable',
    authority: 'observation-only',
    trustPolicyDigest: statementResult.trustPolicyDigest,
    approvalDigest: policyResult.approvalDigest,
    statementDigest: statementResult.statementDigest,
    bindingDigest,
    policyApprovalCryptographyVerified: true,
    capsuleStatementCryptographyVerified: true,
    identityBindingVerified: true,
    scopeBindingVerified: true,
    trustPolicyApprovalVerified: false,
    clockAuthorityVerified: false,
    freshnessState: 'unavailable',
    freshnessObservedAt: null,
    replayTransparencyVerified: false,
    executionPermitted: false,
    evidencePermitted: false,
    mergePermitted: false,
    activationPermitted: false,
    deployPermitted: false,
    blockers: VERIFIER_EXECUTION_POLICY_APPROVAL_BLOCKERS_V1,
  };
}

/**
 * Canonically compose policy and capsule cryptography. V1 deliberately stops
 * at freshness-unavailable until an external clock authority is implemented.
 */
export function inspectVerifierExecutionCompositionV1(
  input: unknown,
): VerifierExecutionCompositionResultV1 {
  try { return inspectCompositionUnsafe(input); } catch { return compositionWithheld('invalid-input'); }
}
