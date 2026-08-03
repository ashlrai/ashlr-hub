/**
 * Data-only verifier capsule admission observation.
 *
 * This module verifies an externally signed statement against caller-pinned
 * expectations. It has no execution, storage, network, or policy authority.
 */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto';

export const VERIFIER_EXECUTION_AUTHORITY_PROTOCOL_V2 =
  'ashlr-verifier-execution-authority-v2' as const;
export const VERIFIER_EXECUTION_TRUST_PROTOCOL_V1 =
  'ashlr-verifier-execution-trust-v1' as const;
export const VERIFIER_EXECUTION_SIGNATURE_ALGORITHM = 'ed25519' as const;

const SIGNER_ROLE = 'verifier-capsule-admission-signer' as const;
const SIGNATURE_DOMAIN = 'ashlr:verifier-execution-authority-signature:v2';
const KEY_ID_DOMAIN = 'ashlr:verifier-execution-authority-key-id:v1';
const TRUST_POLICY_DIGEST_DOMAIN = 'ashlr:verifier-execution-trust-policy:v1';
const STATEMENT_DIGEST_DOMAIN = 'ashlr:verifier-execution-authority-statement:v2';
const DIGEST = /^[0-9a-f]{64}$/;
const POLICY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_TRUST_KEYS = 16;
const MAX_COMMANDS = 64;
const MAX_LIFETIME_MS = 10 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 30_000;
const GENERIC_RESOLVER_ALIASES = new Set([
  'bash', 'bun', 'busybox', 'cmd', 'comspec', 'corepack', 'cscript', 'csh', 'dash', 'deno',
  'env', 'fish', 'java', 'ksh', 'node', 'nodejs', 'npm', 'npx', 'perl', 'php', 'pnpm',
  'powershell', 'pwsh', 'py', 'ruby', 'rundll32', 'sh', 'tcsh', 'wscript', 'yarn', 'zsh',
]);
const WINDOWS_RESERVED_DEVICE = /^(?:aux|clock\$|com[1-9]|con|conin\$|conout\$|lpt[1-9]|nul|prn)$/i;
const EXECUTABLE_ALIAS_EXTENSION = /\.(?:bat|cmd|com|exe)$/i;

const PLATFORMS = ['darwin', 'linux', 'win32'] as const;
const ARCHITECTURES = ['arm64', 'x64'] as const;
const BACKENDS = [
  'linux-namespace-cgroup-broker',
  'macos-virtualization-framework-broker',
  'windows-appcontainer-job-broker',
] as const;

export type VerifierExecutionPlatform = typeof PLATFORMS[number];
export type VerifierExecutionArchitecture = typeof ARCHITECTURES[number];
export type VerifierExecutionBackend = typeof BACKENDS[number];

const CAPSULE_ROOTS: Readonly<Record<VerifierExecutionPlatform, string>> = Object.freeze({
  darwin: '/opt/ashlr/verifier-capsule',
  linux: '/opt/ashlr/verifier-capsule',
  win32: 'C:\\ashlr-verifier-capsule',
});

export const VERIFIER_EXECUTION_AUTHORITY_BLOCKERS_V1 = Object.freeze([
  'external-policy-approval-unresolved',
  'live-immutability-unproven',
  'replay-transparency-unavailable',
  'execution-wiring-disabled',
] as const);

const INPUT_KEYS = [
  'expectedBindings', 'expectedPolicyDigest', 'nowMs', 'statement', 'trustPolicy',
] as const;
const POLICY_KEYS = ['keys', 'policyVersion', 'protocol', 'schemaVersion'] as const;
const TRUST_KEY_KEYS = [
  'allowedArchitectures', 'allowedBackends', 'allowedPlatforms', 'keyId', 'notAfter',
  'notBefore', 'publicKeySpki', 'role', 'signatureAlgorithm',
] as const;
const ENTRYPOINT_KEYS = ['commandId', 'entrypoint'] as const;
const BINDING_KEYS = [
  'architecture', 'backend', 'baseDigest', 'brokerDigest', 'candidateDigest', 'capsuleRoot',
  'capsuleTreeDigest', 'commandEntrypoints', 'commandPlanDigest', 'dependencyDigest',
  'executableDigest', 'isolationPolicyDigest', 'platform', 'ticketDigest',
] as const;
const UNSIGNED_STATEMENT_KEYS = [
  ...BINDING_KEYS,
  'assurance', 'candidateMount', 'capsuleMutability', 'descendantOwnership', 'evidencePermitted',
  'executionPermitted', 'expiresAt', 'hostMounts', 'issuedAt', 'keyId', 'mergePermitted',
  'networkPolicy', 'nonce', 'protocol', 'schemaVersion', 'signatureAlgorithm',
  'trustPolicyDigest',
] as const;
const STATEMENT_KEYS = [...UNSIGNED_STATEMENT_KEYS, 'signature'] as const;

