import {
  createHash,
  createPublicKey,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import {
  parseUnsignedRuntimeReleaseManifest,
} from './runtime-release-manifest.js';

export const RUNTIME_RELEASE_EVIDENCE_ENVELOPE_DOMAIN_V1 =
  'ashlr:runtime-release-evidence-envelope:v1' as const;
export const RUNTIME_RELEASE_EVIDENCE_TRUST_ROOT_DOMAIN_V1 =
  'ashlr:runtime-release-evidence-trust-root:v1' as const;
export const RUNTIME_RELEASE_EVIDENCE_SIGNATURE_ALGORITHM_V1 = 'ed25519' as const;
export const RUNTIME_RELEASE_EVIDENCE_MAX_LIFETIME_MS_V1 = 15 * 60 * 1_000;

const SIGNATURE_INPUT_DOMAIN = 'ashlr:runtime-release-evidence-signature-input:v1';
const MANIFEST_CANONICAL_DIGEST_DOMAIN =
  'ashlr:runtime-release-evidence-manifest-canonical-bytes:v1';
const KEY_ID_DOMAIN = 'ashlr:runtime-release-evidence-key-id:v1';
const MAX_ENVELOPE_BYTES = 16 * 1_024;
const MAX_TRUST_ROOT_BYTES = 64 * 1_024;
const MAX_TRUST_KEYS = 32;
const MAX_PUBLIC_KEY_BYTES = 512;
const ED25519_SIGNATURE_BYTES = 64;
const SHA256_RE = /^[a-f0-9]{64}$/;
const REVISION_RE = /^[a-f0-9]{40}$/;
const KEY_ID_RE = /^ed25519-sha256:[a-f0-9]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface RuntimeReleaseEvidenceCoverageV1 {
  artifactCoherence: 'two-complete-scans';
  artifactSet: 'package-manifest-lockfile-launcher-dist-verifier';
  authenticity: 'envelope-signer-only';
  authority: 'observation-only';
  configuration: 'excluded';
  installedDependencies: 'lockfile-only';
  interpreter: 'caller-declared-artifact-observed';
  rollback: 'unresolved-caller-declared-reference';
  serviceInvocation: 'unbound';
}

export const RUNTIME_RELEASE_EVIDENCE_REQUIRED_COVERAGE_V1:
Readonly<RuntimeReleaseEvidenceCoverageV1> = Object.freeze({
  artifactCoherence: 'two-complete-scans',
  artifactSet: 'package-manifest-lockfile-launcher-dist-verifier',
  authenticity: 'envelope-signer-only',
  authority: 'observation-only',
  configuration: 'excluded',
  installedDependencies: 'lockfile-only',
  interpreter: 'caller-declared-artifact-observed',
  rollback: 'unresolved-caller-declared-reference',
  serviceInvocation: 'unbound',
});

export interface RuntimeReleaseEvidencePayloadV1 {
  assurance: 'signed-observation-only';
  coverage: RuntimeReleaseEvidenceCoverageV1;
  expiresAt: string;
  expectedRevision: string;
  issuedAt: string;
  manifestCanonicalSha256: string;
  manifestDigest: string;
  schemaVersion: 1;
}

export interface SignedRuntimeReleaseEvidenceEnvelopeV1 {
  algorithm: typeof RUNTIME_RELEASE_EVIDENCE_SIGNATURE_ALGORITHM_V1;
  domain: typeof RUNTIME_RELEASE_EVIDENCE_ENVELOPE_DOMAIN_V1;
  keyId: string;
  payload: RuntimeReleaseEvidencePayloadV1;
  schemaVersion: 1;
  signature: string;
}

export interface RuntimeReleaseEvidenceTrustKeyV1 {
  algorithm: typeof RUNTIME_RELEASE_EVIDENCE_SIGNATURE_ALGORITHM_V1;
  keyId: string;
  publicKeySpki: string;
  validFrom: string;
  validUntil: string;
}

export interface RuntimeReleaseEvidenceTrustRootV1 {
  assurance: 'caller-provided-public-key-trust-root';
  domain: typeof RUNTIME_RELEASE_EVIDENCE_TRUST_ROOT_DOMAIN_V1;
  keys: RuntimeReleaseEvidenceTrustKeyV1[];
  requiredCoverage: RuntimeReleaseEvidenceCoverageV1;
  schemaVersion: 1;
}

export interface BuildRuntimeReleaseEvidenceTrustRootOptions {
  keys: Array<{
    publicKey: KeyObject;
    validFrom: string;
    validUntil: string;
  }>;
}

export type BuildRuntimeReleaseEvidenceTrustRootResult =
  | {
    ok: true;
    trustRoot: RuntimeReleaseEvidenceTrustRootV1;
    canonicalJson: string;
  }
  | { ok: false; reason: string };

export interface SignRuntimeReleaseEvidenceEnvelopeOptions {
  expiresAt: string;
  issuedAt: string;
  manifest: string | Buffer;
  privateKey: KeyObject;
}

export type SignRuntimeReleaseEvidenceEnvelopeResult =
  | {
    ok: true;
    envelope: SignedRuntimeReleaseEvidenceEnvelopeV1;
    canonicalJson: string;
    keyId: string;
  }
  | { ok: false; reason: string };

export type ParseRuntimeReleaseEvidenceEnvelopeResult =
  | {
    ok: true;
    envelope: SignedRuntimeReleaseEvidenceEnvelopeV1;
    canonicalJson: string;
  }
  | { ok: false; reason: string };

export type ParseRuntimeReleaseEvidenceTrustRootResult =
  | {
    ok: true;
    trustRoot: RuntimeReleaseEvidenceTrustRootV1;
    canonicalJson: string;
  }
  | { ok: false; reason: string };

export interface VerifyRuntimeReleaseEvidenceEnvelopeOptions {
  envelope: string | Buffer;
  manifest: string | Buffer;
  trustRoot: string | Buffer;
}

export type VerifyRuntimeReleaseEvidenceEnvelopeResult =
  | {
    ok: true;
    assurance: 'signed-observation-only';
    expiresAt: string;
    issuedAt: string;
    keyId: string;
    manifestDigest: string;
    expectedRevision: string;
    rollbackTargetManifestDigest: string | null;
    verifiedAtMs: number;
  }
  | { ok: false; reason: string };

type UnsignedEnvelope = Omit<SignedRuntimeReleaseEvidenceEnvelopeV1, 'signature'>;

function canonicalize(value: unknown, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite JSON number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new TypeError('invalid JSON value');
  }
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
    for (const key of Object.keys(value as Record<string, unknown>)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)) {
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function parseCanonicalJson(
  input: string | Buffer,
  maxBytes: number,
  label: string,
): { value: unknown; canonicalJson: string } {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  if (bytes.length === 0 || bytes.length > maxBytes) {
    throw new Error(`${label} byte length is invalid`);
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error(`${label} is not valid UTF-8`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  const encoded = `${canonicalJson(value)}\n`;
  if (text !== encoded) throw new Error(`${label} encoding is not canonical`);
  return { value, canonicalJson: encoded };
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length !== 24) {
    throw new Error(`${label} is invalid`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function timestampMs(value: string): number {
  return Date.parse(value);
}

function validateLifetime(issuedAt: string, expiresAt: string, label: string): void {
  const lifetime = timestampMs(expiresAt) - timestampMs(issuedAt);
  if (lifetime <= 0 || lifetime > RUNTIME_RELEASE_EVIDENCE_MAX_LIFETIME_MS_V1) {
    throw new Error(`${label} lifetime is invalid`);
  }
}

function coverageFrom(value: unknown, label: string): RuntimeReleaseEvidenceCoverageV1 {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'artifactCoherence',
    'artifactSet',
    'authenticity',
    'authority',
    'configuration',
    'installedDependencies',
    'interpreter',
    'rollback',
    'serviceInvocation',
  ]) ||
    value['artifactCoherence'] !== 'two-complete-scans' ||
    value['artifactSet'] !== 'package-manifest-lockfile-launcher-dist-verifier' ||
    value['authenticity'] !== 'envelope-signer-only' ||
    value['authority'] !== 'observation-only' ||
    value['configuration'] !== 'excluded' ||
    value['installedDependencies'] !== 'lockfile-only' ||
    value['interpreter'] !== 'caller-declared-artifact-observed' ||
    value['rollback'] !== 'unresolved-caller-declared-reference' ||
    value['serviceInvocation'] !== 'unbound') {
    throw new Error(`${label} is incomplete or unsupported`);
  }
  return { ...RUNTIME_RELEASE_EVIDENCE_REQUIRED_COVERAGE_V1 };
}

function decodeBase64url(value: unknown, expectedBytes?: number): Buffer | null {
  if (typeof value !== 'string' || !BASE64URL_RE.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length === 0 || bytes.length > MAX_PUBLIC_KEY_BYTES ||
    (expectedBytes !== undefined && bytes.length !== expectedBytes) ||
    bytes.toString('base64url') !== value) {
    return null;
  }
  return bytes;
}

function publicKeyDer(publicKey: KeyObject): Buffer {
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('runtime release evidence public key must be Ed25519');
  }
  const exported = publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(exported) || exported.length === 0 ||
    exported.length > MAX_PUBLIC_KEY_BYTES) {
    throw new Error('runtime release evidence public key encoding is invalid');
  }
  return exported;
}

