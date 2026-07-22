/**
 * Verifier-only authentication for exact M444 external-skill audit bytes.
 *
 * No caller-controlled trust roots, signing capability, filesystem lookup, or
 * network authority is available here. Authentication remains observation-only.
 */

import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto';

import {
  canonicalExternalSkillAuditReportBytes,
  EXTERNAL_SKILL_AUDIT_POLICY_DIGEST,
  EXTERNAL_SKILL_AUDIT_REPORT_MAX_BYTES,
  type ExternalSkillAuditReport,
} from './external-skill-audit.js';
import {
  EXTERNAL_SKILL_AUDIT_SIGNATURE_ALGORITHM,
  EXTERNAL_SKILL_AUDIT_SIGNER_ROLE,
  EXTERNAL_SKILL_AUDIT_TRUST_POLICY,
  type ExternalSkillAuditTrustPolicy,
  type ExternalSkillAuditTrustRoot,
} from './external-skill-audit-trust-roots.js';

const RECEIPT_PROTOCOL = 'ashlr-external-skill-audit-receipt-v1' as const;
const DIGEST = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_RECEIPT_BYTES = 16 * 1024;
const MAX_RECEIPT_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 60_000;
const BLOCKERS = [
  'capture-custody-authentication-required',
  'one-use-context-envelope-required',
  'sandbox-runner-required',
  'outcome-attestation-required',
] as const;

const INPUT_KEYS = ['receiptBytes', 'reportBytes', 'selectedSkillName'] as const;
const RECEIPT_KEYS = [
  'auditPolicyDigest', 'authority', 'executionEligible', 'expiresAt', 'issuedAt',
  'keyId', 'packDigest', 'policyEligible', 'policyGeneration', 'portablePackDigest',
  'promotionEligible', 'protocol', 'reportDigest', 'schemaVersion',
  'selectedSkillContentHash', 'selectedSkillName', 'signature', 'signatureAlgorithm',
  'signerRole', 'trustPolicyDigest', 'verdict', 'workflowAuthority',
] as const;
const UNSIGNED_RECEIPT_KEYS = RECEIPT_KEYS.filter((key) => key !== 'signature');

export interface ExternalSkillAuditReceiptUnsigned {
  schemaVersion: 1;
  protocol: typeof RECEIPT_PROTOCOL;
  reportDigest: string;
  packDigest: string;
  portablePackDigest: string;
  selectedSkillName: string;
  selectedSkillContentHash: string;
  auditPolicyDigest: string;
  verdict: 'trial-ready';
  issuedAt: string;
  expiresAt: string;
  trustPolicyDigest: string;
  policyGeneration: number;
  keyId: string;
  signerRole: typeof EXTERNAL_SKILL_AUDIT_SIGNER_ROLE;
  signatureAlgorithm: typeof EXTERNAL_SKILL_AUDIT_SIGNATURE_ALGORITHM;
  workflowAuthority: 'none';
  authority: 'observation-only';
  executionEligible: false;
  policyEligible: false;
  promotionEligible: false;
}

export interface ExternalSkillAuditReceipt extends ExternalSkillAuditReceiptUnsigned {
  signature: string;
}

export interface ExternalSkillAuditReceiptInput {
  reportBytes: Uint8Array;
  receiptBytes: Uint8Array;
  selectedSkillName: string;
}

export type ExternalSkillAuditReceiptReason =
  | 'audit-receipt-authenticated'
  | 'invalid-input'
  | 'report-not-canonical'
  | 'audit-not-trial-ready'
  | 'selected-skill-missing'
  | 'receipt-not-canonical'
  | 'report-mismatch'
  | 'selected-skill-mismatch'
  | 'audit-policy-mismatch'
  | 'trust-root-unprovisioned'
  | 'trust-policy-invalid'
  | 'trust-policy-mismatch'
  | 'policy-generation-mismatch'
  | 'trust-key-unknown'
  | 'trust-key-invalid'
  | 'trust-key-inactive'
  | 'trust-key-revoked'
  | 'receipt-not-current'
  | 'receipt-expired'
  | 'signature-invalid';

interface ResultBase {
  schemaVersion: 1;
  mode: 'external-skill-audit-receipt-verification';
  authority: 'observation-only';
  executionEligible: false;
  policyEligible: false;
  promotionEligible: false;
  replayProtectionVerified: false;
  transparencyVerified: false;
  onlineRevocationVerified: false;
  trustedClockVerified: false;
  independentVerifierPrincipalVerified: false;
  captureReceiptBindingVerified: false;
  blockers: typeof BLOCKERS;
}

