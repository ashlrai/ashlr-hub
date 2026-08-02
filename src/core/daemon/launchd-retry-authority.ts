import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto';

import {
  LAUNCHD_RETRY_SIGNATURE_ALGORITHM,
  LAUNCHD_RETRY_SIGNER_ROLE,
  LAUNCHD_RETRY_TRUST_POLICY,
  LAUNCHD_RETRY_TRUST_PROTOCOL,
  type LaunchdRetryTrustPolicy,
  type LaunchdRetryTrustRoot,
} from './launchd-retry-trust-roots.js';

export const LAUNCHD_RETRY_RECEIPT_PROTOCOL = 'ashlr-launchd-retry-epoch-receipt-v1' as const;
export const LAUNCHD_RETRY_SERVICE_IDENTITY = 'ai.ashlr.daemon' as const;

const DIGEST_RE = /^[0-9a-f]{64}$/;
const REVISION_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const RECEIPT_KEYS = [
  'claimCount', 'epoch', 'keyId', 'maxObservedAtMs', 'policyGeneration',
  'previousReceiptDigest', 'protocol', 'releaseRevision', 'schemaVersion',
  'sequence', 'serviceIdentity', 'signature', 'signatureAlgorithm', 'signerRole',
  'transition', 'trustPolicyDigest', 'windowStartedAtMs',
] as const;
const UNSIGNED_RECEIPT_KEYS = RECEIPT_KEYS.filter((key) => key !== 'signature');

export type LaunchdRetryReceiptTransition = 'initialize' | 'claim' | 'healthy-reset';

export interface LaunchdRetryEpochReceiptUnsigned {
  schemaVersion: 1;
  protocol: typeof LAUNCHD_RETRY_RECEIPT_PROTOCOL;
  serviceIdentity: typeof LAUNCHD_RETRY_SERVICE_IDENTITY;
  releaseRevision: string;
  epoch: number;
  sequence: number;
  transition: LaunchdRetryReceiptTransition;
  claimCount: number;
  windowStartedAtMs: number;
  maxObservedAtMs: number;
  previousReceiptDigest: string | null;
  trustPolicyDigest: string;
  policyGeneration: number;
  keyId: string;
  signerRole: typeof LAUNCHD_RETRY_SIGNER_ROLE;
  signatureAlgorithm: typeof LAUNCHD_RETRY_SIGNATURE_ALGORITHM;
}

export interface LaunchdRetryEpochReceipt extends LaunchdRetryEpochReceiptUnsigned {
  signature: string;
}

export interface VerifiedLaunchdRetryEpochReceipt {
  receipt: LaunchdRetryEpochReceipt;
  receiptDigest: string;
  trustPolicyDigest: string;
}

export type LaunchdRetryReceiptVerification =
  | { ok: true; reason: 'receipt-authenticated'; value: VerifiedLaunchdRetryEpochReceipt }
  | {
    ok: false;
    reason:
      | 'trust-root-unprovisioned'
      | 'trust-policy-invalid'
      | 'receipt-invalid'
      | 'receipt-context-mismatch'
      | 'trust-policy-mismatch'
      | 'trust-key-unknown'
      | 'trust-key-invalid'
      | 'trust-key-inactive'
      | 'signature-invalid';
  };

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

function safeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function canonicalBase64Url(value: unknown, expectedBytes: number): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 ||
    !BASE64URL_RE.test(value)) return null;
  try {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length === expectedBytes && bytes.toString('base64url') === value ? bytes : null;
  } catch { return null; }
}

function trustRootShape(value: unknown): value is LaunchdRetryTrustRoot {
  return exactPlainRecord(value, [
    'keyId', 'notAfterMs', 'notBeforeMs', 'publicKeySpki', 'revokedAtMs',
    'signatureAlgorithm', 'signerRole',
  ]) && typeof value['keyId'] === 'string' && DIGEST_RE.test(value['keyId']) &&
    typeof value['publicKeySpki'] === 'string' &&
    launchdRetryAuthorityKeyId(value['publicKeySpki']) === value['keyId'] &&
    value['signerRole'] === LAUNCHD_RETRY_SIGNER_ROLE &&
    value['signatureAlgorithm'] === LAUNCHD_RETRY_SIGNATURE_ALGORITHM &&
    safeNonNegativeInteger(value['notBeforeMs']) && safeNonNegativeInteger(value['notAfterMs']) &&
    value['notBeforeMs'] < value['notAfterMs'] &&
    (value['revokedAtMs'] === null || safeNonNegativeInteger(value['revokedAtMs']));
}

