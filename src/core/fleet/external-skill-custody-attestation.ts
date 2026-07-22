/**
 * Verifier-only asymmetric custody statements for quarantined skill captures.
 *
 * This module never signs, stores, materializes, or executes external content.
 * A successful result verifies one signature under a caller-supplied policy. It
 * does not authenticate that policy, its signer, or remote object availability.
 */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto';

import type { ExternalSkillGitCaptureResult } from './external-skill-git-capture.js';

const DIGEST = /^[0-9a-f]{64}$/;
const POLICY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_TRUST_KEYS = 16;
const MAX_CUSTODY_MS = 366 * 24 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 60_000;
const CAPTURE_PROTOCOL = 'ashlr-external-skill-custody-v1' as const;
const TRUST_PROTOCOL = 'ashlr-external-skill-custody-trust-v1' as const;
const SIGNATURE_ALGORITHM = 'ed25519' as const;
const SIGNER_ROLE = 'custody-statement-signer' as const;
const CUSTODY_CLASS = 'external-retention-lock' as const;
const VERIFICATION = 'canonical-bundle-rehashed' as const;
const CAPTURE_BLOCKERS = [
  'capture-custody-authentication-required',
  'sandbox-runner-required',
  'exposure-verifier-required',
  'outcome-attestation-required',
] as const;

const INPUT_KEYS = ['capture', 'receipt', 'trustPolicy'] as const;
const POLICY_KEYS = ['keys', 'policyVersion', 'protocol', 'schemaVersion'] as const;
const TRUST_KEY_KEYS = [
  'expectedCustodyAuthorityDigest',
  'keyId',
  'notAfter',
  'notBefore',
  'publicKeySpki',
  'expectedRetentionPolicyDigest',
  'role',
  'signatureAlgorithm',
] as const;
const RECEIPT_KEYS = [
  'bundleDigest',
  'captureDigest',
  'captureReceiptDigest',
  'claimedCustodyAuthorityDigest',
  'custodyClass',
  'custodyUntil',
  'executionEligible',
  'fileCount',
  'issuedAt',
  'keyId',
  'objectVersionDigest',
  'portablePackDigest',
  'policyEligible',
  'promotionEligible',
  'protocol',
  'claimedRetentionPolicyDigest',
  'schemaVersion',
  'signature',
  'signatureAlgorithm',
  'sourceIdentity',
  'symlinkCount',
  'totalBytes',
  'trustPolicyDigest',
  'verification',
  'workflowAuthority',
] as const;
const UNSIGNED_RECEIPT_KEYS = RECEIPT_KEYS.filter((key) => key !== 'signature');

export interface ExternalSkillCustodyTrustKey {
  keyId: string;
  signatureAlgorithm: typeof SIGNATURE_ALGORITHM;
  role: typeof SIGNER_ROLE;
  expectedCustodyAuthorityDigest: string;
  expectedRetentionPolicyDigest: string;
  publicKeySpki: string;
  notBefore: string;
  notAfter: string;
}

export interface ExternalSkillCustodyTrustPolicy {
  schemaVersion: 1;
  protocol: typeof TRUST_PROTOCOL;
  policyVersion: string;
  keys: ExternalSkillCustodyTrustKey[];
}

export interface ExternalSkillCustodyAttestationUnsigned {
  schemaVersion: 1;
  protocol: typeof CAPTURE_PROTOCOL;
  captureDigest: string;
  bundleDigest: string;
  captureReceiptDigest: string;
  portablePackDigest: string;
  sourceIdentity: string;
  fileCount: number;
  symlinkCount: number;
  totalBytes: number;
  objectVersionDigest: string;
  claimedCustodyAuthorityDigest: string;
  claimedRetentionPolicyDigest: string;
  custodyClass: typeof CUSTODY_CLASS;
  verification: typeof VERIFICATION;
  issuedAt: string;
  custodyUntil: string;
  trustPolicyDigest: string;
  keyId: string;
  signatureAlgorithm: typeof SIGNATURE_ALGORITHM;
  workflowAuthority: 'none';
  executionEligible: false;
  policyEligible: false;
  promotionEligible: false;
}