function keyIdForDer(der: Buffer): string {
  return `ed25519-sha256:${createHash('sha256')
    .update(KEY_ID_DOMAIN, 'utf8')
    .update('\n', 'utf8')
    .update(der)
    .digest('hex')}`;
}

export function runtimeReleaseEvidenceKeyId(publicKey: KeyObject): string | null {
  try {
    return keyIdForDer(publicKeyDer(publicKey));
  } catch {
    return null;
  }
}

function trustKeyFrom(
  value: unknown,
  previousKeyId: string | null,
): { key: RuntimeReleaseEvidenceTrustKeyV1; publicKey: KeyObject } {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'algorithm',
    'keyId',
    'publicKeySpki',
    'validFrom',
    'validUntil',
  ])) {
    throw new Error('runtime release evidence trust key shape is invalid');
  }
  if (value['algorithm'] !== RUNTIME_RELEASE_EVIDENCE_SIGNATURE_ALGORITHM_V1) {
    throw new Error('runtime release evidence trust key algorithm is unsupported');
  }
  if (typeof value['keyId'] !== 'string' || !KEY_ID_RE.test(value['keyId'])) {
    throw new Error('runtime release evidence trust key id is invalid');
  }
  if (previousKeyId !== null && value['keyId'] <= previousKeyId) {
    throw new Error('runtime release evidence trust keys must be unique and sorted');
  }
  const der = decodeBase64url(value['publicKeySpki']);
  if (!der) throw new Error('runtime release evidence public key encoding is invalid');
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    throw new Error('runtime release evidence public key is invalid');
  }
  const normalizedDer = publicKeyDer(publicKey);
  if (!normalizedDer.equals(der) || keyIdForDer(der) !== value['keyId']) {
    throw new Error('runtime release evidence trust key id does not match public key');
  }
  const validFrom = canonicalTimestamp(
    value['validFrom'],
    'runtime release evidence trust key validFrom',
  );
  const validUntil = canonicalTimestamp(
    value['validUntil'],
    'runtime release evidence trust key validUntil',
  );
  if (timestampMs(validUntil) <= timestampMs(validFrom)) {
    throw new Error('runtime release evidence trust key validity is invalid');
  }
  return {
    key: {
      algorithm: RUNTIME_RELEASE_EVIDENCE_SIGNATURE_ALGORITHM_V1,
      keyId: value['keyId'],
      publicKeySpki: value['publicKeySpki'] as string,
      validFrom,
      validUntil,
    },
    publicKey,
  };
}