function trustPolicyShape(value: unknown): value is LaunchdRetryTrustPolicy {
  if (!exactPlainRecord(value, ['policyGeneration', 'protocol', 'roots', 'schemaVersion']) ||
    value['schemaVersion'] !== 1 || value['protocol'] !== LAUNCHD_RETRY_TRUST_PROTOCOL ||
    !safeNonNegativeInteger(value['policyGeneration']) || !Array.isArray(value['roots']) ||
    value['roots'].length > 16) return false;
  let prior = '';
  for (const root of value['roots']) {
    if (!trustRootShape(root) || root.keyId <= prior) return false;
    prior = root.keyId;
  }
  return true;
}

function receiptUnsignedShape(value: unknown): value is LaunchdRetryEpochReceiptUnsigned {
  if (!exactPlainRecord(value, UNSIGNED_RECEIPT_KEYS) || value['schemaVersion'] !== 1 ||
    value['protocol'] !== LAUNCHD_RETRY_RECEIPT_PROTOCOL ||
    value['serviceIdentity'] !== LAUNCHD_RETRY_SERVICE_IDENTITY ||
    typeof value['releaseRevision'] !== 'string' || !REVISION_RE.test(value['releaseRevision']) ||
    !safeNonNegativeInteger(value['epoch']) || value['epoch'] < 1 ||
    !safeNonNegativeInteger(value['sequence']) ||
    !new Set<LaunchdRetryReceiptTransition>(['initialize', 'claim', 'healthy-reset'])
      .has(value['transition'] as LaunchdRetryReceiptTransition) ||
    !safeNonNegativeInteger(value['claimCount']) || value['claimCount'] > 3 ||
    !safeNonNegativeInteger(value['windowStartedAtMs']) ||
    !safeNonNegativeInteger(value['maxObservedAtMs']) ||
    value['maxObservedAtMs'] < value['windowStartedAtMs'] ||
    !(value['previousReceiptDigest'] === null ||
      (typeof value['previousReceiptDigest'] === 'string' && DIGEST_RE.test(value['previousReceiptDigest']))) ||
    typeof value['trustPolicyDigest'] !== 'string' || !DIGEST_RE.test(value['trustPolicyDigest']) ||
    !safeNonNegativeInteger(value['policyGeneration']) ||
    typeof value['keyId'] !== 'string' || !DIGEST_RE.test(value['keyId']) ||
    value['signerRole'] !== LAUNCHD_RETRY_SIGNER_ROLE ||
    value['signatureAlgorithm'] !== LAUNCHD_RETRY_SIGNATURE_ALGORITHM) return false;
  if (value['transition'] === 'initialize') {
    return value['claimCount'] === 0 && value['previousReceiptDigest'] === null;
  }
  if (value['previousReceiptDigest'] === null) return false;
  return value['transition'] === 'claim' ? value['claimCount'] >= 1 : value['claimCount'] === 0;
}

function receiptShape(value: unknown): value is LaunchdRetryEpochReceipt {
  if (!exactPlainRecord(value, RECEIPT_KEYS)) return false;
  const { signature: _signature, ...unsigned } = value;
  return receiptUnsignedShape(unsigned) && canonicalBase64Url(value['signature'], 64) !== null;
}

function receiptProjection(receipt: LaunchdRetryEpochReceipt): LaunchdRetryEpochReceipt {
  return {
    schemaVersion: receipt.schemaVersion,
    protocol: receipt.protocol,
    serviceIdentity: receipt.serviceIdentity,
    releaseRevision: receipt.releaseRevision,
    epoch: receipt.epoch,
    sequence: receipt.sequence,
    transition: receipt.transition,
    claimCount: receipt.claimCount,
    windowStartedAtMs: receipt.windowStartedAtMs,
    maxObservedAtMs: receipt.maxObservedAtMs,
    previousReceiptDigest: receipt.previousReceiptDigest,
    trustPolicyDigest: receipt.trustPolicyDigest,
    policyGeneration: receipt.policyGeneration,
    keyId: receipt.keyId,
    signerRole: receipt.signerRole,
    signatureAlgorithm: receipt.signatureAlgorithm,
    signature: receipt.signature,
  };
}

export function canonicalLaunchdRetryEpochReceiptBytes(value: unknown): Buffer | null {
  try {
    return receiptShape(value) ? Buffer.from(JSON.stringify(receiptProjection(value)), 'utf8') : null;
  } catch { return null; }
}

export function canonicalLaunchdRetryEpochReceiptPayload(value: unknown): Buffer | null {
  try {
    if (!receiptUnsignedShape(value)) return null;
    return Buffer.from(JSON.stringify([
      'ashlr:launchd-retry-epoch-receipt-signature:v1',
      value.schemaVersion,
      value.protocol,
      value.serviceIdentity,
      value.releaseRevision,
      value.epoch,
      value.sequence,
      value.transition,
      value.claimCount,
      value.windowStartedAtMs,
      value.maxObservedAtMs,
      value.previousReceiptDigest,
      value.trustPolicyDigest,
      value.policyGeneration,
      value.keyId,
      value.signerRole,
      value.signatureAlgorithm,
    ]), 'utf8');
  } catch { return null; }
}