export interface ExternalSkillCustodyAttestation extends ExternalSkillCustodyAttestationUnsigned {
  signature: string;
}

export interface ExternalSkillCustodyAttestationInput {
  capture: ExternalSkillGitCaptureResult;
  receipt: ExternalSkillCustodyAttestation;
  trustPolicy: ExternalSkillCustodyTrustPolicy;
}

export type ExternalSkillCustodyAttestationReason =
  | 'statement-signature-verified'
  | 'invalid-input'
  | 'capture-incomplete'
  | 'trust-policy-invalid'
  | 'trust-policy-mismatch'
  | 'capture-mismatch'
  | 'capture-receipt-mismatch'
  | 'custody-authority-claim-mismatch'
  | 'retention-policy-claim-mismatch'
  | 'trust-key-unknown'
  | 'trust-key-invalid'
  | 'trust-key-inactive'
  | 'receipt-not-current'
  | 'receipt-expired'
  | 'signature-invalid';

interface ExternalSkillCustodyAttestationResultBase {
  schemaVersion: 1;
  mode: 'external-custody-statement-verification';
  authority: 'observation-only';
  executionEligible: false;
  policyEligible: false;
  promotionEligible: false;
}

export type ExternalSkillCustodyAttestationResult = ExternalSkillCustodyAttestationResultBase & (
  | {
    state: 'statement-signature-verified';
    reason: 'statement-signature-verified';
    captureDigest: string;
    captureReceiptDigest: string;
    receiptDigest: string;
    trustPolicyDigest: string;
    keyId: string;
    claimedCustodyAuthorityDigest: string;
    claimedRetentionPolicyDigest: string;
    statement: {
      signatureVerified: true;
      keyMatchedSuppliedPolicy: true;
      trustPolicyApprovalVerified: false;
    };
    custody: {
      bundleIntegrity: 'signer-claimed-rehash';
      retentionClaim: 'unexpired-signer-claim';
      authenticated: false;
      custodyUntil: string;
      liveAvailabilityVerified: false;
      replayProtectionVerified: false;
      transparencyVerified: false;
    };
    blockers: typeof CAPTURE_BLOCKERS;
  }
  | {
    state: 'withheld';
    reason: Exclude<ExternalSkillCustodyAttestationReason, 'statement-signature-verified'>;
    captureDigest: null;
    captureReceiptDigest: null;
    receiptDigest: null;
    trustPolicyDigest: null;
    keyId: null;
    claimedCustodyAuthorityDigest: null;
    claimedRetentionPolicyDigest: null;
    statement: {
      signatureVerified: false;
      keyMatchedSuppliedPolicy: false;
      trustPolicyApprovalVerified: false;
    };
    custody: {
      bundleIntegrity: 'unavailable';
      retentionClaim: 'unavailable';
      authenticated: false;
      custodyUntil: null;
      liveAvailabilityVerified: false;
      replayProtectionVerified: false;
      transparencyVerified: false;
    };
    blockers: typeof CAPTURE_BLOCKERS;
  }
);

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function exactPlainRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(
    (descriptor) => !Object.hasOwn(descriptor, 'value'),
  )) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function plainDataGraph(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (depth > 8 || seen.size >= 256 || seen.has(value)) return false;
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || value.length > 256) return false;
  } else if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value') || !plainDataGraph(descriptor.value, seen, depth + 1)) {
      return false;
    }
  }
  return true;
}

function densePlainArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 || value.length > MAX_TRUST_KEYS ||
    Object.getOwnPropertyNames(value).length !== value.length + 1 ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => !Object.hasOwn(descriptor, 'value'),
    )) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function exactDenseArray(value: unknown, length: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== length || Object.getOwnPropertyNames(value).length !== length + 1) return false;
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function safeCount(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function canonicalBase64Url(value: unknown, minimumBytes: number, maximumBytes: number): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || !BASE64URL.test(value)) {
    return null;
  }
  try {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length >= minimumBytes && bytes.length <= maximumBytes &&
      bytes.toString('base64url') === value ? bytes : null;
  } catch { return null; }
}

