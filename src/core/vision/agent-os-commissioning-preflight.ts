/**
 * Pure, observation-only preflight for an eventual M546 commissioning flow.
 *
 * This module consumes a closed set of already-observed facts. It performs no
 * I/O, takes no locks, reads no credentials, and cannot authorize a write. A
 * successful result means only that the supplied local observations are fit
 * for explicit commissioning review; absence observations remain TOCTOU-prone.
 */

import { createHash } from 'node:crypto';

const PROTOCOL = 'agent-os-commissioning-preflight-v1' as const;
const DOMAIN = 'ashlr:agent-os:commissioning-preflight:v1\0';
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const MAX_OBSERVATION_LIFETIME_MS = 60_000;
const MAX_FUTURE_SKEW_MS = 5_000;

const AUTHORITY = Object.freeze({
  authority: 'observation-only' as const,
  planningAuthority: false as const,
  executionAuthority: false as const,
  effectAuthority: false as const,
  proposalAuthority: false as const,
  routingAuthority: false as const,
  reservationAuthority: false as const,
  verificationAuthority: false as const,
  learningAuthority: false as const,
  policyAuthority: false as const,
  promotionAuthority: false as const,
  mergeAuthority: false as const,
  releaseAuthority: false as const,
  deployAuthority: false as const,
  publicationAuthority: false as const,
  budgetAuthority: false as const,
  credentialAuthority: false as const,
  externalMutationAuthority: false as const,
  commissioningAuthority: false as const,
  writeAuthority: false as const,
  activationAuthority: false as const,
  policyEligible: false as const,
  learningEligible: false as const,
  promotionEligible: false as const,
  stoppedRuntimeVerified: false as const,
  sameUserTamperResistant: false as const,
  rollbackProtected: false as const,
  anchorCommissioned: false as const,
  factsAuthenticated: false as const,
  evidenceAuthenticated: false as const,
});

export type AgentOsCommissioningObservedPresenceV1 = 'absent-observed' | 'present' | 'unknown';

export interface AgentOsCommissioningPreflightInputV1 {
  schemaVersion: 1;
  observedAt: string;
  expiresAt: string;
  observerConfigured: 'disabled' | 'enabled' | 'unknown';
  daemonState: 'stopped-observed' | 'running' | 'unknown';
  observerChildState: AgentOsCommissioningObservedPresenceV1;
  legacyWriterState: AgentOsCommissioningObservedPresenceV1;
  legacyLockState: AgentOsCommissioningObservedPresenceV1;
  activeAttempts: {
    state: 'zero' | 'nonzero' | 'unknown';
    authenticated: boolean;
  };
  legacyRoots: {
    state: 'absent' | 'present' | 'unknown';
    stableRead: boolean;
    mutatedAfterBaseline: boolean | null;
  };
  targetNamespace: 'absent' | 'present-empty' | 'present-nonempty' | 'unknown';
  installedBinaryDigest: string;
  writerProtocolDigest: string;
  expectedWriterProtocolDigest: string;
  anchorState:
    | 'uncommissioned'
    | 'configured-unverified'
    | 'commissioned-observed'
    | 'unavailable'
    | 'unknown';
  anchorHeadState: 'missing-observed' | 'present-unexpected' | 'unavailable' | 'unknown';
  anchorPolicyDigest: string | null;
}

export type AgentOsCommissioningPreflightStopReasonV1 =
  | 'invalid-input'
  | 'observation-future'
  | 'observation-expired'
  | 'observer-enabled'
  | 'observer-state-unknown'
  | 'daemon-running'
  | 'daemon-state-unknown'
  | 'observer-child-present'
  | 'observer-child-unknown'
  | 'legacy-writer-present'
  | 'legacy-writer-unknown'
  | 'legacy-lock-present'
  | 'legacy-lock-unknown'
  | 'active-attempts-present'
  | 'active-attempts-unknown'
  | 'active-attempts-unauthenticated'
  | 'legacy-roots-present'
  | 'legacy-roots-unknown'
  | 'legacy-roots-unstable'
  | 'legacy-mutation-detected'
  | 'legacy-mutation-unknown'
  | 'target-namespace-present'
  | 'target-namespace-unknown'
  | 'binary-digest-invalid'
  | 'writer-protocol-digest-invalid'
  | 'writer-protocol-digest-mismatch'
  | 'installed-writer-digest-mismatch'
  | 'anchor-uncommissioned'
  | 'anchor-already-commissioned'
  | 'anchor-unavailable'
  | 'anchor-state-unknown'
  | 'anchor-head-present'
  | 'anchor-head-unavailable'
  | 'anchor-head-unknown'
  | 'anchor-policy-invalid';

