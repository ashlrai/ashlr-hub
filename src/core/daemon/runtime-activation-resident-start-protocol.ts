/**
 * M521 resident-start permit and exact-release acknowledgement protocol.
 *
 * This module is deliberately pure. It verifies signed intent and canonical
 * evidence shapes, but it cannot authenticate a process, contact launchd,
 * mutate a service, or grant activation/dispatch authority. A future native
 * broker must own those effects and the acknowledgement transport.
 */

import {
  createHash,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';

import { canonicalizeDaemonActivationValue } from './activation-permit.js';

export const RUNTIME_ACTIVATION_RESIDENT_START_PROTOCOL =
  'runtime-activation-resident-start-v1' as const;
export const RUNTIME_ACTIVATION_RESIDENT_START_PERMIT_DOMAIN =
  'ashlr:runtime-activation-resident-start:permit:v1' as const;
export const RUNTIME_ACTIVATION_RESIDENT_START_ACK_DOMAIN =
  'ashlr:runtime-activation-resident-start:ack:v1' as const;

const PERMIT_SIGNATURE_DOMAIN = `${RUNTIME_ACTIVATION_RESIDENT_START_PERMIT_DOMAIN}\0`;
const MAX_PERMIT_FRAME_BYTES = 64 * 1024;
const MAX_ACK_FRAME_BYTES = 64 * 1024;
const MAX_PERMIT_VALIDITY_MS = 120_000;
const MAX_FUTURE_SKEW_MS = 30_000;
const MAX_ACK_DEADLINE_MS = 30_000;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const SHA1_RE = /^[a-f0-9]{40}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const PACKAGE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export const RUNTIME_ACTIVATION_RESIDENT_START_AUTHORITY = Object.freeze({
  activationPermitted: false,
  deployPermitted: false,
  dispatchPermitted: false,
  effectPermitted: false,
  installPermitted: false,
  launchPermitted: false,
  rollbackPermitted: false,
  serviceMutationPermitted: false,
  startPermitted: false,
} as const);

export interface RuntimeActivationResidentStartTrustRootV1 {
  algorithm: 'ed25519';
  keyId: string;
  publicKeySpki: string;
  validFrom: string;
  validUntil: string;
}

export interface RuntimeActivationResidentStartReleaseBindingsV1 {
  candidateRevision: string;
  candidateExpectedTree: string;
  candidateVersion: string;
  candidateReleaseTag: string;
  candidateRuntimeTreeSha256: string;
  candidateManifestDigest: string;
  candidateLaunchReceiptSha256: string;
  candidateServiceDescriptorSha256: string;
  candidateServiceInvocationDigest: string;
  configSha256: string;
  currentTarget: string;
}

export interface RuntimeActivationResidentStartBindingsV1
  extends RuntimeActivationResidentStartReleaseBindingsV1 {
  activationId: string;
  admissionDigest: string;
  planDigest: string;
  canonicalRequestSha256: string;
  trustRootCanonicalSha256: string;
  stoppedPermitId: string;
  stoppedReceiptDigest: string;
  priorServiceLoaded: false;
  priorServiceDisabled: boolean;
  hostUid: number;
  serviceLabel: 'ai.ashlr.daemon';
  serviceTarget: string;
  brokerChallenge: string;
  acknowledgementDeadlineMs: number;
}

export interface RuntimeActivationResidentStartPermitPayloadV1 {
  schemaVersion: 1;
  protocol: typeof RUNTIME_ACTIVATION_RESIDENT_START_PROTOCOL;
  permitId: string;
  keyId: string;
  issuedAt: string;
  expiresAt: string;
  scope: {
    action: 'start-exact-selected-resident-release';
    platform: 'darwin';
    nativeBrokerRequired: true;
    killSwitch: 'healthy-engaged';
    providerEffectsBlocked: true;
    serviceStartRequested: true;
    serviceEnable: false;
    serviceInstall: false;
    pointerMutation: false;
    residentAcknowledgement: 'required-pre-dispatch';
    dispatchAuthorized: false;
  };
  bindings: RuntimeActivationResidentStartBindingsV1;
}

export interface RuntimeActivationResidentStartPermitEnvelopeV1 {
  payload: RuntimeActivationResidentStartPermitPayloadV1;
  signature: string;
}

export interface RuntimeActivationResidentNativeObservationV1 {
  pid: number;
  processStartIdentitySha256: string;
  auditTokenSha256: string;
  executableVnodeSha256: string;
  codeIdentitySha256: string;
  launchdJobGenerationSha256: string;
}

export interface RuntimeActivationResidentStartAcknowledgementV1 {
  schemaVersion: 1;
  protocol: typeof RUNTIME_ACTIVATION_RESIDENT_START_PROTOCOL;
  acknowledgement: 'resident-start-pre-dispatch';
  permitId: string;
  permitPayloadDigest: string;
  activationId: string;
  brokerChallenge: string;
  acknowledgedAt: string;
  bindings: RuntimeActivationResidentStartBindingsV1;
  nativeObservation: RuntimeActivationResidentNativeObservationV1;
  channel: {
    transport: 'broker-owned-inherited-fd';
    peerCredentialsVerified: true;
    challengeVerified: true;
    framing: 'canonical-json-single-lf-eof';
  };
  state: {
    killSwitch: 'healthy-engaged';
    phase: 'pre-dispatch';
    dispatchAuthorized: false;
    providerEffectsBlocked: true;
  };
  authority: typeof RUNTIME_ACTIVATION_RESIDENT_START_AUTHORITY;
}

export interface RuntimeActivationResidentStartEvidenceResultV1 {
  ok: boolean;
  reason: string;
  authority: typeof RUNTIME_ACTIVATION_RESIDENT_START_AUTHORITY;
  acknowledgementDigest: string | null;
}

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

function parseBindings(value: unknown): RuntimeActivationResidentStartBindingsV1 | null {
  const record = dataRecord(value, [
    'activationId',
    'admissionDigest',
    'planDigest',
    'canonicalRequestSha256',
    'trustRootCanonicalSha256',
    'stoppedPermitId',
    'stoppedReceiptDigest',
    'candidateRevision',
    'candidateExpectedTree',
    'candidateVersion',
    'candidateReleaseTag',
    'candidateRuntimeTreeSha256',
    'candidateManifestDigest',
    'candidateLaunchReceiptSha256',
    'candidateServiceDescriptorSha256',
    'candidateServiceInvocationDigest',
    'configSha256',
    'currentTarget',
    'priorServiceLoaded',
    'priorServiceDisabled',
    'hostUid',
    'serviceLabel',
    'serviceTarget',
    'brokerChallenge',
    'acknowledgementDeadlineMs',
  ]);
  if (!record) return null;
  const digestFields = [
    record['admissionDigest'],
    record['planDigest'],
    record['canonicalRequestSha256'],
    record['trustRootCanonicalSha256'],
    record['stoppedReceiptDigest'],
    record['candidateRuntimeTreeSha256'],
    record['candidateManifestDigest'],
    record['candidateLaunchReceiptSha256'],
    record['candidateServiceDescriptorSha256'],
    record['candidateServiceInvocationDigest'],
    record['configSha256'],
  ];
  if (!digestFields.every((entry) => typeof entry === 'string' && SHA256_RE.test(entry))) return null;
  if (typeof record['activationId'] !== 'string' || !UUID_RE.test(record['activationId'])
    || typeof record['stoppedPermitId'] !== 'string' || !UUID_RE.test(record['stoppedPermitId'])
    || typeof record['candidateRevision'] !== 'string' || !SHA1_RE.test(record['candidateRevision'])
    || typeof record['candidateExpectedTree'] !== 'string' || !SHA1_RE.test(record['candidateExpectedTree'])
    || typeof record['candidateVersion'] !== 'string' || !PACKAGE_VERSION_RE.test(record['candidateVersion'])
    || record['candidateReleaseTag'] !== `v${record['candidateVersion']}`
    || record['currentTarget'] !== `releases/${record['candidateRevision']}`
    || record['priorServiceLoaded'] !== false
    || typeof record['priorServiceDisabled'] !== 'boolean'
    || !Number.isSafeInteger(record['hostUid']) || Number(record['hostUid']) < 0
    || record['serviceLabel'] !== 'ai.ashlr.daemon'
    || record['serviceTarget'] !== `gui/${record['hostUid']}/ai.ashlr.daemon`
    || canonicalBase64url(record['brokerChallenge'], 32) === null
    || !Number.isSafeInteger(record['acknowledgementDeadlineMs'])
    || Number(record['acknowledgementDeadlineMs']) < 1
    || Number(record['acknowledgementDeadlineMs']) > MAX_ACK_DEADLINE_MS) return null;
  return record as unknown as RuntimeActivationResidentStartBindingsV1;
}

function parseScope(value: unknown): RuntimeActivationResidentStartPermitPayloadV1['scope'] | null {
  const record = dataRecord(value, [
    'action',
    'platform',
    'nativeBrokerRequired',
    'killSwitch',
    'providerEffectsBlocked',
    'serviceStartRequested',
    'serviceEnable',
    'serviceInstall',
    'pointerMutation',
    'residentAcknowledgement',
    'dispatchAuthorized',
  ]);
  if (!record
    || record['action'] !== 'start-exact-selected-resident-release'
    || record['platform'] !== 'darwin'
    || record['nativeBrokerRequired'] !== true
    || record['killSwitch'] !== 'healthy-engaged'
    || record['providerEffectsBlocked'] !== true
    || record['serviceStartRequested'] !== true
    || record['serviceEnable'] !== false
    || record['serviceInstall'] !== false
    || record['pointerMutation'] !== false
    || record['residentAcknowledgement'] !== 'required-pre-dispatch'
    || record['dispatchAuthorized'] !== false) return null;
  return record as unknown as RuntimeActivationResidentStartPermitPayloadV1['scope'];
}

export function parseRuntimeActivationResidentStartPermit(
  value: unknown,
): RuntimeActivationResidentStartPermitEnvelopeV1 | null {
  try {
    const envelope = dataRecord(value, ['payload', 'signature']);
    if (!envelope || canonicalBase64url(envelope['signature'], 64) === null) return null;
    if (!parsePermitPayload(envelope['payload'])) return null;
    return envelope as unknown as RuntimeActivationResidentStartPermitEnvelopeV1;
  } catch {
    return null;
  }
}

function parsePermitPayload(value: unknown): RuntimeActivationResidentStartPermitPayloadV1 | null {
  const payload = dataRecord(value, [
    'schemaVersion', 'protocol', 'permitId', 'keyId', 'issuedAt', 'expiresAt', 'scope', 'bindings',
  ]);
  if (!payload
    || payload['schemaVersion'] !== 1
    || payload['protocol'] !== RUNTIME_ACTIVATION_RESIDENT_START_PROTOCOL
    || typeof payload['permitId'] !== 'string' || !UUID_RE.test(payload['permitId'])
    || typeof payload['keyId'] !== 'string' || !KEY_ID_RE.test(payload['keyId'])
    || !canonicalTimestamp(payload['issuedAt'])
    || !canonicalTimestamp(payload['expiresAt'])
    || !parseScope(payload['scope'])
    || !parseBindings(payload['bindings'])) return null;
  return payload as unknown as RuntimeActivationResidentStartPermitPayloadV1;
}

function decodeCanonicalFrame(
  input: string | Buffer,
  maxBytes: number,
): { text: string; value: unknown } | null {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  if (bytes.length === 0 || bytes.length > maxBytes || bytes.at(-1) !== 0x0a) return null;
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
    return `${canonicalizeDaemonActivationValue(value)}\n` === text ? { text, value } : null;
  } catch {
    return null;
  }
}