export interface VerifierCapsuleCommandEntrypointV1 {
  commandId: string;
  entrypoint: string;
}

export interface VerifierExecutionExpectedBindingsV1 {
  ticketDigest: string;
  candidateDigest: string;
  baseDigest: string;
  commandPlanDigest: string;
  capsuleTreeDigest: string;
  executableDigest: string;
  dependencyDigest: string;
  brokerDigest: string;
  isolationPolicyDigest: string;
  commandEntrypoints: VerifierCapsuleCommandEntrypointV1[];
  capsuleRoot: string;
  platform: VerifierExecutionPlatform;
  architecture: VerifierExecutionArchitecture;
  backend: VerifierExecutionBackend;
}

export interface VerifierExecutionTrustKeyV1 {
  keyId: string;
  signatureAlgorithm: typeof VERIFIER_EXECUTION_SIGNATURE_ALGORITHM;
  role: typeof SIGNER_ROLE;
  publicKeySpki: string;
  notBefore: string;
  notAfter: string;
  allowedPlatforms: VerifierExecutionPlatform[];
  allowedArchitectures: VerifierExecutionArchitecture[];
  allowedBackends: VerifierExecutionBackend[];
}

export interface VerifierExecutionTrustPolicyV1 {
  schemaVersion: 1;
  protocol: typeof VERIFIER_EXECUTION_TRUST_PROTOCOL_V1;
  policyVersion: string;
  keys: VerifierExecutionTrustKeyV1[];
}

export interface VerifierExecutionAuthorityStatementUnsignedV2
  extends VerifierExecutionExpectedBindingsV1 {
  schemaVersion: 1;
  protocol: typeof VERIFIER_EXECUTION_AUTHORITY_PROTOCOL_V2;
  assurance: 'externally-signed-capsule-observation';
  candidateMount: 'read-only';
  hostMounts: [];
  networkPolicy: 'denied';
  descendantOwnership: 'kernel-owned';
  capsuleMutability: 'immutable';
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  trustPolicyDigest: string;
  keyId: string;
  signatureAlgorithm: typeof VERIFIER_EXECUTION_SIGNATURE_ALGORITHM;
  executionPermitted: false;
  mergePermitted: false;
  evidencePermitted: false;
}

export interface VerifierExecutionAuthorityStatementV2
  extends VerifierExecutionAuthorityStatementUnsignedV2 {
  signature: string;
}

export interface InspectVerifierExecutionAuthorityV2Input {
  statement: VerifierExecutionAuthorityStatementV2;
  trustPolicy: VerifierExecutionTrustPolicyV1;
  expectedPolicyDigest: string;
  expectedBindings: VerifierExecutionExpectedBindingsV1;
  nowMs: number;
}

export type VerifierExecutionAuthorityReasonV2 =
  | 'statement-verified'
  | 'invalid-input'
  | 'trust-policy-invalid'
  | 'trust-policy-digest-mismatch'
  | 'statement-invalid'
  | 'command-map-invalid'
  | 'command-resolution-forbidden'
  | 'unsupported-backend'
  | 'backend-platform-mismatch'
  | 'isolation-claims-invalid'
  | 'binding-mismatch'
  | 'trust-key-unknown'
  | 'trust-key-invalid'
  | 'trust-key-inactive'
  | 'statement-not-current'
  | 'statement-expired'
  | 'statement-lifetime-invalid'
  | 'signature-invalid';

interface VerifierExecutionAuthorityResultBaseV2 {
  schemaVersion: 1;
  mode: 'verifier-execution-authority-observation-v2';
  authority: 'observation-only';
  executionPermitted: false;
  mergePermitted: false;
  evidencePermitted: false;
  blockers: typeof VERIFIER_EXECUTION_AUTHORITY_BLOCKERS_V1;
}