export interface AgentOsCommissioningPreflightResultV1 {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  state: 'locally-quiescent-unverified' | 'blocked';
  readyForExplicitCommissioningReview: boolean;
  evidenceDigest: string | null;
  observedAt: string | null;
  expiresAt: string | null;
  stopReasons: readonly AgentOsCommissioningPreflightStopReasonV1[];
  authority: 'observation-only';
  planningAuthority: false;
  executionAuthority: false;
  effectAuthority: false;
  proposalAuthority: false;
  routingAuthority: false;
  reservationAuthority: false;
  verificationAuthority: false;
  learningAuthority: false;
  policyAuthority: false;
  promotionAuthority: false;
  mergeAuthority: false;
  releaseAuthority: false;
  deployAuthority: false;
  publicationAuthority: false;
  budgetAuthority: false;
  credentialAuthority: false;
  externalMutationAuthority: false;
  commissioningAuthority: false;
  writeAuthority: false;
  activationAuthority: false;
  policyEligible: false;
  learningEligible: false;
  promotionEligible: false;
  stoppedRuntimeVerified: false;
  sameUserTamperResistant: false;
  rollbackProtected: false;
  anchorCommissioned: false;
  factsAuthenticated: false;
  evidenceAuthenticated: false;
}

const INPUT_KEYS = new Set([
  'schemaVersion', 'observedAt', 'expiresAt', 'observerConfigured', 'daemonState',
  'observerChildState', 'legacyWriterState', 'legacyLockState', 'activeAttempts',
  'legacyRoots', 'targetNamespace', 'installedBinaryDigest', 'writerProtocolDigest',
  'expectedWriterProtocolDigest', 'anchorState', 'anchorPolicyDigest',
  'anchorHeadState',
]);
const ATTEMPT_KEYS = new Set(['state', 'authenticated']);
const LEGACY_ROOT_KEYS = new Set(['state', 'stableRead', 'mutatedAfterBaseline']);

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) return null;
    if (keys.some((key) => {
      const descriptor = descriptors[String(key)];
      return !descriptor || !descriptor.enumerable || !('value' in descriptor);
    })) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
}

function validInput(value: unknown): value is AgentOsCommissioningPreflightInputV1 {
  const input = record(value);
  if (!input || !exactKeys(input, INPUT_KEYS) || input['schemaVersion'] !== 1 ||
    !timestamp(input['observedAt']) || !timestamp(input['expiresAt']) ||
    !oneOf(input['observerConfigured'], ['disabled', 'enabled', 'unknown']) ||
    !oneOf(input['daemonState'], ['stopped-observed', 'running', 'unknown']) ||
    !oneOf(input['observerChildState'], ['absent-observed', 'present', 'unknown']) ||
    !oneOf(input['legacyWriterState'], ['absent-observed', 'present', 'unknown']) ||
    !oneOf(input['legacyLockState'], ['absent-observed', 'present', 'unknown']) ||
    !oneOf(input['targetNamespace'], ['absent', 'present-empty', 'present-nonempty', 'unknown']) ||
    !oneOf(input['anchorState'], [
      'uncommissioned', 'configured-unverified', 'commissioned-observed', 'unavailable', 'unknown',
    ]) || !oneOf(input['anchorHeadState'], [
      'missing-observed', 'present-unexpected', 'unavailable', 'unknown',
    ]) || typeof input['installedBinaryDigest'] !== 'string' ||
    typeof input['writerProtocolDigest'] !== 'string' ||
    typeof input['expectedWriterProtocolDigest'] !== 'string' ||
    !(input['anchorPolicyDigest'] === null || typeof input['anchorPolicyDigest'] === 'string')) return false;
  const attempts = record(input['activeAttempts']);
  const roots = record(input['legacyRoots']);
  return Boolean(attempts && exactKeys(attempts, ATTEMPT_KEYS) &&
    oneOf(attempts['state'], ['zero', 'nonzero', 'unknown']) &&
    typeof attempts['authenticated'] === 'boolean' &&
    roots && exactKeys(roots, LEGACY_ROOT_KEYS) &&
    oneOf(roots['state'], ['absent', 'present', 'unknown']) &&
    typeof roots['stableRead'] === 'boolean' &&
    (roots['mutatedAfterBaseline'] === null || typeof roots['mutatedAfterBaseline'] === 'boolean'));
}

function blocked(reasons: AgentOsCommissioningPreflightStopReasonV1[]): AgentOsCommissioningPreflightResultV1 {
  return Object.freeze({
    schemaVersion: 1, protocol: PROTOCOL, state: 'blocked',
    readyForExplicitCommissioningReview: false, evidenceDigest: null,
    observedAt: null, expiresAt: null, stopReasons: Object.freeze([...new Set(reasons)]),
    ...AUTHORITY,
  });
}

/**
 * Compile a short-lived fresh-namespace review candidate. This is never a
 * commissioning permit or the future stopped-runtime legacy-import preflight.
 */