function captureComplete(value: unknown): value is Extract<ExternalSkillGitCaptureResult, { state: 'captured' | 'replayed' }> {
  if (!exactPlainRecord(value, [
    'authority', 'blockers', 'captureDigest', 'captureReceiptDigest', 'custody', 'executionEligible',
    'fileCount', 'mode',
    'policyEligible', 'portablePackDigest', 'promotionEligible', 'reason', 'schemaVersion',
    'sourceIdentity', 'state', 'symlinkCount', 'totalBytes',
  ])) return false;
  const state = value['state'];
  const blockers = value['blockers'];
  const custody = value['custody'];
  return value['schemaVersion'] === 1 && value['mode'] === 'git-object-quarantine' &&
    (state === 'captured' || state === 'replayed') && value['reason'] === state &&
    value['authority'] === 'observation-only' && value['executionEligible'] === false &&
    value['policyEligible'] === false && value['promotionEligible'] === false &&
    typeof value['captureDigest'] === 'string' && DIGEST.test(value['captureDigest']) &&
    typeof value['captureReceiptDigest'] === 'string' &&
    DIGEST.test(value['captureReceiptDigest']) &&
    typeof value['portablePackDigest'] === 'string' && DIGEST.test(value['portablePackDigest']) &&
    typeof value['sourceIdentity'] === 'string' && DIGEST.test(value['sourceIdentity']) &&
    safeCount(value['fileCount'], 2_048) && safeCount(value['symlinkCount'], 2_048) &&
    safeCount(value['totalBytes'], 16 * 1024 * 1024) &&
    exactDenseArray(blockers, CAPTURE_BLOCKERS.length) &&
    blockers.every((entry, index) => entry === CAPTURE_BLOCKERS[index]) &&
    exactPlainRecord(custody, ['authenticated', 'localIntegrity']) &&
    custody['localIntegrity'] === 'verified' && custody['authenticated'] === false;
}

function trustKeyShape(value: unknown): value is ExternalSkillCustodyTrustKey {
  if (!exactPlainRecord(value, TRUST_KEY_KEYS)) return false;
  return typeof value['keyId'] === 'string' && DIGEST.test(value['keyId']) &&
    value['signatureAlgorithm'] === SIGNATURE_ALGORITHM && value['role'] === SIGNER_ROLE &&
    typeof value['expectedCustodyAuthorityDigest'] === 'string' &&
    DIGEST.test(value['expectedCustodyAuthorityDigest']) &&
    typeof value['expectedRetentionPolicyDigest'] === 'string' &&
    DIGEST.test(value['expectedRetentionPolicyDigest']) &&
    typeof value['publicKeySpki'] === 'string' &&
    canonicalBase64Url(value['publicKeySpki'], 32, 128) !== null &&
    externalSkillCustodyKeyId(value['publicKeySpki']) === value['keyId'] &&
    canonicalIso(value['notBefore']) && canonicalIso(value['notAfter']) &&
    Date.parse(value['notBefore']) < Date.parse(value['notAfter']);
}

function trustPolicyShape(value: unknown): value is ExternalSkillCustodyTrustPolicy {
  if (!exactPlainRecord(value, POLICY_KEYS) || value['schemaVersion'] !== 1 ||
    value['protocol'] !== TRUST_PROTOCOL || typeof value['policyVersion'] !== 'string' ||
    !POLICY_VERSION.test(value['policyVersion']) || !densePlainArray(value['keys'])) return false;
  let prior = '';
  for (const key of value['keys']) {
    if (!trustKeyShape(key) || key.keyId <= prior) return false;
    prior = key.keyId;
  }
  return true;
}