export function parseRuntimeActivationResidentStartPermitFrame(
  input: string | Buffer,
): RuntimeActivationResidentStartPermitEnvelopeV1 | null {
  const decoded = decodeCanonicalFrame(input, MAX_PERMIT_FRAME_BYTES);
  return decoded ? parseRuntimeActivationResidentStartPermit(decoded.value) : null;
}

function permitSigningBytes(payload: RuntimeActivationResidentStartPermitPayloadV1): Buffer {
  return Buffer.from(`${PERMIT_SIGNATURE_DOMAIN}${canonicalizeDaemonActivationValue(payload)}`, 'utf8');
}

export function runtimeActivationResidentStartPermitPayloadDigest(
  payload: RuntimeActivationResidentStartPermitPayloadV1,
): string {
  return sha256(
    `${RUNTIME_ACTIVATION_RESIDENT_START_PERMIT_DOMAIN}\n${canonicalizeDaemonActivationValue(payload)}`,
  );
}

export function runtimeActivationResidentStartKeyId(publicKey: KeyObject): string {
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return sha256(Buffer.concat([
    Buffer.from(`${RUNTIME_ACTIVATION_RESIDENT_START_PERMIT_DOMAIN}:key\0`, 'utf8'),
    spki,
  ]));
}

export function signRuntimeActivationResidentStartPermit(
  payload: RuntimeActivationResidentStartPermitPayloadV1,
  privateKey: KeyObject,
): RuntimeActivationResidentStartPermitEnvelopeV1 {
  return {
    payload: structuredClone(payload),
    signature: sign(null, permitSigningBytes(payload), privateKey).toString('base64url'),
  };
}

