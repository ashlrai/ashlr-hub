/**
 * M568 version-general stopped-selection permit protocol.
 *
 * This module is deliberately pure. It authenticates canonical intent and
 * exact release bindings, but it cannot consume replay state, mutate a pointer
 * or plist, contact launchd, or grant selection/rollback authority. Those
 * effects require a separately installed protected native broker.
 */

import {
  createHash,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';
import { posix } from 'node:path';

import { canonicalizeDaemonActivationValue } from './activation-permit.js';

export const RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_PROTOCOL =
  'runtime-activation-stopped-consumer-v2' as const;
export const RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_PERMIT_DOMAIN =
  'ashlr:runtime-activation-stopped-consumer:permit:v2' as const;

const PERMIT_SIGNATURE_DOMAIN = `${RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_PERMIT_DOMAIN}\0`;
const MAX_PERMIT_FRAME_BYTES = 64 * 1024;
const MAX_PERMIT_VALIDITY_MS = 120_000;
const MAX_FUTURE_SKEW_MS = 30_000;
const MAX_PATH_BYTES = 2_048;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const SHA1_RE = /^[a-f0-9]{40}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const PACKAGE_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;

export const RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_AUTHORITY = Object.freeze({
  activationPermitted: false,
  deployPermitted: false,
  dispatchPermitted: false,
  effectPermitted: false,
  installPermitted: false,
  launchPermitted: false,
  pointerMutationPermitted: false,
  rollbackPermitted: false,
  selectionPermitted: false,
  serviceMutationPermitted: false,
  startPermitted: false,
} as const);

export interface RuntimeActivationStoppedConsumerV2TrustRoot {
  algorithm: 'ed25519';
  keyId: string;
  publicKeySpki: string;
  validFrom: string;
  validUntil: string;
}

export interface RuntimeActivationStoppedConsumerV2Bindings {
  activationId: string;
  admissionDigest: string;
  planDigest: string;
  canonicalRequestSha256: string;
  trustRootCanonicalSha256: string;
  configSha256: string;
  homePath: string;
  releasesRoot: string;
  currentPointerPath: string;
  plistPath: string;
  candidateRevision: string;
  candidateExpectedTree: string;
  candidateVersion: string;
  candidateReleaseTag: string;
  candidateRuntimeTreeSha256: string;
  candidateManifestDigest: string;
  candidateLaunchReceiptSha256: string;
  candidateServiceDescriptorSha256: string;
  candidateServiceInvocationDigest: string;
  candidateCurrentTarget: string;
  rollbackRevision: string;
  rollbackExpectedTree: string;
  rollbackVersion: string;
  rollbackReleaseTag: string;
  rollbackRuntimeTreeSha256: string;
  rollbackManifestDigest: string;
  rollbackLaunchReceiptSha256: string;
  rollbackServiceDescriptorSha256: string;
  rollbackServiceInvocationDigest: string;
  priorCurrentTarget: string;
  priorPlistSha256: string;
  priorServiceLoaded: false;
  priorServiceDisabled: boolean;
  hostUid: number;
  serviceLabel: 'ai.ashlr.daemon';
  serviceTarget: string;
}

export interface RuntimeActivationStoppedConsumerV2PermitPayload {
  schemaVersion: 2;
  protocol: typeof RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_PROTOCOL;
  permitId: string;
  keyId: string;
  issuedAt: string;
  expiresAt: string;
  scope: {
    action: 'select-exact-admitted-stopped-release';
    platform: 'darwin';
    nativeBrokerRequired: true;
    nativeConditionalCasRequired: true;
    maintenance: true;
    killSwitch: 'healthy-engaged';
    providerEffectsBlocked: true;
    serviceLoaded: false;
    serviceStart: false;
    serviceEnable: false;
    serviceInstall: false;
    pointerSelectionRequested: true;
    exactStoppedRollbackRequired: true;
    residentAcknowledgement: false;
    dispatchAuthorized: false;
  };
  bindings: RuntimeActivationStoppedConsumerV2Bindings;
}

export interface RuntimeActivationStoppedConsumerV2PermitEnvelope {
  payload: RuntimeActivationStoppedConsumerV2PermitPayload;
  signature: string;
}

export interface RuntimeActivationStoppedConsumerV2EvidenceResult {
  ok: boolean;
  reason: string;
  authority: typeof RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_AUTHORITY;
  permitDigest: string | null;
}

const BINDING_KEYS = [
  'activationId',
  'admissionDigest',
  'planDigest',
  'canonicalRequestSha256',
  'trustRootCanonicalSha256',
  'configSha256',
  'homePath',
  'releasesRoot',
  'currentPointerPath',
  'plistPath',
  'candidateRevision',
  'candidateExpectedTree',
  'candidateVersion',
  'candidateReleaseTag',
  'candidateRuntimeTreeSha256',
  'candidateManifestDigest',
  'candidateLaunchReceiptSha256',
  'candidateServiceDescriptorSha256',
  'candidateServiceInvocationDigest',
  'candidateCurrentTarget',
  'rollbackRevision',
  'rollbackExpectedTree',
  'rollbackVersion',
  'rollbackReleaseTag',
  'rollbackRuntimeTreeSha256',
  'rollbackManifestDigest',
  'rollbackLaunchReceiptSha256',
  'rollbackServiceDescriptorSha256',
  'rollbackServiceInvocationDigest',
  'priorCurrentTarget',
  'priorPlistSha256',
  'priorServiceLoaded',
  'priorServiceDisabled',
  'hostUid',
  'serviceLabel',
  'serviceTarget',
] as const;

function dataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  let prototype: object | null;
  let descriptors: Record<string, PropertyDescriptor>;
  let keys: PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (keys.some((key) => typeof key !== 'string')) return null;
  const actual = (keys as string[]).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return null;
  for (const key of actual) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return null;
  }
  return value as Record<string, unknown>;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function sameDigest(left: string, right: string): boolean {
  return SHA256_RE.test(left) && SHA256_RE.test(right)
    && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function canonicalBase64url(value: unknown, bytes?: number): Buffer | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length > 0
      && (bytes === undefined || decoded.length === bytes)
      && decoded.toString('base64url') === value
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function boundedAbsolutePath(value: unknown): value is string {
  return typeof value === 'string'
    && posix.isAbsolute(value)
    && posix.resolve(value) === value
    && !value.includes('\0')
    && Buffer.byteLength(value, 'utf8') <= MAX_PATH_BYTES;
}

function parseBindings(value: unknown): RuntimeActivationStoppedConsumerV2Bindings | null {
  const record = dataRecord(value, BINDING_KEYS);
  if (!record) return null;
  const digestFields = [
    record['admissionDigest'],
    record['planDigest'],
    record['canonicalRequestSha256'],
    record['trustRootCanonicalSha256'],
    record['configSha256'],
    record['candidateRuntimeTreeSha256'],
    record['candidateManifestDigest'],
    record['candidateLaunchReceiptSha256'],
    record['candidateServiceDescriptorSha256'],
    record['candidateServiceInvocationDigest'],
    record['rollbackRuntimeTreeSha256'],
    record['rollbackManifestDigest'],
    record['rollbackLaunchReceiptSha256'],
    record['rollbackServiceDescriptorSha256'],
    record['rollbackServiceInvocationDigest'],
    record['priorPlistSha256'],
  ];
  if (!digestFields.every((entry) => typeof entry === 'string' && SHA256_RE.test(entry))) return null;
  if (typeof record['activationId'] !== 'string' || !UUID_RE.test(record['activationId'])
    || typeof record['candidateRevision'] !== 'string' || !SHA1_RE.test(record['candidateRevision'])
    || typeof record['candidateExpectedTree'] !== 'string' || !SHA1_RE.test(record['candidateExpectedTree'])
    || typeof record['rollbackRevision'] !== 'string' || !SHA1_RE.test(record['rollbackRevision'])
    || typeof record['rollbackExpectedTree'] !== 'string' || !SHA1_RE.test(record['rollbackExpectedTree'])
    || record['candidateRevision'] === record['rollbackRevision']
    || record['candidateExpectedTree'] === record['rollbackExpectedTree']
    || typeof record['candidateVersion'] !== 'string' || !PACKAGE_VERSION_RE.test(record['candidateVersion'])
    || typeof record['rollbackVersion'] !== 'string' || !PACKAGE_VERSION_RE.test(record['rollbackVersion'])
    || record['candidateReleaseTag'] !== `v${record['candidateVersion']}`
    || record['rollbackReleaseTag'] !== `v${record['rollbackVersion']}`
    || record['candidateCurrentTarget'] !== `releases/${record['candidateRevision']}`
    || record['priorCurrentTarget'] !== `releases/${record['rollbackRevision']}`
    || !boundedAbsolutePath(record['homePath'])
    || !boundedAbsolutePath(record['releasesRoot'])
    || !boundedAbsolutePath(record['currentPointerPath'])
    || !boundedAbsolutePath(record['plistPath'])
    || record['homePath'] === '/'
    || record['releasesRoot'] !== `${record['homePath']}/.local/share/ashlr/releases`
    || record['currentPointerPath'] !== `${record['homePath']}/.local/share/ashlr/current`
    || record['plistPath'] !== `${record['homePath']}/Library/LaunchAgents/ai.ashlr.daemon.plist`
    || record['priorServiceLoaded'] !== false
    || typeof record['priorServiceDisabled'] !== 'boolean'
    || !Number.isSafeInteger(record['hostUid'])
    || Number(record['hostUid']) < 0
    || Number(record['hostUid']) > 0xffff_ffff
    || record['serviceLabel'] !== 'ai.ashlr.daemon'
    || record['serviceTarget'] !== `gui/${record['hostUid']}/ai.ashlr.daemon`) return null;
  return record as unknown as RuntimeActivationStoppedConsumerV2Bindings;
}

function parseScope(value: unknown): RuntimeActivationStoppedConsumerV2PermitPayload['scope'] | null {
  const record = dataRecord(value, [
    'action',
    'platform',
    'nativeBrokerRequired',
    'nativeConditionalCasRequired',
    'maintenance',
    'killSwitch',
    'providerEffectsBlocked',
    'serviceLoaded',
    'serviceStart',
    'serviceEnable',
    'serviceInstall',
    'pointerSelectionRequested',
    'exactStoppedRollbackRequired',
    'residentAcknowledgement',
    'dispatchAuthorized',
  ]);
  if (!record
    || record['action'] !== 'select-exact-admitted-stopped-release'
    || record['platform'] !== 'darwin'
    || record['nativeBrokerRequired'] !== true
    || record['nativeConditionalCasRequired'] !== true
    || record['maintenance'] !== true
    || record['killSwitch'] !== 'healthy-engaged'
    || record['providerEffectsBlocked'] !== true
    || record['serviceLoaded'] !== false
    || record['serviceStart'] !== false
    || record['serviceEnable'] !== false
    || record['serviceInstall'] !== false
    || record['pointerSelectionRequested'] !== true
    || record['exactStoppedRollbackRequired'] !== true
    || record['residentAcknowledgement'] !== false
    || record['dispatchAuthorized'] !== false) return null;
  return record as unknown as RuntimeActivationStoppedConsumerV2PermitPayload['scope'];
}

function parsePermitPayload(value: unknown): RuntimeActivationStoppedConsumerV2PermitPayload | null {
  const payload = dataRecord(value, [
    'schemaVersion', 'protocol', 'permitId', 'keyId', 'issuedAt', 'expiresAt', 'scope', 'bindings',
  ]);
  if (!payload
    || payload['schemaVersion'] !== 2
    || payload['protocol'] !== RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_PROTOCOL
    || typeof payload['permitId'] !== 'string' || !UUID_RE.test(payload['permitId'])
    || typeof payload['keyId'] !== 'string' || !KEY_ID_RE.test(payload['keyId'])
    || !canonicalTimestamp(payload['issuedAt'])
    || !canonicalTimestamp(payload['expiresAt'])
    || !parseScope(payload['scope'])
    || !parseBindings(payload['bindings'])) return null;
  return payload as unknown as RuntimeActivationStoppedConsumerV2PermitPayload;
}

export function parseRuntimeActivationStoppedConsumerV2Permit(
  value: unknown,
): RuntimeActivationStoppedConsumerV2PermitEnvelope | null {
  try {
    const envelope = dataRecord(value, ['payload', 'signature']);
    if (!envelope || canonicalBase64url(envelope['signature'], 64) === null) return null;
    if (!parsePermitPayload(envelope['payload'])) return null;
    return envelope as unknown as RuntimeActivationStoppedConsumerV2PermitEnvelope;
  } catch {
    return null;
  }
}

function decodeCanonicalFrame(input: string | Buffer): unknown | null {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  if (bytes.length === 0 || bytes.length > MAX_PERMIT_FRAME_BYTES || bytes.at(-1) !== 0x0a) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (Buffer.byteLength(text, 'utf8') !== bytes.length || !text.endsWith('\n')) return null;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(0, -1));
  } catch {
    return null;
  }
  try {
    return `${canonicalizeDaemonActivationValue(value)}\n` === text ? value : null;
  } catch {
    return null;
  }
}