export type VerifierExecutionAuthorityResultV2 = VerifierExecutionAuthorityResultBaseV2 & (
  | {
    state: 'statement-verified';
    reason: 'statement-verified';
    statementDigest: string;
    trustPolicyDigest: string;
    keyId: string;
    platform: VerifierExecutionPlatform;
    architecture: VerifierExecutionArchitecture;
    backend: VerifierExecutionBackend;
    commandCount: number;
    signatureVerified: true;
    trustPolicyApprovalVerified: false;
    liveImmutabilityVerified: false;
    replayTransparencyVerified: false;
    executionWiringVerified: false;
  }
  | {
    state: 'withheld';
    reason: Exclude<VerifierExecutionAuthorityReasonV2, 'statement-verified'>;
    statementDigest: null;
    trustPolicyDigest: null;
    keyId: null;
    platform: null;
    architecture: null;
    backend: null;
    commandCount: 0;
    signatureVerified: false;
    trustPolicyApprovalVerified: false;
    liveImmutabilityVerified: false;
    replayTransparencyVerified: false;
    executionWiringVerified: false;
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
  if (depth > 8 || seen.size >= 512 || seen.has(value)) return false;
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || value.length > 128) return false;
  } else if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
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

function canonicalBase64Url(value: unknown, minimumBytes: number, maximumBytes: number): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 ||
    !BASE64URL.test(value)) return null;
  try {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length >= minimumBytes && bytes.length <= maximumBytes &&
      bytes.toString('base64url') === value ? bytes : null;
  } catch { return null; }
}

function sortedEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T[] {
  if (!denseArray(value, 1, allowed.length)) return false;
  let prior = '';
  for (const entry of value) {
    if (typeof entry !== 'string' || !allowed.includes(entry as T) || entry <= prior) return false;
    prior = entry;
  }
  return true;
}

function trustedBackend(platform: VerifierExecutionPlatform, backend: string): boolean {
  return (platform === 'linux' && backend === 'linux-namespace-cgroup-broker') ||
    (platform === 'darwin' && backend === 'macos-virtualization-framework-broker') ||
    (platform === 'win32' && backend === 'windows-appcontainer-job-broker');
}

function genericResolverAlias(component: string): boolean {
  const normalized = component.toLowerCase().replace(EXECUTABLE_ALIAS_EXTENSION, '');
  return GENERIC_RESOLVER_ALIASES.has(normalized) ||
    /^python(?:\d+(?:\.\d+)*)?$/.test(normalized);
}

function windowsComponentForbidden(component: string): boolean {
  if (component.endsWith('.') || component.endsWith(' ') || component.includes(':')) return true;
  const deviceStem = component.split('.', 1)[0] ?? '';
  return WINDOWS_RESERVED_DEVICE.test(deviceStem);
}

function entrypointMapReason(
  value: unknown,
  platform: VerifierExecutionPlatform,
  capsuleRoot: string,
): 'command-map-invalid' | 'command-resolution-forbidden' | null {
  if (!denseArray(value, 1, MAX_COMMANDS) || capsuleRoot !== CAPSULE_ROOTS[platform]) {
    return 'command-map-invalid';
  }
  const separator = platform === 'win32' ? '\\' : '/';
  const prefix = `${capsuleRoot}${separator}entrypoints${separator}`;
  let prior = '';
  for (const entry of value) {
    if (!exactPlainRecord(entry, ENTRYPOINT_KEYS) || typeof entry['commandId'] !== 'string' ||
      !COMMAND_ID.test(entry['commandId']) || entry['commandId'] <= prior ||
      typeof entry['entrypoint'] !== 'string' || entry['entrypoint'].length > 512) {
      return 'command-map-invalid';
    }
    prior = entry['commandId'];
    const path = entry['entrypoint'];
    const lower = path.toLowerCase();
    const segments = path.split(separator);
    const relativeSegments = path.slice(prefix.length).split(separator);
    const windowsPathInvalid = platform === 'win32' && (
      !/^[A-Z]:\\/.test(path) || path.startsWith('\\\\') || path.startsWith('\\\\?\\') ||
      path.startsWith('\\\\.\\') || path.indexOf(':') !== 1 || path.lastIndexOf(':') !== 1 ||
      relativeSegments.some(windowsComponentForbidden)
    );
    if (!path.startsWith(prefix) || path.length === prefix.length || path.includes('\0') ||
      (platform === 'win32' ? path.includes('/') : path.includes('\\')) ||
      windowsPathInvalid ||
      segments.some((segment, index) => segment === '.' || segment === '..' ||
        (segment === '' && !(platform !== 'win32' && index === 0))) ||
      relativeSegments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment)) ||
      relativeSegments.some(genericResolverAlias) ||
      /(?:^|[\\/])(repo|repository|workspace|candidate|node_modules|\.bin)(?:[\\/]|$)/i.test(lower)) {
      return 'command-resolution-forbidden';
    }
  }
  return null;
}