export function verifyRuntimeActivationResidentStartPermit(
  envelope: RuntimeActivationResidentStartPermitEnvelopeV1,
  roots: readonly RuntimeActivationResidentStartTrustRootV1[],
  nowMs: number,
): string | null {
  const parsed = parseRuntimeActivationResidentStartPermit(envelope);
  if (!parsed) return 'runtime activation resident-start permit is invalid';
  const issued = Date.parse(parsed.payload.issuedAt);
  const expires = Date.parse(parsed.payload.expiresAt);
  if (!Number.isFinite(nowMs)
    || expires <= issued
    || expires - issued > MAX_PERMIT_VALIDITY_MS
    || nowMs < issued - MAX_FUTURE_SKEW_MS
    || nowMs >= expires) {
    return 'runtime activation resident-start permit is outside its validity window';
  }
  const parsedRoots: RuntimeActivationResidentStartTrustRootV1[] = [];
  const seenKeyIds = new Set<string>();
  for (const candidate of roots) {
    const record = dataRecord(candidate, ['algorithm', 'keyId', 'publicKeySpki', 'validFrom', 'validUntil']);
    if (!record
      || record['algorithm'] !== 'ed25519'
      || typeof record['keyId'] !== 'string' || !KEY_ID_RE.test(record['keyId'])
      || canonicalBase64url(record['publicKeySpki']) === null
      || !canonicalTimestamp(record['validFrom'])
      || !canonicalTimestamp(record['validUntil'])
      || seenKeyIds.has(record['keyId'])) {
      return 'runtime activation resident-start signing root is unavailable';
    }
    seenKeyIds.add(record['keyId']);
    parsedRoots.push(record as unknown as RuntimeActivationResidentStartTrustRootV1);
  }
  const root = parsedRoots.find((entry) => entry.keyId === parsed.payload.keyId) ?? null;
  if (!root
    || Date.parse(root.validFrom) > issued
    || Date.parse(root.validUntil) < expires
    || nowMs < Date.parse(root.validFrom)
    || nowMs >= Date.parse(root.validUntil)) {
    return 'runtime activation resident-start signing root is unavailable';
  }
  const spki = canonicalBase64url(root.publicKeySpki);
  const signature = canonicalBase64url(parsed.signature, 64);
  if (!spki || !signature) return 'runtime activation resident-start permit signature is invalid';
  try {
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519'
      || runtimeActivationResidentStartKeyId(key) !== root.keyId
      || !verify(null, permitSigningBytes(parsed.payload), key, signature)) {
      return 'runtime activation resident-start permit signature is invalid';
    }
  } catch {
    return 'runtime activation resident-start permit signature is invalid';
  }
  return null;
}