export type ExternalSkillAuditReceiptVerificationResult = ResultBase & (
  | {
    state: 'authenticated';
    reason: 'audit-receipt-authenticated';
    reportDigest: string;
    receiptDigest: string;
    packDigest: string;
    portablePackDigest: string;
    selectedSkillName: string;
    selectedSkillContentHash: string;
    auditPolicyDigest: string;
    trustPolicyDigest: string;
    policyGeneration: number;
    keyId: string;
    expiresAt: string;
    signatureVerified: true;
    trustRootProvisioned: true;
  }
  | {
    state: 'withheld';
    reason: Exclude<ExternalSkillAuditReceiptReason, 'audit-receipt-authenticated'>;
    reportDigest: null;
    receiptDigest: null;
    packDigest: null;
    portablePackDigest: null;
    selectedSkillName: null;
    selectedSkillContentHash: null;
    auditPolicyDigest: null;
    trustPolicyDigest: null;
    policyGeneration: null;
    keyId: null;
    expiresAt: null;
    signatureVerified: false;
    trustRootProvisioned: boolean;
  }
);

function sha256(domain: string, bytes: Uint8Array): string {
  return createHash('sha256').update(domain, 'utf8').update(bytes).digest('hex');
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

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function canonicalBase64Url(value: unknown, expectedBytes: number): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || !BASE64URL.test(value)) {
    return null;
  }
  try {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length === expectedBytes && bytes.toString('base64url') === value ? bytes : null;
  } catch { return null; }
}

function copyBytes(value: unknown, maximum: number): Buffer | null {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > maximum) return null;
  return Buffer.from(value);
}

function decodeJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

function byteEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function receiptUnsignedShape(value: unknown): value is ExternalSkillAuditReceiptUnsigned {
  return exactPlainRecord(value, UNSIGNED_RECEIPT_KEYS) &&
    value['schemaVersion'] === 1 && value['protocol'] === RECEIPT_PROTOCOL &&
    typeof value['reportDigest'] === 'string' && DIGEST.test(value['reportDigest']) &&
    typeof value['packDigest'] === 'string' && DIGEST.test(value['packDigest']) &&
    typeof value['portablePackDigest'] === 'string' && DIGEST.test(value['portablePackDigest']) &&
    typeof value['selectedSkillName'] === 'string' && SKILL_NAME.test(value['selectedSkillName']) &&
    typeof value['selectedSkillContentHash'] === 'string' && DIGEST.test(value['selectedSkillContentHash']) &&
    typeof value['auditPolicyDigest'] === 'string' && DIGEST.test(value['auditPolicyDigest']) &&
    value['verdict'] === 'trial-ready' && canonicalIso(value['issuedAt']) &&
    canonicalIso(value['expiresAt']) && typeof value['trustPolicyDigest'] === 'string' &&
    DIGEST.test(value['trustPolicyDigest']) && Number.isSafeInteger(value['policyGeneration']) &&
    (value['policyGeneration'] as number) >= 0 && typeof value['keyId'] === 'string' &&
    DIGEST.test(value['keyId']) && value['signerRole'] === EXTERNAL_SKILL_AUDIT_SIGNER_ROLE &&
    value['signatureAlgorithm'] === EXTERNAL_SKILL_AUDIT_SIGNATURE_ALGORITHM &&
    value['workflowAuthority'] === 'none' && value['authority'] === 'observation-only' &&
    value['executionEligible'] === false && value['policyEligible'] === false &&
    value['promotionEligible'] === false;
}

function receiptShape(value: unknown): value is ExternalSkillAuditReceipt {
  if (!exactPlainRecord(value, RECEIPT_KEYS)) return false;
  const { signature: _signature, ...unsigned } = value;
  return receiptUnsignedShape(unsigned) && canonicalBase64Url(value['signature'], 64) !== null;
}