function trustKeyShape(value: unknown): value is VerifierExecutionTrustKeyV1 {
  if (!exactPlainRecord(value, TRUST_KEY_KEYS)) return false;
  return typeof value['keyId'] === 'string' && DIGEST.test(value['keyId']) &&
    value['signatureAlgorithm'] === VERIFIER_EXECUTION_SIGNATURE_ALGORITHM &&
    value['role'] === SIGNER_ROLE && typeof value['publicKeySpki'] === 'string' &&
    verifierExecutionAuthorityKeyId(value['publicKeySpki']) === value['keyId'] &&
    canonicalIso(value['notBefore']) && canonicalIso(value['notAfter']) &&
    Date.parse(value['notBefore']) < Date.parse(value['notAfter']) &&
    sortedEnumArray(value['allowedPlatforms'], PLATFORMS) &&
    sortedEnumArray(value['allowedArchitectures'], ARCHITECTURES) &&
    sortedEnumArray(value['allowedBackends'], BACKENDS);
}

function trustPolicyShape(value: unknown): value is VerifierExecutionTrustPolicyV1 {
  if (!exactPlainRecord(value, POLICY_KEYS) || value['schemaVersion'] !== 1 ||
    value['protocol'] !== VERIFIER_EXECUTION_TRUST_PROTOCOL_V1 ||
    typeof value['policyVersion'] !== 'string' || !POLICY_VERSION.test(value['policyVersion']) ||
    !denseArray(value['keys'], 1, MAX_TRUST_KEYS)) return false;
  let prior = '';
  for (const key of value['keys']) {
    if (!trustKeyShape(key) || key.keyId <= prior) return false;
    prior = key.keyId;
  }
  return true;
}

function commandEntrypointsEqual(
  left: VerifierCapsuleCommandEntrypointV1[],
  right: VerifierCapsuleCommandEntrypointV1[],
): boolean {
  return left.length === right.length && left.every((entry, index) =>
    entry.commandId === right[index]?.commandId && entry.entrypoint === right[index]?.entrypoint);
}

function bindingShape(value: unknown): value is VerifierExecutionExpectedBindingsV1 {
  if (!exactPlainRecord(value, BINDING_KEYS)) return false;
  if (!PLATFORMS.includes(value['platform'] as VerifierExecutionPlatform) ||
    !ARCHITECTURES.includes(value['architecture'] as VerifierExecutionArchitecture) ||
    !BACKENDS.includes(value['backend'] as VerifierExecutionBackend) ||
    typeof value['capsuleRoot'] !== 'string') return false;
  for (const key of BINDING_KEYS) {
    if (key.endsWith('Digest') && (typeof value[key] !== 'string' || !DIGEST.test(value[key]))) {
      return false;
    }
  }
  const platform = value['platform'] as VerifierExecutionPlatform;
  return entrypointMapReason(value['commandEntrypoints'], platform, value['capsuleRoot']) === null;
}