function parseAuthority(value: unknown): typeof RUNTIME_ACTIVATION_RESIDENT_START_AUTHORITY | null {
  const record = dataRecord(value, Object.keys(RUNTIME_ACTIVATION_RESIDENT_START_AUTHORITY));
  if (!record || Object.values(record).some((entry) => entry !== false)) return null;
  return record as unknown as typeof RUNTIME_ACTIVATION_RESIDENT_START_AUTHORITY;
}

function parseNativeObservation(value: unknown): RuntimeActivationResidentNativeObservationV1 | null {
  const record = dataRecord(value, [
    'pid',
    'processStartIdentitySha256',
    'auditTokenSha256',
    'executableVnodeSha256',
    'codeIdentitySha256',
    'launchdJobGenerationSha256',
  ]);
  if (!record
    || !Number.isSafeInteger(record['pid']) || Number(record['pid']) <= 0
    || [
      record['processStartIdentitySha256'],
      record['auditTokenSha256'],
      record['executableVnodeSha256'],
      record['codeIdentitySha256'],
      record['launchdJobGenerationSha256'],
    ].some((entry) => typeof entry !== 'string' || !SHA256_RE.test(entry))) return null;
  return record as unknown as RuntimeActivationResidentNativeObservationV1;
}

export function parseRuntimeActivationResidentStartAcknowledgement(
  value: unknown,
): RuntimeActivationResidentStartAcknowledgementV1 | null {
  try {
    const ack = dataRecord(value, [
      'schemaVersion',
      'protocol',
      'acknowledgement',
      'permitId',
      'permitPayloadDigest',
      'activationId',
      'brokerChallenge',
      'acknowledgedAt',
      'bindings',
      'nativeObservation',
      'channel',
      'state',
      'authority',
    ]);
    if (!ack
      || ack['schemaVersion'] !== 1
      || ack['protocol'] !== RUNTIME_ACTIVATION_RESIDENT_START_PROTOCOL
      || ack['acknowledgement'] !== 'resident-start-pre-dispatch'
      || typeof ack['permitId'] !== 'string' || !UUID_RE.test(ack['permitId'])
      || typeof ack['permitPayloadDigest'] !== 'string' || !SHA256_RE.test(ack['permitPayloadDigest'])
      || typeof ack['activationId'] !== 'string' || !UUID_RE.test(ack['activationId'])
      || canonicalBase64url(ack['brokerChallenge'], 32) === null
      || !canonicalTimestamp(ack['acknowledgedAt'])
      || !parseBindings(ack['bindings'])
      || !parseNativeObservation(ack['nativeObservation'])
      || !parseAuthority(ack['authority'])) return null;
    const channel = dataRecord(ack['channel'], [
      'transport', 'peerCredentialsVerified', 'challengeVerified', 'framing',
    ]);
    if (!channel
      || channel['transport'] !== 'broker-owned-inherited-fd'
      || channel['peerCredentialsVerified'] !== true
      || channel['challengeVerified'] !== true
      || channel['framing'] !== 'canonical-json-single-lf-eof') return null;
    const state = dataRecord(ack['state'], [
      'killSwitch', 'phase', 'dispatchAuthorized', 'providerEffectsBlocked',
    ]);
    if (!state
      || state['killSwitch'] !== 'healthy-engaged'
      || state['phase'] !== 'pre-dispatch'
      || state['dispatchAuthorized'] !== false
      || state['providerEffectsBlocked'] !== true) return null;
    return ack as unknown as RuntimeActivationResidentStartAcknowledgementV1;
  } catch {
    return null;
  }
}

