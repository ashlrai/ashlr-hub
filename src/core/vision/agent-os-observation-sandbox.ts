/**
 * Backend-neutral, fail-closed isolation contract for Agent OS observation producers.
 *
 * This module does not create a sandbox, launch a process, provision keys, or
 * activate M562. It authenticates a narrow request/response protocol and admits
 * an `enforced` result only when a separately trusted verifier authenticates a
 * fresh backend attestation for every required isolation property.
 *
 * Node's Permission Model is useful defense in depth, but Node explicitly does
 * not treat it as a malicious-code security boundary. A permission-only backend
 * therefore remains `seatbelt-only` even if it claims every control below.
 */

import { createHash } from 'node:crypto';

export const AGENT_OS_OBSERVATION_SANDBOX_PROTOCOL_V1 =
  'ashlr-agent-os-observation-sandbox-v1' as const;
export const AGENT_OS_OBSERVATION_SANDBOX_MAX_DURATION_MS_V1 = 5 * 60_000;
export const AGENT_OS_OBSERVATION_SANDBOX_MAX_INPUT_BYTES_V1 = 2 * 1024 * 1024;
export const AGENT_OS_OBSERVATION_SANDBOX_MAX_OUTPUT_BYTES_V1 = 2 * 1024 * 1024;
export const AGENT_OS_OBSERVATION_SANDBOX_MAX_ATTESTATION_LIFETIME_MS_V1 = 5 * 60_000;
export const AGENT_OS_OBSERVATION_SANDBOX_MAX_FUTURE_SKEW_MS_V1 = 5_000;

const ATTESTATION_DOMAIN = 'ashlr:agent-os:observation-sandbox:attestation:v1\0';
const REQUEST_DOMAIN = 'ashlr:agent-os:observation-sandbox:request:v1\0';
const RESPONSE_DOMAIN = 'ashlr:agent-os:observation-sandbox:response:v1\0';
const RAW_SHA256_RE = /^[a-f0-9]{64}$/u;
const PREFIXED_SHA256_RE = /^sha256:[a-f0-9]{64}$/u;

const NO_AUTHORITY = Object.freeze({
  authority: 'observation-only' as const,
  executionAuthority: false as const,
  effectAuthority: false as const,
  externalMutationAuthority: false as const,
  credentialAuthority: false as const,
  commissioningAuthority: false as const,
  activationAuthority: false as const,
  sandboxProvisioningAuthority: false as const,
});

export type AgentOsObservationSandboxBackendKindV1 =
  | 'macos-sandbox-exec'
  | 'local-container'
  | 'local-vm'
  | 'custom-isolator'
  | 'node-permission-seatbelt';

export interface AgentOsObservationSandboxControlsV1 {
  processIsolated: boolean;
  untrustedCodeIsolation: boolean;
  networkDenied: boolean;
  filesystemReadRestricted: boolean;
  filesystemWriteDenied: boolean;
  environmentSanitized: boolean;
  hostIpcDenied: boolean;
  childProcessDenied: boolean;
  workerThreadsDenied: boolean;
  nativeAddonsDenied: boolean;
  wasiDenied: boolean;
  inspectorDenied: boolean;
  deadlineKillEnforced: boolean;
  outputLimitEnforced: boolean;
  processIdentityBound: boolean;
}

export interface AgentOsObservationSandboxAttestationV1 {
  schemaVersion: 1;
  protocol: typeof AGENT_OS_OBSERVATION_SANDBOX_PROTOCOL_V1;
  backendKind: AgentOsObservationSandboxBackendKindV1;
  backendIdentityDigest: string;
  policyDigest: string;
  hostPlatform: string;
  generatedAt: string;
  expiresAt: string;
  controls: AgentOsObservationSandboxControlsV1;
  attestationKeyId: string;
  authenticator: string;
}

export interface AgentOsObservationSandboxAttestationVerifierV1 {
  keyId: string;
  verify(input: Readonly<{
    canonicalDomainSeparatedAttestation: Uint8Array;
    authenticator: string;
  }>): boolean;
}

export type AgentOsObservationSandboxPreflightReasonV1 =
  | 'invalid-attestation'
  | 'attestation-future'
  | 'attestation-expired'
  | 'attestation-lifetime-exceeded'
  | 'backend-identity-mismatch'
  | 'policy-mismatch'
  | 'attestation-key-mismatch'
  | 'attestation-authentication-failed'
  | 'attestation-verifier-mutated-input'
  | 'node-permission-is-seatbelt-only'
  | 'process-isolation-not-proven'
  | 'untrusted-code-isolation-not-proven'
  | 'network-denial-not-proven'
  | 'filesystem-read-restriction-not-proven'
  | 'filesystem-write-denial-not-proven'
  | 'environment-sanitization-not-proven'
  | 'host-ipc-denial-not-proven'
  | 'child-process-denial-not-proven'
  | 'worker-denial-not-proven'
  | 'native-addon-denial-not-proven'
  | 'wasi-denial-not-proven'
  | 'inspector-denial-not-proven'
  | 'deadline-kill-not-proven'
  | 'output-limit-not-proven'
  | 'process-identity-binding-not-proven';

export interface AgentOsObservationSandboxPreflightV1 {
  state: 'enforced' | 'seatbelt-only' | 'blocked';
  enforced: boolean;
  backendIdentityDigest: string | null;
  policyDigest: string | null;
  attestationDigest: string | null;
  stopReasons: readonly AgentOsObservationSandboxPreflightReasonV1[];
  authority: 'observation-only';
  executionAuthority: false;
  effectAuthority: false;
  externalMutationAuthority: false;
  credentialAuthority: false;
  commissioningAuthority: false;
  activationAuthority: false;
  sandboxProvisioningAuthority: false;
}