export function compileAgentOsCommissioningPreflightV1(
  value: unknown,
  nowMs: number = Date.now(),
): AgentOsCommissioningPreflightResultV1 {
  if (!Number.isFinite(nowMs) || !validInput(value)) return blocked(['invalid-input']);
  const input = value;
  const observedAtMs = Date.parse(input.observedAt);
  const expiresAtMs = Date.parse(input.expiresAt);
  const reasons: AgentOsCommissioningPreflightStopReasonV1[] = [];
  if (observedAtMs > nowMs + MAX_FUTURE_SKEW_MS) reasons.push('observation-future');
  if (expiresAtMs <= nowMs || expiresAtMs <= observedAtMs ||
    expiresAtMs - observedAtMs > MAX_OBSERVATION_LIFETIME_MS) reasons.push('observation-expired');
  if (input.observerConfigured !== 'disabled') reasons.push(
    input.observerConfigured === 'enabled' ? 'observer-enabled' : 'observer-state-unknown');
  if (input.daemonState !== 'stopped-observed') reasons.push(
    input.daemonState === 'running' ? 'daemon-running' : 'daemon-state-unknown');
  for (const [state, present, unknown] of [
    [input.observerChildState, 'observer-child-present', 'observer-child-unknown'],
    [input.legacyWriterState, 'legacy-writer-present', 'legacy-writer-unknown'],
    [input.legacyLockState, 'legacy-lock-present', 'legacy-lock-unknown'],
  ] as const) {
    if (state !== 'absent-observed') reasons.push(state === 'present' ? present : unknown);
  }
  if (input.activeAttempts.state !== 'zero') reasons.push(
    input.activeAttempts.state === 'nonzero' ? 'active-attempts-present' : 'active-attempts-unknown');
  if (!input.activeAttempts.authenticated) reasons.push('active-attempts-unauthenticated');
  if (input.legacyRoots.state !== 'absent') reasons.push(
    input.legacyRoots.state === 'present' ? 'legacy-roots-present' : 'legacy-roots-unknown');
  if (!input.legacyRoots.stableRead) reasons.push('legacy-roots-unstable');
  if (input.legacyRoots.mutatedAfterBaseline !== false) reasons.push(
    input.legacyRoots.mutatedAfterBaseline === true ? 'legacy-mutation-detected' : 'legacy-mutation-unknown');
  if (input.targetNamespace !== 'absent') reasons.push(
    input.targetNamespace === 'unknown' ? 'target-namespace-unknown' : 'target-namespace-present');
  if (!SHA256_RE.test(input.installedBinaryDigest)) reasons.push('binary-digest-invalid');
  if (!SHA256_RE.test(input.writerProtocolDigest) || !SHA256_RE.test(input.expectedWriterProtocolDigest)) {
    reasons.push('writer-protocol-digest-invalid');
  } else if (input.writerProtocolDigest !== input.expectedWriterProtocolDigest) {
    reasons.push('writer-protocol-digest-mismatch');
  }
  if (SHA256_RE.test(input.installedBinaryDigest) && SHA256_RE.test(input.writerProtocolDigest) &&
    input.installedBinaryDigest !== input.writerProtocolDigest) {
    reasons.push('installed-writer-digest-mismatch');
  }
  if (input.anchorState !== 'configured-unverified') reasons.push(
    input.anchorState === 'uncommissioned' ? 'anchor-uncommissioned' :
      input.anchorState === 'commissioned-observed' ? 'anchor-already-commissioned' :
        input.anchorState === 'unavailable' ? 'anchor-unavailable' : 'anchor-state-unknown');
  if (input.anchorHeadState !== 'missing-observed') reasons.push(
    input.anchorHeadState === 'present-unexpected' ? 'anchor-head-present' :
      input.anchorHeadState === 'unavailable' ? 'anchor-head-unavailable' : 'anchor-head-unknown');
  if (!SHA256_RE.test(input.anchorPolicyDigest ?? '')) reasons.push('anchor-policy-invalid');
  if (reasons.length > 0) return blocked(reasons);
  const evidenceDigest = `sha256:${createHash('sha256').update(DOMAIN, 'utf8')
    .update(canonicalJson(input), 'utf8').digest('hex')}`;
  return Object.freeze({
    schemaVersion: 1, protocol: PROTOCOL, state: 'locally-quiescent-unverified',
    readyForExplicitCommissioningReview: true, evidenceDigest,
    observedAt: input.observedAt, expiresAt: input.expiresAt,
    stopReasons: Object.freeze([]), ...AUTHORITY,
  });
}

/** Default production posture: no adapter or trust state is assumed or created. */
export function uncommissionedAgentOsPreflightV1(): AgentOsCommissioningPreflightResultV1 {
  return blocked(['anchor-uncommissioned']);
}