export function parseRuntimeActivationStoppedConsumerV2PermitFrame(
  input: string | Buffer,
): RuntimeActivationStoppedConsumerV2PermitEnvelope | null {
  const decoded = decodeCanonicalFrame(input);
  return decoded ? parseRuntimeActivationStoppedConsumerV2Permit(decoded) : null;
}

function permitSigningBytes(payload: RuntimeActivationStoppedConsumerV2PermitPayload): Buffer {
  return Buffer.from(`${PERMIT_SIGNATURE_DOMAIN}${canonicalizeDaemonActivationValue(payload)}`, 'utf8');
}

export function runtimeActivationStoppedConsumerV2PermitPayloadDigest(
  payload: RuntimeActivationStoppedConsumerV2PermitPayload,
): string {
  return sha256(
    `${RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_PERMIT_DOMAIN}\n` +
    canonicalizeDaemonActivationValue(payload),
  );
}

export function runtimeActivationStoppedConsumerV2KeyId(publicKey: KeyObject): string {
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return sha256(Buffer.concat([
    Buffer.from(`${RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_PERMIT_DOMAIN}:key\0`, 'utf8'),
    spki,
  ]));
}

export function signRuntimeActivationStoppedConsumerV2Permit(
  payload: RuntimeActivationStoppedConsumerV2PermitPayload,
  privateKey: KeyObject,
): RuntimeActivationStoppedConsumerV2PermitEnvelope {
  return {
    payload: structuredClone(payload),
    signature: sign(null, permitSigningBytes(payload), privateKey).toString('base64url'),
  };
}