export function parseRuntimeActivationResidentStartAcknowledgementFrame(
  input: string | Buffer,
): RuntimeActivationResidentStartAcknowledgementV1 | null {
  const decoded = decodeCanonicalFrame(input, MAX_ACK_FRAME_BYTES);
  return decoded ? parseRuntimeActivationResidentStartAcknowledgement(decoded.value) : null;
}

export function runtimeActivationResidentStartPermitFrame(
  envelope: RuntimeActivationResidentStartPermitEnvelopeV1,
): string {
  return `${canonicalizeDaemonActivationValue(envelope)}\n`;
}

export function runtimeActivationResidentStartAcknowledgementFrame(
  acknowledgement: RuntimeActivationResidentStartAcknowledgementV1,
): string {
  return `${canonicalizeDaemonActivationValue(acknowledgement)}\n`;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    const leftDigest = sha256(canonicalizeDaemonActivationValue(left));
    const rightDigest = sha256(canonicalizeDaemonActivationValue(right));
    return sameDigest(leftDigest, rightDigest);
  } catch {
    return false;
  }
}

/**
 * Validate that a broker-authenticated frame is exactly release-bound.
 *
 * Even a successful result is evidence only. This function cannot establish
 * that the caller supplied evidence from a native broker-owned channel.
 */
