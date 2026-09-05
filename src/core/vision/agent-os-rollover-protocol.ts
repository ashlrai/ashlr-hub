/**
 * Source-only Agent OS epoch rollover protocol core (M546/M550).
 *
 * This module validates and classifies observation evidence. It deliberately
 * contains no filesystem writer, anchor implementation, credential access,
 * daemon wiring, or activation path. External CAS remains the sole commit
 * point, and every public result is observation-only.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export const AGENT_OS_EPOCH_MANIFEST_PROTOCOL_V1 =
  'ashlr-agent-os-observation-epoch-manifest-v1' as const;
export const AGENT_OS_EPOCH_HEAD_PROTOCOL_V1 =
  'ashlr-agent-os-observation-epoch-head-v1' as const;
export const AGENT_OS_EPOCH_MANIFEST_DIGEST_DOMAIN_V1 =
  'ashlr:agent-os:epoch-manifest:v1\0' as const;
export const AGENT_OS_EPOCH_HEAD_DIGEST_DOMAIN_V1 =
  'ashlr:agent-os:epoch-head:v1\0' as const;
export const AGENT_OS_ROLLOVER_OPERATION_DOMAIN_V1 =
  'ashlr:agent-os:epoch-rollover-operation:v1\0' as const;
export const AGENT_OS_ATTEMPT_NAMESPACE_DOMAIN_V1 =
  'ashlr:agent-os:epoch-attempt-namespace:v1\0' as const;
export const AGENT_OS_ROLLOVER_PROTOCOL_GENERATION_V1 = 1 as const;
export const AGENT_OS_ROLLOVER_MAX_EPOCH_V1 = 999_999_999_999;
/** Exact V1 source/snapshot capacity inherited by the M546 transition tuple. */
export const AGENT_OS_ROLLOVER_MAX_LEDGER_SEQUENCE_V1 = 4_096;
export const AGENT_OS_ROLLOVER_MAX_POLICY_GENERATION_V1 = 1_000_000;

const MAX_CANONICAL_BYTES = 64 * 1024;
const MAX_CANONICAL_DEPTH = 16;
const MAX_CANONICAL_NODES = 2_048;
/** M550-owned control-plane identities are always explicitly algorithm-tagged. */
const CONTROL_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
/** Existing signed V1 source/snapshot artifacts use canonical untagged SHA-256 hex. */
const SIGNED_ARTIFACT_DIGEST_RE = /^[a-f0-9]{64}$/;
const AUTHENTICATOR_RE = /^[a-f0-9]{64}$/;
const CANONICAL_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface AgentOsRolloverAuthorityV1 {
  authority: 'observation-only';
  planningAuthority: false;
  executionAuthority: false;
  effectAuthority: false;
  proposalAuthority: false;
  learningAuthority: false;
  promotionAuthority: false;
  mergeAuthority: false;
  releaseAuthority: false;
  deployAuthority: false;
  publicationAuthority: false;
  budgetAuthority: false;
  credentialAuthority: false;
  externalMutationAuthority: false;
}

export const AGENT_OS_ROLLOVER_AUTHORITY_V1: Readonly<AgentOsRolloverAuthorityV1> = Object.freeze({
  authority: 'observation-only',
  planningAuthority: false,
  executionAuthority: false,
  effectAuthority: false,
  proposalAuthority: false,
  learningAuthority: false,
  promotionAuthority: false,
  mergeAuthority: false,
  releaseAuthority: false,
  deployAuthority: false,
  publicationAuthority: false,
  budgetAuthority: false,
  credentialAuthority: false,
  externalMutationAuthority: false,
});

export interface AgentOsEpochSourceTipV1 {
  sequence: number;
  bundleDigest: string;
}

export interface AgentOsEpochSnapshotTipV1 {
  sequence: number;
  envelopeDigest: string;
}

export interface AgentOsEpochFirstSourceV1 {
  epochSequence: 1;
  bundleDigest: string;
  previousBundleDigest: string;
  trustPolicyDigest: string;
  policyGeneration: number;
}

export interface AgentOsEpochSnapshotBaseV1 {
  nextSequence: 1;
  previousEnvelopeDigest: string;
}

export interface AgentOsObservationEpochManifestV1 extends AgentOsRolloverAuthorityV1 {
  schemaVersion: 1;
  protocol: typeof AGENT_OS_EPOCH_MANIFEST_PROTOCOL_V1;
  recordType: 'agent-os-observation-epoch';
  epoch: number;
  protocolGeneration: typeof AGENT_OS_ROLLOVER_PROTOCOL_GENERATION_V1;
  previousEpochHeadDigest: string;
  previousEpochManifestDigest: string;
  previousSourceTip: AgentOsEpochSourceTipV1 | null;
  previousSnapshotTip: AgentOsEpochSnapshotTipV1 | null;
  previousAttemptSetDigest: string;
  previousCoherentBindingDigest: string | null;
  firstSourceBundle: AgentOsEpochFirstSourceV1;
  snapshotBase: AgentOsEpochSnapshotBaseV1;
  attemptNamespaceDigest: string;
  createdAt: string;
  manifestDigest: string;
  localAuthenticator: string;
}

export interface AgentOsObservationEpochHeadV1 extends AgentOsRolloverAuthorityV1 {
  schemaVersion: 1;
  protocol: typeof AGENT_OS_EPOCH_HEAD_PROTOCOL_V1;
  epoch: number;
  protocolGeneration: typeof AGENT_OS_ROLLOVER_PROTOCOL_GENERATION_V1;
  previousHeadDigest: string;
  epochManifestDigest: string;
  firstSourceBundleDigest: string;
  closedSourceTipDigest: string;
  closedSnapshotTipDigest: string;
  closedAttemptSetDigest: string;
  coherentBindingDigest: string;
  writerProtocolDigest: string;
  advancedAt: string;
  headDigest: string;
}

export type AgentOsObservationEpochManifestUnsignedV1 = Omit<
  AgentOsObservationEpochManifestV1,
  'manifestDigest' | 'localAuthenticator'
>;
export type AgentOsObservationEpochHeadUnsignedV1 = Omit<
  AgentOsObservationEpochHeadV1,
  'headDigest'
>;

function controlGenesisDigest(label: string): string {
  return `sha256:${createHash('sha256').update(`ashlr:agent-os:rollover:genesis:${label}:v1\0`, 'utf8').digest('hex')}`;
}

function signedArtifactGenesisDigest(label: string): string {
  return createHash('sha256')
    .update(`ashlr:agent-os:rollover:genesis:${label}:v1\0`, 'utf8')
    .digest('hex');
}

/** Raw-hex sentinel matching the signed source-bundle V1 digest representation. */
export const AGENT_OS_SOURCE_BUNDLE_GENESIS_DIGEST_V1 =
  signedArtifactGenesisDigest('source-bundle');
/** Raw-hex sentinel matching the signed snapshot-envelope V1 digest representation. */
export const AGENT_OS_SNAPSHOT_ENVELOPE_GENESIS_DIGEST_V1 =
  signedArtifactGenesisDigest('snapshot-envelope');

export const AGENT_OS_EPOCH_GENESIS_V1 = Object.freeze({
  headDigest: controlGenesisDigest('head'),
  manifestDigest: controlGenesisDigest('manifest'),
  sourceTipDigest: AGENT_OS_SOURCE_BUNDLE_GENESIS_DIGEST_V1,
  snapshotTipDigest: AGENT_OS_SNAPSHOT_ENVELOPE_GENESIS_DIGEST_V1,
  attemptSetDigest: controlGenesisDigest('attempt-set'),
  coherentBindingDigest: controlGenesisDigest('coherent-binding'),
});