export function runtimeActivationStoppedConsumerV2PermitFrame(
  envelope: RuntimeActivationStoppedConsumerV2PermitEnvelope,
): string {
  return `${canonicalizeDaemonActivationValue(envelope)}\n`;
}

export function verifyRuntimeActivationStoppedConsumerV2Permit(
  envelope: RuntimeActivationStoppedConsumerV2PermitEnvelope,
  roots: readonly RuntimeActivationStoppedConsumerV2TrustRoot[],
  nowMs: number,
): string | null {
  const parsed = parseRuntimeActivationStoppedConsumerV2Permit(envelope);
  if (!parsed) return 'runtime activation stopped-consumer v2 permit is invalid';
  const issued = Date.parse(parsed.payload.issuedAt);
  const expires = Date.parse(parsed.payload.expiresAt);
  if (!Number.isFinite(nowMs)
    || expires <= issued
    || expires - issued > MAX_PERMIT_VALIDITY_MS
    || nowMs < issued - MAX_FUTURE_SKEW_MS
    || nowMs >= expires) {
    return 'runtime activation stopped-consumer v2 permit is outside its validity window';
  }
  if (!Array.isArray(roots) || roots.length > 8) {
    return 'runtime activation stopped-consumer v2 signing root is unavailable';
  }
  const parsedRoots: RuntimeActivationStoppedConsumerV2TrustRoot[] = [];
  const seenKeyIds = new Set<string>();
  for (const candidate of roots) {
    const record = dataRecord(candidate, ['algorithm', 'keyId', 'publicKeySpki', 'validFrom', 'validUntil']);
    if (!record
      || record['algorithm'] !== 'ed25519'
      || typeof record['keyId'] !== 'string' || !KEY_ID_RE.test(record['keyId'])
      || canonicalBase64url(record['publicKeySpki']) === null
      || !canonicalTimestamp(record['validFrom'])
      || !canonicalTimestamp(record['validUntil'])
      || Date.parse(record['validUntil']) <= Date.parse(record['validFrom'])
      || seenKeyIds.has(record['keyId'])) {
      return 'runtime activation stopped-consumer v2 signing root is unavailable';
    }
    seenKeyIds.add(record['keyId']);
    parsedRoots.push(record as unknown as RuntimeActivationStoppedConsumerV2TrustRoot);
  }
  const root = parsedRoots.find((entry) => entry.keyId === parsed.payload.keyId) ?? null;
  if (!root
    || Date.parse(root.validFrom) > issued
    || Date.parse(root.validUntil) < expires
    || nowMs < Date.parse(root.validFrom)
    || nowMs >= Date.parse(root.validUntil)) {
    return 'runtime activation stopped-consumer v2 signing root is unavailable';
  }
  const spki = canonicalBase64url(root.publicKeySpki);
  const signature = canonicalBase64url(parsed.signature, 64);
  if (!spki || !signature) {
    return 'runtime activation stopped-consumer v2 permit signature is invalid';
  }
  try {
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519'
      || runtimeActivationStoppedConsumerV2KeyId(key) !== root.keyId
      || !verify(null, permitSigningBytes(parsed.payload), key, signature)) {
      return 'runtime activation stopped-consumer v2 permit signature is invalid';
    }
  } catch {
    return 'runtime activation stopped-consumer v2 permit signature is invalid';
  }
  return null;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return sameDigest(
      sha256(canonicalizeDaemonActivationValue(left)),
      sha256(canonicalizeDaemonActivationValue(right)),
    );
  } catch {
    return false;
  }
}