export interface AgentOsObservationSandboxFrameSignerV1 {
  keyId: string;
  authenticate(canonicalDomainSeparatedFrame: Uint8Array): string;
}

export interface AgentOsObservationSandboxFrameVerifierV1 {
  keyId: string;
  verify(input: Readonly<{
    canonicalDomainSeparatedFrame: Uint8Array;
    authenticator: string;
  }>): boolean;
}

export interface AgentOsObservationSandboxRequestPolicyV1 {
  network: 'deny';
  filesystemRead: 'runtime-and-input-only';
  filesystemWrite: 'deny';
  environment: 'minimal';
  hostIpc: 'deny';
  childProcess: 'deny';
  workerThreads: 'deny';
  nativeAddons: 'deny';
  wasi: 'deny';
  inspector: 'deny';
}

export const AGENT_OS_OBSERVATION_SANDBOX_DENY_POLICY_V1:
Readonly<AgentOsObservationSandboxRequestPolicyV1> = Object.freeze({
  network: 'deny',
  filesystemRead: 'runtime-and-input-only',
  filesystemWrite: 'deny',
  environment: 'minimal',
  hostIpc: 'deny',
  childProcess: 'deny',
  workerThreads: 'deny',
  nativeAddons: 'deny',
  wasi: 'deny',
  inspector: 'deny',
});

export interface AgentOsObservationSandboxRequestV1 {
  schemaVersion: 1;
  protocol: typeof AGENT_OS_OBSERVATION_SANDBOX_PROTOCOL_V1;
  requestId: string;
  requestNonce: string;
  epoch: number;
  durableTickDigest: string;
  attemptId: string;
  startReceiptDigest: string;
  issuedAt: string;
  deadlineAt: string;
  maxOutputBytes: number;
  backendIdentityDigest: string;
  policyDigest: string;
  inputBytes: number;
  inputDigest: string;
  inputBase64: string;
  policy: AgentOsObservationSandboxRequestPolicyV1;
  frameKeyId: string;
  requestDigest: string;
  authenticator: string;
}

export interface AgentOsObservationSandboxProcessIdentityV1 {
  pid: number;
  executableDigest: string;
  instanceNonce: string;
  launchedAt: string;
}

export interface AgentOsObservationSandboxResponseV1 {
  schemaVersion: 1;
  protocol: typeof AGENT_OS_OBSERVATION_SANDBOX_PROTOCOL_V1;
  requestId: string;
  requestDigest: string;
  backendIdentityDigest: string;
  policyDigest: string;
  outcome: 'succeeded' | 'failed' | 'timed-out' | 'output-limit-exceeded';
  process: AgentOsObservationSandboxProcessIdentityV1;
  finishedAt: string;
  outputBytes: number;
  outputDigest: string;
  outputBase64: string;
  frameKeyId: string;
  responseDigest: string;
  authenticator: string;
}

export interface AgentOsObservationSandboxBackendV1 {
  readAttestation(): AgentOsObservationSandboxAttestationV1 | null;
  execute(request: Readonly<AgentOsObservationSandboxRequestV1>):
    AgentOsObservationSandboxResponseV1 | null;
}

export interface RunAgentOsObservationSandboxInputV1 {
  requestId: string;
  requestNonce: string;
  epoch: number;
  durableTickDigest: string;
  attemptId: string;
  startReceiptDigest: string;
  issuedAt: string;
  deadlineAt: string;
  maxOutputBytes: number;
  inputBytes: number;
  inputDigest: string;
  inputBase64: string;
}

export interface AgentOsObservationSandboxDependenciesV1 {
  expectedBackendIdentityDigest: string;
  expectedPolicyDigest: string;
  attestationVerifier: AgentOsObservationSandboxAttestationVerifierV1;
  requestSigner: AgentOsObservationSandboxFrameSignerV1;
  responseVerifier: AgentOsObservationSandboxFrameVerifierV1;
  backend: AgentOsObservationSandboxBackendV1;
  now(): number;
}

export type AgentOsObservationSandboxRunReasonV1 =
  | 'succeeded'
  | 'invalid-input'
  | 'invalid-dependencies'
  | 'backend-not-enforced'
  | 'attestation-drift'
  | 'request-authentication-failed'
  | 'backend-failed'
  | 'backend-mutated-request'
  | 'invalid-response'
  | 'response-authentication-failed'
  | 'deadline-exceeded'
  | 'output-limit-exceeded'
  | 'producer-failed';

export interface AgentOsObservationSandboxRunResultV1 {
  state: 'completed' | 'withheld';
  reason: AgentOsObservationSandboxRunReasonV1;
  enforced: boolean;
  requestDigest: string | null;
  responseDigest: string | null;
  output: Uint8Array | null;
  process: Readonly<AgentOsObservationSandboxProcessIdentityV1> | null;
  preflight: Readonly<AgentOsObservationSandboxPreflightV1> | null;
  authority: 'observation-only';
  executionAuthority: false;
  effectAuthority: false;
  externalMutationAuthority: false;
  credentialAuthority: false;
  commissioningAuthority: false;
  activationAuthority: false;
  sandboxProvisioningAuthority: false;
}