function validateTrustRoot(
  value: unknown,
): {
  trustRoot: RuntimeReleaseEvidenceTrustRootV1;
  publicKeys: Map<string, KeyObject>;
} {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'assurance',
    'domain',
    'keys',
    'requiredCoverage',
    'schemaVersion',
  ])) {
    throw new Error('runtime release evidence trust root shape is invalid');
  }
  if (value['schemaVersion'] !== 1) {
    throw new Error('runtime release evidence trust root schema is unsupported');
  }
  if (value['domain'] !== RUNTIME_RELEASE_EVIDENCE_TRUST_ROOT_DOMAIN_V1) {
    throw new Error('runtime release evidence trust root domain is unsupported');
  }
  if (value['assurance'] !== 'caller-provided-public-key-trust-root') {
    throw new Error('runtime release evidence trust root assurance is unsupported');
  }
  const keysValue = value['keys'];
  if (!Array.isArray(keysValue) || keysValue.length === 0 ||
    keysValue.length > MAX_TRUST_KEYS) {
    throw new Error('runtime release evidence trust key count is invalid');
  }
  const keys: RuntimeReleaseEvidenceTrustKeyV1[] = [];
  const publicKeys = new Map<string, KeyObject>();
  let previousKeyId: string | null = null;
  for (const entry of keysValue) {
    const parsed = trustKeyFrom(entry, previousKeyId);
    keys.push(parsed.key);
    publicKeys.set(parsed.key.keyId, parsed.publicKey);
    previousKeyId = parsed.key.keyId;
  }
  return {
    trustRoot: {
      assurance: 'caller-provided-public-key-trust-root',
      domain: RUNTIME_RELEASE_EVIDENCE_TRUST_ROOT_DOMAIN_V1,
      keys,
      requiredCoverage: coverageFrom(
        value['requiredCoverage'],
        'runtime release evidence required coverage',
      ),
      schemaVersion: 1,
    },
    publicKeys,
  };
}

