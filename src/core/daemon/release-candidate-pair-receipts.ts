import {
  createHash,
  createPublicKey,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

export const RELEASE_CANDIDATE_PAIR_RECEIPT_SCHEMA_VERSION = 1 as const;
export const RELEASE_CANDIDATE_PAIR_RECEIPT_DOMAIN_V1 =
  'ashlr:release-candidate-pair-receipt:v1' as const;
export const RELEASE_CANDIDATE_PAIR_TRUST_POLICY_DOMAIN_V1 =
  'ashlr:release-candidate-pair-trust-policy:v1' as const;
export const RELEASE_CANDIDATE_PAIR_EVIDENCE_DOMAIN_V1 =
  'ashlr:release-candidate-pair-external-evidence:v1' as const;
export const RELEASE_CANDIDATE_PAIR_SIGNER_ROLE = 'release-observer' as const;
export const RELEASE_CANDIDATE_PAIR_RECEIPT_AUTHORITY = 'observation-only' as const;
export const RELEASE_CANDIDATE_PAIR_RECEIPT_MAX_LIFETIME_MS = 15 * 60 * 1_000;

const RECEIPT_SIGNATURE_DOMAIN = 'ashlr:release-candidate-pair-receipt-signature:v1';
const RECEIPT_DIGEST_DOMAIN = 'ashlr:release-candidate-pair-canonical-receipt:v1';
const EVIDENCE_SIGNATURE_DOMAIN = 'ashlr:release-candidate-pair-evidence-signature:v1';
const EVIDENCE_DIGEST_DOMAIN = 'ashlr:release-candidate-pair-evidence-digest:v1';
const TRUST_POLICY_DIGEST_DOMAIN = 'ashlr:release-candidate-pair-trust-policy-digest:v1';
const RELEASE_IDENTITY_DIGEST_DOMAIN = 'ashlr:release-candidate-pair-release-identity:v1';
const KEY_ID_DOMAIN = 'ashlr:release-candidate-pair-key-id:v1';
const MAX_RECEIPT_BYTES = 96 * 1_024;
const MAX_EVIDENCE_BYTES = 48 * 1_024;
const MAX_PUBLIC_KEYS = 32;
const MAX_PUBLIC_KEY_BYTES = 512;
const MAX_REQUIRED_CHECKS = 64;
const MAX_IDENTIFIER_BYTES = 128;
const MAX_CHECK_CONTEXT_BYTES = 256;
const ED25519_SIGNATURE_BYTES = 64;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const REVISION_RE = /^[a-f0-9]{40}$/;
const KEY_ID_RE = /^ed25519-sha256:[a-f0-9]{64}$/;
const APP_ID_RE = /^[1-9]\d*$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const IDENTIFIER_RE = /^[A-Za-z0-9._:-]+$/;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ReleaseCandidatePairRepositoryScopeV1 {
  branch: 'master';
  repositoryId: string;
}

export interface ReleaseCandidatePairTrustKeyV1 {
  algorithm: 'ed25519';
  keyId: string;
  notAfter: string;
  notBefore: string;
  publicKeySpki: string;
  signerRole: typeof RELEASE_CANDIDATE_PAIR_SIGNER_ROLE;
}

export interface ReleaseCandidatePairTrustPolicyV1 {
  domain: typeof RELEASE_CANDIDATE_PAIR_TRUST_POLICY_DOMAIN_V1;
  keys: ReleaseCandidatePairTrustKeyV1[];
  policyEpoch: string;
  repositoryScope: ReleaseCandidatePairRepositoryScopeV1;
  schemaVersion: 1;
}

export interface ReleaseCandidatePairRequiredCheckV1 {
  appId: string;
  conclusion: 'success';
  context: string;
}

interface ExternalEvidenceBaseV1 {
  authority: 'externally-authenticated-observation';
  expiresAt: string;
  observedAt: string;
  policyEpoch: string;
  repositoryScope: ReleaseCandidatePairRepositoryScopeV1;
  schemaVersion: 1;
  signerRole: typeof RELEASE_CANDIDATE_PAIR_SIGNER_ROLE;
  trustPolicyDigest: string;
}

export interface ReleaseCandidatePairProtectedHeadEvidencePayloadV1
  extends ExternalEvidenceBaseV1 {
  adminEnforced: true;
  candidateOid: string;
  deletionAllowed: false;
  evidenceType: 'protected-head';
  forcePushAllowed: false;
  protected: true;
  protectionSnapshotDigest: string;
  requiredChecks: ReleaseCandidatePairRequiredCheckV1[];
  strictRequiredChecks: true;
}

export interface ReleaseCandidatePairAncestryDeploymentEvidencePayloadV1
  extends ExternalEvidenceBaseV1 {
  candidateDescendsFromRollback: true;
  candidateOid: string;
  evidenceType: 'ancestry-deployment';
  installedReceiptDigest: string;
  rollbackOid: string;
  rollbackWasPreviouslyActivated: true;
}

export type ReleaseCandidatePairExternalEvidencePayloadV1 =
  | ReleaseCandidatePairProtectedHeadEvidencePayloadV1
  | ReleaseCandidatePairAncestryDeploymentEvidencePayloadV1;

export interface SignedReleaseCandidatePairExternalEvidenceV1 {
  algorithm: 'ed25519';
  domain: typeof RELEASE_CANDIDATE_PAIR_EVIDENCE_DOMAIN_V1;
  keyId: string;
  payload: ReleaseCandidatePairExternalEvidencePayloadV1;
  schemaVersion: 1;
  signature: string;
}

export interface ReleaseCandidatePairReleaseIdentityV1 {
  artifacts: {
    artifactDigest: string;
    complete: true;
    immutable: true;
    packagedTreeDigest: string;
  };
  configPolicyDigest: string;
  dependencies: {
    complete: true;
    immutable: true;
    installedClosureDigest: string;
  };
  revision: string;
  runtime: {
    complete: true;
    immutable: true;
    nodeExecutableDigest: string;
  };
  service: {
    argvDigest: string;
    environmentPolicyDigest: string;
  };
}

export interface ReleaseCandidatePairPayloadV1 {
  activationPermitted: false;
  ancestryDeployment: {
    candidateDescendsFromRollback: true;
    candidateOid: string;
    evidenceDigest: string;
    expiresAt: string;
    installedReceiptDigest: string;
    observedAt: string;
    rollbackOid: string;
    rollbackWasPreviouslyActivated: true;
    signerKeyId: string;
  };
  authority: typeof RELEASE_CANDIDATE_PAIR_RECEIPT_AUTHORITY;
  candidate: ReleaseCandidatePairReleaseIdentityV1;
  candidateReleaseDigest: string;
  capturedAt: string;
  deployPermitted: false;
  expiresAt: string;
  installPermitted: false;
  mergePermitted: false;
  policyEpoch: string;
  predecessorReceiptDigest: string;
  previousReleaseDigest: string;
  protectedHead: {
    candidateOid: string;
    evidenceDigest: string;
    expiresAt: string;
    observedAt: string;
    protectionSnapshotDigest: string;
    requiredChecks: ReleaseCandidatePairRequiredCheckV1[];
    signerKeyId: string;
  };
  repositoryScope: ReleaseCandidatePairRepositoryScopeV1;
  rollbackPermitted: false;
  rollbackTarget: ReleaseCandidatePairReleaseIdentityV1;
  rollbackTargetReleaseDigest: string;
  schemaVersion: 1;
  sequence: number;
  startPermitted: false;
  trustPolicyDigest: string;
}

export interface SignedReleaseCandidatePairReceiptV1 {
  algorithm: 'ed25519';
  domain: typeof RELEASE_CANDIDATE_PAIR_RECEIPT_DOMAIN_V1;
  keyId: string;
  payload: ReleaseCandidatePairPayloadV1;
  schemaVersion: 1;
  signature: string;
}

export interface ReleaseCandidatePairExpectedBindingsV1 {
  currentTipAuthority: 'externally-authenticated-observation';
  currentTipDigest: string;
  currentTipSequence: number;
  policyEpoch: string;
  repositoryScope: ReleaseCandidatePairRepositoryScopeV1;
  trustPolicyDigest: string;
}

export interface SignReleaseCandidatePairEvidenceOptions<Payload> {
  payload: Payload;
  privateKey: KeyObject;
}

export interface BuildReleaseCandidatePairReceiptOptions {
  ancestryDeploymentEvidence: string | Buffer;
  candidate: ReleaseCandidatePairReleaseIdentityV1;
  capturedAt: string;
  expected: ReleaseCandidatePairExpectedBindingsV1;
  expiresAt: string;
  predecessorReceiptDigest: string;
  privateKey: KeyObject;
  protectedHeadEvidence: string | Buffer;
  rollbackTarget: ReleaseCandidatePairReleaseIdentityV1;
  sequence: number;
  trustPolicy: ReleaseCandidatePairTrustPolicyV1;
}

export interface VerifyReleaseCandidatePairReceiptOptions {
  ancestryDeploymentEvidence: string | Buffer;
  expected: ReleaseCandidatePairExpectedBindingsV1;
  now?: Date | number;
  protectedHeadEvidence: string | Buffer;
  receipt: string | Buffer;
  receiptTrustedPublicKeys: KeyObject[];
  trustPolicy: ReleaseCandidatePairTrustPolicyV1;
}

type SignEvidenceResult =
  | {
    canonicalJson: string;
    evidence: SignedReleaseCandidatePairExternalEvidenceV1;
    evidenceDigest: string;
    keyId: string;
    ok: true;
  }
  | { ok: false; reason: string };

export type BuildReleaseCandidatePairReceiptResult =
  | {
    canonicalJson: string;
    keyId: string;
    ok: true;
    receipt: SignedReleaseCandidatePairReceiptV1;
    receiptDigest: string;
  }
  | { ok: false; reason: string };

export type ParseReleaseCandidatePairReceiptResult =
  | {
    canonicalJson: string;
    ok: true;
    receipt: SignedReleaseCandidatePairReceiptV1;
    receiptDigest: string;
  }
  | { ok: false; reason: string };

export type VerifyReleaseCandidatePairReceiptResult =
  | {
    authority: typeof RELEASE_CANDIDATE_PAIR_RECEIPT_AUTHORITY;
    candidateReleaseDigest: string;
    expiresAt: string;
    keyId: string;
    ok: true;
    predecessorReceiptDigest: string;
    receiptDigest: string;
    rollbackTargetReleaseDigest: string;
    sequence: number;
    verifiedAtMs: number;
  }
  | { ok: false; reason: string };

type UnsignedEvidence = Omit<SignedReleaseCandidatePairExternalEvidenceV1, 'signature'>;
type UnsignedReceipt = Omit<SignedReleaseCandidatePairReceiptV1, 'signature'>;

function canonicalize(value: unknown, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite JSON number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('invalid JSON value');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => {
        if (!Object.hasOwn(value, index)) throw new TypeError('sparse JSON array');
        return canonicalize(entry, ancestors);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('non-plain JSON object');
    }
    const output = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      output[key] = canonicalize((value as Record<string, unknown>)[key], ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set<object>()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function domainDigest(domain: string, value: string | Buffer): string {
  return `sha256:${createHash('sha256')
    .update(domain, 'utf8')
    .update('\n', 'utf8')
    .update(value)
    .digest('hex')}`;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function sameDigest(left: string, right: string): boolean {
  return DIGEST_RE.test(left) && DIGEST_RE.test(right) &&
    timingSafeEqual(Buffer.from(left.slice(7), 'hex'), Buffer.from(right.slice(7), 'hex'));
}

function revision(value: unknown, label: string): string {
  if (typeof value !== 'string' || !REVISION_RE.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length !== 24) throw new Error(`${label} is invalid`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function timestampMs(value: string): number {
  return Date.parse(value);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_RE.test(value) ||
    Buffer.byteLength(value, 'utf8') > MAX_IDENTIFIER_BYTES) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function scopeFrom(value: unknown): ReleaseCandidatePairRepositoryScopeV1 {
  if (!isRecord(value) || !exact(value, ['branch', 'repositoryId']) || value['branch'] !== 'master') {
    throw new Error('release candidate pair repository scope is invalid');
  }
  return {
    branch: 'master',
    repositoryId: identifier(value['repositoryId'], 'release candidate pair repository id'),
  };
}

function sameScope(
  left: ReleaseCandidatePairRepositoryScopeV1,
  right: ReleaseCandidatePairRepositoryScopeV1,
): boolean {
  return left.branch === right.branch && left.repositoryId === right.repositoryId;
}

function containsControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function requiredChecksFrom(value: unknown): ReleaseCandidatePairRequiredCheckV1[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REQUIRED_CHECKS) {
    throw new Error('release candidate pair successful App-bound checks are missing');
  }
  let previous = '';
  return value.map((entry) => {
    if (!isRecord(entry) || !exact(entry, ['appId', 'conclusion', 'context']) ||
      typeof entry['appId'] !== 'string' || !APP_ID_RE.test(entry['appId']) ||
      entry['conclusion'] !== 'success' || typeof entry['context'] !== 'string' ||
      entry['context'].length === 0 || containsControl(entry['context']) ||
      Buffer.byteLength(entry['context'], 'utf8') > MAX_CHECK_CONTEXT_BYTES) {
      throw new Error('release candidate pair required check is not an exact successful App check');
    }
    const key = `${entry['context']}\u0000${entry['appId']}`;
    if (key <= previous) {
      throw new Error('release candidate pair required checks must be unique and sorted');
    }
    previous = key;
    return { appId: entry['appId'], conclusion: 'success', context: entry['context'] };
  });
}

function publicKeyDer(key: KeyObject): Buffer {
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('release candidate pair public key must be Ed25519');
  }
  const bytes = key.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_PUBLIC_KEY_BYTES) {
    throw new Error('release candidate pair public key encoding is invalid');
  }
  return bytes;
}

function keyIdFor(key: KeyObject): string {
  return `ed25519-sha256:${createHash('sha256')
    .update(KEY_ID_DOMAIN, 'utf8')
    .update('\n', 'utf8')
    .update(publicKeyDer(key))
    .digest('hex')}`;
}

export function releaseCandidatePairKeyId(key: KeyObject): string | null {
  try {
    return keyIdFor(key);
  } catch {
    return null;
  }
}

function publicKeyFromSpki(value: string): KeyObject {
  if (!BASE64URL_RE.test(value)) throw new Error('release candidate pair trust key is invalid');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length === 0 || bytes.length > MAX_PUBLIC_KEY_BYTES ||
    bytes.toString('base64url') !== value) {
    throw new Error('release candidate pair trust key is invalid');
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
  } catch {
    throw new Error('release candidate pair trust key is invalid');
  }
  if (!publicKeyDer(key).equals(bytes)) throw new Error('release candidate pair trust key is invalid');
  return key;
}

function trustPolicyFrom(value: unknown): ReleaseCandidatePairTrustPolicyV1 {
  if (!isRecord(value) || !exact(value, [
    'domain', 'keys', 'policyEpoch', 'repositoryScope', 'schemaVersion',
  ]) || value['domain'] !== RELEASE_CANDIDATE_PAIR_TRUST_POLICY_DOMAIN_V1 ||
    value['schemaVersion'] !== 1 || !Array.isArray(value['keys']) ||
    value['keys'].length === 0 || value['keys'].length > MAX_PUBLIC_KEYS) {
    throw new Error('release candidate pair trust policy is invalid');
  }
  const repositoryScope = scopeFrom(value['repositoryScope']);
  const policyEpoch = identifier(value['policyEpoch'], 'release candidate pair policy epoch');
  let previousKeyId = '';
  const keys = value['keys'].map((entry) => {
    if (!isRecord(entry) || !exact(entry, [
      'algorithm', 'keyId', 'notAfter', 'notBefore', 'publicKeySpki', 'signerRole',
    ]) || entry['algorithm'] !== 'ed25519' ||
      entry['signerRole'] !== RELEASE_CANDIDATE_PAIR_SIGNER_ROLE ||
      typeof entry['keyId'] !== 'string' || !KEY_ID_RE.test(entry['keyId']) ||
      typeof entry['publicKeySpki'] !== 'string') {
      throw new Error('release candidate pair trust key is invalid');
    }
    if (entry['keyId'] <= previousKeyId) {
      throw new Error('release candidate pair trust keys must be unique and sorted');
    }
    previousKeyId = entry['keyId'];
    const publicKey = publicKeyFromSpki(entry['publicKeySpki']);
    if (keyIdFor(publicKey) !== entry['keyId']) {
      throw new Error('release candidate pair trust key id mismatch');
    }
    const notBefore = timestamp(entry['notBefore'], 'release candidate pair trust key notBefore');
    const notAfter = timestamp(entry['notAfter'], 'release candidate pair trust key notAfter');
    if (timestampMs(notAfter) <= timestampMs(notBefore)) {
      throw new Error('release candidate pair trust key validity is invalid');
    }
    return {
      algorithm: 'ed25519' as const,
      keyId: entry['keyId'],
      notAfter,
      notBefore,
      publicKeySpki: entry['publicKeySpki'],
      signerRole: RELEASE_CANDIDATE_PAIR_SIGNER_ROLE,
    };
  });
  return {
    domain: RELEASE_CANDIDATE_PAIR_TRUST_POLICY_DOMAIN_V1,
    keys,
    policyEpoch,
    repositoryScope,
    schemaVersion: 1,
  };
}

export function releaseCandidatePairTrustPolicyDigest(
  value: ReleaseCandidatePairTrustPolicyV1,
): string | null {
  try {
    return domainDigest(TRUST_POLICY_DIGEST_DOMAIN, canonicalJson(trustPolicyFrom(value)));
  } catch {
    return null;
  }
}

function evidenceBaseFrom(value: Record<string, unknown>): ExternalEvidenceBaseV1 {
  if (value['schemaVersion'] !== 1 ||
    value['authority'] !== 'externally-authenticated-observation' ||
    value['signerRole'] !== RELEASE_CANDIDATE_PAIR_SIGNER_ROLE) {
    throw new Error('release candidate pair evidence authority is invalid');
  }
  const observedAt = timestamp(value['observedAt'], 'release candidate pair evidence observedAt');
  const expiresAt = timestamp(value['expiresAt'], 'release candidate pair evidence expiresAt');
  const lifetime = timestampMs(expiresAt) - timestampMs(observedAt);
  if (lifetime <= 0 || lifetime > RELEASE_CANDIDATE_PAIR_RECEIPT_MAX_LIFETIME_MS) {
    throw new Error('release candidate pair evidence lifetime is invalid');
  }
  return {
    authority: 'externally-authenticated-observation',
    expiresAt,
    observedAt,
    policyEpoch: identifier(value['policyEpoch'], 'release candidate pair evidence policy epoch'),
    repositoryScope: scopeFrom(value['repositoryScope']),
    schemaVersion: 1,
    signerRole: RELEASE_CANDIDATE_PAIR_SIGNER_ROLE,
    trustPolicyDigest: digest(value['trustPolicyDigest'], 'release candidate pair evidence trust policy digest'),
  };
}

function evidencePayloadFrom(value: unknown): ReleaseCandidatePairExternalEvidencePayloadV1 {
  if (!isRecord(value) || typeof value['evidenceType'] !== 'string') {
    throw new Error('release candidate pair evidence payload is invalid');
  }
  if (value['evidenceType'] === 'protected-head') {
    if (!exact(value, [
      'adminEnforced', 'authority', 'candidateOid', 'deletionAllowed', 'evidenceType',
      'expiresAt', 'forcePushAllowed', 'observedAt', 'policyEpoch', 'protected',
      'protectionSnapshotDigest', 'repositoryScope', 'requiredChecks', 'schemaVersion',
      'signerRole', 'strictRequiredChecks', 'trustPolicyDigest',
    ]) || value['protected'] !== true || value['adminEnforced'] !== true ||
      value['strictRequiredChecks'] !== true || value['forcePushAllowed'] !== false ||
      value['deletionAllowed'] !== false) {
      throw new Error('release candidate pair protected-head evidence is invalid');
    }
    return {
      ...evidenceBaseFrom(value),
      adminEnforced: true,
      candidateOid: revision(value['candidateOid'], 'release candidate pair protected-head candidate'),
      deletionAllowed: false,
      evidenceType: 'protected-head',
      forcePushAllowed: false,
      protected: true,
      protectionSnapshotDigest: digest(
        value['protectionSnapshotDigest'],
        'release candidate pair protection snapshot digest',
      ),
      requiredChecks: requiredChecksFrom(value['requiredChecks']),
      strictRequiredChecks: true,
    };
  }
  if (value['evidenceType'] === 'ancestry-deployment') {
    if (!exact(value, [
      'authority', 'candidateDescendsFromRollback', 'candidateOid', 'evidenceType',
      'expiresAt', 'installedReceiptDigest', 'observedAt', 'policyEpoch', 'repositoryScope',
      'rollbackOid', 'rollbackWasPreviouslyActivated', 'schemaVersion', 'signerRole',
      'trustPolicyDigest',
    ]) || value['candidateDescendsFromRollback'] !== true ||
      value['rollbackWasPreviouslyActivated'] !== true) {
      throw new Error('release candidate pair ancestry/deployment evidence is invalid');
    }
    return {
      ...evidenceBaseFrom(value),
      candidateDescendsFromRollback: true,
      candidateOid: revision(value['candidateOid'], 'release candidate pair ancestry candidate'),
      evidenceType: 'ancestry-deployment',
      installedReceiptDigest: digest(
        value['installedReceiptDigest'],
        'release candidate pair installed receipt digest',
      ),
      rollbackOid: revision(value['rollbackOid'], 'release candidate pair ancestry rollback'),
      rollbackWasPreviouslyActivated: true,
    };
  }
  throw new Error('release candidate pair evidence type is unsupported');
}

function decodeSignature(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !BASE64URL_RE.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === ED25519_SIGNATURE_BYTES && bytes.toString('base64url') === value
    ? bytes
    : null;
}

function unsignedEvidence(
  evidence: SignedReleaseCandidatePairExternalEvidenceV1,
): UnsignedEvidence {
  return {
    algorithm: evidence.algorithm,
    domain: evidence.domain,
    keyId: evidence.keyId,
    payload: evidence.payload,
    schemaVersion: evidence.schemaVersion,
  };
}

function evidenceSignatureInput(evidence: UnsignedEvidence): Buffer {
  return Buffer.concat([
    Buffer.from(`${EVIDENCE_SIGNATURE_DOMAIN}\n`, 'utf8'),
    Buffer.from(canonicalJson(evidence), 'utf8'),
  ]);
}

function evidenceFrom(value: unknown): SignedReleaseCandidatePairExternalEvidenceV1 {
  if (!isRecord(value) || !exact(value, [
    'algorithm', 'domain', 'keyId', 'payload', 'schemaVersion', 'signature',
  ]) || value['algorithm'] !== 'ed25519' ||
    value['domain'] !== RELEASE_CANDIDATE_PAIR_EVIDENCE_DOMAIN_V1 ||
    value['schemaVersion'] !== 1 || typeof value['keyId'] !== 'string' ||
    !KEY_ID_RE.test(value['keyId']) || !decodeSignature(value['signature'])) {
    throw new Error('release candidate pair signed evidence envelope is invalid');
  }
  return {
    algorithm: 'ed25519',
    domain: RELEASE_CANDIDATE_PAIR_EVIDENCE_DOMAIN_V1,
    keyId: value['keyId'],
    payload: evidencePayloadFrom(value['payload']),
    schemaVersion: 1,
    signature: value['signature'] as string,
  };
}

function parseCanonical<T>(
  input: string | Buffer,
  maxBytes: number,
  label: string,
  parse: (value: unknown) => T,
): { canonicalJson: string; value: T } {
  const bytes = Buffer.isBuffer(input) ? Buffer.from(input) : Buffer.from(input, 'utf8');
  if (bytes.length === 0 || bytes.length > maxBytes) throw new Error(`${label} byte length is invalid`);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`${label} is not valid UTF-8`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  const parsed = parse(value);
  const encoded = `${canonicalJson(parsed)}\n`;
  if (encoded !== text) throw new Error(`${label} encoding is not canonical`);
  return { canonicalJson: encoded, value: parsed };
}

function signEvidence(
  payload: ReleaseCandidatePairExternalEvidencePayloadV1,
  privateKey: KeyObject,
): SignEvidenceResult {
  try {
    if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('release candidate pair evidence private key must be Ed25519');
    }
    const keyId = keyIdFor(createPublicKey(privateKey));
    const unsigned: UnsignedEvidence = {
      algorithm: 'ed25519',
      domain: RELEASE_CANDIDATE_PAIR_EVIDENCE_DOMAIN_V1,
      keyId,
      payload: evidencePayloadFrom(payload),
      schemaVersion: 1,
    };
    const evidence: SignedReleaseCandidatePairExternalEvidenceV1 = {
      ...unsigned,
      signature: cryptoSign(null, evidenceSignatureInput(unsigned), privateKey).toString('base64url'),
    };
    const canonical = `${canonicalJson(evidence)}\n`;
    const parsed = parseCanonical(canonical, MAX_EVIDENCE_BYTES, 'release candidate pair evidence', evidenceFrom);
    return {
      canonicalJson: parsed.canonicalJson,
      evidence: parsed.value,
      evidenceDigest: domainDigest(EVIDENCE_DIGEST_DOMAIN, parsed.canonicalJson),
      keyId,
      ok: true,
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function signReleaseCandidatePairProtectedHeadEvidence(
  options: SignReleaseCandidatePairEvidenceOptions<ReleaseCandidatePairProtectedHeadEvidencePayloadV1>,
): SignEvidenceResult {
  return signEvidence(options.payload, options.privateKey);
}

export function signReleaseCandidatePairAncestryDeploymentEvidence(
  options: SignReleaseCandidatePairEvidenceOptions<
    ReleaseCandidatePairAncestryDeploymentEvidencePayloadV1
  >,
): SignEvidenceResult {
  return signEvidence(options.payload, options.privateKey);
}

function trustedPolicyKeys(policy: ReleaseCandidatePairTrustPolicyV1): Map<string, {
  key: KeyObject;
  policy: ReleaseCandidatePairTrustKeyV1;
}> {
  const output = new Map<string, { key: KeyObject; policy: ReleaseCandidatePairTrustKeyV1 }>();
  for (const entry of policy.keys) {
    output.set(entry.keyId, { key: publicKeyFromSpki(entry.publicKeySpki), policy: entry });
  }
  return output;
}

interface VerifiedEvidence {
  canonicalJson: string;
  evidence: SignedReleaseCandidatePairExternalEvidenceV1;
  evidenceDigest: string;
}

function verifyExternalEvidence(
  input: string | Buffer,
  expectedType: ReleaseCandidatePairExternalEvidencePayloadV1['evidenceType'],
  policy: ReleaseCandidatePairTrustPolicyV1,
  expected: ReleaseCandidatePairExpectedBindingsV1,
  atMs: number,
): VerifiedEvidence {
  const parsed = parseCanonical(input, MAX_EVIDENCE_BYTES, 'release candidate pair evidence', evidenceFrom);
  const evidence = parsed.value;
  if (evidence.payload.evidenceType !== expectedType) {
    throw new Error(`release candidate pair ${expectedType} evidence is missing`);
  }
  if (!sameDigest(evidence.payload.trustPolicyDigest, expected.trustPolicyDigest) ||
    evidence.payload.policyEpoch !== expected.policyEpoch ||
    !sameScope(evidence.payload.repositoryScope, expected.repositoryScope)) {
    throw new Error('release candidate pair evidence expected policy binding mismatch');
  }
  const selected = trustedPolicyKeys(policy).get(evidence.keyId);
  if (!selected || selected.policy.signerRole !== RELEASE_CANDIDATE_PAIR_SIGNER_ROLE) {
    throw new Error('release candidate pair evidence signer is not a trusted release observer');
  }
  const observedAtMs = timestampMs(evidence.payload.observedAt);
  const expiresAtMs = timestampMs(evidence.payload.expiresAt);
  if (observedAtMs < timestampMs(selected.policy.notBefore) ||
    expiresAtMs > timestampMs(selected.policy.notAfter)) {
    throw new Error('release candidate pair evidence falls outside observer key validity');
  }
  if (atMs < observedAtMs) throw new Error('release candidate pair evidence is not yet valid');
  if (atMs >= expiresAtMs) throw new Error('release candidate pair evidence is stale');
  const signature = decodeSignature(evidence.signature);
  if (!signature || !cryptoVerify(
    null,
    evidenceSignatureInput(unsignedEvidence(evidence)),
    selected.key,
    signature,
  )) {
    throw new Error('release candidate pair evidence signature verification failed');
  }
  return {
    canonicalJson: parsed.canonicalJson,
    evidence,
    evidenceDigest: domainDigest(EVIDENCE_DIGEST_DOMAIN, parsed.canonicalJson),
  };
}

function releaseIdentityFrom(value: unknown, label: string): ReleaseCandidatePairReleaseIdentityV1 {
  if (!isRecord(value) || !exact(value, [
    'artifacts', 'configPolicyDigest', 'dependencies', 'revision', 'runtime', 'service',
  ])) throw new Error(`${label} shape is invalid`);
  const artifacts = value['artifacts'];
  const dependencies = value['dependencies'];
  const runtime = value['runtime'];
  const service = value['service'];
  if (!isRecord(artifacts) || !exact(artifacts, [
    'artifactDigest', 'complete', 'immutable', 'packagedTreeDigest',
  ]) || artifacts['complete'] !== true || artifacts['immutable'] !== true) {
    throw new Error(`${label} artifact identity is mutable or incomplete`);
  }
  if (!isRecord(dependencies) || !exact(dependencies, [
    'complete', 'immutable', 'installedClosureDigest',
  ]) || dependencies['complete'] !== true || dependencies['immutable'] !== true) {
    throw new Error(`${label} dependency identity is mutable or incomplete`);
  }
  if (!isRecord(runtime) || !exact(runtime, [
    'complete', 'immutable', 'nodeExecutableDigest',
  ]) || runtime['complete'] !== true || runtime['immutable'] !== true) {
    throw new Error(`${label} runtime identity is mutable or incomplete`);
  }
  if (!isRecord(service) || !exact(service, ['argvDigest', 'environmentPolicyDigest'])) {
    throw new Error(`${label} service identity is incomplete`);
  }
  return {
    artifacts: {
      artifactDigest: digest(artifacts['artifactDigest'], `${label} artifact digest`),
      complete: true,
      immutable: true,
      packagedTreeDigest: digest(artifacts['packagedTreeDigest'], `${label} packaged tree digest`),
    },
    configPolicyDigest: digest(value['configPolicyDigest'], `${label} config policy digest`),
    dependencies: {
      complete: true,
      immutable: true,
      installedClosureDigest: digest(
        dependencies['installedClosureDigest'],
        `${label} installed dependency closure digest`,
      ),
    },
    revision: revision(value['revision'], `${label} revision`),
    runtime: {
      complete: true,
      immutable: true,
      nodeExecutableDigest: digest(runtime['nodeExecutableDigest'], `${label} Node executable digest`),
    },
    service: {
      argvDigest: digest(service['argvDigest'], `${label} service argv digest`),
      environmentPolicyDigest: digest(
        service['environmentPolicyDigest'],
        `${label} service environment policy digest`,
      ),
    },
  };
}

export function releaseCandidatePairReleaseIdentityDigest(
  identity: ReleaseCandidatePairReleaseIdentityV1,
): string | null {
  try {
    return domainDigest(
      RELEASE_IDENTITY_DIGEST_DOMAIN,
      canonicalJson(releaseIdentityFrom(identity, 'release identity')),
    );
  } catch {
    return null;
  }
}

function expectedFrom(value: unknown): ReleaseCandidatePairExpectedBindingsV1 {
  if (!isRecord(value) || !exact(value, [
    'currentTipAuthority', 'currentTipDigest', 'currentTipSequence', 'policyEpoch',
    'repositoryScope', 'trustPolicyDigest',
  ]) || value['currentTipAuthority'] !== 'externally-authenticated-observation' ||
    !Number.isSafeInteger(value['currentTipSequence']) ||
    Number(value['currentTipSequence']) < 0 ||
    Number(value['currentTipSequence']) >= Number.MAX_SAFE_INTEGER) {
    throw new Error('release candidate pair expected bindings are invalid');
  }
  return {
    currentTipAuthority: 'externally-authenticated-observation',
    currentTipDigest: digest(value['currentTipDigest'], 'release candidate pair current tip digest'),
    currentTipSequence: Number(value['currentTipSequence']),
    policyEpoch: identifier(value['policyEpoch'], 'release candidate pair expected policy epoch'),
    repositoryScope: scopeFrom(value['repositoryScope']),
    trustPolicyDigest: digest(
      value['trustPolicyDigest'],
      'release candidate pair expected trust policy digest',
    ),
  };
}

function validatePolicyBinding(
  policyInput: ReleaseCandidatePairTrustPolicyV1,
  expectedInput: ReleaseCandidatePairExpectedBindingsV1,
): { expected: ReleaseCandidatePairExpectedBindingsV1; policy: ReleaseCandidatePairTrustPolicyV1 } {
  const policy = trustPolicyFrom(policyInput);
  const expected = expectedFrom(expectedInput);
  const policyDigest = releaseCandidatePairTrustPolicyDigest(policy);
  if (!policyDigest || !sameDigest(policyDigest, expected.trustPolicyDigest) ||
    policy.policyEpoch !== expected.policyEpoch ||
    !sameScope(policy.repositoryScope, expected.repositoryScope)) {
    throw new Error('release candidate pair trust policy substitution detected');
  }
  return { expected, policy };
}

function validateTip(
  sequence: number,
  predecessorReceiptDigest: string,
  expected: ReleaseCandidatePairExpectedBindingsV1,
): void {
  if (sequence !== expected.currentTipSequence + 1 ||
    !sameDigest(predecessorReceiptDigest, expected.currentTipDigest)) {
    throw new Error('release candidate pair fork/conflict: predecessor is not trusted current tip');
  }
}

function payloadFrom(value: unknown): ReleaseCandidatePairPayloadV1 {
  if (!isRecord(value) || !exact(value, [
    'activationPermitted', 'ancestryDeployment', 'authority', 'candidate',
    'candidateReleaseDigest', 'capturedAt', 'deployPermitted', 'expiresAt',
    'installPermitted', 'mergePermitted', 'policyEpoch', 'predecessorReceiptDigest',
    'previousReleaseDigest', 'protectedHead', 'repositoryScope', 'rollbackPermitted',
    'rollbackTarget', 'rollbackTargetReleaseDigest', 'schemaVersion', 'sequence',
    'startPermitted', 'trustPolicyDigest',
  ]) || value['schemaVersion'] !== 1 ||
    value['authority'] !== RELEASE_CANDIDATE_PAIR_RECEIPT_AUTHORITY ||
    value['installPermitted'] !== false || value['startPermitted'] !== false ||
    value['mergePermitted'] !== false || value['rollbackPermitted'] !== false ||
    value['deployPermitted'] !== false || value['activationPermitted'] !== false ||
    !Number.isSafeInteger(value['sequence']) || Number(value['sequence']) <= 0) {
    throw new Error('release candidate pair payload authority or shape is invalid');
  }
  const protectedHead = value['protectedHead'];
  if (!isRecord(protectedHead) || !exact(protectedHead, [
    'candidateOid', 'evidenceDigest', 'expiresAt', 'observedAt',
    'protectionSnapshotDigest', 'requiredChecks', 'signerKeyId',
  ]) || typeof protectedHead['signerKeyId'] !== 'string' ||
    !KEY_ID_RE.test(protectedHead['signerKeyId'])) {
    throw new Error('release candidate pair protected-head projection is invalid');
  }
  const ancestry = value['ancestryDeployment'];
  if (!isRecord(ancestry) || !exact(ancestry, [
    'candidateDescendsFromRollback', 'candidateOid', 'evidenceDigest', 'expiresAt',
    'installedReceiptDigest', 'observedAt', 'rollbackOid',
    'rollbackWasPreviouslyActivated', 'signerKeyId',
  ]) || ancestry['candidateDescendsFromRollback'] !== true ||
    ancestry['rollbackWasPreviouslyActivated'] !== true ||
    typeof ancestry['signerKeyId'] !== 'string' || !KEY_ID_RE.test(ancestry['signerKeyId'])) {
    throw new Error('release candidate pair ancestry/deployment projection is invalid');
  }
  const candidate = releaseIdentityFrom(value['candidate'], 'release candidate');
  const rollbackTarget = releaseIdentityFrom(value['rollbackTarget'], 'release rollback target');
  if (candidate.revision === rollbackTarget.revision) {
    throw new Error('release candidate and rollback target must differ');
  }
  const candidateReleaseDigest = releaseCandidatePairReleaseIdentityDigest(candidate);
  const rollbackTargetReleaseDigest = releaseCandidatePairReleaseIdentityDigest(rollbackTarget);
  if (!candidateReleaseDigest || !rollbackTargetReleaseDigest ||
    !sameDigest(digest(value['candidateReleaseDigest'], 'release candidate digest'), candidateReleaseDigest) ||
    !sameDigest(
      digest(value['rollbackTargetReleaseDigest'], 'release rollback target digest'),
      rollbackTargetReleaseDigest,
    ) || !sameDigest(
      digest(value['previousReleaseDigest'], 'release previous release digest'),
      rollbackTargetReleaseDigest,
    )) {
    throw new Error('release candidate pair release identity digest mismatch');
  }
  const capturedAt = timestamp(value['capturedAt'], 'release candidate pair capturedAt');
  const expiresAt = timestamp(value['expiresAt'], 'release candidate pair expiresAt');
  const lifetime = timestampMs(expiresAt) - timestampMs(capturedAt);
  if (lifetime <= 0 || lifetime > RELEASE_CANDIDATE_PAIR_RECEIPT_MAX_LIFETIME_MS) {
    throw new Error('release candidate pair lifetime is invalid');
  }
  return {
    activationPermitted: false,
    ancestryDeployment: {
      candidateDescendsFromRollback: true,
      candidateOid: revision(ancestry['candidateOid'], 'release candidate pair ancestry candidate'),
      evidenceDigest: digest(ancestry['evidenceDigest'], 'release candidate pair ancestry evidence digest'),
      expiresAt: timestamp(ancestry['expiresAt'], 'release candidate pair ancestry expiresAt'),
      installedReceiptDigest: digest(
        ancestry['installedReceiptDigest'],
        'release candidate pair installed receipt digest',
      ),
      observedAt: timestamp(ancestry['observedAt'], 'release candidate pair ancestry observedAt'),
      rollbackOid: revision(ancestry['rollbackOid'], 'release candidate pair ancestry rollback'),
      rollbackWasPreviouslyActivated: true,
      signerKeyId: ancestry['signerKeyId'],
    },
    authority: RELEASE_CANDIDATE_PAIR_RECEIPT_AUTHORITY,
    candidate,
    candidateReleaseDigest,
    capturedAt,
    deployPermitted: false,
    expiresAt,
    installPermitted: false,
    mergePermitted: false,
    policyEpoch: identifier(value['policyEpoch'], 'release candidate pair policy epoch'),
    predecessorReceiptDigest: digest(
      value['predecessorReceiptDigest'],
      'release candidate pair predecessor receipt digest',
    ),
    previousReleaseDigest: rollbackTargetReleaseDigest,
    protectedHead: {
      candidateOid: revision(protectedHead['candidateOid'], 'release candidate pair protected candidate'),
      evidenceDigest: digest(
        protectedHead['evidenceDigest'],
        'release candidate pair protected-head evidence digest',
      ),
      expiresAt: timestamp(protectedHead['expiresAt'], 'release candidate pair protected-head expiresAt'),
      observedAt: timestamp(protectedHead['observedAt'], 'release candidate pair protected-head observedAt'),
      protectionSnapshotDigest: digest(
        protectedHead['protectionSnapshotDigest'],
        'release candidate pair protection snapshot digest',
      ),
      requiredChecks: requiredChecksFrom(protectedHead['requiredChecks']),
      signerKeyId: protectedHead['signerKeyId'],
    },
    repositoryScope: scopeFrom(value['repositoryScope']),
    rollbackPermitted: false,
    rollbackTarget,
    rollbackTargetReleaseDigest,
    schemaVersion: 1,
    sequence: Number(value['sequence']),
    startPermitted: false,
    trustPolicyDigest: digest(value['trustPolicyDigest'], 'release candidate pair trust policy digest'),
  };
}

function unsignedReceipt(receipt: SignedReleaseCandidatePairReceiptV1): UnsignedReceipt {
  return {
    algorithm: receipt.algorithm,
    domain: receipt.domain,
    keyId: receipt.keyId,
    payload: receipt.payload,
    schemaVersion: receipt.schemaVersion,
  };
}

function receiptSignatureInput(receipt: UnsignedReceipt): Buffer {
  return Buffer.concat([
    Buffer.from(`${RECEIPT_SIGNATURE_DOMAIN}\n`, 'utf8'),
    Buffer.from(canonicalJson(receipt), 'utf8'),
  ]);
}

function receiptFrom(value: unknown): SignedReleaseCandidatePairReceiptV1 {
  if (!isRecord(value) || !exact(value, [
    'algorithm', 'domain', 'keyId', 'payload', 'schemaVersion', 'signature',
  ]) || value['algorithm'] !== 'ed25519' ||
    value['domain'] !== RELEASE_CANDIDATE_PAIR_RECEIPT_DOMAIN_V1 ||
    value['schemaVersion'] !== 1 || typeof value['keyId'] !== 'string' ||
    !KEY_ID_RE.test(value['keyId']) || !decodeSignature(value['signature'])) {
    throw new Error('release candidate pair receipt envelope is invalid');
  }
  return {
    algorithm: 'ed25519',
    domain: RELEASE_CANDIDATE_PAIR_RECEIPT_DOMAIN_V1,
    keyId: value['keyId'],
    payload: payloadFrom(value['payload']),
    schemaVersion: 1,
    signature: value['signature'] as string,
  };
}

function parseReceipt(input: string | Buffer): {
  canonicalJson: string;
  receipt: SignedReleaseCandidatePairReceiptV1;
  receiptDigest: string;
} {
  const parsed = parseCanonical(input, MAX_RECEIPT_BYTES, 'release candidate pair receipt', receiptFrom);
  return {
    canonicalJson: parsed.canonicalJson,
    receipt: parsed.value,
    receiptDigest: domainDigest(RECEIPT_DIGEST_DOMAIN, parsed.canonicalJson),
  };
}

export function parseReleaseCandidatePairReceipt(
  input: string | Buffer,
): ParseReleaseCandidatePairReceiptResult {
  try {
    return { ok: true, ...parseReceipt(input) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function verifyReceiptSignature(receipt: SignedReleaseCandidatePairReceiptV1, keys: KeyObject[]): void {
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_PUBLIC_KEYS) {
    throw new Error('release candidate pair receipt trust keys are unavailable');
  }
  const trusted = new Map<string, KeyObject>();
  for (const key of keys) {
    const keyId = keyIdFor(key);
    if (trusted.has(keyId)) throw new Error('release candidate pair receipt trust keys repeat');
    trusted.set(keyId, key);
  }
  const key = trusted.get(receipt.keyId);
  const signature = decodeSignature(receipt.signature);
  if (!key) throw new Error('release candidate pair receipt signing key is untrusted');
  if (!signature || !cryptoVerify(
    null,
    receiptSignatureInput(unsignedReceipt(receipt)),
    key,
    signature,
  )) throw new Error('release candidate pair receipt signature verification failed');
}

interface VerifiedInputs {
  ancestry: VerifiedEvidence & {
    payload: ReleaseCandidatePairAncestryDeploymentEvidencePayloadV1;
  };
  expected: ReleaseCandidatePairExpectedBindingsV1;
  policy: ReleaseCandidatePairTrustPolicyV1;
  protectedHead: VerifiedEvidence & {
    payload: ReleaseCandidatePairProtectedHeadEvidencePayloadV1;
  };
}

function protectedHeadProjection(
  verified: VerifiedInputs['protectedHead'],
): ReleaseCandidatePairPayloadV1['protectedHead'] {
  return {
    candidateOid: verified.payload.candidateOid,
    evidenceDigest: verified.evidenceDigest,
    expiresAt: verified.payload.expiresAt,
    observedAt: verified.payload.observedAt,
    protectionSnapshotDigest: verified.payload.protectionSnapshotDigest,
    requiredChecks: verified.payload.requiredChecks,
    signerKeyId: verified.evidence.keyId,
  };
}

function ancestryDeploymentProjection(
  verified: VerifiedInputs['ancestry'],
): ReleaseCandidatePairPayloadV1['ancestryDeployment'] {
  return {
    candidateDescendsFromRollback: true,
    candidateOid: verified.payload.candidateOid,
    evidenceDigest: verified.evidenceDigest,
    expiresAt: verified.payload.expiresAt,
    installedReceiptDigest: verified.payload.installedReceiptDigest,
    observedAt: verified.payload.observedAt,
    rollbackOid: verified.payload.rollbackOid,
    rollbackWasPreviouslyActivated: true,
    signerKeyId: verified.evidence.keyId,
  };
}

function verifyInputs(options: {
  ancestryDeploymentEvidence: string | Buffer;
  atMs: number;
  expected: ReleaseCandidatePairExpectedBindingsV1;
  protectedHeadEvidence: string | Buffer;
  trustPolicy: ReleaseCandidatePairTrustPolicyV1;
}): VerifiedInputs {
  const { expected, policy } = validatePolicyBinding(options.trustPolicy, options.expected);
  const protectedHead = verifyExternalEvidence(
    options.protectedHeadEvidence,
    'protected-head',
    policy,
    expected,
    options.atMs,
  );
  const ancestry = verifyExternalEvidence(
    options.ancestryDeploymentEvidence,
    'ancestry-deployment',
    policy,
    expected,
    options.atMs,
  );
  return {
    ancestry: {
      ...ancestry,
      payload: ancestry.evidence.payload as ReleaseCandidatePairAncestryDeploymentEvidencePayloadV1,
    },
    expected,
    policy,
    protectedHead: {
      ...protectedHead,
      payload: protectedHead.evidence.payload as ReleaseCandidatePairProtectedHeadEvidencePayloadV1,
    },
  };
}

function validateEvidenceAgainstRelease(
  candidate: ReleaseCandidatePairReleaseIdentityV1,
  rollback: ReleaseCandidatePairReleaseIdentityV1,
  verified: VerifiedInputs,
  pairExpiresAt: string,
): void {
  if (verified.protectedHead.payload.candidateOid !== candidate.revision ||
    verified.ancestry.payload.candidateOid !== candidate.revision ||
    verified.ancestry.payload.rollbackOid !== rollback.revision) {
    throw new Error('release candidate pair signed evidence OID binding mismatch');
  }
  if (candidate.revision === rollback.revision) {
    throw new Error('release candidate and rollback target must differ');
  }
  if (timestampMs(pairExpiresAt) > timestampMs(verified.protectedHead.payload.expiresAt) ||
    timestampMs(pairExpiresAt) > timestampMs(verified.ancestry.payload.expiresAt)) {
    throw new Error('release candidate pair outlives signed external evidence');
  }
}

function payloadFromVerified(
  options: BuildReleaseCandidatePairReceiptOptions,
  verified: VerifiedInputs,
): ReleaseCandidatePairPayloadV1 {
  const candidate = releaseIdentityFrom(options.candidate, 'release candidate');
  const rollbackTarget = releaseIdentityFrom(options.rollbackTarget, 'release rollback target');
  const candidateReleaseDigest = releaseCandidatePairReleaseIdentityDigest(candidate);
  const rollbackTargetReleaseDigest = releaseCandidatePairReleaseIdentityDigest(rollbackTarget);
  if (!candidateReleaseDigest || !rollbackTargetReleaseDigest) {
    throw new Error('release candidate pair release identity digest is unavailable');
  }
  const capturedAt = timestamp(options.capturedAt, 'release candidate pair capturedAt');
  const expiresAt = timestamp(options.expiresAt, 'release candidate pair expiresAt');
  const lifetime = timestampMs(expiresAt) - timestampMs(capturedAt);
  if (lifetime <= 0 || lifetime > RELEASE_CANDIDATE_PAIR_RECEIPT_MAX_LIFETIME_MS) {
    throw new Error('release candidate pair lifetime is invalid');
  }
  validateTip(options.sequence, options.predecessorReceiptDigest, verified.expected);
  validateEvidenceAgainstRelease(candidate, rollbackTarget, verified, expiresAt);
  return payloadFrom({
    activationPermitted: false,
    ancestryDeployment: ancestryDeploymentProjection(verified.ancestry),
    authority: RELEASE_CANDIDATE_PAIR_RECEIPT_AUTHORITY,
    candidate,
    candidateReleaseDigest,
    capturedAt,
    deployPermitted: false,
    expiresAt,
    installPermitted: false,
    mergePermitted: false,
    policyEpoch: verified.expected.policyEpoch,
    predecessorReceiptDigest: options.predecessorReceiptDigest,
    previousReleaseDigest: rollbackTargetReleaseDigest,
    protectedHead: protectedHeadProjection(verified.protectedHead),
    repositoryScope: verified.expected.repositoryScope,
    rollbackPermitted: false,
    rollbackTarget,
    rollbackTargetReleaseDigest,
    schemaVersion: 1,
    sequence: options.sequence,
    startPermitted: false,
    trustPolicyDigest: verified.expected.trustPolicyDigest,
  });
}

export function buildReleaseCandidatePairReceipt(
  options: BuildReleaseCandidatePairReceiptOptions,
): BuildReleaseCandidatePairReceiptResult {
  try {
    if (options.privateKey.type !== 'private' || options.privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('release candidate pair private key must be Ed25519');
    }
    const capturedAt = timestamp(options.capturedAt, 'release candidate pair capturedAt');
    const verified = verifyInputs({
      ancestryDeploymentEvidence: options.ancestryDeploymentEvidence,
      atMs: timestampMs(capturedAt),
      expected: options.expected,
      protectedHeadEvidence: options.protectedHeadEvidence,
      trustPolicy: options.trustPolicy,
    });
    const payload = payloadFromVerified(options, verified);
    const keyId = keyIdFor(createPublicKey(options.privateKey));
    const unsigned: UnsignedReceipt = {
      algorithm: 'ed25519',
      domain: RELEASE_CANDIDATE_PAIR_RECEIPT_DOMAIN_V1,
      keyId,
      payload,
      schemaVersion: 1,
    };
    const receipt: SignedReleaseCandidatePairReceiptV1 = {
      ...unsigned,
      signature: cryptoSign(null, receiptSignatureInput(unsigned), options.privateKey)
        .toString('base64url'),
    };
    const parsed = parseReceipt(`${canonicalJson(receipt)}\n`);
    return {
      canonicalJson: parsed.canonicalJson,
      keyId,
      ok: true,
      receipt: parsed.receipt,
      receiptDigest: parsed.receiptDigest,
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function verifyReleaseCandidatePairReceipt(
  options: VerifyReleaseCandidatePairReceiptOptions,
): VerifyReleaseCandidatePairReceiptResult {
  try {
    const nowMs = options.now instanceof Date ? options.now.getTime() : options.now ?? Date.now();
    if (!Number.isFinite(nowMs)) throw new Error('release candidate pair verification time is invalid');
    const verified = verifyInputs({
      ancestryDeploymentEvidence: options.ancestryDeploymentEvidence,
      atMs: nowMs,
      expected: options.expected,
      protectedHeadEvidence: options.protectedHeadEvidence,
      trustPolicy: options.trustPolicy,
    });
    const parsed = parseReceipt(options.receipt);
    verifyReceiptSignature(parsed.receipt, options.receiptTrustedPublicKeys);
    const payload = parsed.receipt.payload;
    validateTip(payload.sequence, payload.predecessorReceiptDigest, verified.expected);
    if (nowMs < timestampMs(payload.capturedAt)) {
      throw new Error('release candidate pair receipt is not yet valid');
    }
    if (nowMs >= timestampMs(payload.expiresAt)) {
      throw new Error('release candidate pair receipt is stale');
    }
    validateEvidenceAgainstRelease(payload.candidate, payload.rollbackTarget, verified, payload.expiresAt);
    if (!sameScope(payload.repositoryScope, verified.expected.repositoryScope) ||
      payload.policyEpoch !== verified.expected.policyEpoch ||
      !sameDigest(payload.trustPolicyDigest, verified.expected.trustPolicyDigest) ||
      canonicalJson(payload.protectedHead) !==
        canonicalJson(protectedHeadProjection(verified.protectedHead)) ||
      canonicalJson(payload.ancestryDeployment) !==
        canonicalJson(ancestryDeploymentProjection(verified.ancestry))) {
      throw new Error('release candidate pair receipt conflicts with signed external evidence');
    }
    return {
      authority: RELEASE_CANDIDATE_PAIR_RECEIPT_AUTHORITY,
      candidateReleaseDigest: payload.candidateReleaseDigest,
      expiresAt: payload.expiresAt,
      keyId: parsed.receipt.keyId,
      ok: true,
      predecessorReceiptDigest: payload.predecessorReceiptDigest,
      receiptDigest: parsed.receiptDigest,
      rollbackTargetReleaseDigest: payload.rollbackTargetReleaseDigest,
      sequence: payload.sequence,
      verifiedAtMs: nowMs,
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