const CONTROL_KEYS = [
  'childProcessDenied', 'deadlineKillEnforced', 'environmentSanitized',
  'filesystemReadRestricted', 'filesystemWriteDenied', 'hostIpcDenied', 'inspectorDenied',
  'nativeAddonsDenied', 'networkDenied', 'outputLimitEnforced', 'processIdentityBound',
  'processIsolated', 'untrustedCodeIsolation', 'wasiDenied', 'workerThreadsDenied',
] as const;
const ATTESTATION_KEYS = [
  'attestationKeyId', 'authenticator', 'backendIdentityDigest', 'backendKind', 'controls',
  'expiresAt', 'generatedAt', 'hostPlatform', 'policyDigest', 'protocol', 'schemaVersion',
] as const;
const REQUEST_UNSIGNED_KEYS = [
  'backendIdentityDigest', 'deadlineAt', 'durableTickDigest', 'epoch', 'inputBase64',
  'inputBytes', 'inputDigest', 'issuedAt', 'maxOutputBytes', 'policy', 'policyDigest', 'protocol', 'requestId',
  'requestNonce', 'schemaVersion', 'startReceiptDigest', 'attemptId',
] as const;
const REQUEST_KEYS = [...REQUEST_UNSIGNED_KEYS, 'authenticator', 'frameKeyId', 'requestDigest'] as const;
const POLICY_KEYS = [
  'childProcess', 'environment', 'filesystemRead', 'filesystemWrite', 'hostIpc',
  'inspector', 'nativeAddons', 'network', 'wasi', 'workerThreads',
] as const;
const PROCESS_KEYS = ['executableDigest', 'instanceNonce', 'launchedAt', 'pid'] as const;
const RESPONSE_UNSIGNED_KEYS = [
  'backendIdentityDigest', 'finishedAt', 'outcome', 'outputBase64', 'outputBytes',
  'outputDigest', 'policyDigest', 'process', 'protocol', 'requestDigest', 'requestId',
  'schemaVersion',
] as const;
const RESPONSE_KEYS = [...RESPONSE_UNSIGNED_KEYS, 'authenticator', 'frameKeyId', 'responseDigest'] as const;

function plainRecord(value: unknown): Record<string, unknown> | null {
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

function digest(domain: string, value: unknown): string {
  return createHash('sha256').update(domain, 'utf8').update(canonicalJson(value), 'utf8').digest('hex');
}

function domainBytes(domain: string, value: unknown): Buffer {
  return Buffer.from(`${domain}${canonicalJson(value)}`, 'utf8');
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function rawDigest(value: unknown): value is string {
  return typeof value === 'string' && RAW_SHA256_RE.test(value);
}

function validAttestationVerifier(
  value: unknown,
): value is AgentOsObservationSandboxAttestationVerifierV1 {
  const row = plainRecord(value);
  return Boolean(row && exactKeys(row, ['keyId', 'verify']) && rawDigest(row['keyId']) &&
    typeof row['verify'] === 'function');
}

function validFrameSigner(value: unknown): value is AgentOsObservationSandboxFrameSignerV1 {
  const row = plainRecord(value);
  return Boolean(row && exactKeys(row, ['authenticate', 'keyId']) && rawDigest(row['keyId']) &&
    typeof row['authenticate'] === 'function');
}

function validFrameVerifier(value: unknown): value is AgentOsObservationSandboxFrameVerifierV1 {
  const row = plainRecord(value);
  return Boolean(row && exactKeys(row, ['keyId', 'verify']) && rawDigest(row['keyId']) &&
    typeof row['verify'] === 'function');
}

function prefixedDigest(value: unknown): value is string {
  return typeof value === 'string' && PREFIXED_SHA256_RE.test(value);
}

function cloneBytes(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.compare(cloneBytes(left), cloneBytes(right)) === 0;
}

function immutable<T>(value: T, seen = new WeakSet<object>()): T {
  if (ArrayBuffer.isView(value)) return value;
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const nested of Object.values(value as Record<string, unknown>)) immutable(nested, seen);
    Object.freeze(value);
  }
  return value;
}

function validControls(value: unknown): value is AgentOsObservationSandboxControlsV1 {
  const row = plainRecord(value);
  return Boolean(row && exactKeys(row, CONTROL_KEYS) && CONTROL_KEYS.every((key) =>
    typeof row[key] === 'boolean'));
}

function unsignedAttestation(value: AgentOsObservationSandboxAttestationV1): Omit<
AgentOsObservationSandboxAttestationV1, 'authenticator'> {
  const { authenticator: _authenticator, ...unsigned } = value;
  return unsigned;
}

/** Canonical bytes a commissioned backend asks its attestation key to authenticate. */
export function canonicalAgentOsObservationSandboxAttestationAuthenticatorBytesV1(
  value: unknown,
): Buffer | null {
  return validAttestation(value)
    ? domainBytes(ATTESTATION_DOMAIN, unsignedAttestation(value))
    : null;
}

function validAttestation(value: unknown): value is AgentOsObservationSandboxAttestationV1 {
  const row = plainRecord(value);
  return Boolean(row && exactKeys(row, ATTESTATION_KEYS) && row['schemaVersion'] === 1 &&
    row['protocol'] === AGENT_OS_OBSERVATION_SANDBOX_PROTOCOL_V1 &&
    ['macos-sandbox-exec', 'local-container', 'local-vm', 'custom-isolator',
      'node-permission-seatbelt'].includes(String(row['backendKind'])) &&
    rawDigest(row['backendIdentityDigest']) && rawDigest(row['policyDigest']) &&
    typeof row['hostPlatform'] === 'string' && row['hostPlatform'].length > 0 &&
    row['hostPlatform'].length <= 32 && timestamp(row['generatedAt']) && timestamp(row['expiresAt']) &&
    validControls(row['controls']) && rawDigest(row['attestationKeyId']) && rawDigest(row['authenticator']));
}