export function evaluateRuntimeActivationResidentStartAcknowledgement(
  acknowledgement: RuntimeActivationResidentStartAcknowledgementV1,
  permit: RuntimeActivationResidentStartPermitPayloadV1,
  expectedNativeObservation: RuntimeActivationResidentNativeObservationV1,
): RuntimeActivationResidentStartEvidenceResultV1 {
  const ack = parseRuntimeActivationResidentStartAcknowledgement(acknowledgement);
  const parsedPermit = parsePermitPayload(permit);
  const failure = (reason: string): RuntimeActivationResidentStartEvidenceResultV1 => ({
    ok: false,
    reason,
    authority: RUNTIME_ACTIVATION_RESIDENT_START_AUTHORITY,
    acknowledgementDigest: null,
  });
  if (!ack || !parsedPermit) return failure('runtime activation resident-start acknowledgement or permit is invalid');
  if (ack.permitId !== permit.permitId
    || !sameDigest(ack.permitPayloadDigest, runtimeActivationResidentStartPermitPayloadDigest(permit))
    || ack.activationId !== permit.bindings.activationId
    || ack.brokerChallenge !== permit.bindings.brokerChallenge
    || !canonicalEqual(ack.bindings, permit.bindings)) {
    return failure('runtime activation resident-start acknowledgement binding mismatch');
  }
  const acknowledged = Date.parse(ack.acknowledgedAt);
  const issued = Date.parse(permit.issuedAt);
  const expires = Date.parse(permit.expiresAt);
  if (acknowledged < issued
    || acknowledged >= expires
    || acknowledged - issued > permit.bindings.acknowledgementDeadlineMs) {
    return failure('runtime activation resident-start acknowledgement missed its bound deadline');
  }
  if (!canonicalEqual(ack.nativeObservation, expectedNativeObservation)) {
    return failure('runtime activation resident-start native observation mismatch');
  }
  return {
    ok: true,
    reason: 'canonical exact-release pre-dispatch acknowledgement matched; native authority remains external',
    authority: RUNTIME_ACTIVATION_RESIDENT_START_AUTHORITY,
    acknowledgementDigest: sha256(
      `${RUNTIME_ACTIVATION_RESIDENT_START_ACK_DOMAIN}\n${canonicalizeDaemonActivationValue(ack)}`,
    ),
  };
}