function receiptProjection(receipt: ExternalSkillAuditReceipt): ExternalSkillAuditReceipt {
  return {
    schemaVersion: receipt.schemaVersion,
    protocol: receipt.protocol,
    reportDigest: receipt.reportDigest,
    packDigest: receipt.packDigest,
    portablePackDigest: receipt.portablePackDigest,
    selectedSkillName: receipt.selectedSkillName,
    selectedSkillContentHash: receipt.selectedSkillContentHash,
    auditPolicyDigest: receipt.auditPolicyDigest,
    verdict: receipt.verdict,
    issuedAt: receipt.issuedAt,
    expiresAt: receipt.expiresAt,
    trustPolicyDigest: receipt.trustPolicyDigest,
    policyGeneration: receipt.policyGeneration,
    keyId: receipt.keyId,
    signerRole: receipt.signerRole,
    signatureAlgorithm: receipt.signatureAlgorithm,
    workflowAuthority: receipt.workflowAuthority,
    authority: receipt.authority,
    executionEligible: receipt.executionEligible,
    policyEligible: receipt.policyEligible,
    promotionEligible: receipt.promotionEligible,
    signature: receipt.signature,
  };
}

/** Exact receipt bytes accepted by the verifier. This helper never signs. */
export function canonicalExternalSkillAuditReceiptBytes(value: unknown): Buffer | null {
  try {
    if (!receiptShape(value)) return null;
    return Buffer.from(JSON.stringify(receiptProjection(value)), 'utf8');
  } catch { return null; }
}

/** Domain-separated bytes an independent audit principal signs. */
export function canonicalExternalSkillAuditReceiptPayload(value: unknown): Buffer | null {
  try {
    if (!receiptUnsignedShape(value)) return null;
    return Buffer.from(JSON.stringify([
      'ashlr:external-skill-audit-receipt-signature:v1',
      value.schemaVersion,
      value.protocol,
      value.reportDigest,
      value.packDigest,
      value.portablePackDigest,
      value.selectedSkillName,
      value.selectedSkillContentHash,
      value.auditPolicyDigest,
      value.verdict,
      value.issuedAt,
      value.expiresAt,
      value.trustPolicyDigest,
      value.policyGeneration,
      value.keyId,
      value.signerRole,
      value.signatureAlgorithm,
      value.workflowAuthority,
      value.authority,
      value.executionEligible,
      value.policyEligible,
      value.promotionEligible,
    ]), 'utf8');
  } catch { return null; }
}

/** Stable role-separated identity for an audit-verifier Ed25519 public key. */
export function externalSkillAuditVerifierKeyId(publicKeySpki: unknown): string | null {
  if (typeof publicKeySpki !== 'string') return null;
  let bytes: Buffer;
  try { bytes = Buffer.from(publicKeySpki, 'base64url'); } catch { return null; }
  if (bytes.length < 32 || bytes.length > 128 || bytes.toString('base64url') !== publicKeySpki) return null;
  try {
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    const canonical = Buffer.from(key.export({ format: 'der', type: 'spki' }));
    if (key.asymmetricKeyType !== 'ed25519' || !canonical.equals(bytes)) return null;
    return sha256('ashlr:external-skill-audit-verifier-key-id:v1\0', bytes);
  } catch { return null; }
}

function trustRootShape(value: unknown): value is ExternalSkillAuditTrustRoot {
  return exactPlainRecord(value, [
    'auditPolicyDigest', 'keyId', 'notAfter', 'notBefore', 'publicKeySpki', 'revokedAt',
    'signatureAlgorithm', 'signerRole',
  ]) && typeof value['keyId'] === 'string' && DIGEST.test(value['keyId']) &&
    typeof value['publicKeySpki'] === 'string' &&
    externalSkillAuditVerifierKeyId(value['publicKeySpki']) === value['keyId'] &&
    value['signerRole'] === EXTERNAL_SKILL_AUDIT_SIGNER_ROLE &&
    value['signatureAlgorithm'] === EXTERNAL_SKILL_AUDIT_SIGNATURE_ALGORITHM &&
    value['auditPolicyDigest'] === EXTERNAL_SKILL_AUDIT_POLICY_DIGEST &&
    canonicalIso(value['notBefore']) && canonicalIso(value['notAfter']) &&
    Date.parse(value['notBefore']) < Date.parse(value['notAfter']) &&
    (value['revokedAt'] === null || canonicalIso(value['revokedAt']));
}

function trustPolicyShape(value: unknown): value is ExternalSkillAuditTrustPolicy {
  if (!exactPlainRecord(value, ['policyGeneration', 'protocol', 'roots', 'schemaVersion']) ||
    value['schemaVersion'] !== 1 || value['protocol'] !== 'ashlr-external-skill-audit-trust-v1' ||
    !Number.isSafeInteger(value['policyGeneration']) || (value['policyGeneration'] as number) < 0 ||
    !Array.isArray(value['roots']) || value['roots'].length > 16) return false;
  let prior = '';
  for (const root of value['roots']) {
    if (!trustRootShape(root) || root.keyId <= prior) return false;
    prior = root.keyId;
  }
  return true;
}