function stoppedPreflight(
  state: AgentOsObservationSandboxPreflightV1['state'],
  reasons: AgentOsObservationSandboxPreflightReasonV1[],
  attestation: AgentOsObservationSandboxAttestationV1 | null = null,
): AgentOsObservationSandboxPreflightV1 {
  return immutable({
    state,
    enforced: false,
    backendIdentityDigest: attestation?.backendIdentityDigest ?? null,
    policyDigest: attestation?.policyDigest ?? null,
    attestationDigest: attestation ? digest(ATTESTATION_DOMAIN, unsignedAttestation(attestation)) : null,
    stopReasons: [...new Set(reasons)],
    ...NO_AUTHORITY,
  });
}

/** Authenticate a fresh backend claim. This function performs no host probing or commissioning. */
export function compileAgentOsObservationSandboxPreflightV1(
  value: unknown,
  expected: Readonly<{ backendIdentityDigest: string; policyDigest: string; nowMs: number }>,
  verifier: AgentOsObservationSandboxAttestationVerifierV1,
): AgentOsObservationSandboxPreflightV1 {
  if (!validAttestation(value) || !rawDigest(expected.backendIdentityDigest) ||
    !rawDigest(expected.policyDigest) || !Number.isSafeInteger(expected.nowMs) ||
    !validAttestationVerifier(verifier)) return stoppedPreflight('blocked', ['invalid-attestation']);
  const attestation = value;
  const reasons: AgentOsObservationSandboxPreflightReasonV1[] = [];
  const generated = Date.parse(attestation.generatedAt);
  const expires = Date.parse(attestation.expiresAt);
  if (generated > expected.nowMs + AGENT_OS_OBSERVATION_SANDBOX_MAX_FUTURE_SKEW_MS_V1) {
    reasons.push('attestation-future');
  }
  if (expires <= expected.nowMs) reasons.push('attestation-expired');
  if (expires <= generated ||
    expires - generated > AGENT_OS_OBSERVATION_SANDBOX_MAX_ATTESTATION_LIFETIME_MS_V1) {
    reasons.push('attestation-lifetime-exceeded');
  }
  if (attestation.backendIdentityDigest !== expected.backendIdentityDigest) {
    reasons.push('backend-identity-mismatch');
  }
  if (attestation.policyDigest !== expected.policyDigest) reasons.push('policy-mismatch');
  if (attestation.attestationKeyId !== verifier.keyId) reasons.push('attestation-key-mismatch');
  const bytes = domainBytes(ATTESTATION_DOMAIN, unsignedAttestation(attestation));
  const callbackBytes = Buffer.from(bytes);
  let verified = false;
  try {
    verified = verifier.verify(immutable({
      canonicalDomainSeparatedAttestation: callbackBytes,
      authenticator: attestation.authenticator,
    })) === true;
  } catch {
    verified = false;
  }
  if (!equalBytes(bytes, callbackBytes)) reasons.push('attestation-verifier-mutated-input');
  else if (!verified) reasons.push('attestation-authentication-failed');
  const controls = attestation.controls;
  const required: readonly [keyof AgentOsObservationSandboxControlsV1,
    AgentOsObservationSandboxPreflightReasonV1][] = [
    ['processIsolated', 'process-isolation-not-proven'],
    ['untrustedCodeIsolation', 'untrusted-code-isolation-not-proven'],
    ['networkDenied', 'network-denial-not-proven'],
    ['filesystemReadRestricted', 'filesystem-read-restriction-not-proven'],
    ['filesystemWriteDenied', 'filesystem-write-denial-not-proven'],
    ['environmentSanitized', 'environment-sanitization-not-proven'],
    ['hostIpcDenied', 'host-ipc-denial-not-proven'],
    ['childProcessDenied', 'child-process-denial-not-proven'],
    ['workerThreadsDenied', 'worker-denial-not-proven'],
    ['nativeAddonsDenied', 'native-addon-denial-not-proven'],
    ['wasiDenied', 'wasi-denial-not-proven'],
    ['inspectorDenied', 'inspector-denial-not-proven'],
    ['deadlineKillEnforced', 'deadline-kill-not-proven'],
    ['outputLimitEnforced', 'output-limit-not-proven'],
    ['processIdentityBound', 'process-identity-binding-not-proven'],
  ];
  for (const [key, reason] of required) if (!controls[key]) reasons.push(reason);
  if (attestation.backendKind === 'node-permission-seatbelt') {
    reasons.push('node-permission-is-seatbelt-only');
    return stoppedPreflight('seatbelt-only', reasons, attestation);
  }
  if (reasons.length > 0) return stoppedPreflight('blocked', reasons, attestation);
  return immutable({
    state: 'enforced' as const,
    enforced: true as const,
    backendIdentityDigest: attestation.backendIdentityDigest,
    policyDigest: attestation.policyDigest,
    attestationDigest: digest(ATTESTATION_DOMAIN, unsignedAttestation(attestation)),
    stopReasons: [] as readonly AgentOsObservationSandboxPreflightReasonV1[],
    ...NO_AUTHORITY,
  });
}