/**
 * Authenticate a version-general permit and compare all independently derived
 * bindings. A successful result is evidence only; every authority bit remains
 * false and no permit is consumed.
 */
export function evaluateRuntimeActivationStoppedConsumerV2Permit(
  envelope: RuntimeActivationStoppedConsumerV2PermitEnvelope,
  roots: readonly RuntimeActivationStoppedConsumerV2TrustRoot[],
  nowMs: number,
  expectedBindings: RuntimeActivationStoppedConsumerV2Bindings,
): RuntimeActivationStoppedConsumerV2EvidenceResult {
  const failure = (reason: string): RuntimeActivationStoppedConsumerV2EvidenceResult => ({
    ok: false,
    reason,
    authority: RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_AUTHORITY,
    permitDigest: null,
  });
  const error = verifyRuntimeActivationStoppedConsumerV2Permit(envelope, roots, nowMs);
  if (error) return failure(error);
  const parsed = parseRuntimeActivationStoppedConsumerV2Permit(envelope);
  const expected = parseBindings(expectedBindings);
  if (!parsed || !expected || !canonicalEqual(parsed.payload.bindings, expected)) {
    return failure('runtime activation stopped-consumer v2 binding mismatch');
  }
  return {
    ok: true,
    reason: 'exact version-general stopped-selection permit matched; mutation authority remains external',
    authority: RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_AUTHORITY,
    permitDigest: runtimeActivationStoppedConsumerV2PermitPayloadDigest(parsed.payload),
  };
}