function trustPolicyDigest(policy: ExternalSkillCustodyTrustPolicy): string {
  return sha256(JSON.stringify([
    'ashlr:external-skill-custody-trust-policy:v1',
    policy.schemaVersion,
    policy.protocol,
    policy.policyVersion,
    policy.keys.map((key) => [
      key.keyId,
      key.signatureAlgorithm,
      key.role,
      key.expectedCustodyAuthorityDigest,
      key.expectedRetentionPolicyDigest,
      key.publicKeySpki,
      key.notBefore,
      key.notAfter,
    ]),
  ]));
}

/** Canonical identity statement signers bind into their signed statement. */
export function externalSkillCustodyTrustPolicyDigest(value: unknown): string | null {
  try {
    if (!plainDataGraph(value)) return null;
    const snapshot = structuredClone(value);
    return trustPolicyShape(snapshot) ? trustPolicyDigest(snapshot) : null;
  } catch { return null; }
}

function unsignedReceiptShape(value: unknown): value is ExternalSkillCustodyAttestationUnsigned {
  if (!exactPlainRecord(value, UNSIGNED_RECEIPT_KEYS)) return false;
  return value['schemaVersion'] === 1 && value['protocol'] === CAPTURE_PROTOCOL &&
    typeof value['captureDigest'] === 'string' && DIGEST.test(value['captureDigest']) &&
    typeof value['bundleDigest'] === 'string' && DIGEST.test(value['bundleDigest']) &&
    typeof value['captureReceiptDigest'] === 'string' &&
    DIGEST.test(value['captureReceiptDigest']) &&
    typeof value['portablePackDigest'] === 'string' && DIGEST.test(value['portablePackDigest']) &&
    typeof value['sourceIdentity'] === 'string' && DIGEST.test(value['sourceIdentity']) &&
    safeCount(value['fileCount'], 2_048) && safeCount(value['symlinkCount'], 2_048) &&
    safeCount(value['totalBytes'], 16 * 1024 * 1024) &&
    typeof value['objectVersionDigest'] === 'string' && DIGEST.test(value['objectVersionDigest']) &&
    typeof value['claimedCustodyAuthorityDigest'] === 'string' &&
    DIGEST.test(value['claimedCustodyAuthorityDigest']) &&
    typeof value['claimedRetentionPolicyDigest'] === 'string' &&
    DIGEST.test(value['claimedRetentionPolicyDigest']) &&
    value['custodyClass'] === CUSTODY_CLASS && value['verification'] === VERIFICATION &&
    canonicalIso(value['issuedAt']) && canonicalIso(value['custodyUntil']) &&
    typeof value['trustPolicyDigest'] === 'string' && DIGEST.test(value['trustPolicyDigest']) &&
    typeof value['keyId'] === 'string' && DIGEST.test(value['keyId']) &&
    value['signatureAlgorithm'] === SIGNATURE_ALGORITHM && value['workflowAuthority'] === 'none' &&
    value['executionEligible'] === false && value['policyEligible'] === false &&
    value['promotionEligible'] === false;
}

function receiptShape(value: unknown): value is ExternalSkillCustodyAttestation {
  if (!exactPlainRecord(value, RECEIPT_KEYS)) return false;
  const { signature: _signature, ...unsigned } = value;
  return unsignedReceiptShape(unsigned) && canonicalBase64Url(value['signature'], 64, 64) !== null;
}