function validRequestInput(value: unknown): value is RunAgentOsObservationSandboxInputV1 {
  const row = plainRecord(value);
  const keys = [
    'attemptId', 'deadlineAt', 'durableTickDigest', 'epoch', 'inputBase64', 'inputBytes',
    'inputDigest', 'issuedAt', 'maxOutputBytes', 'requestId', 'requestNonce', 'startReceiptDigest',
  ];
  if (!row || !exactKeys(row, keys) || !rawDigest(row['requestId']) ||
    !rawDigest(row['requestNonce']) || !Number.isSafeInteger(row['epoch']) ||
    (row['epoch'] as number) < 1 || (row['epoch'] as number) > 999_999_999_999 ||
    !prefixedDigest(row['durableTickDigest']) || !prefixedDigest(row['attemptId']) ||
    !rawDigest(row['startReceiptDigest']) ||
    !timestamp(row['issuedAt']) || !timestamp(row['deadlineAt']) ||
    !Number.isSafeInteger(row['inputBytes']) || (row['inputBytes'] as number) < 0 ||
    (row['inputBytes'] as number) > AGENT_OS_OBSERVATION_SANDBOX_MAX_INPUT_BYTES_V1 ||
    !Number.isSafeInteger(row['maxOutputBytes']) || (row['maxOutputBytes'] as number) < 1 ||
    (row['maxOutputBytes'] as number) > AGENT_OS_OBSERVATION_SANDBOX_MAX_OUTPUT_BYTES_V1 ||
    !rawDigest(row['inputDigest'])) return false;
  const inputBytes = decodeCanonicalBase64(row['inputBase64'], row['inputBytes'] as number);
  if (!inputBytes || createHash('sha256').update(inputBytes).digest('hex') !== row['inputDigest']) {
    return false;
  }
  const issued = Date.parse(row['issuedAt'] as string);
  const deadline = Date.parse(row['deadlineAt'] as string);
  return deadline > issued && deadline - issued <= AGENT_OS_OBSERVATION_SANDBOX_MAX_DURATION_MS_V1;
}

function validDependencies(value: unknown): value is AgentOsObservationSandboxDependenciesV1 {
  const row = plainRecord(value);
  if (!row || !exactKeys(row, [
    'attestationVerifier', 'backend', 'expectedBackendIdentityDigest', 'expectedPolicyDigest',
    'now', 'requestSigner', 'responseVerifier',
  ]) || !rawDigest(row['expectedBackendIdentityDigest']) || !rawDigest(row['expectedPolicyDigest']) ||
    typeof row['now'] !== 'function') return false;
  const attestationVerifier = plainRecord(row['attestationVerifier']);
  const requestSigner = plainRecord(row['requestSigner']);
  const responseVerifier = plainRecord(row['responseVerifier']);
  const backend = plainRecord(row['backend']);
  return Boolean(attestationVerifier && exactKeys(attestationVerifier, ['keyId', 'verify']) &&
    rawDigest(attestationVerifier['keyId']) && typeof attestationVerifier['verify'] === 'function' &&
    requestSigner && exactKeys(requestSigner, ['authenticate', 'keyId']) &&
    rawDigest(requestSigner['keyId']) && typeof requestSigner['authenticate'] === 'function' &&
    responseVerifier && exactKeys(responseVerifier, ['keyId', 'verify']) &&
    rawDigest(responseVerifier['keyId']) && typeof responseVerifier['verify'] === 'function' &&
    attestationVerifier['keyId'] !== requestSigner['keyId'] &&
    attestationVerifier['keyId'] !== responseVerifier['keyId'] &&
    requestSigner['keyId'] !== responseVerifier['keyId'] &&
    backend && exactKeys(backend, ['execute', 'readAttestation']) &&
    typeof backend['execute'] === 'function' && typeof backend['readAttestation'] === 'function');
}

type UnsignedRequest = Omit<AgentOsObservationSandboxRequestV1,
'authenticator' | 'frameKeyId' | 'requestDigest'>;

type AgentOsObservationSandboxRequestCreationDependenciesV1 = Pick<
AgentOsObservationSandboxDependenciesV1,
'expectedBackendIdentityDigest' | 'expectedPolicyDigest' | 'requestSigner'>;

function unsignedRequest(input: RunAgentOsObservationSandboxInputV1,
  dependencies: AgentOsObservationSandboxRequestCreationDependenciesV1): UnsignedRequest {
  return {
    schemaVersion: 1,
    protocol: AGENT_OS_OBSERVATION_SANDBOX_PROTOCOL_V1,
    requestId: input.requestId,
    requestNonce: input.requestNonce,
    epoch: input.epoch,
    durableTickDigest: input.durableTickDigest,
    attemptId: input.attemptId,
    startReceiptDigest: input.startReceiptDigest,
    issuedAt: input.issuedAt,
    deadlineAt: input.deadlineAt,
    maxOutputBytes: input.maxOutputBytes,
    backendIdentityDigest: dependencies.expectedBackendIdentityDigest,
    policyDigest: dependencies.expectedPolicyDigest,
    inputBytes: input.inputBytes,
    inputDigest: input.inputDigest,
    inputBase64: input.inputBase64,
    policy: { ...AGENT_OS_OBSERVATION_SANDBOX_DENY_POLICY_V1 },
  };
}

/** Controller-side authenticated request framing for asynchronous isolation adapters. */
export function createAgentOsObservationSandboxRequestV1(
  input: RunAgentOsObservationSandboxInputV1,
  dependencies: AgentOsObservationSandboxRequestCreationDependenciesV1,
): AgentOsObservationSandboxRequestV1 | null {
  const unsigned = unsignedRequest(input, dependencies);
  const requestDigest = digest(REQUEST_DOMAIN, unsigned);
  const bytes = domainBytes(REQUEST_DOMAIN, unsigned);
  const callbackBytes = Buffer.from(bytes);
  try {
    const authenticator = dependencies.requestSigner.authenticate(callbackBytes);
    if (!equalBytes(bytes, callbackBytes) || !rawDigest(authenticator)) return null;
    return immutable({
      ...unsigned,
      frameKeyId: dependencies.requestSigner.keyId,
      requestDigest,
      authenticator,
    });
  } catch {
    return null;
  }
}