function unsignedStatementShape(
  value: unknown,
): {
  statement: VerifierExecutionAuthorityStatementUnsignedV2 | null;
  reason: Exclude<VerifierExecutionAuthorityReasonV2, 'statement-verified'> | null;
} {
  if (!exactPlainRecord(value, UNSIGNED_STATEMENT_KEYS)) return { statement: null, reason: 'statement-invalid' };
  if (!PLATFORMS.includes(value['platform'] as VerifierExecutionPlatform) ||
    !ARCHITECTURES.includes(value['architecture'] as VerifierExecutionArchitecture) ||
    typeof value['backend'] !== 'string' ||
    typeof value['capsuleRoot'] !== 'string') return { statement: null, reason: 'statement-invalid' };
  const platform = value['platform'] as VerifierExecutionPlatform;
  const backend = value['backend'] as string;
  if (!BACKENDS.includes(backend as VerifierExecutionBackend)) {
    return { statement: null, reason: 'unsupported-backend' };
  }
  if (!trustedBackend(platform, backend)) return {
    statement: null,
    reason: BACKENDS.includes(backend as VerifierExecutionBackend)
      ? 'backend-platform-mismatch' : 'unsupported-backend',
  };
  const commandReason = entrypointMapReason(value['commandEntrypoints'], platform, value['capsuleRoot']);
  if (commandReason) return { statement: null, reason: commandReason };
  for (const key of BINDING_KEYS) {
    if (key.endsWith('Digest') && (typeof value[key] !== 'string' || !DIGEST.test(value[key]))) {
      return { statement: null, reason: 'statement-invalid' };
    }
  }
  if (value['schemaVersion'] !== 1 || value['protocol'] !== VERIFIER_EXECUTION_AUTHORITY_PROTOCOL_V2 ||
    value['assurance'] !== 'externally-signed-capsule-observation' ||
    value['candidateMount'] !== 'read-only' || !denseArray(value['hostMounts'], 0, 0) ||
    value['networkPolicy'] !== 'denied' || value['descendantOwnership'] !== 'kernel-owned' ||
    value['capsuleMutability'] !== 'immutable' || !canonicalIso(value['issuedAt']) ||
    !canonicalIso(value['expiresAt']) || canonicalBase64Url(value['nonce'], 16, 64) === null ||
    typeof value['trustPolicyDigest'] !== 'string' || !DIGEST.test(value['trustPolicyDigest']) ||
    typeof value['keyId'] !== 'string' || !DIGEST.test(value['keyId']) ||
    value['signatureAlgorithm'] !== VERIFIER_EXECUTION_SIGNATURE_ALGORITHM ||
    value['executionPermitted'] !== false || value['mergePermitted'] !== false ||
    value['evidencePermitted'] !== false) {
    const isolationKeys = [
      value['candidateMount'], value['hostMounts'], value['networkPolicy'],
      value['descendantOwnership'], value['capsuleMutability'],
    ];
    const isolationValid = isolationKeys[0] === 'read-only' && denseArray(isolationKeys[1], 0, 0) &&
      isolationKeys[2] === 'denied' && isolationKeys[3] === 'kernel-owned' &&
      isolationKeys[4] === 'immutable';
    return { statement: null, reason: isolationValid ? 'statement-invalid' : 'isolation-claims-invalid' };
  }
  return { statement: value as unknown as VerifierExecutionAuthorityStatementUnsignedV2, reason: null };
}

function statementShape(
  value: unknown,
): {
  statement: VerifierExecutionAuthorityStatementV2 | null;
  reason: Exclude<VerifierExecutionAuthorityReasonV2, 'statement-verified'> | null;
} {
  if (!exactPlainRecord(value, STATEMENT_KEYS)) return { statement: null, reason: 'statement-invalid' };
  const { signature, ...unsigned } = value;
  const checked = unsignedStatementShape(unsigned);
  if (!checked.statement || checked.reason) return { statement: null, reason: checked.reason };
  if (canonicalBase64Url(signature, 64, 64) === null) return { statement: null, reason: 'signature-invalid' };
  return { statement: value as unknown as VerifierExecutionAuthorityStatementV2, reason: null };
}

/** Stable identity for an external Ed25519 admission key. */
export function verifierExecutionAuthorityKeyId(publicKeySpki: unknown): string | null {
  const bytes = canonicalBase64Url(publicKeySpki, 32, 128);
  if (!bytes) return null;
  try {
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    const canonical = Buffer.from(key.export({ format: 'der', type: 'spki' }));
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519' || !canonical.equals(bytes)) {
      return null;
    }
    return sha256(Buffer.concat([Buffer.from(`${KEY_ID_DOMAIN}\0`, 'utf8'), bytes]));
  } catch { return null; }
}