export function launchdRetryAuthorityKeyId(publicKeySpki: unknown): string | null {
  if (typeof publicKeySpki !== 'string') return null;
  let bytes: Buffer;
  try { bytes = Buffer.from(publicKeySpki, 'base64url'); } catch { return null; }
  if (bytes.length < 32 || bytes.length > 128 || bytes.toString('base64url') !== publicKeySpki) return null;
  try {
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    const canonical = Buffer.from(key.export({ format: 'der', type: 'spki' }));
    if (key.asymmetricKeyType !== 'ed25519' || !canonical.equals(bytes)) return null;
    return sha256('ashlr:launchd-retry-authority-key-id:v1\0', bytes);
  } catch { return null; }
}

export function launchdRetryTrustPolicyDigest(
  policy: LaunchdRetryTrustPolicy = LAUNCHD_RETRY_TRUST_POLICY,
): string | null {
  try {
    if (!trustPolicyShape(policy)) return null;
    return sha256('ashlr:launchd-retry-trust-policy:v1\0', Buffer.from(JSON.stringify([
      policy.schemaVersion,
      policy.protocol,
      policy.policyGeneration,
      policy.roots.map((root) => [
        root.keyId,
        root.publicKeySpki,
        root.signerRole,
        root.signatureAlgorithm,
        root.notBeforeMs,
        root.notAfterMs,
        root.revokedAtMs,
      ]),
    ]), 'utf8'));
  } catch { return null; }
}

function trustedPublicKey(root: LaunchdRetryTrustRoot): KeyObject | null {
  if (!trustRootShape(root)) return null;
  try {
    const bytes = Buffer.from(root.publicKeySpki, 'base64url');
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch { return null; }
}

export function verifyLaunchdRetryEpochReceipt(
  value: unknown,
  context: { releaseRevision: string; serviceIdentity: string; nowMs: number },
  policy: LaunchdRetryTrustPolicy = LAUNCHD_RETRY_TRUST_POLICY,
): LaunchdRetryReceiptVerification {
  if (!trustPolicyShape(policy)) return { ok: false, reason: 'trust-policy-invalid' };
  if (policy.roots.length === 0) return { ok: false, reason: 'trust-root-unprovisioned' };
  if (!receiptShape(value)) return { ok: false, reason: 'receipt-invalid' };
  if (!REVISION_RE.test(context.releaseRevision) || !safeNonNegativeInteger(context.nowMs) ||
    value.releaseRevision !== context.releaseRevision ||
    value.serviceIdentity !== context.serviceIdentity) {
    return { ok: false, reason: 'receipt-context-mismatch' };
  }
  const policyDigest = launchdRetryTrustPolicyDigest(policy);
  if (!policyDigest || value.trustPolicyDigest !== policyDigest ||
    value.policyGeneration !== policy.policyGeneration) {
    return { ok: false, reason: 'trust-policy-mismatch' };
  }
  const root = policy.roots.find((entry) => entry.keyId === value.keyId);
  if (!root) return { ok: false, reason: 'trust-key-unknown' };
  const publicKey = trustedPublicKey(root);
  if (!publicKey) return { ok: false, reason: 'trust-key-invalid' };
  if (context.nowMs < root.notBeforeMs || context.nowMs >= root.notAfterMs ||
    (root.revokedAtMs !== null && context.nowMs >= root.revokedAtMs)) {
    return { ok: false, reason: 'trust-key-inactive' };
  }
  const { signature, ...unsigned } = value;
  const payload = canonicalLaunchdRetryEpochReceiptPayload(unsigned);
  const signatureBytes = canonicalBase64Url(signature, 64);
  if (!payload || !signatureBytes) return { ok: false, reason: 'receipt-invalid' };
  let signatureVerified = false;
  try { signatureVerified = verifySignature(null, payload, publicKey, signatureBytes); } catch { /* fail closed */ }
  if (!signatureVerified) return { ok: false, reason: 'signature-invalid' };
  const receiptBytes = canonicalLaunchdRetryEpochReceiptBytes(value);
  if (!receiptBytes) return { ok: false, reason: 'receipt-invalid' };
  return {
    ok: true,
    reason: 'receipt-authenticated',
    value: {
      receipt: receiptProjection(value),
      receiptDigest: sha256('ashlr:launchd-retry-epoch-receipt:v1\0', receiptBytes),
      trustPolicyDigest: policyDigest,
    },
  };
}

export function launchdRetryReceiptBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