function validPolicy(value: unknown): value is AgentOsObservationSandboxRequestPolicyV1 {
  const row = plainRecord(value);
  return Boolean(row && exactKeys(row, POLICY_KEYS) && row['network'] === 'deny' &&
    row['filesystemRead'] === 'runtime-and-input-only' && row['filesystemWrite'] === 'deny' &&
    row['environment'] === 'minimal' && row['hostIpc'] === 'deny' &&
    row['childProcess'] === 'deny' && row['workerThreads'] === 'deny' &&
    row['nativeAddons'] === 'deny' && row['wasi'] === 'deny' && row['inspector'] === 'deny');
}

function validRequest(value: unknown): value is AgentOsObservationSandboxRequestV1 {
  const row = plainRecord(value);
  if (!row || !exactKeys(row, REQUEST_KEYS) || row['schemaVersion'] !== 1 ||
    row['protocol'] !== AGENT_OS_OBSERVATION_SANDBOX_PROTOCOL_V1 || !validPolicy(row['policy']) ||
    !rawDigest(row['frameKeyId']) || !rawDigest(row['requestDigest']) ||
    !rawDigest(row['authenticator'])) return false;
  const unsigned = Object.fromEntries(REQUEST_UNSIGNED_KEYS.map((key) => [key, row[key]]));
  return validRequestInput({
    requestId: row['requestId'], requestNonce: row['requestNonce'], epoch: row['epoch'],
    durableTickDigest: row['durableTickDigest'], attemptId: row['attemptId'],
    startReceiptDigest: row['startReceiptDigest'], issuedAt: row['issuedAt'],
    deadlineAt: row['deadlineAt'], maxOutputBytes: row['maxOutputBytes'],
    inputBytes: row['inputBytes'], inputDigest: row['inputDigest'], inputBase64: row['inputBase64'],
  }) && digest(REQUEST_DOMAIN, unsigned) === row['requestDigest'];
}

/** Backend-side request authentication helper. It rejects verifier input mutation. */
export function verifyAgentOsObservationSandboxRequestV1(
  value: unknown,
  verifier: AgentOsObservationSandboxFrameVerifierV1,
): AgentOsObservationSandboxRequestV1 | null {
  if (!validRequest(value) || !validFrameVerifier(verifier) || value.frameKeyId !== verifier.keyId) {
    return null;
  }
  const unsigned = Object.fromEntries(REQUEST_UNSIGNED_KEYS.map((key) => [key, value[key]]));
  const bytes = domainBytes(REQUEST_DOMAIN, unsigned);
  const callbackBytes = Buffer.from(bytes);
  try {
    const verified = verifier.verify(immutable({
      canonicalDomainSeparatedFrame: callbackBytes,
      authenticator: value.authenticator,
    })) === true;
    return verified && equalBytes(bytes, callbackBytes) ? immutable({ ...value }) : null;
  } catch {
    return null;
  }
}

/** Exact newline-delimited JSON frame sent over the native producer's stdin. */
export function canonicalAgentOsObservationSandboxRequestFrameBytesV1(value: unknown): Buffer | null {
  return validRequest(value) ? Buffer.from(`${canonicalJson(value)}\n`, 'utf8') : null;
}

export type AgentOsObservationSandboxUnsignedResponseV1 = Omit<AgentOsObservationSandboxResponseV1,
'authenticator' | 'frameKeyId' | 'responseDigest'>;

function validProcess(value: unknown): value is AgentOsObservationSandboxProcessIdentityV1 {
  const row = plainRecord(value);
  return Boolean(row && exactKeys(row, PROCESS_KEYS) && Number.isSafeInteger(row['pid']) &&
    (row['pid'] as number) > 0 && rawDigest(row['executableDigest']) &&
    rawDigest(row['instanceNonce']) && timestamp(row['launchedAt']));
}

function decodeCanonicalBase64(value: unknown, expectedBytes: number): Buffer | null {
  if (typeof value !== 'string' || value.length > Math.ceil(expectedBytes / 3) * 4 + 4) return null;
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.byteLength === expectedBytes && decoded.toString('base64') === value ? decoded : null;
  } catch {
    return null;
  }
}

function unsignedResponse(value: AgentOsObservationSandboxResponseV1):
AgentOsObservationSandboxUnsignedResponseV1 {
  const { authenticator: _authenticator, frameKeyId: _frameKeyId,
    responseDigest: _responseDigest, ...unsigned } = value;
  return unsigned;
}

/** Backend-side response framing helper. It does not establish backend trust. */
export function createAgentOsObservationSandboxResponseV1(
  value: AgentOsObservationSandboxUnsignedResponseV1,
  signer: AgentOsObservationSandboxFrameSignerV1,
): AgentOsObservationSandboxResponseV1 | null {
  const row = plainRecord(value);
  if (!row || !exactKeys(row, RESPONSE_UNSIGNED_KEYS) || !validFrameSigner(signer)) return null;
  const provisional = {
    ...value,
    frameKeyId: signer.keyId,
    responseDigest: digest(RESPONSE_DOMAIN, value),
    authenticator: '0'.repeat(64),
  };
  const requestShape = {
    requestId: value.requestId,
    requestDigest: value.requestDigest,
    backendIdentityDigest: value.backendIdentityDigest,
    policyDigest: value.policyDigest,
    maxOutputBytes: AGENT_OS_OBSERVATION_SANDBOX_MAX_OUTPUT_BYTES_V1,
    issuedAt: value.process.launchedAt,
  };
  if (!validateResponse(provisional, requestShape as AgentOsObservationSandboxRequestV1)) return null;
  const bytes = domainBytes(RESPONSE_DOMAIN, value);
  const callbackBytes = Buffer.from(bytes);
  try {
    const authenticator = signer.authenticate(callbackBytes);
    if (!equalBytes(bytes, callbackBytes) || !rawDigest(authenticator)) return null;
    return immutable({ ...provisional, authenticator });
  } catch {
    return null;
  }
}