/** Canonical caller-pinned identity of a bounded trust policy. */
export function verifierExecutionAuthorityTrustPolicyDigest(value: unknown): string | null {
  try {
    if (!plainDataGraph(value)) return null;
    const policy = structuredClone(value);
    if (!trustPolicyShape(policy)) return null;
    return sha256(JSON.stringify([
      TRUST_POLICY_DIGEST_DOMAIN,
      policy.schemaVersion,
      policy.protocol,
      policy.policyVersion,
      policy.keys.map((key) => [
        key.keyId, key.signatureAlgorithm, key.role, key.publicKeySpki, key.notBefore, key.notAfter,
        key.allowedPlatforms, key.allowedArchitectures, key.allowedBackends,
      ]),
    ]));
  } catch { return null; }
}

/** Canonical bytes an external authority signs. This helper never signs. */
export function canonicalVerifierExecutionAuthorityPayloadV2(value: unknown): Buffer | null {
  try {
    if (!plainDataGraph(value)) return null;
    const statement = structuredClone(value);
    const checked = unsignedStatementShape(statement);
    if (!checked.statement || checked.reason) return null;
    const bounded = checked.statement;
    return Buffer.from(JSON.stringify([
      SIGNATURE_DOMAIN,
      bounded.schemaVersion,
      bounded.protocol,
      bounded.assurance,
      bounded.ticketDigest,
      bounded.candidateDigest,
      bounded.baseDigest,
      bounded.commandPlanDigest,
      bounded.capsuleTreeDigest,
      bounded.executableDigest,
      bounded.dependencyDigest,
      bounded.brokerDigest,
      bounded.isolationPolicyDigest,
      bounded.commandEntrypoints.map((entry) => [entry.commandId, entry.entrypoint]),
      bounded.capsuleRoot,
      bounded.platform,
      bounded.architecture,
      bounded.backend,
      bounded.candidateMount,
      bounded.hostMounts,
      bounded.networkPolicy,
      bounded.descendantOwnership,
      bounded.capsuleMutability,
      bounded.issuedAt,
      bounded.expiresAt,
      bounded.nonce,
      bounded.trustPolicyDigest,
      bounded.keyId,
      bounded.signatureAlgorithm,
      bounded.executionPermitted,
      bounded.mergePermitted,
      bounded.evidencePermitted,
    ]), 'utf8');
  } catch { return null; }
}

function trustedPublicKey(key: VerifierExecutionTrustKeyV1): KeyObject | null {
  const bytes = canonicalBase64Url(key.publicKeySpki, 32, 128);
  if (!bytes || verifierExecutionAuthorityKeyId(key.publicKeySpki) !== key.keyId) return null;
  try {
    const publicKey = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    return publicKey.type === 'public' && publicKey.asymmetricKeyType === 'ed25519' &&
      Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).equals(bytes)
      ? publicKey : null;
  } catch { return null; }
}

function withheld(
  reason: Exclude<VerifierExecutionAuthorityReasonV2, 'statement-verified'>,
): VerifierExecutionAuthorityResultV2 {
  return {
    schemaVersion: 1,
    mode: 'verifier-execution-authority-observation-v2',
    state: 'withheld',
    reason,
    authority: 'observation-only',
    executionPermitted: false,
    mergePermitted: false,
    evidencePermitted: false,
    statementDigest: null,
    trustPolicyDigest: null,
    keyId: null,
    platform: null,
    architecture: null,
    backend: null,
    commandCount: 0,
    signatureVerified: false,
    trustPolicyApprovalVerified: false,
    liveImmutabilityVerified: false,
    replayTransparencyVerified: false,
    executionWiringVerified: false,
    blockers: VERIFIER_EXECUTION_AUTHORITY_BLOCKERS_V1,
  };
}

function bindingsMatch(
  statement: VerifierExecutionAuthorityStatementV2,
  expected: VerifierExecutionExpectedBindingsV1,
): boolean {
  return BINDING_KEYS.every((key) => key === 'commandEntrypoints'
    ? commandEntrypointsEqual(statement.commandEntrypoints, expected.commandEntrypoints)
    : statement[key] === expected[key]);
}

