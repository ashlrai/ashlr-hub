/**
 * Pure, deny-by-construction Docker create policy for Agent OS observers.
 *
 * This module does not contact Docker, create a container, inspect a host, or
 * prove that any control was enforced. It only constructs and validates the
 * canonical policy that a separately commissioned broker must translate and
 * attest.
 */

import { createHash } from 'node:crypto';

export const AGENT_OS_LOCAL_CONTAINER_POLICY_V1 =
  'ashlr-agent-os-local-container-create-policy-v1' as const;
export const AGENT_OS_LOCAL_CONTAINER_POLICY_DIGEST_DOMAIN_V1 =
  'ashlr:agent-os:local-container-create-policy:v1\0' as const;

export const AGENT_OS_LOCAL_CONTAINER_MAX_DURATION_MS_V1 = 5 * 60_000;
export const AGENT_OS_LOCAL_CONTAINER_MAX_OUTPUT_BYTES_V1 = 2 * 1024 * 1024;
export const AGENT_OS_LOCAL_CONTAINER_NATIVE_PRODUCER_ENTRYPOINT_V1 =
  '/opt/ashlr/bin/agent-os-observation-producer' as const;

const RAW_SHA256_RE = /^[a-f0-9]{64}$/u;
const IMAGE_REPOSITORY_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/u;
const NUMERIC_USER_RE = /^(?:[1-9][0-9]{0,9}):(?:[1-9][0-9]{0,9})$/u;
const NO_AUTHORITY = Object.freeze({
  authority: 'policy-description-only' as const,
  executionAuthority: false as const,
  effectAuthority: false as const,
  externalMutationAuthority: false as const,
  credentialAuthority: false as const,
  commissioningAuthority: false as const,
  activationAuthority: false as const,
  containerProvisioningAuthority: false as const,
  dockerEnforcementVerified: false as const,
});

export interface AgentOsLocalContainerLimitsV1 {
  cpuNanoCpus: number;
  memoryBytes: number;
  memorySwapBytes: number;
  pidsLimit: number;
  maxDurationMs: number;
  maxOutputBytes: number;
}

export interface AgentOsLocalContainerCreatePolicyInputV1 {
  image: string;
  producerDigest: string;
  allowedProducerDigests: string[];
  user: string;
  workingDir: string;
  seccompProfileDigest: string;
  limits: AgentOsLocalContainerLimitsV1;
}

export interface AgentOsLocalContainerCreatePolicyV1 {
  schemaVersion: 1;
  protocol: typeof AGENT_OS_LOCAL_CONTAINER_POLICY_V1;
  engine: 'docker';
  image: string;
  producer: {
    entrypoint: typeof AGENT_OS_LOCAL_CONTAINER_NATIVE_PRODUCER_ENTRYPOINT_V1;
    digest: string;
    allowedDigests: string[];
  };
  command: [typeof AGENT_OS_LOCAL_CONTAINER_NATIVE_PRODUCER_ENTRYPOINT_V1, '--stdio'];
  user: string;
  workingDir: string;
  environment: [];
  mounts: [];
  ports: [];
  devices: [];
  namespaces: {
    network: 'none';
    pid: 'private';
    ipc: 'private';
    uts: 'private';
    cgroup: 'private';
  };
  privileged: false;
  capabilities: {
    add: [];
    drop: ['ALL'];
  };
  readonlyRootfs: true;
  noNewPrivileges: true;
  seccompProfileDigest: string;
  restart: {
    name: 'no';
    maximumRetryCount: 0;
  };
  logging: {
    driver: 'none';
    options: Record<string, never>;
  };
  limits: AgentOsLocalContainerLimitsV1;
}

export type AgentOsLocalContainerPolicyReasonV1 =
  | 'policy-admitted'
  | 'invalid-input'
  | 'image-not-digest-pinned'
  | 'command-invalid'
  | 'producer-not-allowlisted'
  | 'identity-invalid'
  | 'working-directory-invalid'
  | 'seccomp-profile-unbound'
  | 'limits-missing-or-invalid'
  | 'environment-inheritance-forbidden'
  | 'mounts-forbidden'
  | 'ports-forbidden'
  | 'devices-forbidden'
  | 'host-namespace-forbidden'
  | 'network-forbidden'
  | 'privileged-mode-forbidden'
  | 'added-capabilities-forbidden'
  | 'required-capability-drop-missing'
  | 'writable-rootfs-forbidden'
  | 'no-new-privileges-required'
  | 'restart-forbidden'
  | 'logging-forbidden';