type Canonical = null | boolean | number | string | Canonical[] | { [key: string]: Canonical };

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
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function canonicalize(
  value: unknown,
  state = { depth: 0, nodes: 0, ancestors: new Set<object>() },
): Canonical {
  state.nodes += 1;
  if (state.nodes > MAX_CANONICAL_NODES || state.depth > MAX_CANONICAL_DEPTH) {
    throw new TypeError('canonical value exceeds bounds');
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new TypeError('non-canonical number');
    return value;
  }
  if (typeof value !== 'object' || state.ancestors.has(value)) throw new TypeError('non-json value');
  state.ancestors.add(value);
  state.depth += 1;
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol' ||
        (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key)))) throw new TypeError('invalid array');
      return value.map((entry, index) => {
        if (!Object.hasOwn(value, index)) throw new TypeError('sparse array');
        return canonicalize(entry, state);
      });
    }
    const row = record(value);
    if (!row) throw new TypeError('non-plain object');
    const output: { [key: string]: Canonical } = Object.create(null) as { [key: string]: Canonical };
    for (const key of Object.keys(row).sort()) output[key] = canonicalize(row[key], state);
    return output;
  } finally {
    state.depth -= 1;
    state.ancestors.delete(value);
  }
}

function canonicalBytes(value: unknown): Buffer | null {
  try {
    const bytes = Buffer.from(JSON.stringify(canonicalize(value)), 'utf8');
    return bytes.length > 0 && bytes.length <= MAX_CANONICAL_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

function exactBytes(left: Uint8Array, right: Uint8Array): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function digest(domain: string, value: unknown): string | null {
  const bytes = canonicalBytes(value);
  return bytes
    ? `sha256:${createHash('sha256').update(domain, 'utf8').update(bytes).digest('hex')}`
    : null;
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && CONTROL_DIGEST_RE.test(value);
}

function validSignedArtifactDigest(value: unknown): value is string {
  return typeof value === 'string' && SIGNED_ARTIFACT_DIGEST_RE.test(value);
}

function validPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validBoundedInteger(value: unknown, maximum: number): value is number {
  return validPositiveInteger(value) && Number(value) <= maximum;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP_RE.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

const AUTHORITY_KEYS = Object.keys(AGENT_OS_ROLLOVER_AUTHORITY_V1) as Array<keyof AgentOsRolloverAuthorityV1>;
const MANIFEST_KEYS = [
  'schemaVersion', 'protocol', 'recordType', 'epoch', 'protocolGeneration',
  'previousEpochHeadDigest', 'previousEpochManifestDigest', 'previousSourceTip',
  'previousSnapshotTip', 'previousAttemptSetDigest', 'previousCoherentBindingDigest',
  'firstSourceBundle', 'snapshotBase', 'attemptNamespaceDigest', 'createdAt',
  'manifestDigest', 'localAuthenticator', ...AUTHORITY_KEYS,
] as const;
const MANIFEST_UNSIGNED_KEYS = MANIFEST_KEYS.filter((key) =>
  key !== 'manifestDigest' && key !== 'localAuthenticator');
const SOURCE_TIP_KEYS = ['sequence', 'bundleDigest'] as const;
const SNAPSHOT_TIP_KEYS = ['sequence', 'envelopeDigest'] as const;
const FIRST_SOURCE_KEYS = [
  'epochSequence', 'bundleDigest', 'previousBundleDigest', 'trustPolicyDigest', 'policyGeneration',
] as const;
const SNAPSHOT_BASE_KEYS = ['nextSequence', 'previousEnvelopeDigest'] as const;
const HEAD_KEYS = [
  'schemaVersion', 'protocol', 'epoch', 'protocolGeneration', 'previousHeadDigest',
  'epochManifestDigest', 'firstSourceBundleDigest', 'closedSourceTipDigest',
  'closedSnapshotTipDigest', 'closedAttemptSetDigest', 'coherentBindingDigest',
  'writerProtocolDigest', 'advancedAt', 'headDigest', ...AUTHORITY_KEYS,
] as const;
const HEAD_UNSIGNED_KEYS = HEAD_KEYS.filter((key) => key !== 'headDigest');

function validAuthority(value: Record<string, unknown>): boolean {
  return AUTHORITY_KEYS.every((key) => value[key] === AGENT_OS_ROLLOVER_AUTHORITY_V1[key]);
}

function validSourceTip(value: unknown): value is AgentOsEpochSourceTipV1 {
  const row = record(value);
  return row !== null && exactKeys(row, SOURCE_TIP_KEYS) &&
    validBoundedInteger(row['sequence'], AGENT_OS_ROLLOVER_MAX_LEDGER_SEQUENCE_V1) &&
    validSignedArtifactDigest(row['bundleDigest']);
}

function validSnapshotTip(value: unknown): value is AgentOsEpochSnapshotTipV1 {
  const row = record(value);
  return row !== null && exactKeys(row, SNAPSHOT_TIP_KEYS) &&
    validBoundedInteger(row['sequence'], AGENT_OS_ROLLOVER_MAX_LEDGER_SEQUENCE_V1) &&
    validSignedArtifactDigest(row['envelopeDigest']);
}

function validFirstSource(value: unknown): value is AgentOsEpochFirstSourceV1 {
  const row = record(value);
  return row !== null && exactKeys(row, FIRST_SOURCE_KEYS) && row['epochSequence'] === 1 &&
    validSignedArtifactDigest(row['bundleDigest']) &&
    validSignedArtifactDigest(row['previousBundleDigest']) &&
    validSignedArtifactDigest(row['trustPolicyDigest']) &&
    validBoundedInteger(row['policyGeneration'], AGENT_OS_ROLLOVER_MAX_POLICY_GENERATION_V1);
}

function validSnapshotBase(value: unknown): value is AgentOsEpochSnapshotBaseV1 {
  const row = record(value);
  return row !== null && exactKeys(row, SNAPSHOT_BASE_KEYS) && row['nextSequence'] === 1 &&
    validSignedArtifactDigest(row['previousEnvelopeDigest']);
}

function manifestUnsigned(value: Record<string, unknown>): AgentOsObservationEpochManifestUnsignedV1 | null {
  if (!exactKeys(value, MANIFEST_KEYS) || !validAuthority(value) ||
    value['schemaVersion'] !== 1 || value['protocol'] !== AGENT_OS_EPOCH_MANIFEST_PROTOCOL_V1 ||
    value['recordType'] !== 'agent-os-observation-epoch' ||
    !validBoundedInteger(value['epoch'], AGENT_OS_ROLLOVER_MAX_EPOCH_V1) ||
    value['protocolGeneration'] !== AGENT_OS_ROLLOVER_PROTOCOL_GENERATION_V1 ||
    !validDigest(value['previousEpochHeadDigest']) ||
    !validDigest(value['previousEpochManifestDigest']) ||
    (value['previousSourceTip'] !== null && !validSourceTip(value['previousSourceTip'])) ||
    (value['previousSnapshotTip'] !== null && !validSnapshotTip(value['previousSnapshotTip'])) ||
    !validDigest(value['previousAttemptSetDigest']) ||
    (value['previousCoherentBindingDigest'] !== null &&
      !validDigest(value['previousCoherentBindingDigest'])) ||
    !validFirstSource(value['firstSourceBundle']) || !validSnapshotBase(value['snapshotBase']) ||
    !validDigest(value['attemptNamespaceDigest']) || !validTimestamp(value['createdAt']) ||
    !validDigest(value['manifestDigest']) ||
    typeof value['localAuthenticator'] !== 'string' ||
    !AUTHENTICATOR_RE.test(value['localAuthenticator'])) return null;

  const epoch = value['epoch'];
  const previousSourceTip = value['previousSourceTip'] as AgentOsEpochSourceTipV1 | null;
  const previousSnapshotTip = value['previousSnapshotTip'] as AgentOsEpochSnapshotTipV1 | null;
  const previousCoherentBindingDigest = value['previousCoherentBindingDigest'] as string | null;
  const firstSource = value['firstSourceBundle'] as AgentOsEpochFirstSourceV1;
  const snapshotBase = value['snapshotBase'] as AgentOsEpochSnapshotBaseV1;
  if (epoch === 1) {
    if (value['previousEpochHeadDigest'] !== AGENT_OS_EPOCH_GENESIS_V1.headDigest ||
      value['previousEpochManifestDigest'] !== AGENT_OS_EPOCH_GENESIS_V1.manifestDigest ||
      previousSourceTip !== null || previousSnapshotTip !== null ||
      value['previousAttemptSetDigest'] !== AGENT_OS_EPOCH_GENESIS_V1.attemptSetDigest ||
      previousCoherentBindingDigest !== null ||
      firstSource.previousBundleDigest !== AGENT_OS_EPOCH_GENESIS_V1.sourceTipDigest ||
      snapshotBase.previousEnvelopeDigest !== AGENT_OS_EPOCH_GENESIS_V1.snapshotTipDigest) return null;
  } else if (previousSourceTip === null || previousSnapshotTip === null ||
    previousCoherentBindingDigest === null ||
    value['previousEpochHeadDigest'] === AGENT_OS_EPOCH_GENESIS_V1.headDigest ||
    value['previousEpochManifestDigest'] === AGENT_OS_EPOCH_GENESIS_V1.manifestDigest ||
    previousSourceTip.bundleDigest === AGENT_OS_SOURCE_BUNDLE_GENESIS_DIGEST_V1 ||
    previousSnapshotTip.envelopeDigest === AGENT_OS_SNAPSHOT_ENVELOPE_GENESIS_DIGEST_V1 ||
    firstSource.previousBundleDigest !== previousSourceTip.bundleDigest ||
    snapshotBase.previousEnvelopeDigest !== previousSnapshotTip.envelopeDigest) return null;

  if (value['attemptNamespaceDigest'] !== agentOsAttemptNamespaceDigestV1({
    epoch,
    previousEpochHeadDigest: value['previousEpochHeadDigest'] as string,
    previousAttemptSetDigest: value['previousAttemptSetDigest'] as string,
    firstSourceBundleDigest: firstSource.bundleDigest,
  })) return null;

  const unsigned = Object.fromEntries(MANIFEST_UNSIGNED_KEYS.map((key) => [key, value[key]]));
  return unsigned as unknown as AgentOsObservationEpochManifestUnsignedV1;
}

function headUnsigned(value: Record<string, unknown>): AgentOsObservationEpochHeadUnsignedV1 | null {
  if (!exactKeys(value, HEAD_KEYS) || !validAuthority(value) || value['schemaVersion'] !== 1 ||
    value['protocol'] !== AGENT_OS_EPOCH_HEAD_PROTOCOL_V1 ||
    !validBoundedInteger(value['epoch'], AGENT_OS_ROLLOVER_MAX_EPOCH_V1) ||
    value['protocolGeneration'] !== AGENT_OS_ROLLOVER_PROTOCOL_GENERATION_V1 ||
    !validDigest(value['previousHeadDigest']) || !validDigest(value['epochManifestDigest']) ||
    !validSignedArtifactDigest(value['firstSourceBundleDigest']) ||
    !validSignedArtifactDigest(value['closedSourceTipDigest']) ||
    !validSignedArtifactDigest(value['closedSnapshotTipDigest']) ||
    !validDigest(value['closedAttemptSetDigest']) ||
    !validDigest(value['coherentBindingDigest']) || !validDigest(value['writerProtocolDigest']) ||
    !validTimestamp(value['advancedAt']) || !validDigest(value['headDigest'])) return null;
  if (value['epoch'] === 1 && value['previousHeadDigest'] !== AGENT_OS_EPOCH_GENESIS_V1.headDigest) return null;
  const unsigned = Object.fromEntries(HEAD_UNSIGNED_KEYS.map((key) => [key, value[key]]));
  return unsigned as unknown as AgentOsObservationEpochHeadUnsignedV1;
}

export function agentOsObservationEpochManifestDigestV1(value: unknown): string | null {
  const row = record(value);
  if (!row || !exactKeys(row, MANIFEST_UNSIGNED_KEYS) || !validAuthority(row)) return null;
  const candidate = {
    ...row,
    manifestDigest: `sha256:${'0'.repeat(64)}`,
    localAuthenticator: '0'.repeat(64),
  };
  if (!manifestUnsigned(candidate)) return null;
  return digest(AGENT_OS_EPOCH_MANIFEST_DIGEST_DOMAIN_V1, row);
}

export function agentOsObservationEpochHeadDigestV1(value: unknown): string | null {
  const row = record(value);
  if (!row || !exactKeys(row, HEAD_UNSIGNED_KEYS) || !validAuthority(row)) return null;
  const candidate = { ...row, headDigest: `sha256:${'0'.repeat(64)}` };
  if (!headUnsigned(candidate)) return null;
  return digest(AGENT_OS_EPOCH_HEAD_DIGEST_DOMAIN_V1, row);
}

/**
 * Idempotency identity for one exact fleet/policy/head transition. The adapter
 * still has to enforce idempotency; this helper only makes the required binding
 * deterministic and inspectable.
 */
export function agentOsRolloverOperationIdV1(input: {
  fleetIdentityDigest: string;
  anchorPolicyDigest: string;
  expectedHeadDigest: string;
  nextHeadDigest: string;
  protocolGeneration: typeof AGENT_OS_ROLLOVER_PROTOCOL_GENERATION_V1;
}): string | null {
  const row = record(input);
  if (!row || !exactKeys(row, [
    'fleetIdentityDigest', 'anchorPolicyDigest', 'expectedHeadDigest', 'nextHeadDigest',
    'protocolGeneration',
  ]) || !validDigest(row['fleetIdentityDigest']) || !validDigest(row['anchorPolicyDigest']) ||
    !validDigest(row['expectedHeadDigest']) || !validDigest(row['nextHeadDigest']) ||
    row['protocolGeneration'] !== AGENT_OS_ROLLOVER_PROTOCOL_GENERATION_V1) return null;
  return digest(AGENT_OS_ROLLOVER_OPERATION_DOMAIN_V1, row);
}

export function agentOsAttemptNamespaceDigestV1(input: {
  epoch: number;
  previousEpochHeadDigest: string;
  previousAttemptSetDigest: string;
  firstSourceBundleDigest: string;
}): string | null {
  const row = record(input);
  if (!row || !exactKeys(row, [
    'epoch', 'previousEpochHeadDigest', 'previousAttemptSetDigest', 'firstSourceBundleDigest',
  ]) || !validBoundedInteger(row['epoch'], AGENT_OS_ROLLOVER_MAX_EPOCH_V1) ||
    !validDigest(row['previousEpochHeadDigest']) || !validDigest(row['previousAttemptSetDigest']) ||
    !validSignedArtifactDigest(row['firstSourceBundleDigest'])) return null;
  return digest(AGENT_OS_ATTEMPT_NAMESPACE_DOMAIN_V1, row);
}

export function canonicalAgentOsObservationEpochManifestBytesV1(value: unknown): Buffer | null {
  const row = record(value);
  if (!row) return null;
  const unsigned = manifestUnsigned(row);
  if (!unsigned || agentOsObservationEpochManifestDigestV1(unsigned) !== row['manifestDigest']) return null;
  return canonicalBytes(row);
}

export function canonicalAgentOsObservationEpochHeadBytesV1(value: unknown): Buffer | null {
  const row = record(value);
  if (!row) return null;
  const unsigned = headUnsigned(row);
  if (!unsigned || agentOsObservationEpochHeadDigestV1(unsigned) !== row['headDigest']) return null;
  return canonicalBytes(row);
}

function parseCanonical<T>(
  bytes: Uint8Array,
  serializer: (value: unknown) => Buffer | null,
): T | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_CANONICAL_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    const canonical = serializer(parsed);
    return canonical && exactBytes(bytes, canonical) ? parsed as T : null;
  } catch {
    return null;
  }
}

/** Structural parser only; it does not authenticate `localAuthenticator`. */
export function parseAgentOsObservationEpochManifestV1(
  bytes: Uint8Array,
): AgentOsObservationEpochManifestV1 | null {
  return parseCanonical(bytes, canonicalAgentOsObservationEpochManifestBytesV1);
}

export function parseAgentOsObservationEpochHeadV1(
  bytes: Uint8Array,
): AgentOsObservationEpochHeadV1 | null {
  return parseCanonical(bytes, canonicalAgentOsObservationEpochHeadBytesV1);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export type AgentOsMonotonicAnchorReadResultV1 =
  | { state: 'present'; canonicalHeadBytes: Uint8Array }
  | { state: 'missing' }
  | { state: 'unavailable' }
  | { state: 'degraded' };

export type AgentOsMonotonicAnchorCasResultV1 =
  | { state: 'advanced'; canonicalHeadBytes: Uint8Array }
  | { state: 'replayed'; canonicalHeadBytes: Uint8Array }
  | { state: 'conflict'; canonicalHeadBytes: Uint8Array | null }
  | { state: 'unavailable' }
  | { state: 'indeterminate' };

export interface AgentOsMonotonicAnchorV1 {
  read(): AgentOsMonotonicAnchorReadResultV1 | Promise<AgentOsMonotonicAnchorReadResultV1>;
  compareAndSwap(input: {
    expectedHeadDigest: string | null;
    nextCanonicalHeadBytes: Uint8Array;
    operationId: string;
  }): AgentOsMonotonicAnchorCasResultV1 | Promise<AgentOsMonotonicAnchorCasResultV1>;
}

export type AgentOsRolloverOperationalStateV1 =
  | 'uncommissioned'
  | 'legacy-detected'
  | 'healthy'
  | 'rollover-required'
  | 'rollover-preparing'
  | 'anchor-advanced'
  | 'awaiting-first-snapshot'
  | 'anchor-conflict'
  | 'anchor-unavailable'
  | 'capacity-exhausted'
  | 'degraded';

export type AgentOsRolloverRecoveryActionV1 =
  | 'none'
  | 'halt-writes'
  | 'prepare-rollover'
  | 'replay-same-cas-operation'
  | 'recover-local-pointer'
  | 'run-first-observation';

export type AgentOsRolloverBlockerV1 =
  | 'not-commissioned'
  | 'anchor-missing'
  | 'anchor-unavailable'
  | 'anchor-degraded'
  | 'anchor-head-invalid'
  | 'local-head-missing'
  | 'local-head-invalid'
  | 'manifest-missing'
  | 'manifest-invalid'
  | 'head-manifest-incoherent'
  | 'local-anchor-conflict'
  | 'local-pointer-ahead'
  | 'epoch-skip'
  | 'prepared-epoch-invalid'
  | 'prepared-epoch-evidence-unverified'
  | 'writer-protocol-mismatch'
  | 'legacy-activity-detected'
  | 'ledger-incomplete'
  | 'open-attempts'
  | 'source-not-current'
  | 'coherent-binding-missing'
  | 'rollover-not-requested'
  | 'successor-source-invalid'
  | 'role-separation-weakened'
  | 'coordination-lease-missing'
  | 'transaction-lock-missing'
  | 'kill-active'
  | 'cancellation-active'
  | 'deadline-active'
  | 'capacity-exhausted';

export interface AgentOsRolloverPublicResultV1 extends AgentOsRolloverAuthorityV1 {
  state: 'accepted' | 'withheld' | 'uncommissioned' | 'unavailable' | 'conflict' | 'indeterminate' | 'degraded';
  operationalState: AgentOsRolloverOperationalStateV1;
  recoveryAction: AgentOsRolloverRecoveryActionV1;
  blockers: readonly AgentOsRolloverBlockerV1[];
  rollbackProtected: false;
  evidenceAssurance: 'structural-and-injected-verifier-only';
  writesPermitted: false;
  casPermitted: false;
  pointerMutationPermitted: false;
}

export type AgentOsManifestAuthenticatorVerifierV1 = (
  canonicalManifestBytes: Uint8Array,
  manifest: AgentOsObservationEpochManifestV1,
) => boolean;

/**
 * Closed identity of a fully durable prepared epoch. The injected verifier is
 * responsible for re-reading the manifest, first source, empty bounded stores,
 * and recovery marker before this evidence can support CAS or pointer recovery.
 */
export interface AgentOsPreparedEpochEvidenceV1 {
  epoch: number;
  previousHeadDigest: string;
  manifestDigest: string;
  firstSourceBundleDigest: string;
  snapshotBasePreviousEnvelopeDigest: string;
  attemptNamespaceDigest: string;
  recoveryOperationId: string;
}

export type AgentOsPreparedEpochEvidenceVerifierV1 = (
  evidence: AgentOsPreparedEpochEvidenceV1,
) => boolean;

export interface AgentOsRolloverStatusInputV1 {
  commissioned: boolean;
  legacyActivityDetected: boolean;
  fleetIdentityDigest: string;
  anchorPolicyDigest: string;
  runningWriterProtocolDigest: string;
  anchor: AgentOsMonotonicAnchorReadResultV1;
  localActiveHeadBytes: Uint8Array | null;
  activeManifestBytes: Uint8Array | null;
  preparedManifestBytes: Uint8Array | null;
  manifestAuthenticatorVerifier: AgentOsManifestAuthenticatorVerifierV1;
  preparedEpochEvidence: AgentOsPreparedEpochEvidenceV1 | null;
  preparedEpochEvidenceVerifier: AgentOsPreparedEpochEvidenceVerifierV1;
  ledgersComplete: boolean;
  capacityExhausted: boolean;
  rolloverThresholdReached: boolean;
  firstSnapshotPresent: boolean;
}

function result(
  state: AgentOsRolloverPublicResultV1['state'],
  operationalState: AgentOsRolloverOperationalStateV1,
  recoveryAction: AgentOsRolloverRecoveryActionV1,
  blockers: AgentOsRolloverBlockerV1[],
): AgentOsRolloverPublicResultV1 {
  return Object.freeze({
    state,
    operationalState,
    recoveryAction,
    blockers: Object.freeze([...new Set(blockers)]),
    rollbackProtected: false,
    evidenceAssurance: 'structural-and-injected-verifier-only',
    writesPermitted: false,
    casPermitted: false,
    pointerMutationPermitted: false,
    ...AGENT_OS_ROLLOVER_AUTHORITY_V1,
  });
}

const STATUS_INPUT_KEYS = [
  'commissioned', 'legacyActivityDetected', 'fleetIdentityDigest', 'anchorPolicyDigest',
  'runningWriterProtocolDigest', 'anchor',
  'localActiveHeadBytes', 'activeManifestBytes', 'preparedManifestBytes',
  'manifestAuthenticatorVerifier', 'preparedEpochEvidence', 'preparedEpochEvidenceVerifier',
  'ledgersComplete', 'capacityExhausted',
  'rolloverThresholdReached', 'firstSnapshotPresent',
] as const;

function validAnchorReadResult(value: unknown): value is AgentOsMonotonicAnchorReadResultV1 {
  const row = record(value);
  if (!row || typeof row['state'] !== 'string') return false;
  if (row['state'] === 'present') {
    return exactKeys(row, ['state', 'canonicalHeadBytes']) && row['canonicalHeadBytes'] instanceof Uint8Array;
  }
  return ['missing', 'unavailable', 'degraded'].includes(row['state']) && exactKeys(row, ['state']);
}

function validStatusInput(value: unknown): value is AgentOsRolloverStatusInputV1 {
  const row = record(value);
  return row !== null && exactKeys(row, STATUS_INPUT_KEYS) &&
    typeof row['commissioned'] === 'boolean' && typeof row['legacyActivityDetected'] === 'boolean' &&
    validDigest(row['fleetIdentityDigest']) && validDigest(row['anchorPolicyDigest']) &&
    typeof row['runningWriterProtocolDigest'] === 'string' && validAnchorReadResult(row['anchor']) &&
    (row['localActiveHeadBytes'] === null || row['localActiveHeadBytes'] instanceof Uint8Array) &&
    (row['activeManifestBytes'] === null || row['activeManifestBytes'] instanceof Uint8Array) &&
    (row['preparedManifestBytes'] === null || row['preparedManifestBytes'] instanceof Uint8Array) &&
    typeof row['manifestAuthenticatorVerifier'] === 'function' &&
    (row['preparedEpochEvidence'] === null || validPreparedEpochEvidence(row['preparedEpochEvidence'])) &&
    typeof row['preparedEpochEvidenceVerifier'] === 'function' &&
    typeof row['ledgersComplete'] === 'boolean' && typeof row['capacityExhausted'] === 'boolean' &&
    typeof row['rolloverThresholdReached'] === 'boolean' && typeof row['firstSnapshotPresent'] === 'boolean';
}

const PREPARED_EPOCH_EVIDENCE_KEYS = [
  'epoch', 'previousHeadDigest', 'manifestDigest', 'firstSourceBundleDigest',
  'snapshotBasePreviousEnvelopeDigest', 'attemptNamespaceDigest', 'recoveryOperationId',
] as const;

function validPreparedEpochEvidence(value: unknown): value is AgentOsPreparedEpochEvidenceV1 {
  const row = record(value);
  return row !== null && exactKeys(row, PREPARED_EPOCH_EVIDENCE_KEYS) &&
    validBoundedInteger(row['epoch'], AGENT_OS_ROLLOVER_MAX_EPOCH_V1) &&
    validDigest(row['previousHeadDigest']) && validDigest(row['manifestDigest']) &&
    validSignedArtifactDigest(row['firstSourceBundleDigest']) &&
    validSignedArtifactDigest(row['snapshotBasePreviousEnvelopeDigest']) &&
    validDigest(row['attemptNamespaceDigest']) && validDigest(row['recoveryOperationId']);
}

function verifiedPreparedEpochEvidence(
  evidence: AgentOsPreparedEpochEvidenceV1 | null,
  verifier: AgentOsPreparedEpochEvidenceVerifierV1,
): AgentOsPreparedEpochEvidenceV1 | null {
  if (!evidence || !validPreparedEpochEvidence(evidence)) return null;
  try {
    const owned = deepFreeze(JSON.parse(JSON.stringify(evidence)) as AgentOsPreparedEpochEvidenceV1);
    return verifier(owned) === true ? owned : null;
  } catch {
    return null;
  }
}

function authenticatedManifest(
  bytes: Uint8Array,
  verifier: AgentOsManifestAuthenticatorVerifierV1,
): AgentOsObservationEpochManifestV1 | null {
  try {
    const ownedBytes = Buffer.from(bytes);
    const parsed = parseAgentOsObservationEpochManifestV1(ownedBytes);
    if (!parsed) return null;
    const ownedManifest = deepFreeze(
      JSON.parse(ownedBytes.toString('utf8')) as AgentOsObservationEpochManifestV1,
    );
    return verifier(Buffer.from(ownedBytes), ownedManifest) === true ? ownedManifest : null;
  } catch {
    return null;
  }
}

function pinStatusInput(input: AgentOsRolloverStatusInputV1): AgentOsRolloverStatusInputV1 {
  const anchor = input.anchor.state === 'present'
    ? Object.freeze({ state: 'present' as const, canonicalHeadBytes: Buffer.from(input.anchor.canonicalHeadBytes) })
    : Object.freeze({ state: input.anchor.state });
  return Object.freeze({
    commissioned: input.commissioned,
    legacyActivityDetected: input.legacyActivityDetected,
    fleetIdentityDigest: input.fleetIdentityDigest,
    anchorPolicyDigest: input.anchorPolicyDigest,
    runningWriterProtocolDigest: input.runningWriterProtocolDigest,
    anchor,
    localActiveHeadBytes: input.localActiveHeadBytes ? Buffer.from(input.localActiveHeadBytes) : null,
    activeManifestBytes: input.activeManifestBytes ? Buffer.from(input.activeManifestBytes) : null,
    preparedManifestBytes: input.preparedManifestBytes ? Buffer.from(input.preparedManifestBytes) : null,
    manifestAuthenticatorVerifier: input.manifestAuthenticatorVerifier,
    preparedEpochEvidence: input.preparedEpochEvidence
      ? deepFreeze(JSON.parse(JSON.stringify(input.preparedEpochEvidence)) as AgentOsPreparedEpochEvidenceV1)
      : null,
    preparedEpochEvidenceVerifier: input.preparedEpochEvidenceVerifier,
    ledgersComplete: input.ledgersComplete,
    capacityExhausted: input.capacityExhausted,
    rolloverThresholdReached: input.rolloverThresholdReached,
    firstSnapshotPresent: input.firstSnapshotPresent,
  });
}

function manifestHeadCoherent(
  manifest: AgentOsObservationEpochManifestV1,
  head: AgentOsObservationEpochHeadV1,
): boolean {
  const closedSource = manifest.previousSourceTip?.bundleDigest ?? AGENT_OS_EPOCH_GENESIS_V1.sourceTipDigest;
  const closedSnapshot = manifest.previousSnapshotTip?.envelopeDigest ?? AGENT_OS_EPOCH_GENESIS_V1.snapshotTipDigest;
  const coherent = manifest.previousCoherentBindingDigest ?? AGENT_OS_EPOCH_GENESIS_V1.coherentBindingDigest;
  return manifest.epoch === head.epoch && manifest.manifestDigest === head.epochManifestDigest &&
    manifest.previousEpochHeadDigest === head.previousHeadDigest &&
    manifest.firstSourceBundle.bundleDigest === head.firstSourceBundleDigest &&
    closedSource === head.closedSourceTipDigest && closedSnapshot === head.closedSnapshotTipDigest &&
    manifest.previousAttemptSetDigest === head.closedAttemptSetDigest &&
    coherent === head.coherentBindingDigest &&
    Date.parse(head.advancedAt) >= Date.parse(manifest.createdAt);
}

function compileAgentOsRolloverStatusInternalV1(
  input: AgentOsRolloverStatusInputV1,
): AgentOsRolloverPublicResultV1 {
  if (!validStatusInput(input)) {
    return result('degraded', 'degraded', 'halt-writes', ['manifest-invalid']);
  }
  input = pinStatusInput(input);
  if (input.commissioned !== true) {
    return result('uncommissioned', 'uncommissioned', 'none', ['not-commissioned']);
  }
  if (input.legacyActivityDetected === true) {
    return result('degraded', 'legacy-detected', 'halt-writes', ['legacy-activity-detected']);
  }
  if (!validDigest(input.runningWriterProtocolDigest)) {
    return result('degraded', 'degraded', 'halt-writes', ['writer-protocol-mismatch']);
  }
  if (input.anchor.state === 'unavailable' || input.anchor.state === 'degraded') {
    return result('unavailable', 'anchor-unavailable', 'halt-writes', [
      input.anchor.state === 'unavailable' ? 'anchor-unavailable' : 'anchor-degraded',
    ]);
  }
  if (input.anchor.state === 'missing') {
    return result('degraded', 'degraded', 'halt-writes', ['anchor-missing']);
  }
  const anchorHead = parseAgentOsObservationEpochHeadV1(input.anchor.canonicalHeadBytes);
  if (!anchorHead) return result('degraded', 'degraded', 'halt-writes', ['anchor-head-invalid']);
  if (anchorHead.writerProtocolDigest !== input.runningWriterProtocolDigest) {
    return result('degraded', 'degraded', 'halt-writes', ['writer-protocol-mismatch']);
  }
  if (!input.localActiveHeadBytes) {
    return result('degraded', 'degraded', 'halt-writes', ['local-head-missing']);
  }
  const localHead = parseAgentOsObservationEpochHeadV1(input.localActiveHeadBytes);
  if (!localHead) return result('degraded', 'degraded', 'halt-writes', ['local-head-invalid']);

  if (!exactBytes(input.anchor.canonicalHeadBytes, input.localActiveHeadBytes)) {
    if (anchorHead.epoch === localHead.epoch + 1 && anchorHead.previousHeadDigest === localHead.headDigest) {
      const prepared = input.preparedManifestBytes
        ? authenticatedManifest(input.preparedManifestBytes, input.manifestAuthenticatorVerifier)
        : null;
      const evidence = verifiedPreparedEpochEvidence(
        input.preparedEpochEvidence,
        input.preparedEpochEvidenceVerifier,
      );
      const preparedCoherent = prepared !== null && manifestHeadCoherent(prepared, anchorHead) &&
        prepared.previousEpochManifestDigest === localHead.epochManifestDigest;
      const expectedOperationId = agentOsRolloverOperationIdV1({
        fleetIdentityDigest: input.fleetIdentityDigest,
        anchorPolicyDigest: input.anchorPolicyDigest,
        expectedHeadDigest: localHead.headDigest,
        nextHeadDigest: anchorHead.headDigest,
        protocolGeneration: AGENT_OS_ROLLOVER_PROTOCOL_GENERATION_V1,
      });
      if (preparedCoherent && evidence &&
        evidence.epoch === anchorHead.epoch && evidence.previousHeadDigest === localHead.headDigest &&
        evidence.manifestDigest === prepared!.manifestDigest &&
        evidence.firstSourceBundleDigest === prepared!.firstSourceBundle.bundleDigest &&
        evidence.snapshotBasePreviousEnvelopeDigest === prepared!.snapshotBase.previousEnvelopeDigest &&
        evidence.attemptNamespaceDigest === prepared!.attemptNamespaceDigest &&
        evidence.recoveryOperationId === expectedOperationId) {
        return result('accepted', 'anchor-advanced', 'recover-local-pointer', []);
      }
      return result('degraded', 'anchor-advanced', 'halt-writes', [
        preparedCoherent ? 'prepared-epoch-evidence-unverified' : 'prepared-epoch-invalid',
      ]);
    }
    if (localHead.epoch > anchorHead.epoch) {
      return result('degraded', 'degraded', 'halt-writes', ['local-pointer-ahead']);
    }
    if (Math.abs(localHead.epoch - anchorHead.epoch) > 1) {
      return result('degraded', 'degraded', 'halt-writes', ['epoch-skip']);
    }
    return result('conflict', 'anchor-conflict', 'halt-writes', ['local-anchor-conflict']);
  }

  if (!input.activeManifestBytes) {
    return result('degraded', 'degraded', 'halt-writes', ['manifest-missing']);
  }
  const manifest = authenticatedManifest(input.activeManifestBytes, input.manifestAuthenticatorVerifier);
  if (!manifest) return result('degraded', 'degraded', 'halt-writes', ['manifest-invalid']);
  if (!manifestHeadCoherent(manifest, anchorHead)) {
    return result('degraded', 'degraded', 'halt-writes', ['head-manifest-incoherent']);
  }
  if (!input.ledgersComplete) {
    return result('degraded', 'degraded', 'halt-writes', ['ledger-incomplete']);
  }
  if (input.capacityExhausted) {
    return result('degraded', 'capacity-exhausted', 'halt-writes', ['capacity-exhausted']);
  }
  if (!input.firstSnapshotPresent) {
    return result('accepted', 'awaiting-first-snapshot', 'run-first-observation', []);
  }
  if (input.rolloverThresholdReached) {
    return result('accepted', 'rollover-required', 'prepare-rollover', []);
  }
  return result('accepted', 'healthy', 'none', []);
}

export function compileAgentOsRolloverStatusV1(
  input: AgentOsRolloverStatusInputV1,
): AgentOsRolloverPublicResultV1 {
  try {
    return compileAgentOsRolloverStatusInternalV1(input);
  } catch {
    return result('degraded', 'degraded', 'halt-writes', ['manifest-invalid']);
  }
}

export interface AgentOsRolloverPreflightInputV1 extends AgentOsRolloverStatusInputV1 {
  preparedManifestBytes: Uint8Array;
  intendedNextHeadBytes: Uint8Array;
  currentClosure: AgentOsEpochClosureEvidenceV1;
  closureEvidenceVerifier: (closure: AgentOsEpochClosureEvidenceV1) => boolean;
  openAttempts: number;
  currentSourceValid: boolean;
  coherentBindingValid: boolean;
  maintenanceRequested: boolean;
  successorSourceValid: boolean;
  roleSeparationPreserved: boolean;
  coordinationLeaseHeld: boolean;
  transactionLockHeld: boolean;
  killActive: boolean;
  cancellationActive: boolean;
  deadlineActive: boolean;
}

/**
 * Exact closure tuple supplied by an authenticated ledger reader. It is not a
 * standalone authenticated artifact and carries no key or rollback assurance.
 */
export interface AgentOsEpochClosureEvidenceV1 {
  epoch: number;
  epochHeadDigest: string;
  sourceTip: AgentOsEpochSourceTipV1;
  snapshotTip: AgentOsEpochSnapshotTipV1;
  attemptSetDigest: string;
  coherentBindingDigest: string;
}

const CLOSURE_KEYS = [
  'epoch', 'epochHeadDigest', 'sourceTip', 'snapshotTip', 'attemptSetDigest',
  'coherentBindingDigest',
] as const;
const PREFLIGHT_EXTRA_KEYS = [
  'intendedNextHeadBytes', 'currentClosure', 'closureEvidenceVerifier', 'openAttempts',
  'currentSourceValid', 'coherentBindingValid', 'maintenanceRequested', 'successorSourceValid',
  'roleSeparationPreserved', 'coordinationLeaseHeld', 'transactionLockHeld', 'killActive',
  'cancellationActive', 'deadlineActive',
] as const;

function validClosure(value: unknown): value is AgentOsEpochClosureEvidenceV1 {
  const row = record(value);
  return row !== null && exactKeys(row, CLOSURE_KEYS) &&
    validBoundedInteger(row['epoch'], AGENT_OS_ROLLOVER_MAX_EPOCH_V1) &&
    validDigest(row['epochHeadDigest']) && validSourceTip(row['sourceTip']) &&
    validSnapshotTip(row['snapshotTip']) && validDigest(row['attemptSetDigest']) &&
    validDigest(row['coherentBindingDigest']);
}

function statusProjection(input: AgentOsRolloverPreflightInputV1): AgentOsRolloverStatusInputV1 {
  return Object.fromEntries(STATUS_INPUT_KEYS.map((key) => [key, input[key]])) as unknown as
    AgentOsRolloverStatusInputV1;
}

function validPreflightInput(value: unknown): value is AgentOsRolloverPreflightInputV1 {
  const row = record(value);
  if (!row || !exactKeys(row, [...STATUS_INPUT_KEYS, ...PREFLIGHT_EXTRA_KEYS])) return false;
  const projected = Object.fromEntries(STATUS_INPUT_KEYS.map((key) => [key, row[key]]));
  return validStatusInput(projected) && row['preparedManifestBytes'] instanceof Uint8Array &&
    row['intendedNextHeadBytes'] instanceof Uint8Array && validClosure(row['currentClosure']) &&
    typeof row['closureEvidenceVerifier'] === 'function' &&
    Number.isSafeInteger(row['openAttempts']) && Number(row['openAttempts']) >= 0 &&
    [
      'currentSourceValid', 'coherentBindingValid', 'maintenanceRequested', 'successorSourceValid',
      'roleSeparationPreserved', 'coordinationLeaseHeld', 'transactionLockHeld', 'killActive',
      'cancellationActive', 'deadlineActive',
    ].every((key) => typeof row[key] === 'boolean');
}

function pinPreflightInput(input: AgentOsRolloverPreflightInputV1): AgentOsRolloverPreflightInputV1 {
  const status = pinStatusInput(input);
  const closure = deepFreeze(JSON.parse(JSON.stringify(input.currentClosure)) as AgentOsEpochClosureEvidenceV1);
  return Object.freeze({
    ...status,
    preparedManifestBytes: Buffer.from(input.preparedManifestBytes),
    intendedNextHeadBytes: Buffer.from(input.intendedNextHeadBytes),
    currentClosure: closure,
    closureEvidenceVerifier: input.closureEvidenceVerifier,
    openAttempts: input.openAttempts,
    currentSourceValid: input.currentSourceValid,
    coherentBindingValid: input.coherentBindingValid,
    maintenanceRequested: input.maintenanceRequested,
    successorSourceValid: input.successorSourceValid,
    roleSeparationPreserved: input.roleSeparationPreserved,
    coordinationLeaseHeld: input.coordinationLeaseHeld,
    transactionLockHeld: input.transactionLockHeld,
    killActive: input.killActive,
    cancellationActive: input.cancellationActive,
    deadlineActive: input.deadlineActive,
  });
}

function preflightAgentOsRolloverInternalV1(
  input: AgentOsRolloverPreflightInputV1,
): AgentOsRolloverPublicResultV1 {
  if (!validPreflightInput(input)) {
    return result('withheld', 'degraded', 'halt-writes', ['prepared-epoch-invalid']);
  }
  input = pinPreflightInput(input);
  const status = compileAgentOsRolloverStatusV1(statusProjection(input));
  if (status.state !== 'accepted' ||
    !['healthy', 'rollover-required'].includes(status.operationalState)) return status;

  const blockers: AgentOsRolloverBlockerV1[] = [];
  if (!input.ledgersComplete) blockers.push('ledger-incomplete');
  if (!Number.isSafeInteger(input.openAttempts) || input.openAttempts !== 0) blockers.push('open-attempts');
  if (!input.currentSourceValid) blockers.push('source-not-current');
  if (!input.coherentBindingValid) blockers.push('coherent-binding-missing');
  if (!input.rolloverThresholdReached && !input.maintenanceRequested) blockers.push('rollover-not-requested');
  if (!input.successorSourceValid) blockers.push('successor-source-invalid');
  if (!input.roleSeparationPreserved) blockers.push('role-separation-weakened');
  if (!input.coordinationLeaseHeld) blockers.push('coordination-lease-missing');
  if (!input.transactionLockHeld) blockers.push('transaction-lock-missing');
  if (input.killActive) blockers.push('kill-active');
  if (input.cancellationActive) blockers.push('cancellation-active');
  if (input.deadlineActive) blockers.push('deadline-active');
  if (input.capacityExhausted) blockers.push('capacity-exhausted');

  const currentHead = input.anchor.state === 'present'
    ? parseAgentOsObservationEpochHeadV1(input.anchor.canonicalHeadBytes)
    : null;
  const nextManifest = authenticatedManifest(
    input.preparedManifestBytes,
    input.manifestAuthenticatorVerifier,
  );
  const nextHead = parseAgentOsObservationEpochHeadV1(input.intendedNextHeadBytes);
  const preparedEvidence = verifiedPreparedEpochEvidence(
    input.preparedEpochEvidence,
    input.preparedEpochEvidenceVerifier,
  );
  let closureAuthenticated = false;
  try { closureAuthenticated = input.closureEvidenceVerifier(input.currentClosure) === true; } catch { /* fail closed */ }
  const preparedStructurallyValid = currentHead !== null && nextManifest !== null && nextHead !== null &&
    nextHead.epoch === currentHead.epoch + 1 &&
    nextHead.previousHeadDigest === currentHead.headDigest &&
    nextManifest.previousEpochHeadDigest === currentHead.headDigest &&
    nextManifest.previousEpochManifestDigest === currentHead.epochManifestDigest &&
    nextHead.writerProtocolDigest === input.runningWriterProtocolDigest &&
    Date.parse(nextManifest.createdAt) > Date.parse(currentHead.advancedAt) &&
    manifestHeadCoherent(nextManifest, nextHead) && closureAuthenticated &&
    input.currentClosure.epoch === currentHead.epoch &&
    input.currentClosure.epochHeadDigest === currentHead.headDigest &&
    nextManifest.previousSourceTip?.sequence === input.currentClosure.sourceTip.sequence &&
    nextManifest.previousSourceTip?.bundleDigest === input.currentClosure.sourceTip.bundleDigest &&
    nextManifest.previousSnapshotTip?.sequence === input.currentClosure.snapshotTip.sequence &&
    nextManifest.previousSnapshotTip?.envelopeDigest === input.currentClosure.snapshotTip.envelopeDigest &&
    nextManifest.previousAttemptSetDigest === input.currentClosure.attemptSetDigest &&
    nextManifest.previousCoherentBindingDigest === input.currentClosure.coherentBindingDigest;
  if (!preparedStructurallyValid) blockers.push('prepared-epoch-invalid');

  const expectedOperationId = currentHead && nextHead ? agentOsRolloverOperationIdV1({
    fleetIdentityDigest: input.fleetIdentityDigest,
    anchorPolicyDigest: input.anchorPolicyDigest,
    expectedHeadDigest: currentHead.headDigest,
    nextHeadDigest: nextHead.headDigest,
    protocolGeneration: AGENT_OS_ROLLOVER_PROTOCOL_GENERATION_V1,
  }) : null;
  if (preparedStructurallyValid && (!preparedEvidence ||
    preparedEvidence.epoch !== nextHead!.epoch ||
    preparedEvidence.previousHeadDigest !== currentHead!.headDigest ||
    preparedEvidence.manifestDigest !== nextManifest!.manifestDigest ||
    preparedEvidence.firstSourceBundleDigest !== nextManifest!.firstSourceBundle.bundleDigest ||
    preparedEvidence.snapshotBasePreviousEnvelopeDigest !== nextManifest!.snapshotBase.previousEnvelopeDigest ||
    preparedEvidence.attemptNamespaceDigest !== nextManifest!.attemptNamespaceDigest ||
    preparedEvidence.recoveryOperationId !== expectedOperationId)) {
    blockers.push('prepared-epoch-evidence-unverified');
  }

  return blockers.length > 0
    ? result('withheld', 'degraded', 'halt-writes', blockers)
    : result('accepted', 'rollover-preparing', 'none', []);
}

export function preflightAgentOsRolloverV1(
  input: AgentOsRolloverPreflightInputV1,
): AgentOsRolloverPublicResultV1 {
  try {
    return preflightAgentOsRolloverInternalV1(input);
  } catch {
    return result('withheld', 'degraded', 'halt-writes', ['prepared-epoch-invalid']);
  }
}

export interface AgentOsAnchorCasClassificationInputV1 {
  expectedCurrentHeadBytes: Uint8Array;
  intendedNextHeadBytes: Uint8Array;
  fleetIdentityDigest: string;
  anchorPolicyDigest: string;
  operationId: string;
  casResult: AgentOsMonotonicAnchorCasResultV1;
  readAfterCas: AgentOsMonotonicAnchorReadResultV1;
}

const CAS_INPUT_KEYS = [
  'expectedCurrentHeadBytes', 'intendedNextHeadBytes', 'fleetIdentityDigest',
  'anchorPolicyDigest', 'operationId', 'casResult', 'readAfterCas',
] as const;

function validCasResult(value: unknown): value is AgentOsMonotonicAnchorCasResultV1 {
  const row = record(value);
  if (!row || typeof row['state'] !== 'string') return false;
  if (row['state'] === 'advanced' || row['state'] === 'replayed') {
    return exactKeys(row, ['state', 'canonicalHeadBytes']) && row['canonicalHeadBytes'] instanceof Uint8Array;
  }
  if (row['state'] === 'conflict') {
    return exactKeys(row, ['state', 'canonicalHeadBytes']) &&
      (row['canonicalHeadBytes'] === null || row['canonicalHeadBytes'] instanceof Uint8Array);
  }
  return (row['state'] === 'unavailable' || row['state'] === 'indeterminate') && exactKeys(row, ['state']);
}

function validCasInput(value: unknown): value is AgentOsAnchorCasClassificationInputV1 {
  const row = record(value);
  return row !== null && exactKeys(row, CAS_INPUT_KEYS) &&
    row['expectedCurrentHeadBytes'] instanceof Uint8Array &&
    row['intendedNextHeadBytes'] instanceof Uint8Array && validDigest(row['fleetIdentityDigest']) &&
    validDigest(row['anchorPolicyDigest']) && validDigest(row['operationId']) &&
    validCasResult(row['casResult']) && validAnchorReadResult(row['readAfterCas']);
}

function pinCasInput(input: AgentOsAnchorCasClassificationInputV1): AgentOsAnchorCasClassificationInputV1 {
  const casResult = input.casResult.state === 'advanced' || input.casResult.state === 'replayed'
    ? { state: input.casResult.state, canonicalHeadBytes: Buffer.from(input.casResult.canonicalHeadBytes) }
    : input.casResult.state === 'conflict'
      ? {
          state: 'conflict' as const,
          canonicalHeadBytes: input.casResult.canonicalHeadBytes
            ? Buffer.from(input.casResult.canonicalHeadBytes)
            : null,
        }
      : { state: input.casResult.state };
  const readAfterCas = input.readAfterCas.state === 'present'
    ? { state: 'present' as const, canonicalHeadBytes: Buffer.from(input.readAfterCas.canonicalHeadBytes) }
    : { state: input.readAfterCas.state };
  return Object.freeze({
    expectedCurrentHeadBytes: Buffer.from(input.expectedCurrentHeadBytes),
    intendedNextHeadBytes: Buffer.from(input.intendedNextHeadBytes),
    fleetIdentityDigest: input.fleetIdentityDigest,
    anchorPolicyDigest: input.anchorPolicyDigest,
    operationId: input.operationId,
    casResult: Object.freeze(casResult),
    readAfterCas: Object.freeze(readAfterCas),
  });
}

function classifyAgentOsAnchorCasOutcomeInternalV1(
  input: AgentOsAnchorCasClassificationInputV1,
): AgentOsRolloverPublicResultV1 {
  if (!validCasInput(input)) {
    return result('degraded', 'degraded', 'halt-writes', ['prepared-epoch-invalid']);
  }
  input = pinCasInput(input);
  const current = parseAgentOsObservationEpochHeadV1(input.expectedCurrentHeadBytes);
  const intended = parseAgentOsObservationEpochHeadV1(input.intendedNextHeadBytes);
  if (!current || !intended || intended.epoch !== current.epoch + 1 ||
    intended.previousHeadDigest !== current.headDigest) {
    return result('degraded', 'degraded', 'halt-writes', ['prepared-epoch-invalid']);
  }

  const expectedOperationId = agentOsRolloverOperationIdV1({
    fleetIdentityDigest: input.fleetIdentityDigest,
    anchorPolicyDigest: input.anchorPolicyDigest,
    expectedHeadDigest: current.headDigest,
    nextHeadDigest: intended.headDigest,
    protocolGeneration: AGENT_OS_ROLLOVER_PROTOCOL_GENERATION_V1,
  });
  if (input.operationId !== expectedOperationId) {
    return result('degraded', 'degraded', 'halt-writes', ['prepared-epoch-invalid']);
  }

  const committed = (): AgentOsRolloverPublicResultV1 =>
    result('accepted', 'anchor-advanced', 'recover-local-pointer', []);
  if (input.casResult.state === 'advanced' || input.casResult.state === 'replayed') {
    if (!parseAgentOsObservationEpochHeadV1(input.casResult.canonicalHeadBytes) ||
      !exactBytes(input.casResult.canonicalHeadBytes, input.intendedNextHeadBytes)) {
      return result('degraded', 'degraded', 'halt-writes', ['anchor-head-invalid']);
    }
  }
  if (input.casResult.state === 'conflict' && input.casResult.canonicalHeadBytes &&
    !parseAgentOsObservationEpochHeadV1(input.casResult.canonicalHeadBytes)) {
    return result('degraded', 'degraded', 'halt-writes', ['anchor-head-invalid']);
  }

  const reread = input.readAfterCas;
  if (reread.state === 'degraded') {
    return result('degraded', 'degraded', 'halt-writes', ['anchor-degraded']);
  }
  if (reread.state === 'unavailable') {
    return result('indeterminate', 'anchor-unavailable', 'halt-writes', ['anchor-unavailable']);
  }
  if (reread.state === 'missing') {
    return result('indeterminate', 'anchor-unavailable', 'halt-writes', ['anchor-missing']);
  }
  if (!parseAgentOsObservationEpochHeadV1(reread.canonicalHeadBytes)) {
    return result('degraded', 'degraded', 'halt-writes', ['anchor-head-invalid']);
  }
  if (exactBytes(reread.canonicalHeadBytes, input.intendedNextHeadBytes)) return committed();
  if (exactBytes(reread.canonicalHeadBytes, input.expectedCurrentHeadBytes)) {
    if (input.casResult.state === 'indeterminate' || input.casResult.state === 'unavailable') {
      return result('indeterminate', 'rollover-preparing', 'replay-same-cas-operation', []);
    }
    if (input.casResult.state === 'advanced' || input.casResult.state === 'replayed') {
      return result('degraded', 'degraded', 'halt-writes', ['local-anchor-conflict']);
    }
  }
  return result('conflict', 'anchor-conflict', 'halt-writes', ['local-anchor-conflict']);
}

export function classifyAgentOsAnchorCasOutcomeV1(
  input: AgentOsAnchorCasClassificationInputV1,
): AgentOsRolloverPublicResultV1 {
  try {
    return classifyAgentOsAnchorCasOutcomeInternalV1(input);
  } catch {
    return result('degraded', 'degraded', 'halt-writes', ['prepared-epoch-invalid']);
  }
}