function trustPolicyDigest(policy: ExternalSkillAuditTrustPolicy): string {
  return sha256('ashlr:external-skill-audit-trust-policy:v1\0', Buffer.from(JSON.stringify([
    policy.schemaVersion,
    policy.protocol,
    policy.policyGeneration,
    policy.roots.map((root) => [
      root.keyId,
      root.publicKeySpki,
      root.signerRole,
      root.signatureAlgorithm,
      root.auditPolicyDigest,
      root.notBefore,
      root.notAfter,
      root.revokedAt,
    ]),
  ]), 'utf8'));
}

/** Identity of the code-owned trust policy. There is no caller-supplied variant. */
export function externalSkillAuditTrustPolicyDigest(): string | null {
  try {
    return trustPolicyShape(EXTERNAL_SKILL_AUDIT_TRUST_POLICY)
      ? trustPolicyDigest(EXTERNAL_SKILL_AUDIT_TRUST_POLICY)
      : null;
  } catch { return null; }
}

function trustedPublicKey(root: ExternalSkillAuditTrustRoot): KeyObject | null {
  if (!trustRootShape(root)) return null;
  try {
    const bytes = Buffer.from(root.publicKeySpki, 'base64url');
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch { return null; }
}

function withheld(
  reason: Exclude<ExternalSkillAuditReceiptReason, 'audit-receipt-authenticated'>,
  trustRootProvisioned = EXTERNAL_SKILL_AUDIT_TRUST_POLICY.roots.length > 0,
): ExternalSkillAuditReceiptVerificationResult {
  return {
    schemaVersion: 1,
    mode: 'external-skill-audit-receipt-verification',
    state: 'withheld',
    reason,
    reportDigest: null,
    receiptDigest: null,
    packDigest: null,
    portablePackDigest: null,
    selectedSkillName: null,
    selectedSkillContentHash: null,
    auditPolicyDigest: null,
    trustPolicyDigest: null,
    policyGeneration: null,
    keyId: null,
    expiresAt: null,
    signatureVerified: false,
    trustRootProvisioned,
    replayProtectionVerified: false,
    transparencyVerified: false,
    onlineRevocationVerified: false,
    trustedClockVerified: false,
    independentVerifierPrincipalVerified: false,
    captureReceiptBindingVerified: false,
    authority: 'observation-only',
    executionEligible: false,
    policyEligible: false,
    promotionEligible: false,
    blockers: BLOCKERS,
  };
}

/** Authenticate one exact M444 report under the repository-owned verifier roots. */
function verifyTrustedExternalSkillAuditReceiptUnsafe(
  input: unknown,
): ExternalSkillAuditReceiptVerificationResult {
  if (!exactPlainRecord(input, INPUT_KEYS) || typeof input['selectedSkillName'] !== 'string' ||
    !SKILL_NAME.test(input['selectedSkillName'])) return withheld('invalid-input');
  const reportBytes = copyBytes(input['reportBytes'], EXTERNAL_SKILL_AUDIT_REPORT_MAX_BYTES);
  const receiptBytes = copyBytes(input['receiptBytes'], MAX_RECEIPT_BYTES);
  if (!reportBytes || !receiptBytes) return withheld('invalid-input');

  let reportValue: unknown;
  try { reportValue = decodeJson(reportBytes); } catch { return withheld('report-not-canonical'); }
  const canonicalReport = canonicalExternalSkillAuditReportBytes(reportValue);
  if (!canonicalReport || !byteEqual(canonicalReport, reportBytes)) return withheld('report-not-canonical');
  const report = reportValue as ExternalSkillAuditReport;
  if (!report.trialReady || !report.structural.passed || !report.routing.passed ||
    report.behavioral.state !== 'declared' || report.promotion.eligible !== false) {
    return withheld('audit-not-trial-ready');
  }
  const selectedSkill = report.skills.find((skill) => skill.name === input['selectedSkillName']);
  if (!selectedSkill) return withheld('selected-skill-missing');

  let receiptValue: unknown;
  try { receiptValue = decodeJson(receiptBytes); } catch { return withheld('receipt-not-canonical'); }
  if (!receiptShape(receiptValue)) return withheld('receipt-not-canonical');
  const canonicalReceipt = canonicalExternalSkillAuditReceiptBytes(receiptValue);
  if (!canonicalReceipt || !byteEqual(canonicalReceipt, receiptBytes)) {
    return withheld('receipt-not-canonical');
  }
  const receipt = receiptValue;
  const reportDigest = sha256('ashlr:external-skill-audit-report:v1\0', reportBytes);
  if (receipt.reportDigest !== reportDigest || receipt.packDigest !== report.packDigest ||
    receipt.portablePackDigest !== report.portablePackDigest) return withheld('report-mismatch');
  if (receipt.selectedSkillName !== input['selectedSkillName'] ||
    receipt.selectedSkillContentHash !== selectedSkill.contentHash) {
    return withheld('selected-skill-mismatch');
  }
  if (receipt.auditPolicyDigest !== EXTERNAL_SKILL_AUDIT_POLICY_DIGEST) {
    return withheld('audit-policy-mismatch');
  }
  if (EXTERNAL_SKILL_AUDIT_TRUST_POLICY.roots.length === 0) {
    return withheld('trust-root-unprovisioned', false);
  }
  if (!trustPolicyShape(EXTERNAL_SKILL_AUDIT_TRUST_POLICY)) return withheld('trust-policy-invalid');
  const policyDigest = trustPolicyDigest(EXTERNAL_SKILL_AUDIT_TRUST_POLICY);
  if (receipt.trustPolicyDigest !== policyDigest) return withheld('trust-policy-mismatch');
  if (receipt.policyGeneration !== EXTERNAL_SKILL_AUDIT_TRUST_POLICY.policyGeneration) {
    return withheld('policy-generation-mismatch');
  }
  const root = EXTERNAL_SKILL_AUDIT_TRUST_POLICY.roots.find((entry) => entry.keyId === receipt.keyId);
  if (!root) return withheld('trust-key-unknown');
  const publicKey = trustedPublicKey(root);
  if (!publicKey) return withheld('trust-key-invalid');

  const issuedAt = Date.parse(receipt.issuedAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  const now = Date.now();
  if (issuedAt < Date.parse(root.notBefore) || issuedAt > Date.parse(root.notAfter) ||
    expiresAt > Date.parse(root.notAfter) || now >= Date.parse(root.notAfter)) {
    return withheld('trust-key-inactive');
  }
  if (root.revokedAt !== null && now >= Date.parse(root.revokedAt)) return withheld('trust-key-revoked');
  if (issuedAt > now + MAX_FUTURE_SKEW_MS || expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_RECEIPT_LIFETIME_MS) return withheld('receipt-not-current');
  if (expiresAt <= now) return withheld('receipt-expired');

  const { signature, ...unsigned } = receipt;
  const payload = canonicalExternalSkillAuditReceiptPayload(unsigned);
  const signatureBytes = canonicalBase64Url(signature, 64);
  if (!payload || !signatureBytes) return withheld('receipt-not-canonical');
  let signatureVerified = false;
  try { signatureVerified = verifySignature(null, payload, publicKey, signatureBytes); } catch { /* withheld */ }
  if (!signatureVerified) return withheld('signature-invalid');
  const receiptDigest = sha256('ashlr:external-skill-audit-receipt:v1\0', receiptBytes);

  return {
    schemaVersion: 1,
    mode: 'external-skill-audit-receipt-verification',
    state: 'authenticated',
    reason: 'audit-receipt-authenticated',
    reportDigest,
    receiptDigest,
    packDigest: receipt.packDigest,
    portablePackDigest: receipt.portablePackDigest,
    selectedSkillName: receipt.selectedSkillName,
    selectedSkillContentHash: receipt.selectedSkillContentHash,
    auditPolicyDigest: receipt.auditPolicyDigest,
    trustPolicyDigest: policyDigest,
    policyGeneration: receipt.policyGeneration,
    keyId: root.keyId,
    expiresAt: receipt.expiresAt,
    signatureVerified: true,
    trustRootProvisioned: true,
    replayProtectionVerified: false,
    transparencyVerified: false,
    onlineRevocationVerified: false,
    trustedClockVerified: false,
    independentVerifierPrincipalVerified: false,
    captureReceiptBindingVerified: false,
    authority: 'observation-only',
    executionEligible: false,
    policyEligible: false,
    promotionEligible: false,
    blockers: BLOCKERS,
  };
}

export function verifyTrustedExternalSkillAuditReceipt(
  input: unknown,
): ExternalSkillAuditReceiptVerificationResult {
  try {
    return verifyTrustedExternalSkillAuditReceiptUnsafe(input);
  } catch {
    return withheld('invalid-input');
  }
}