export interface AgentOsLocalContainerPolicyInspectionV1 {
  schemaVersion: 1;
  mode: 'agent-os-local-container-policy-inspection-v1';
  state: 'admitted' | 'withheld';
  reason: AgentOsLocalContainerPolicyReasonV1;
  structurallyAdmissible: boolean;
  createConfigDigest: string | null;
  policy: Readonly<AgentOsLocalContainerCreatePolicyV1> | null;
  authority: 'policy-description-only';
  executionAuthority: false;
  effectAuthority: false;
  externalMutationAuthority: false;
  credentialAuthority: false;
  commissioningAuthority: false;
  activationAuthority: false;
  containerProvisioningAuthority: false;
  dockerEnforcementVerified: false;
}

const INPUT_KEYS = [
  'allowedProducerDigests', 'image', 'limits', 'producerDigest', 'seccompProfileDigest', 'user',
  'workingDir',
] as const;
const POLICY_KEYS = [
  'capabilities', 'command', 'devices', 'engine', 'environment', 'image', 'limits', 'producer',
  'logging', 'mounts', 'namespaces', 'noNewPrivileges', 'ports', 'privileged', 'protocol',
  'readonlyRootfs', 'restart', 'schemaVersion', 'seccompProfileDigest', 'user', 'workingDir',
] as const;
const LIMIT_KEYS = [
  'cpuNanoCpus', 'maxDurationMs', 'maxOutputBytes', 'memoryBytes', 'memorySwapBytes', 'pidsLimit',
] as const;
const NAMESPACE_KEYS = ['cgroup', 'ipc', 'network', 'pid', 'uts'] as const;
const CAPABILITY_KEYS = ['add', 'drop'] as const;
const RESTART_KEYS = ['maximumRetryCount', 'name'] as const;
const LOGGING_KEYS = ['driver', 'options'] as const;
const PRODUCER_KEYS = ['allowedDigests', 'digest', 'entrypoint'] as const;

function record(value: unknown): Record<string, unknown> | null {
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

function denseArray(value: unknown, maximum: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum || Reflect.ownKeys(value).some((key) => typeof key === 'symbol') ||
    Object.getOwnPropertyNames(value).length !== value.length + 1) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!Object.hasOwn(value, index) || !descriptor || !Object.hasOwn(descriptor, 'value') ||
      descriptor.enumerable !== true) return false;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  return Boolean(lengthDescriptor && Object.hasOwn(lengthDescriptor, 'value'));
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

export function isAgentOsLocalContainerLimitsV1(value: unknown): value is AgentOsLocalContainerLimitsV1 {
  const limits = record(value);
  return Boolean(limits && exactKeys(limits, LIMIT_KEYS) &&
    boundedInteger(limits['cpuNanoCpus'], 10_000_000, 64_000_000_000) &&
    boundedInteger(limits['memoryBytes'], 16 * 1024 * 1024, 64 * 1024 * 1024 * 1024) &&
    boundedInteger(limits['memorySwapBytes'], 16 * 1024 * 1024, 64 * 1024 * 1024 * 1024) &&
    limits['memorySwapBytes'] === limits['memoryBytes'] &&
    limits['pidsLimit'] === 1 &&
    boundedInteger(limits['maxDurationMs'], 1, AGENT_OS_LOCAL_CONTAINER_MAX_DURATION_MS_V1) &&
    boundedInteger(limits['maxOutputBytes'], 1, AGENT_OS_LOCAL_CONTAINER_MAX_OUTPUT_BYTES_V1));
}

function digestPinnedImage(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 255) return false;
  const marker = '@sha256:';
  const markerIndex = value.indexOf(marker);
  if (markerIndex < 1 || markerIndex !== value.lastIndexOf(marker)) return false;
  const repository = value.slice(0, markerIndex);
  const digest = value.slice(markerIndex + marker.length);
  return IMAGE_REPOSITORY_RE.test(repository) && RAW_SHA256_RE.test(digest);
}