/**
 * Verify a capsule-admission statement without granting execution authority.
 * `nowMs` is caller-owned so the inspector has no ambient clock dependency.
 */
export function inspectVerifierExecutionAuthorityV2(
  input: unknown,
): VerifierExecutionAuthorityResultV2 {
  let snapshot: unknown;
  try {
    if (!plainDataGraph(input)) return withheld('invalid-input');
    snapshot = structuredClone(input);
  } catch { return withheld('invalid-input'); }
  if (!exactPlainRecord(snapshot, INPUT_KEYS) || !Number.isSafeInteger(snapshot['nowMs']) ||
    (snapshot['nowMs'] as number) < 0 || typeof snapshot['expectedPolicyDigest'] !== 'string' ||
    !DIGEST.test(snapshot['expectedPolicyDigest'])) return withheld('invalid-input');

  const policy = snapshot['trustPolicy'];
  if (!trustPolicyShape(policy)) return withheld('trust-policy-invalid');
  const policyDigest = verifierExecutionAuthorityTrustPolicyDigest(policy);
  if (!policyDigest || policyDigest !== snapshot['expectedPolicyDigest']) {
    return withheld('trust-policy-digest-mismatch');
  }

  const checkedStatement = statementShape(snapshot['statement']);
  if (!checkedStatement.statement || checkedStatement.reason) {
    return withheld(checkedStatement.reason ?? 'statement-invalid');
  }
  const statement = checkedStatement.statement;
  if (statement.trustPolicyDigest !== policyDigest) return withheld('trust-policy-digest-mismatch');

  const expectedBindings = snapshot['expectedBindings'];
  if (!bindingShape(expectedBindings) || !bindingsMatch(statement, expectedBindings)) {
    return withheld('binding-mismatch');
  }

  const key = policy.keys.find((candidate) => candidate.keyId === statement.keyId);
  if (!key) return withheld('trust-key-unknown');
  const publicKey = trustedPublicKey(key);
  if (!publicKey) return withheld('trust-key-invalid');
  if (!key.allowedPlatforms.includes(statement.platform) ||
    !key.allowedArchitectures.includes(statement.architecture) ||
    !key.allowedBackends.includes(statement.backend)) return withheld('trust-key-invalid');

  const nowMs = snapshot['nowMs'] as number;
  const issuedAt = Date.parse(statement.issuedAt);
  const expiresAt = Date.parse(statement.expiresAt);
  if (issuedAt < Date.parse(key.notBefore) || expiresAt > Date.parse(key.notAfter)) {
    return withheld('trust-key-inactive');
  }
  if (issuedAt > nowMs + MAX_FUTURE_SKEW_MS) return withheld('statement-not-current');
  if (expiresAt <= nowMs) return withheld('statement-expired');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_LIFETIME_MS) {
    return withheld('statement-lifetime-invalid');
  }

  const { signature, ...unsigned } = statement;
  const payload = canonicalVerifierExecutionAuthorityPayloadV2(unsigned);
  const signatureBytes = canonicalBase64Url(signature, 64, 64);
  if (!payload || !signatureBytes) return withheld('signature-invalid');
  let verified = false;
  try { verified = verifySignature(null, payload, publicKey, signatureBytes); } catch { /* withheld */ }
  if (!verified) return withheld('signature-invalid');

  return {
    schemaVersion: 1,
    mode: 'verifier-execution-authority-observation-v2',
    state: 'statement-verified',
    reason: 'statement-verified',
    authority: 'observation-only',
    executionPermitted: false,
    mergePermitted: false,
    evidencePermitted: false,
    statementDigest: sha256(Buffer.concat([
      Buffer.from(`${STATEMENT_DIGEST_DOMAIN}\0`, 'utf8'), payload, signatureBytes,
    ])),
    trustPolicyDigest: policyDigest,
    keyId: statement.keyId,
    platform: statement.platform,
    architecture: statement.architecture,
    backend: statement.backend,
    commandCount: statement.commandEntrypoints.length,
    signatureVerified: true,
    trustPolicyApprovalVerified: false,
    liveImmutabilityVerified: false,
    replayTransparencyVerified: false,
    executionWiringVerified: false,
    blockers: VERIFIER_EXECUTION_AUTHORITY_BLOCKERS_V1,
  };
}