function validateEnvelope(value: unknown): SignedRuntimeReleaseEvidenceEnvelopeV1 {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'algorithm',
    'domain',
    'keyId',
    'payload',
    'schemaVersion',
    'signature',
  ])) {
    throw new Error('runtime release evidence envelope shape is invalid');
  }
  if (value['schemaVersion'] !== 1) {
    throw new Error('runtime release evidence envelope schema is unsupported');
  }
  if (value['domain'] !== RUNTIME_RELEASE_EVIDENCE_ENVELOPE_DOMAIN_V1) {
    throw new Error('runtime release evidence envelope domain is unsupported');
  }
  if (value['algorithm'] !== RUNTIME_RELEASE_EVIDENCE_SIGNATURE_ALGORITHM_V1) {
    throw new Error('runtime release evidence envelope algorithm is unsupported');
  }
  if (typeof value['keyId'] !== 'string' || !KEY_ID_RE.test(value['keyId'])) {
    throw new Error('runtime release evidence envelope key id is invalid');
  }
  const signature = decodeBase64url(value['signature'], ED25519_SIGNATURE_BYTES);
  if (!signature) throw new Error('runtime release evidence signature is invalid');

  const payload = value['payload'];
  if (!isPlainRecord(payload) || !hasExactKeys(payload, [
    'assurance',
    'coverage',
    'expiresAt',
    'expectedRevision',
    'issuedAt',
    'manifestCanonicalSha256',
    'manifestDigest',
    'schemaVersion',
  ])) {
    throw new Error('runtime release evidence payload shape is invalid');
  }
  if (payload['schemaVersion'] !== 1 ||
    payload['assurance'] !== 'signed-observation-only') {
    throw new Error('runtime release evidence payload schema is unsupported');
  }
  if (typeof payload['expectedRevision'] !== 'string' ||
    !REVISION_RE.test(payload['expectedRevision'])) {
    throw new Error('runtime release evidence expected revision is invalid');
  }
  if (typeof payload['manifestDigest'] !== 'string' ||
    !SHA256_RE.test(payload['manifestDigest']) ||
    typeof payload['manifestCanonicalSha256'] !== 'string' ||
    !SHA256_RE.test(payload['manifestCanonicalSha256'])) {
    throw new Error('runtime release evidence manifest identity is invalid');
  }
  const issuedAt = canonicalTimestamp(
    payload['issuedAt'],
    'runtime release evidence issuedAt',
  );
  const expiresAt = canonicalTimestamp(
    payload['expiresAt'],
    'runtime release evidence expiresAt',
  );
  validateLifetime(issuedAt, expiresAt, 'runtime release evidence');
  return {
    algorithm: RUNTIME_RELEASE_EVIDENCE_SIGNATURE_ALGORITHM_V1,
    domain: RUNTIME_RELEASE_EVIDENCE_ENVELOPE_DOMAIN_V1,
    keyId: value['keyId'],
    payload: {
      assurance: 'signed-observation-only',
      coverage: coverageFrom(
        payload['coverage'],
        'runtime release evidence coverage',
      ),
      expiresAt,
      expectedRevision: payload['expectedRevision'],
      issuedAt,
      manifestCanonicalSha256: payload['manifestCanonicalSha256'],
      manifestDigest: payload['manifestDigest'],
      schemaVersion: 1,
    },
    schemaVersion: 1,
    signature: value['signature'] as string,
  };
}