function canonicalAbsolutePath(value: unknown, allowRoot: boolean): value is string {
  if (typeof value !== 'string' || value.length > 512 || !value.startsWith('/') ||
    value.includes('\0') || value.includes('\\') || value.includes('//')) return false;
  if (!allowRoot && value === '/') return false;
  const segments = value.split('/').slice(1);
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function validCommand(value: unknown): value is AgentOsLocalContainerCreatePolicyV1['command'] {
  return denseArray(value, 2) && value.length === 2 &&
    value[0] === AGENT_OS_LOCAL_CONTAINER_NATIVE_PRODUCER_ENTRYPOINT_V1 && value[1] === '--stdio';
}

function validDigestAllowlist(value: unknown): value is string[] {
  if (!denseArray(value, 16) || value.length < 1) return false;
  let prior = '';
  for (const entry of value) {
    if (typeof entry !== 'string' || !RAW_SHA256_RE.test(entry) || entry <= prior) return false;
    prior = entry;
  }
  return true;
}

function validProducer(value: unknown): value is AgentOsLocalContainerCreatePolicyV1['producer'] {
  const producer = record(value);
  return Boolean(producer && exactKeys(producer, PRODUCER_KEYS) &&
    producer['entrypoint'] === AGENT_OS_LOCAL_CONTAINER_NATIVE_PRODUCER_ENTRYPOINT_V1 &&
    typeof producer['digest'] === 'string' && RAW_SHA256_RE.test(producer['digest']) &&
    validDigestAllowlist(producer['allowedDigests']) &&
    producer['allowedDigests'].includes(producer['digest']));
}

function emptyArray(value: unknown): value is [] {
  return denseArray(value, 0) && value.length === 0;
}

function oneAll(value: unknown): value is ['ALL'] {
  return denseArray(value, 1) && value.length === 1 && value[0] === 'ALL';
}

function emptyRecord(value: unknown): value is Record<string, never> {
  const row = record(value);
  return Boolean(row && exactKeys(row, []));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
    Object.freeze(value);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
}

function ownedPolicy(value: AgentOsLocalContainerCreatePolicyV1): AgentOsLocalContainerCreatePolicyV1 {
  return deepFreeze(JSON.parse(canonicalJson(value)) as AgentOsLocalContainerCreatePolicyV1);
}

export function agentOsLocalContainerCreatePolicyDigestV1(value: unknown): string | null {
  const inspected = inspectAgentOsLocalContainerCreatePolicyV1(value);
  return inspected.state === 'admitted' ? inspected.createConfigDigest : null;
}

function withheld(reason: Exclude<AgentOsLocalContainerPolicyReasonV1, 'policy-admitted'>):
AgentOsLocalContainerPolicyInspectionV1 {
  return Object.freeze({
    schemaVersion: 1,
    mode: 'agent-os-local-container-policy-inspection-v1',
    state: 'withheld',
    reason,
    structurallyAdmissible: false,
    createConfigDigest: null,
    policy: null,
    ...NO_AUTHORITY,
  });
}

function policyReason(value: unknown): Exclude<AgentOsLocalContainerPolicyReasonV1, 'policy-admitted'> | null {
  const policy = record(value);
  if (!policy || !exactKeys(policy, POLICY_KEYS) || policy['schemaVersion'] !== 1 ||
    policy['protocol'] !== AGENT_OS_LOCAL_CONTAINER_POLICY_V1 || policy['engine'] !== 'docker') {
    return 'invalid-input';
  }
  if (!digestPinnedImage(policy['image'])) return 'image-not-digest-pinned';
  if (!validCommand(policy['command'])) return 'command-invalid';
  if (!validProducer(policy['producer'])) return 'producer-not-allowlisted';
  if (typeof policy['user'] !== 'string' || !NUMERIC_USER_RE.test(policy['user'])) return 'identity-invalid';
  if (!canonicalAbsolutePath(policy['workingDir'], false)) return 'working-directory-invalid';
  if (!emptyArray(policy['environment'])) return 'environment-inheritance-forbidden';
  if (!emptyArray(policy['mounts'])) return 'mounts-forbidden';
  if (!emptyArray(policy['ports'])) return 'ports-forbidden';
  if (!emptyArray(policy['devices'])) return 'devices-forbidden';
  const namespaces = record(policy['namespaces']);
  if (!namespaces || !exactKeys(namespaces, NAMESPACE_KEYS)) return 'host-namespace-forbidden';
  if (namespaces['network'] !== 'none') return 'network-forbidden';
  if (namespaces['pid'] !== 'private' || namespaces['ipc'] !== 'private' ||
    namespaces['uts'] !== 'private' || namespaces['cgroup'] !== 'private') {
    return 'host-namespace-forbidden';
  }
  if (policy['privileged'] !== false) return 'privileged-mode-forbidden';
  const capabilities = record(policy['capabilities']);
  if (!capabilities || !exactKeys(capabilities, CAPABILITY_KEYS)) return 'added-capabilities-forbidden';
  if (!emptyArray(capabilities['add'])) return 'added-capabilities-forbidden';
  if (!oneAll(capabilities['drop'])) return 'required-capability-drop-missing';
  if (policy['readonlyRootfs'] !== true) return 'writable-rootfs-forbidden';
  if (policy['noNewPrivileges'] !== true) return 'no-new-privileges-required';
  if (typeof policy['seccompProfileDigest'] !== 'string' ||
    !RAW_SHA256_RE.test(policy['seccompProfileDigest'])) return 'seccomp-profile-unbound';
  const restart = record(policy['restart']);
  if (!restart || !exactKeys(restart, RESTART_KEYS) || restart['name'] !== 'no' ||
    restart['maximumRetryCount'] !== 0) return 'restart-forbidden';
  const logging = record(policy['logging']);
  if (!logging || !exactKeys(logging, LOGGING_KEYS) || logging['driver'] !== 'none' ||
    !emptyRecord(logging['options'])) return 'logging-forbidden';
  return isAgentOsLocalContainerLimitsV1(policy['limits']) ? null : 'limits-missing-or-invalid';
}

/** Validate a caller-owned policy without consulting Docker or the host. */
export function inspectAgentOsLocalContainerCreatePolicyV1(
  value: unknown,
): AgentOsLocalContainerPolicyInspectionV1 {
  try {
    const reason = policyReason(value);
    if (reason) return withheld(reason);
    const policy = ownedPolicy(value as AgentOsLocalContainerCreatePolicyV1);
    const createConfigDigest = createHash('sha256')
      .update(AGENT_OS_LOCAL_CONTAINER_POLICY_DIGEST_DOMAIN_V1, 'utf8')
      .update(canonicalJson(policy), 'utf8')
      .digest('hex');
    return deepFreeze({
      schemaVersion: 1,
      mode: 'agent-os-local-container-policy-inspection-v1' as const,
      state: 'admitted' as const,
      reason: 'policy-admitted' as const,
      structurallyAdmissible: true,
      createConfigDigest,
      policy,
      ...NO_AUTHORITY,
    });
  } catch {
    return withheld('invalid-input');
  }
}

/** Build the single canonical deny policy. This function performs no I/O. */
export function buildAgentOsLocalContainerCreatePolicyV1(
  input: unknown,
): AgentOsLocalContainerPolicyInspectionV1 {
  const row = record(input);
  if (!row || !exactKeys(row, INPUT_KEYS)) return withheld('invalid-input');
  if (!digestPinnedImage(row['image'])) return withheld('image-not-digest-pinned');
  if (typeof row['producerDigest'] !== 'string' || !RAW_SHA256_RE.test(row['producerDigest']) ||
    !validDigestAllowlist(row['allowedProducerDigests']) ||
    !row['allowedProducerDigests'].includes(row['producerDigest'])) {
    return withheld('producer-not-allowlisted');
  }
  if (typeof row['user'] !== 'string' || !NUMERIC_USER_RE.test(row['user'])) {
    return withheld('identity-invalid');
  }
  if (!canonicalAbsolutePath(row['workingDir'], false)) return withheld('working-directory-invalid');
  if (typeof row['seccompProfileDigest'] !== 'string' ||
    !RAW_SHA256_RE.test(row['seccompProfileDigest'])) return withheld('seccomp-profile-unbound');
  if (!isAgentOsLocalContainerLimitsV1(row['limits'])) return withheld('limits-missing-or-invalid');
  const limits = row['limits'] as AgentOsLocalContainerLimitsV1;
  const policy: AgentOsLocalContainerCreatePolicyV1 = {
    schemaVersion: 1,
    protocol: AGENT_OS_LOCAL_CONTAINER_POLICY_V1,
    engine: 'docker',
    image: row['image'],
    producer: {
      entrypoint: AGENT_OS_LOCAL_CONTAINER_NATIVE_PRODUCER_ENTRYPOINT_V1,
      digest: row['producerDigest'],
      allowedDigests: [...row['allowedProducerDigests'] as string[]],
    },
    command: [AGENT_OS_LOCAL_CONTAINER_NATIVE_PRODUCER_ENTRYPOINT_V1, '--stdio'],
    user: row['user'],
    workingDir: row['workingDir'],
    environment: [],
    mounts: [],
    ports: [],
    devices: [],
    namespaces: { network: 'none', pid: 'private', ipc: 'private', uts: 'private', cgroup: 'private' },
    privileged: false,
    capabilities: { add: [], drop: ['ALL'] },
    readonlyRootfs: true,
    noNewPrivileges: true,
    seccompProfileDigest: row['seccompProfileDigest'],
    restart: { name: 'no', maximumRetryCount: 0 },
    logging: { driver: 'none', options: {} },
    limits: { ...limits },
  };
  return inspectAgentOsLocalContainerCreatePolicyV1(policy);
}