/** Canonical bytes external statement signers sign. This helper never accesses a private key. */
export function canonicalExternalSkillCustodyAttestationPayload(
  value: unknown,
): Buffer | null {
  try {
    if (!plainDataGraph(value)) return null;
    const snapshot = structuredClone(value);
    if (!unsignedReceiptShape(snapshot)) return null;
    return Buffer.from(JSON.stringify([
      'ashlr:external-skill-custody-attestation-signature:v1',
      snapshot.schemaVersion,
      snapshot.protocol,
      snapshot.captureDigest,
      snapshot.bundleDigest,
      snapshot.captureReceiptDigest,
      snapshot.portablePackDigest,
      snapshot.sourceIdentity,
      snapshot.fileCount,
      snapshot.symlinkCount,
      snapshot.totalBytes,
      snapshot.objectVersionDigest,
      snapshot.claimedCustodyAuthorityDigest,
      snapshot.claimedRetentionPolicyDigest,
      snapshot.custodyClass,
      snapshot.verification,
      snapshot.issuedAt,
      snapshot.custodyUntil,
      snapshot.trustPolicyDigest,
      snapshot.keyId,
      snapshot.signatureAlgorithm,
      snapshot.workflowAuthority,
      snapshot.executionEligible,
      snapshot.policyEligible,
      snapshot.promotionEligible,
    ]), 'utf8');
  } catch { return null; }
}

/** Stable public-key identity used by trust policies and signed receipts. */
export function externalSkillCustodyKeyId(publicKeySpki: unknown): string | null {
  const bytes = canonicalBase64Url(publicKeySpki, 32, 128);
  if (!bytes) return null;
  try {
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519' || !Buffer.from(key.export({
      format: 'der',
      type: 'spki',
    })).equals(bytes)) return null;
    return sha256(Buffer.concat([
      Buffer.from('ashlr:external-skill-custody-key-id:v1\0', 'utf8'),
      bytes,
    ]));
  } catch { return null; }
}

function withheld(
  reason: Exclude<ExternalSkillCustodyAttestationReason, 'statement-signature-verified'>,
): ExternalSkillCustodyAttestationResult {
  return {
    schemaVersion: 1,
    mode: 'external-custody-statement-verification',
    state: 'withheld',
    reason,
    captureDigest: null,
    captureReceiptDigest: null,
    receiptDigest: null,
    trustPolicyDigest: null,
    keyId: null,
    claimedCustodyAuthorityDigest: null,
    claimedRetentionPolicyDigest: null,
    statement: {
      signatureVerified: false,
      keyMatchedSuppliedPolicy: false,
      trustPolicyApprovalVerified: false,
    },
    authority: 'observation-only',
    executionEligible: false,
    policyEligible: false,
    promotionEligible: false,
    custody: {
      bundleIntegrity: 'unavailable',
      retentionClaim: 'unavailable',
      authenticated: false,
      custodyUntil: null,
      liveAvailabilityVerified: false,
      replayProtectionVerified: false,
      transparencyVerified: false,
    },
    blockers: CAPTURE_BLOCKERS,
  };
}

function trustedPublicKey(key: ExternalSkillCustodyTrustKey): KeyObject | null {
  const bytes = canonicalBase64Url(key.publicKeySpki, 32, 128);
  if (!bytes || externalSkillCustodyKeyId(key.publicKeySpki) !== key.keyId) return null;
  try {
    const publicKey = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    return publicKey.asymmetricKeyType === 'ed25519' && Buffer.from(publicKey.export({
      format: 'der',
      type: 'spki',
    })).equals(bytes) ? publicKey : null;
  } catch { return null; }
}

/**
 * Verify one retention-bounded statement against an explicit supplied policy.
 * No signing key, policy-approval root, network, filesystem, or content path is
 * available to this function.
 */