function unsignedEnvelope(envelope: SignedRuntimeReleaseEvidenceEnvelopeV1): UnsignedEnvelope {
  const { signature: _signature, ...unsigned } = envelope;
  return unsigned;
}

function signatureInput(envelope: UnsignedEnvelope): Buffer {
  return Buffer.concat([
    Buffer.from(`${SIGNATURE_INPUT_DOMAIN}\n`, 'utf8'),
    Buffer.from(canonicalJson(envelope), 'utf8'),
  ]);
}

function manifestCanonicalSha256(canonicalManifest: string): string {
  return createHash('sha256')
    .update(MANIFEST_CANONICAL_DIGEST_DOMAIN, 'utf8')
    .update('\n', 'utf8')
    .update(canonicalManifest, 'utf8')
    .digest('hex');
}

function equalHexDigest(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function buildRuntimeReleaseEvidenceTrustRoot(
  options: BuildRuntimeReleaseEvidenceTrustRootOptions,
): BuildRuntimeReleaseEvidenceTrustRootResult {
  try {
    if (!Array.isArray(options.keys) || options.keys.length === 0 ||
      options.keys.length > MAX_TRUST_KEYS) {
      return { ok: false, reason: 'runtime release evidence trust key count is invalid' };
    }
    const keys = options.keys.map((entry): RuntimeReleaseEvidenceTrustKeyV1 => {
      const der = publicKeyDer(entry.publicKey);
      const validFrom = canonicalTimestamp(
        entry.validFrom,
        'runtime release evidence trust key validFrom',
      );
      const validUntil = canonicalTimestamp(
        entry.validUntil,
        'runtime release evidence trust key validUntil',
      );
      if (timestampMs(validUntil) <= timestampMs(validFrom)) {
        throw new Error('runtime release evidence trust key validity is invalid');
      }
      return {
        algorithm: RUNTIME_RELEASE_EVIDENCE_SIGNATURE_ALGORITHM_V1,
        keyId: keyIdForDer(der),
        publicKeySpki: der.toString('base64url'),
        validFrom,
        validUntil,
      };
    }).sort((left, right) => left.keyId < right.keyId ? -1 : left.keyId > right.keyId ? 1 : 0);
    if (keys.some((entry, index) => index > 0 && entry.keyId === keys[index - 1]!.keyId)) {
      return { ok: false, reason: 'runtime release evidence trust keys must be unique' };
    }
    const trustRoot: RuntimeReleaseEvidenceTrustRootV1 = {
      assurance: 'caller-provided-public-key-trust-root',
      domain: RUNTIME_RELEASE_EVIDENCE_TRUST_ROOT_DOMAIN_V1,
      keys,
      requiredCoverage: { ...RUNTIME_RELEASE_EVIDENCE_REQUIRED_COVERAGE_V1 },
      schemaVersion: 1,
    };
    const encoded = `${canonicalJson(trustRoot)}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > MAX_TRUST_ROOT_BYTES) {
      return { ok: false, reason: 'runtime release evidence trust root exceeds byte limit' };
    }
    return { ok: true, trustRoot, canonicalJson: encoded };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function parseRuntimeReleaseEvidenceTrustRoot(
  input: string | Buffer,
): ParseRuntimeReleaseEvidenceTrustRootResult {
  try {
    const parsed = parseCanonicalJson(
      input,
      MAX_TRUST_ROOT_BYTES,
      'runtime release evidence trust root',
    );
    const { trustRoot } = validateTrustRoot(parsed.value);
    return { ok: true, trustRoot, canonicalJson: parsed.canonicalJson };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function signRuntimeReleaseEvidenceEnvelope(
  options: SignRuntimeReleaseEvidenceEnvelopeOptions,
): SignRuntimeReleaseEvidenceEnvelopeResult {
  try {
    if (options.privateKey.type !== 'private' ||
      options.privateKey.asymmetricKeyType !== 'ed25519') {
      return { ok: false, reason: 'runtime release evidence private key must be Ed25519' };
    }
    const manifest = parseUnsignedRuntimeReleaseManifest(options.manifest);
    if (!manifest.ok) return manifest;
    const issuedAt = canonicalTimestamp(options.issuedAt, 'runtime release evidence issuedAt');
    const expiresAt = canonicalTimestamp(options.expiresAt, 'runtime release evidence expiresAt');
    validateLifetime(issuedAt, expiresAt, 'runtime release evidence');
    const publicKey = createPublicKey(options.privateKey);
    const keyId = keyIdForDer(publicKeyDer(publicKey));
    const unsigned: UnsignedEnvelope = {
      algorithm: RUNTIME_RELEASE_EVIDENCE_SIGNATURE_ALGORITHM_V1,
      domain: RUNTIME_RELEASE_EVIDENCE_ENVELOPE_DOMAIN_V1,
      keyId,
      payload: {
        assurance: 'signed-observation-only',
        coverage: { ...RUNTIME_RELEASE_EVIDENCE_REQUIRED_COVERAGE_V1 },
        expiresAt,
        expectedRevision: manifest.manifest.expectedRevision,
        issuedAt,
        manifestCanonicalSha256: manifestCanonicalSha256(manifest.canonicalJson),
        manifestDigest: manifest.manifest.manifestDigest,
        schemaVersion: 1,
      },
      schemaVersion: 1,
    };
    const signature = cryptoSign(null, signatureInput(unsigned), options.privateKey);
    if (signature.length !== ED25519_SIGNATURE_BYTES) {
      return { ok: false, reason: 'runtime release evidence signature length is invalid' };
    }
    const envelope: SignedRuntimeReleaseEvidenceEnvelopeV1 = {
      ...unsigned,
      signature: signature.toString('base64url'),
    };
    const encoded = `${canonicalJson(envelope)}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > MAX_ENVELOPE_BYTES) {
      return { ok: false, reason: 'runtime release evidence envelope exceeds byte limit' };
    }
    return { ok: true, envelope, canonicalJson: encoded, keyId };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function parseRuntimeReleaseEvidenceEnvelope(
  input: string | Buffer,
): ParseRuntimeReleaseEvidenceEnvelopeResult {
  try {
    const parsed = parseCanonicalJson(
      input,
      MAX_ENVELOPE_BYTES,
      'runtime release evidence envelope',
    );
    const envelope = validateEnvelope(parsed.value);
    return { ok: true, envelope, canonicalJson: parsed.canonicalJson };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function verifyRuntimeReleaseEvidenceEnvelope(
  options: VerifyRuntimeReleaseEvidenceEnvelopeOptions,
): VerifyRuntimeReleaseEvidenceEnvelopeResult {
  try {
    const manifest = parseUnsignedRuntimeReleaseManifest(options.manifest);
    if (!manifest.ok) return manifest;
    const envelope = parseRuntimeReleaseEvidenceEnvelope(options.envelope);
    if (!envelope.ok) return envelope;
    const parsedTrustRoot = parseCanonicalJson(
      options.trustRoot,
      MAX_TRUST_ROOT_BYTES,
      'runtime release evidence trust root',
    );
    const { trustRoot, publicKeys } = validateTrustRoot(parsedTrustRoot.value);
    const nowMs = Date.now();
    if (!Number.isFinite(nowMs) || !Number.isSafeInteger(nowMs)) {
      return { ok: false, reason: 'runtime release evidence trusted clock is invalid' };
    }

    const key = trustRoot.keys.find((candidate) =>
      candidate.keyId === envelope.envelope.keyId);
    if (!key) return { ok: false, reason: 'runtime release evidence signing key is unknown' };
    if (key.algorithm !== envelope.envelope.algorithm) {
      return { ok: false, reason: 'runtime release evidence key algorithm mismatch' };
    }
    const publicKey = publicKeys.get(key.keyId);
    if (!publicKey) {
      return { ok: false, reason: 'runtime release evidence signing key is unavailable' };
    }
    const signature = decodeBase64url(
      envelope.envelope.signature,
      ED25519_SIGNATURE_BYTES,
    );
    if (!signature || !cryptoVerify(
      null,
      signatureInput(unsignedEnvelope(envelope.envelope)),
      publicKey,
      signature,
    )) {
      return { ok: false, reason: 'runtime release evidence signature verification failed' };
    }
    if (timestampMs(envelope.envelope.payload.issuedAt) < timestampMs(key.validFrom) ||
      timestampMs(envelope.envelope.payload.expiresAt) > timestampMs(key.validUntil)) {
      return {
        ok: false,
        reason: 'runtime release evidence falls outside signing key validity',
      };
    }
    if (canonicalJson(envelope.envelope.payload.coverage) !==
      canonicalJson(trustRoot.requiredCoverage)) {
      return { ok: false, reason: 'runtime release evidence does not meet required coverage' };
    }
    if (!equalHexDigest(
      envelope.envelope.payload.manifestDigest,
      manifest.manifest.manifestDigest,
    )) {
      return { ok: false, reason: 'runtime release evidence manifest digest mismatch' };
    }
    if (!equalHexDigest(
      envelope.envelope.payload.manifestCanonicalSha256,
      manifestCanonicalSha256(manifest.canonicalJson),
    )) {
      return {
        ok: false,
        reason: 'runtime release evidence canonical manifest digest mismatch',
      };
    }
    if (envelope.envelope.payload.expectedRevision !== manifest.manifest.expectedRevision) {
      return { ok: false, reason: 'runtime release evidence expected revision mismatch' };
    }
    if (nowMs < timestampMs(envelope.envelope.payload.issuedAt)) {
      return { ok: false, reason: 'runtime release evidence is not yet valid' };
    }
    if (nowMs >= timestampMs(envelope.envelope.payload.expiresAt)) {
      return { ok: false, reason: 'runtime release evidence is stale' };
    }
    return {
      ok: true,
      assurance: 'signed-observation-only',
      expiresAt: envelope.envelope.payload.expiresAt,
      issuedAt: envelope.envelope.payload.issuedAt,
      keyId: envelope.envelope.keyId,
      manifestDigest: envelope.envelope.payload.manifestDigest,
      expectedRevision: envelope.envelope.payload.expectedRevision,
      rollbackTargetManifestDigest:
        manifest.manifest.rollbackDeclaration.targetManifestDigest,
      verifiedAtMs: nowMs,
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