function validateResponse(
  value: unknown,
  request: AgentOsObservationSandboxRequestV1,
): { response: AgentOsObservationSandboxResponseV1; output: Buffer } | null {
  const row = plainRecord(value);
  if (!row || !exactKeys(row, RESPONSE_KEYS) || row['schemaVersion'] !== 1 ||
    row['protocol'] !== AGENT_OS_OBSERVATION_SANDBOX_PROTOCOL_V1 ||
    row['requestId'] !== request.requestId || row['requestDigest'] !== request.requestDigest ||
    row['backendIdentityDigest'] !== request.backendIdentityDigest ||
    row['policyDigest'] !== request.policyDigest ||
    !['succeeded', 'failed', 'timed-out', 'output-limit-exceeded'].includes(String(row['outcome'])) ||
    !validProcess(row['process']) || !timestamp(row['finishedAt']) ||
    !Number.isSafeInteger(row['outputBytes']) || (row['outputBytes'] as number) < 0 ||
    (row['outputBytes'] as number) > request.maxOutputBytes || !rawDigest(row['outputDigest']) ||
    !rawDigest(row['frameKeyId']) || !rawDigest(row['responseDigest']) ||
    !rawDigest(row['authenticator'])) return null;
  const output = decodeCanonicalBase64(row['outputBase64'], row['outputBytes'] as number);
  if (!output || createHash('sha256').update(output).digest('hex') !== row['outputDigest']) return null;
  const response = value as AgentOsObservationSandboxResponseV1;
  const unsigned = unsignedResponse(response);
  if (digest(RESPONSE_DOMAIN, unsigned) !== response.responseDigest ||
    Date.parse(response.process.launchedAt) < Date.parse(request.issuedAt) -
      AGENT_OS_OBSERVATION_SANDBOX_MAX_FUTURE_SKEW_MS_V1 ||
    Date.parse(response.finishedAt) < Date.parse(response.process.launchedAt)) return null;
  return { response, output };
}

function pinValidatedResponse(
  value: { response: AgentOsObservationSandboxResponseV1; output: Buffer },
): Readonly<{ response: AgentOsObservationSandboxResponseV1; output: Buffer }> {
  return Object.freeze({
    response: immutable({
      ...value.response,
      process: { ...value.response.process },
    }),
    output: Buffer.from(value.output),
  });
}

/**
 * Controller-side response authentication for asynchronous isolation adapters.
 * The returned frame and bytes are owned snapshots; verifier mutation is denied.
 */
export function verifyAgentOsObservationSandboxResponseV1(
  value: unknown,
  request: AgentOsObservationSandboxRequestV1,
  verifier: AgentOsObservationSandboxFrameVerifierV1,
): Readonly<{ response: AgentOsObservationSandboxResponseV1; output: Uint8Array }> | null {
  const validated = validateResponse(value, request);
  if (!validated || !validFrameVerifier(verifier) || validated.response.frameKeyId !== verifier.keyId) {
    return null;
  }
  const pinned = pinValidatedResponse(validated);
  const signedBytes = domainBytes(RESPONSE_DOMAIN, unsignedResponse(pinned.response));
  const callbackBytes = Buffer.from(signedBytes);
  let authenticated = false;
  try {
    authenticated = verifier.verify(immutable({
      canonicalDomainSeparatedFrame: callbackBytes,
      authenticator: pinned.response.authenticator,
    })) === true;
  } catch {
    authenticated = false;
  }
  if (!equalBytes(signedBytes, callbackBytes) || !authenticated) return null;
  return Object.freeze({ response: pinned.response, output: Buffer.from(pinned.output) });
}

function sameAttestation(left: AgentOsObservationSandboxPreflightV1,
  right: AgentOsObservationSandboxPreflightV1): boolean {
  return left.enforced && right.enforced && left.attestationDigest === right.attestationDigest &&
    left.backendIdentityDigest === right.backendIdentityDigest && left.policyDigest === right.policyDigest;
}

function runResult(
  state: AgentOsObservationSandboxRunResultV1['state'],
  reason: AgentOsObservationSandboxRunReasonV1,
  values: Partial<Pick<AgentOsObservationSandboxRunResultV1,
    'requestDigest' | 'responseDigest' | 'output' | 'process' | 'preflight'>> = {},
): AgentOsObservationSandboxRunResultV1 {
  return immutable({
    state,
    reason,
    enforced: state === 'completed',
    requestDigest: values.requestDigest ?? null,
    responseDigest: values.responseDigest ?? null,
    output: values.output ?? null,
    process: values.process ?? null,
    preflight: values.preflight ?? null,
    ...NO_AUTHORITY,
  });
}

/**
 * Execute through an injected local backend only after its exact isolation
 * policy is freshly authenticated. The backend, not this coordinator, must
 * enforce process termination and output collection limits.
 */