export function verifyExternalSkillCustodyAttestation(
  input: unknown,
): ExternalSkillCustodyAttestationResult {
  let snapshot: unknown;
  try {
    if (!plainDataGraph(input)) return withheld('invalid-input');
    snapshot = structuredClone(input);
  } catch { return withheld('invalid-input'); }
  if (!exactPlainRecord(snapshot, INPUT_KEYS)) return withheld('invalid-input');
  const capture = snapshot['capture'];
  const receipt = snapshot['receipt'];
  const policy = snapshot['trustPolicy'];
  if (!captureComplete(capture)) return withheld('capture-incomplete');
  if (!trustPolicyShape(policy)) return withheld('trust-policy-invalid');
  if (!receiptShape(receipt)) return withheld('invalid-input');

  const policyDigest = externalSkillCustodyTrustPolicyDigest(policy);
  if (!policyDigest) return withheld('trust-policy-invalid');
  if (receipt.trustPolicyDigest !== policyDigest) return withheld('trust-policy-mismatch');
  if (receipt.captureDigest !== capture.captureDigest ||
    receipt.portablePackDigest !== capture.portablePackDigest ||
    receipt.sourceIdentity !== capture.sourceIdentity ||
    receipt.fileCount !== capture.fileCount ||
    receipt.symlinkCount !== capture.symlinkCount ||
    receipt.totalBytes !== capture.totalBytes ||
    sha256(`ashlr-external-skill-git-capture-v1\0${receipt.bundleDigest}`) !== capture.captureDigest) {
    return withheld('capture-mismatch');
  }

  const key = policy.keys.find((entry) => entry.keyId === receipt.keyId);
  if (!key) return withheld('trust-key-unknown');
  const publicKey = trustedPublicKey(key);
  if (!publicKey) return withheld('trust-key-invalid');
  if (receipt.captureReceiptDigest !== capture.captureReceiptDigest) {
    return withheld('capture-receipt-mismatch');
  }
  if (receipt.claimedCustodyAuthorityDigest !== key.expectedCustodyAuthorityDigest) {
    return withheld('custody-authority-claim-mismatch');
  }
  if (receipt.claimedRetentionPolicyDigest !== key.expectedRetentionPolicyDigest) {
    return withheld('retention-policy-claim-mismatch');
  }
  const issuedAt = Date.parse(receipt.issuedAt);
  const custodyUntil = Date.parse(receipt.custodyUntil);
  const notBefore = Date.parse(key.notBefore);
  const notAfter = Date.parse(key.notAfter);
  const now = Date.now();
  if (issuedAt < notBefore || issuedAt > notAfter) return withheld('trust-key-inactive');
  if (issuedAt > now + MAX_FUTURE_SKEW_MS || custodyUntil <= issuedAt ||
    custodyUntil - issuedAt > MAX_CUSTODY_MS) return withheld('receipt-not-current');
  if (custodyUntil <= now) return withheld('receipt-expired');

  const { signature, ...unsigned } = receipt;
  const payload = canonicalExternalSkillCustodyAttestationPayload(unsigned);
  const signatureBytes = canonicalBase64Url(signature, 64, 64);
  if (!payload || !signatureBytes) return withheld('invalid-input');
  let verified = false;
  try { verified = verifySignature(null, payload, publicKey, signatureBytes); } catch { /* withheld */ }
  if (!verified) return withheld('signature-invalid');

  const receiptDigest = sha256(Buffer.concat([
    Buffer.from('ashlr:external-skill-custody-receipt:v1\0', 'utf8'),
    payload,
    Buffer.from('\0', 'utf8'),
    signatureBytes,
  ]));
  return {
    schemaVersion: 1,
    mode: 'external-custody-statement-verification',
    state: 'statement-signature-verified',
    reason: 'statement-signature-verified',
    captureDigest: capture.captureDigest,
    captureReceiptDigest: capture.captureReceiptDigest,
    receiptDigest,
    trustPolicyDigest: policyDigest,
    keyId: key.keyId,
    claimedCustodyAuthorityDigest: receipt.claimedCustodyAuthorityDigest,
    claimedRetentionPolicyDigest: receipt.claimedRetentionPolicyDigest,
    authority: 'observation-only',
    executionEligible: false,
    policyEligible: false,
    promotionEligible: false,
    statement: {
      signatureVerified: true,
      keyMatchedSuppliedPolicy: true,
      trustPolicyApprovalVerified: false,
    },
    custody: {
      bundleIntegrity: 'signer-claimed-rehash',
      retentionClaim: 'unexpired-signer-claim',
      authenticated: false,
      custodyUntil: receipt.custodyUntil,
      liveAvailabilityVerified: false,
      replayProtectionVerified: false,
      transparencyVerified: false,
    },
    blockers: CAPTURE_BLOCKERS,
  };
}