export function runAgentOsObservationSandboxV1(
  input: RunAgentOsObservationSandboxInputV1,
  dependencies: AgentOsObservationSandboxDependenciesV1,
): AgentOsObservationSandboxRunResultV1 {
  if (!validRequestInput(input)) return runResult('withheld', 'invalid-input');
  if (!validDependencies(dependencies)) return runResult('withheld', 'invalid-dependencies');
  let now: number;
  let firstAttestation: AgentOsObservationSandboxAttestationV1 | null;
  try {
    now = dependencies.now();
    firstAttestation = dependencies.backend.readAttestation();
  } catch {
    return runResult('withheld', 'backend-not-enforced');
  }
  if (!Number.isSafeInteger(now) || now < Date.parse(input.issuedAt) -
    AGENT_OS_OBSERVATION_SANDBOX_MAX_FUTURE_SKEW_MS_V1 || now >= Date.parse(input.deadlineAt)) {
    return runResult('withheld', 'deadline-exceeded');
  }
  const expected = {
    backendIdentityDigest: dependencies.expectedBackendIdentityDigest,
    policyDigest: dependencies.expectedPolicyDigest,
    nowMs: now,
  };
  const preflight = compileAgentOsObservationSandboxPreflightV1(
    firstAttestation, expected, dependencies.attestationVerifier,
  );
  if (!preflight.enforced) return runResult('withheld', 'backend-not-enforced', { preflight });
  const request = createAgentOsObservationSandboxRequestV1(input, dependencies);
  if (!request || !validRequest(request)) {
    return runResult('withheld', 'request-authentication-failed', { preflight });
  }
  const before = canonicalJson(request);
  let responseValue: AgentOsObservationSandboxResponseV1 | null;
  try {
    responseValue = dependencies.backend.execute(request);
  } catch {
    return runResult('withheld', 'backend-failed', { preflight, requestDigest: request.requestDigest });
  }
  if (canonicalJson(request) !== before) {
    return runResult('withheld', 'backend-mutated-request', {
      preflight, requestDigest: request.requestDigest,
    });
  }
  if (!responseValue) return runResult('withheld', 'backend-failed', {
    preflight, requestDigest: request.requestDigest,
  });
  const validated = validateResponse(responseValue, request);
  if (!validated || validated.response.frameKeyId !== dependencies.responseVerifier.keyId) {
    return runResult('withheld', 'invalid-response', { preflight, requestDigest: request.requestDigest });
  }
  const pinned = pinValidatedResponse(validated);
  const signedBytes = domainBytes(RESPONSE_DOMAIN, unsignedResponse(pinned.response));
  const callbackBytes = Buffer.from(signedBytes);
  let responseAuthenticated = false;
  try {
    responseAuthenticated = dependencies.responseVerifier.verify(immutable({
      canonicalDomainSeparatedFrame: callbackBytes,
      authenticator: pinned.response.authenticator,
    })) === true;
  } catch {
    responseAuthenticated = false;
  }
  if (!equalBytes(signedBytes, callbackBytes) || !responseAuthenticated) {
    return runResult('withheld', 'response-authentication-failed', {
      preflight, requestDigest: request.requestDigest,
      responseDigest: pinned.response.responseDigest,
    });
  }
  let finalNow: number;
  let finalAttestation: AgentOsObservationSandboxAttestationV1 | null;
  try {
    finalNow = dependencies.now();
    finalAttestation = dependencies.backend.readAttestation();
  } catch {
    return runResult('withheld', 'attestation-drift', { preflight, requestDigest: request.requestDigest });
  }
  const finalPreflight = compileAgentOsObservationSandboxPreflightV1(finalAttestation, {
    ...expected, nowMs: finalNow,
  }, dependencies.attestationVerifier);
  if (!sameAttestation(preflight, finalPreflight)) {
    return runResult('withheld', 'attestation-drift', {
      preflight, requestDigest: request.requestDigest,
      responseDigest: pinned.response.responseDigest,
    });
  }
  if (Date.parse(pinned.response.finishedAt) > finalNow +
    AGENT_OS_OBSERVATION_SANDBOX_MAX_FUTURE_SKEW_MS_V1) {
    return runResult('withheld', 'invalid-response', {
      preflight, requestDigest: request.requestDigest,
      responseDigest: pinned.response.responseDigest,
    });
  }
  if (finalNow >= Date.parse(input.deadlineAt) ||
    Date.parse(pinned.response.finishedAt) > Date.parse(input.deadlineAt) ||
    pinned.response.outcome === 'timed-out') {
    return runResult('withheld', 'deadline-exceeded', {
      preflight, requestDigest: request.requestDigest,
      responseDigest: pinned.response.responseDigest, process: pinned.response.process,
    });
  }
  if (pinned.response.outcome === 'output-limit-exceeded') {
    return runResult('withheld', 'output-limit-exceeded', {
      preflight, requestDigest: request.requestDigest,
      responseDigest: pinned.response.responseDigest, process: pinned.response.process,
    });
  }
  if (pinned.response.outcome !== 'succeeded') {
    return runResult('withheld', 'producer-failed', {
      preflight, requestDigest: request.requestDigest,
      responseDigest: pinned.response.responseDigest, process: pinned.response.process,
    });
  }
  return runResult('completed', 'succeeded', {
    preflight,
    requestDigest: request.requestDigest,
    responseDigest: pinned.response.responseDigest,
    output: Buffer.from(pinned.output),
    process: { ...pinned.response.process },
  });
}

/** Node 22 permission flags suitable only as an additional accidental-use guard. */
export function agentOsNode22ObservationSeatbeltArgsV1(): readonly string[] {
  return Object.freeze(['--permission', '--disable-proto=throw', '--no-addons']);
}
