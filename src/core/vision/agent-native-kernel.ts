/**
 * Agent-Native Kernel Shadow V1.
 *
 * A pure composition receipt over Execution Identity V1 and the Living
 * End-State portfolio. It performs no I/O and owns no authority. Callers
 * supply verified evidence metadata, time, and the prior verified cycle.
 */

import { createHash } from 'node:crypto';
import {
  EXECUTION_IDENTITY_V1_MAX_FUTURE_SKEW_MS,
  EXECUTION_IDENTITY_V1_OBSERVATION_MAX_AGE_MS,
  digestExecutionIdentityModelResourcesV1,
  type ExecutionIdentityShadowStatusV1,
} from '../fabric/execution-identity.js';
import {
  digestResourceEnvelopeV1,
  verifyResourceEnvelopeV1,
  verifyPortfolioShadowV1,
  type PortfolioShadowV1,
  type ResourceEnvelopeV1,
} from './value-portfolio.js';

export const AGENT_NATIVE_KERNEL_SCHEMA_VERSION = 1 as const;
export const AGENT_NATIVE_KERNEL_PROTOCOL = 'agent-native-kernel-shadow-v1' as const;

const DIGEST_RE = /^(?:sha256:)?[a-f0-9]{64}$/;
const IDENTITY_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const MAX_IDENTITIES = 32;
const MAX_ITEMS = 4_096;

type Digest = string;
type KernelPhaseV1 = 'sense' | 'allocate' | 'observe';
type KernelLifecycleV1 = 'degraded' | 'holding' | 'running' | 'observing' | 'settled';
type KernelDegradedReasonV1 =
  | 'identity-disabled'
  | 'identity-degraded'
  | 'identity-resource-mismatch'
  | 'resource-source-incomplete'
  | 'evidence-source-incomplete';
type KernelHoldReasonV1 =
  | 'no-candidates'
  | 'source-incomplete'
  | 'outcome-untrusted'
  | 'outcome-window-open'
  | 'dependency-blocked'
  | 'portfolio-cap'
  | 'insufficient-capacity';

export interface AgentNativeKernelEvidenceV1 {
  /** Neutral wire-format identifier. It conveys no authenticity by itself. */
  format: 'evidence-index-v1';
  sourceComplete: boolean;
  evidenceDigest: Digest;
  resourceDigest: Digest;
  portfolioDigest: Digest;
  observedAt: string;
}

/** Authenticates the exact evidence index through an external trust root. */
export interface AgentNativeKernelEvidenceVerifierV1 {
  verifyEvidenceIndex(
    evidence: Readonly<AgentNativeKernelEvidenceV1>,
  ): { authenticated: boolean };
}

export interface AgentNativeKernelCheckpointInputV1 {
  sequence: number;
  previousCycle: AgentNativeKernelShadowV1 | null;
  nextWakeAt: string;
}

export interface AgentNativeKernelInputV1 {
  schemaVersion: 1;
  asOf: string;
  specDigest: Digest;
  missionDigest: Digest;
  executionIdentity: ExecutionIdentityShadowStatusV1;
  resourceEnvelope: ResourceEnvelopeV1;
  portfolio: PortfolioShadowV1;
  evidence: AgentNativeKernelEvidenceV1;
  checkpoint: AgentNativeKernelCheckpointInputV1;
}

interface KernelAuthorityV1 {
  planning: false;
  execution: false;
  proposal: false;
  agent: false;
  merge: false;
  release: false;
  deploy: false;
  rollback: false;
  publication: false;
  externalMutation: false;
  budget: false;
  learning: false;
}

interface KernelEffectsV1 {
  files: false;
  models: false;
  providers: false;
  dispatches: false;
  goals: false;
  proposals: false;
  merges: false;
  releases: false;
  deployments: false;
  rollbacks: false;
  publications: false;
  externalMutations: false;
  budgets: false;
  learning: false;
}

export interface AgentNativeKernelShadowV1 {
  schemaVersion: 1;
  protocol: typeof AGENT_NATIVE_KERNEL_PROTOCOL;
  recordType: 'agent-native-kernel-cycle';
  mode: 'shadow';
  authority: 'observation-only';
  policyEligible: false;
  phase: KernelPhaseV1;
  lifecycle: KernelLifecycleV1;
  degradedReasons: KernelDegradedReasonV1[];
  holdReasons: KernelHoldReasonV1[];
  sources: {
    identity: 'disabled' | 'healthy' | 'degraded';
    resourceComplete: boolean;
    evidenceComplete: boolean;
  };
  basis: {
    asOf: string;
    specDigest: Digest;
    missionDigest: Digest;
    executionIdentityDigest: Digest;
    executionIdentityModelDigest: Digest;
    resourceDigest: Digest;
    evidenceDigest: Digest;
    portfolioDigest: Digest;
  };
  counts: {
    identities: number;
    trustedSlots: number;
    candidates: number;
    allocated: number;
    observing: number;
    held: number;
    stopped: number;
    effective: number;
    refuted: number;
    guardrailBreached: number;
  };
  checkpoint: {
    sequence: number;
    previousCycleDigest: Digest | null;
    nextWakeAt: string;
    checkpointDigest: Digest;
  };
  authorityBits: KernelAuthorityV1;
  effects: KernelEffectsV1;
  basisDigest: Digest;
  cycleDigest: Digest;
}

export type AgentNativeKernelBuildResultV1 =
  | { ok: true; kernel: AgentNativeKernelShadowV1; issues: [] }
  | { ok: false; kernel: null; issues: string[] };

const INPUT_KEYS = new Set([
  'schemaVersion', 'asOf', 'specDigest', 'missionDigest', 'executionIdentity',
  'resourceEnvelope', 'portfolio', 'evidence', 'checkpoint',
]);
const EVIDENCE_KEYS = new Set([
  'format', 'sourceComplete', 'evidenceDigest', 'resourceDigest', 'portfolioDigest',
  'observedAt',
]);
const CHECKPOINT_INPUT_KEYS = new Set([
  'sequence', 'previousCycle', 'nextWakeAt',
]);
const IDENTITY_KEYS = new Set([
  'schemaVersion', 'authority', 'enabled', 'shadowOnly', 'sourceState', 'stopReasons',
  'configuredIdentityCount', 'identities', 'assignments', 'unassigned',
  'executionAuthority', 'proposalAuthority', 'routingMutation',
]);
const IDENTITY_RESOURCE_KEYS = new Set([
  'executionIdentityDigest', 'engine', 'state', 'trustedSlots', 'maxConcurrent',
  'usedPercent', 'observedAt', 'reason',
]);
const IDENTITY_ASSIGNMENT_KEYS = new Set([
  'workItemDigest', 'engine', 'executionIdentityDigest', 'authority', 'executionAuthority',
]);
const IDENTITY_UNASSIGNED_KEYS = new Set(['workItemDigest', 'engine', 'reason']);
const OUTPUT_KEYS = new Set([
  'schemaVersion', 'protocol', 'recordType', 'mode', 'authority', 'policyEligible',
  'phase', 'lifecycle', 'degradedReasons', 'holdReasons', 'sources', 'basis', 'counts',
  'checkpoint', 'authorityBits', 'effects', 'basisDigest', 'cycleDigest',
]);
const SOURCE_KEYS = new Set(['identity', 'resourceComplete', 'evidenceComplete']);
const BASIS_KEYS = new Set([
  'asOf', 'specDigest', 'missionDigest', 'executionIdentityDigest', 'executionIdentityModelDigest', 'resourceDigest',
  'evidenceDigest', 'portfolioDigest',
]);
const COUNT_KEYS = new Set([
  'identities', 'trustedSlots', 'candidates', 'allocated', 'observing', 'held', 'stopped',
  'effective', 'refuted',
  'guardrailBreached',
]);
const CHECKPOINT_KEYS = new Set([
  'sequence', 'previousCycleDigest', 'nextWakeAt', 'checkpointDigest',
]);
const AUTHORITY_KEYS = new Set([
  'planning', 'execution', 'proposal', 'agent', 'merge', 'release', 'deploy', 'rollback',
  'publication', 'externalMutation', 'budget', 'learning',
]);
const EFFECT_KEYS = new Set([
  'files', 'models', 'providers', 'dispatches', 'goals', 'proposals', 'merges', 'releases',
  'deployments', 'rollbacks', 'publications', 'externalMutations', 'budgets', 'learning',
]);
const ENGINES = new Set([
  'builtin', 'local-coder', 'ashlrcode', 'aw', 'claude', 'codex', 'hermes', 'kimi',
  'nim', 'opencode', 'grok',
]);
const IDENTITY_STATES = new Set(['open', 'near', 'exhausted', 'unreachable', 'unknown']);
const RESOURCE_REASONS = new Set([
  'observation-missing', 'observation-stale', 'observed-open', 'observed-near',
  'observed-exhausted', 'observed-unreachable', 'observed-zero-capacity',
  'interactive-reserved', 'backoff-rate-limited', 'backoff-provider-refused',
  'backoff-transport-error',
]);
const STOP_REASONS = new Set([
  'feature-not-shadow-only', 'identity-roster-missing', 'identity-roster-limit',
  'invalid-identity-record', 'invalid-identity-ref', 'duplicate-identity-ref',
  'duplicate-runtime-locator-ref', 'engine-not-allowed', 'engine-not-registered',
  'platform-private-store-unsupported', 'private-store-missing', 'private-store-unsafe',
  'private-store-malformed', 'private-binding-missing', 'auth-engine-mismatch',
  'plan-engine-mismatch', 'plan-policy-missing', 'runtime-locator-invalid',
  'phantom-reference-invalid', 'resource-roster-mismatch',
]);
const DEGRADED_REASONS = new Set<KernelDegradedReasonV1>([
  'identity-disabled', 'identity-degraded', 'identity-resource-mismatch',
  'resource-source-incomplete', 'evidence-source-incomplete',
]);
const HOLD_REASONS = new Set<KernelHoldReasonV1>([
  'no-candidates', 'source-incomplete', 'outcome-untrusted', 'outcome-window-open',
  'dependency-blocked', 'portfolio-cap', 'insufficient-capacity',
]);

type SnapshotResult = { ok: true; value: unknown } | { ok: false };

function safeSnapshot(value: unknown, depth = 0, seen = new Set<object>()): SnapshotResult {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return { ok: true, value };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  }
  if (typeof value !== 'object' || depth > 24 || seen.has(value)) return { ok: false };
  seen.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (value.length > MAX_ITEMS || Reflect.ownKeys(value).some((key) =>
        typeof key === 'symbol' || (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key)))) {
        return { ok: false };
      }
      const output: unknown[] = [];
      for (const entry of value) {
        const item = safeSnapshot(entry, depth + 1, seen);
        if (!item.ok) return item;
        output.push(item.value);
      }
      return { ok: true, value: output };
    }
    if (prototype !== Object.prototype && prototype !== null) return { ok: false };
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_ITEMS || keys.some((key) => typeof key !== 'string')) return { ok: false };
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !('value' in descriptor)) return { ok: false };
      const item = safeSnapshot(descriptor.value, depth + 1, seen);
      if (!item.ok) return item;
      output[key] = item.value;
    }
    return { ok: true, value: output };
  } finally {
    seen.delete(value);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function digestValue(value: unknown, domain: string): Digest {
  return createHash('sha256').update(domain, 'utf8').update('\0')
    .update(canonicalJson(value), 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function validIdentityResource(value: unknown): boolean {
  const row = record(value);
  if (!row || !exactKeys(row, IDENTITY_RESOURCE_KEYS) ||
    typeof row['executionIdentityDigest'] !== 'string' ||
    !IDENTITY_DIGEST_RE.test(row['executionIdentityDigest']) || !ENGINES.has(String(row['engine'])) ||
    !IDENTITY_STATES.has(String(row['state'])) || !integer(row['trustedSlots'], 0, MAX_IDENTITIES) ||
    !integer(row['maxConcurrent'], 0, MAX_IDENTITIES) ||
    (row['usedPercent'] !== null && (typeof row['usedPercent'] !== 'number' ||
      !Number.isFinite(row['usedPercent']) || row['usedPercent'] < 0 || row['usedPercent'] > 100)) ||
    (row['observedAt'] !== null && !timestamp(row['observedAt'])) ||
    !RESOURCE_REASONS.has(String(row['reason']))) return false;
  const trusted = row['trustedSlots'] as number;
  const maximum = row['maxConcurrent'] as number;
  const reason = String(row['reason']);
  if (trusted > maximum || (trusted > 0) !== ['observed-open', 'observed-near'].includes(String(reason))) {
    return false;
  }
  const expectedState = reason === 'observed-open' ? 'open'
    : reason === 'observed-near' ? 'near'
      : reason === 'observed-unreachable' ? 'unreachable'
        : ['observed-exhausted', 'observed-zero-capacity', 'backoff-rate-limited',
          'backoff-provider-refused', 'backoff-transport-error'].includes(reason)
          ? 'exhausted'
          : 'unknown';
  const expectedNullObservation = [
    'observation-missing', 'interactive-reserved', 'backoff-rate-limited',
    'backoff-provider-refused', 'backoff-transport-error',
  ].includes(reason);
  return row['state'] === expectedState &&
    (expectedNullObservation ? row['observedAt'] === null : row['observedAt'] !== null);
}

function validIdentityAssignment(value: unknown): boolean {
  const row = record(value);
  return !!row && exactKeys(row, IDENTITY_ASSIGNMENT_KEYS) &&
    typeof row['workItemDigest'] === 'string' && IDENTITY_DIGEST_RE.test(row['workItemDigest']) &&
    ENGINES.has(String(row['engine'])) && typeof row['executionIdentityDigest'] === 'string' &&
    IDENTITY_DIGEST_RE.test(row['executionIdentityDigest']) && row['authority'] === 'shadow-only' &&
    row['executionAuthority'] === false;
}

function validIdentityUnassigned(value: unknown): boolean {
  const row = record(value);
  if (!row || !exactKeys(row, IDENTITY_UNASSIGNED_KEYS) ||
    typeof row['workItemDigest'] !== 'string' || !IDENTITY_DIGEST_RE.test(row['workItemDigest']) ||
    !['invalid-work-item', 'no-trusted-capacity'].includes(String(row['reason']))) return false;
  return row['reason'] === 'invalid-work-item'
    ? row['engine'] === null
    : ENGINES.has(String(row['engine']));
}

function verifyIdentitySnapshot(value: unknown, asOf: string): ExecutionIdentityShadowStatusV1 | null {
  const row = record(value);
  if (!row || !exactKeys(row, IDENTITY_KEYS) || row['schemaVersion'] !== 1 ||
    row['authority'] !== 'shadow-only' || typeof row['enabled'] !== 'boolean' ||
    row['shadowOnly'] !== true || !['disabled', 'healthy', 'degraded'].includes(String(row['sourceState'])) ||
    !Array.isArray(row['stopReasons']) || row['stopReasons'].length > STOP_REASONS.size ||
    row['stopReasons'].some((reason) => !STOP_REASONS.has(String(reason))) ||
    new Set(row['stopReasons']).size !== row['stopReasons'].length ||
    !integer(row['configuredIdentityCount'], 0, MAX_IDENTITIES) || !Array.isArray(row['identities']) ||
    row['identities'].length > MAX_IDENTITIES || row['identities'].some((item) => !validIdentityResource(item)) ||
    !Array.isArray(row['assignments']) || row['assignments'].length > MAX_ITEMS ||
    row['assignments'].some((item) => !validIdentityAssignment(item)) ||
    !Array.isArray(row['unassigned']) || row['unassigned'].length > MAX_ITEMS ||
    row['unassigned'].some((item) => !validIdentityUnassigned(item)) ||
    row['executionAuthority'] !== false || row['proposalAuthority'] !== false ||
    row['routingMutation'] !== false) return null;

  const source = row['sourceState'];
  const enabled = row['enabled'];
  if ((source === 'disabled' && (enabled !== false || row['configuredIdentityCount'] !== 0 ||
      row['stopReasons'].length !== 0 || row['identities'].length !== 0 ||
      row['assignments'].length !== 0 || row['unassigned'].length !== 0)) ||
    (source === 'degraded' && (enabled !== true || row['stopReasons'].length === 0 ||
      row['identities'].length !== 0 || row['assignments'].length !== 0 ||
      row['unassigned'].length !== 0)) ||
    (source === 'healthy' && (enabled !== true || row['stopReasons'].length !== 0 ||
      row['configuredIdentityCount'] !== row['identities'].length))) return null;

  const identities = row['identities'] as Array<Record<string, unknown>>;
  const identityDigests = identities.map((item) => item['executionIdentityDigest'] as string);
  if (new Set(identityDigests).size !== identityDigests.length) return null;
  const byDigest = new Map(identities.map((item) => [item['executionIdentityDigest'], item]));
  const usage = new Map<string, number>();
  for (const assignment of row['assignments'] as Array<Record<string, unknown>>) {
    const identity = byDigest.get(assignment['executionIdentityDigest']);
    if (!identity || identity['engine'] !== assignment['engine']) return null;
    const key = assignment['executionIdentityDigest'] as string;
    usage.set(key, (usage.get(key) ?? 0) + 1);
  }
  if ([...usage].some(([key, count]) => count > Number(byDigest.get(key)?.['trustedSlots'] ?? 0))) {
    return null;
  }
  const asOfMs = Date.parse(asOf);
  for (const identity of identities) {
    const observedAt = identity['observedAt'];
    if (observedAt === null) continue;
    const ageMs = asOfMs - Date.parse(observedAt as string);
    const stale = identity['reason'] === 'observation-stale';
    if (ageMs < -EXECUTION_IDENTITY_V1_MAX_FUTURE_SKEW_MS ||
      (stale && ageMs <= EXECUTION_IDENTITY_V1_OBSERVATION_MAX_AGE_MS) ||
      (!stale && ageMs > EXECUTION_IDENTITY_V1_OBSERVATION_MAX_AGE_MS)) return null;
  }
  return value as ExecutionIdentityShadowStatusV1;
}

function allFalse(value: unknown, keys: ReadonlySet<string>): boolean {
  const row = record(value);
  return !!row && exactKeys(row, keys) && Object.values(row).every((entry) => entry === false);
}

function portfolioCounts(portfolio: PortfolioShadowV1): AgentNativeKernelShadowV1['counts'] {
  const decisions = portfolio.decisions;
  return {
    identities: 0,
    trustedSlots: 0,
    candidates: decisions.length,
    allocated: decisions.filter((item) => item.allocation !== null).length,
    observing: decisions.filter((item) => item.reason === 'outcome-window-open').length,
    held: decisions.filter((item) => item.disposition === 'hold').length,
    stopped: decisions.filter((item) => item.disposition === 'stop').length,
    effective: decisions.filter((item) => item.effective === true).length,
    refuted: decisions.filter((item) => item.reason === 'refuted').length,
    guardrailBreached: decisions.filter((item) => item.reason === 'guardrail-breached').length,
  };
}

function evidenceIndexAuthenticated(
  verifier: AgentNativeKernelEvidenceVerifierV1 | null,
  evidence: AgentNativeKernelEvidenceV1,
): boolean {
  if (!verifier) return false;
  try {
    return verifier.verifyEvidenceIndex(evidence)?.authenticated === true;
  } catch {
    return false;
  }
}

/** Build one deterministic, values-free sense → allocate → observe cycle receipt. */
export function buildAgentNativeKernelShadowV1(
  value: unknown,
  verifier: AgentNativeKernelEvidenceVerifierV1 | null = null,
): AgentNativeKernelBuildResultV1 {
  const snap = safeSnapshot(value);
  const input = snap.ok ? record(snap.value) : null;
  if (!input || !exactKeys(input, INPUT_KEYS) || input['schemaVersion'] !== 1 ||
    !timestamp(input['asOf']) || typeof input['specDigest'] !== 'string' ||
    !DIGEST_RE.test(input['specDigest']) || typeof input['missionDigest'] !== 'string' ||
    !DIGEST_RE.test(input['missionDigest'])) {
    return { ok: false, kernel: null, issues: ['invalid-input'] };
  }
  const identity = verifyIdentitySnapshot(input['executionIdentity'], input['asOf'] as string);
  if (!identity) return { ok: false, kernel: null, issues: ['invalid-identity-snapshot'] };
  const resourceEnvelope = verifyResourceEnvelopeV1(input['resourceEnvelope']);
  if (!resourceEnvelope) return { ok: false, kernel: null, issues: ['invalid-resource-snapshot'] };
  const portfolio = verifyPortfolioShadowV1(input['portfolio']);
  if (!portfolio) return { ok: false, kernel: null, issues: ['invalid-portfolio-snapshot'] };
  const identityDigest = digestValue(identity, 'ashlr:agent-native-kernel:identity:v1');
  const executionIdentityModelDigest = digestExecutionIdentityModelResourcesV1(
    identity.sourceState,
    identity.identities,
  );
  const resourceDigest = digestResourceEnvelopeV1(resourceEnvelope);
  if (!resourceDigest) return { ok: false, kernel: null, issues: ['invalid-resource-snapshot'] };
  const evidence = record(input['evidence']);
  const checkpointInput = record(input['checkpoint']);
  const previousCycle = checkpointInput?.['previousCycle'] === null
    ? null
    : verifyAgentNativeKernelShadowV1(checkpointInput?.['previousCycle']);
  const asOfMs = Date.parse(input['asOf'] as string);
  if (!evidence || !exactKeys(evidence, EVIDENCE_KEYS) ||
    evidence['format'] !== 'evidence-index-v1' ||
    typeof evidence['sourceComplete'] !== 'boolean' ||
    typeof evidence['evidenceDigest'] !== 'string' || !DIGEST_RE.test(evidence['evidenceDigest']) ||
    typeof evidence['resourceDigest'] !== 'string' || !DIGEST_RE.test(evidence['resourceDigest']) ||
    typeof evidence['portfolioDigest'] !== 'string' || !DIGEST_RE.test(evidence['portfolioDigest']) ||
    evidence['resourceDigest'] !== resourceDigest || evidence['portfolioDigest'] !== portfolio.portfolioDigest ||
    !timestamp(evidence['observedAt']) || Date.parse(evidence['observedAt'] as string) > asOfMs ||
    asOfMs - Date.parse(evidence['observedAt'] as string) >
      EXECUTION_IDENTITY_V1_OBSERVATION_MAX_AGE_MS ||
    !checkpointInput || !exactKeys(checkpointInput, CHECKPOINT_INPUT_KEYS) ||
    !integer(checkpointInput['sequence'], 0, Number.MAX_SAFE_INTEGER) ||
    (checkpointInput['sequence'] === 0) !== (checkpointInput['previousCycle'] === null) ||
    (checkpointInput['previousCycle'] !== null && previousCycle === null) ||
    (previousCycle !== null && (checkpointInput['sequence'] !== previousCycle.checkpoint.sequence + 1 ||
      previousCycle.basis.asOf >= input['asOf'])) ||
    !timestamp(checkpointInput['nextWakeAt']) || checkpointInput['nextWakeAt'] <= input['asOf']) {
    return { ok: false, kernel: null, issues: ['invalid-cycle-metadata'] };
  }
  if (!evidenceIndexAuthenticated(verifier, evidence as unknown as AgentNativeKernelEvidenceV1)) {
    return { ok: false, kernel: null, issues: ['evidence-index-authentication-failed'] };
  }
  if (portfolio.basis.asOf !== input['asOf'] || portfolio.basis.specDigest !== input['specDigest'] ||
    portfolio.basis.missionDigest !== input['missionDigest'] ||
    portfolio.basis.resourceEnvelopeDigest !== resourceDigest) {
    return { ok: false, kernel: null, issues: ['basis-mismatch'] };
  }

  const counts = portfolioCounts(portfolio);
  counts.identities = identity.identities.length;
  counts.trustedSlots = identity.identities.reduce((sum, item) => sum + item.trustedSlots, 0);

  const degraded: KernelDegradedReasonV1[] = [];
  if (identity.sourceState === 'disabled') degraded.push('identity-disabled');
  if (identity.sourceState === 'degraded') degraded.push('identity-degraded');
  if (!portfolio.resources.sourceComplete) degraded.push('resource-source-incomplete');
  if (evidence['sourceComplete'] === false) degraded.push('evidence-source-incomplete');
  const providerForEngine = (engine: string | undefined): ResourceEnvelopeV1['capacity'][number]['provider'] | null =>
    engine === 'codex' ? 'codex' : engine === 'claude' ? 'claude' : engine === 'local-coder' ? 'local' : null;
  const identityByDigest = new Map<string, ExecutionIdentityShadowStatusV1['identities'][number]>(
    identity.identities.map((item) =>
    [item.executionIdentityDigest, item] as const));
  const stateMatches = (resourceState: ResourceEnvelopeV1['capacity'][number]['state'],
    identityResource: ExecutionIdentityShadowStatusV1['identities'][number] | undefined): boolean => {
    if (!identityResource) return false;
    if (resourceState === 'open' || resourceState === 'near') return identityResource.state === resourceState;
    if (resourceState === 'stale') return identityResource.reason === 'observation-stale';
    if (resourceState === 'reserved') return identityResource.reason === 'interactive-reserved';
    if (resourceState === 'unknown') return identityResource.reason === 'observation-missing';
    return identityResource.state === 'exhausted' || identityResource.state === 'unreachable';
  };
  const relevantIdentityDigests = new Set(identity.identities
    .filter((item) => providerForEngine(item.engine) !== null)
    .map((item) => item.executionIdentityDigest));
  const envelopeIdentityDigests = new Set(resourceEnvelope.capacity
    .map((item) => item.executionIdentityDigest));
  if (identity.sourceState === 'healthy' && resourceEnvelope.sourceComplete && (
    relevantIdentityDigests.size !== envelopeIdentityDigests.size ||
    [...relevantIdentityDigests].some((item) => !envelopeIdentityDigests.has(item)) ||
    resourceEnvelope.capacity.some((item) => {
      const identityResource = identityByDigest.get(item.executionIdentityDigest);
      return item.provider !== providerForEngine(identityResource?.engine) ||
        !stateMatches(item.state, identityResource);
    }))) {
    degraded.push('identity-resource-mismatch');
  }
  const degradedReasons = sortedUnique(degraded);
  const holdReasons = sortedUnique<KernelHoldReasonV1>([
    ...(portfolio.decisions.length === 0 ? ['no-candidates' as const] : []),
    ...portfolio.decisions.flatMap((decision) =>
      decision.disposition === 'hold' && HOLD_REASONS.has(decision.reason as KernelHoldReasonV1)
        ? [decision.reason as KernelHoldReasonV1]
        : []),
  ]);
  const hasObservedOutcome = counts.observing + counts.effective + counts.refuted +
    counts.guardrailBreached > 0;
  const allSettled = counts.candidates > 0 && counts.stopped === counts.candidates;
  const phase: KernelPhaseV1 = degradedReasons.length > 0
    ? 'sense'
    : hasObservedOutcome || allSettled ? 'observe' : counts.allocated > 0 ? 'allocate' : 'sense';
  const lifecycle: KernelLifecycleV1 = degradedReasons.length > 0
    ? 'degraded'
    : allSettled ? 'settled' : hasObservedOutcome ? 'observing'
      : counts.allocated > 0 ? 'running' : 'holding';
  const basis = {
    asOf: input['asOf'] as string,
    specDigest: input['specDigest'] as string,
    missionDigest: input['missionDigest'] as string,
    executionIdentityDigest: identityDigest,
    executionIdentityModelDigest,
    resourceDigest,
    evidenceDigest: evidence['evidenceDigest'] as string,
    portfolioDigest: portfolio.portfolioDigest,
  };
  const basisDigest = digestValue(basis, 'ashlr:agent-native-kernel:basis:v1');
  const checkpoint = {
    sequence: checkpointInput['sequence'] as number,
    previousCycleDigest: previousCycle?.cycleDigest ?? null,
    nextWakeAt: checkpointInput['nextWakeAt'] as string,
    checkpointDigest: digestValue({
      sequence: checkpointInput['sequence'],
      previousCycleDigest: previousCycle?.cycleDigest ?? null,
      nextWakeAt: checkpointInput['nextWakeAt'],
      basisDigest,
    }, 'ashlr:agent-native-kernel:checkpoint:v1'),
  };
  const unsigned: Omit<AgentNativeKernelShadowV1, 'cycleDigest'> = {
    schemaVersion: 1,
    protocol: AGENT_NATIVE_KERNEL_PROTOCOL,
    recordType: 'agent-native-kernel-cycle',
    mode: 'shadow',
    authority: 'observation-only',
    policyEligible: false,
    phase,
    lifecycle,
    degradedReasons,
    holdReasons,
    sources: {
      identity: identity.sourceState,
      resourceComplete: portfolio.resources.sourceComplete,
      evidenceComplete: evidence['sourceComplete'] as boolean,
    },
    basis,
    counts,
    checkpoint,
    authorityBits: {
      planning: false, execution: false, proposal: false, agent: false, merge: false,
      release: false, deploy: false, rollback: false, publication: false,
      externalMutation: false, budget: false, learning: false,
    },
    effects: {
      files: false, models: false, providers: false, dispatches: false, goals: false,
      proposals: false, merges: false, releases: false, deployments: false, rollbacks: false,
      publications: false, externalMutations: false, budgets: false, learning: false,
    },
    basisDigest,
  };
  return {
    ok: true,
    issues: [],
    kernel: {
      ...unsigned,
      cycleDigest: digestValue(unsigned, 'ashlr:agent-native-kernel:cycle:v1'),
    },
  };
}

/** Strictly verifies a kernel receipt's shape, inertness, lifecycle, and digests. */
export function verifyAgentNativeKernelShadowV1(value: unknown): AgentNativeKernelShadowV1 | null {
  const snap = safeSnapshot(value);
  if (!snap.ok) return null;
  const row = record(snap.value);
  if (!row || !exactKeys(row, OUTPUT_KEYS) || row['schemaVersion'] !== 1 ||
    row['protocol'] !== AGENT_NATIVE_KERNEL_PROTOCOL ||
    row['recordType'] !== 'agent-native-kernel-cycle' || row['mode'] !== 'shadow' ||
    row['authority'] !== 'observation-only' || row['policyEligible'] !== false ||
    !['sense', 'allocate', 'observe'].includes(String(row['phase'])) ||
    !['degraded', 'holding', 'running', 'observing', 'settled'].includes(String(row['lifecycle'])) ||
    !Array.isArray(row['degradedReasons']) || row['degradedReasons'].length > DEGRADED_REASONS.size ||
    row['degradedReasons'].some((item) => !DEGRADED_REASONS.has(item as KernelDegradedReasonV1)) ||
    JSON.stringify(row['degradedReasons']) !== JSON.stringify(sortedUnique(
      row['degradedReasons'] as KernelDegradedReasonV1[],
    )) || !Array.isArray(row['holdReasons']) || row['holdReasons'].length > HOLD_REASONS.size ||
    row['holdReasons'].some((item) => !HOLD_REASONS.has(item as KernelHoldReasonV1)) ||
    JSON.stringify(row['holdReasons']) !== JSON.stringify(sortedUnique(
      row['holdReasons'] as KernelHoldReasonV1[],
    )) || !allFalse(row['authorityBits'], AUTHORITY_KEYS) || !allFalse(row['effects'], EFFECT_KEYS)) {
    return null;
  }
  const sources = record(row['sources']);
  const basis = record(row['basis']);
  const counts = record(row['counts']);
  const checkpoint = record(row['checkpoint']);
  if (!sources || !exactKeys(sources, SOURCE_KEYS) ||
    !['disabled', 'healthy', 'degraded'].includes(String(sources['identity'])) ||
    typeof sources['resourceComplete'] !== 'boolean' || typeof sources['evidenceComplete'] !== 'boolean' ||
    !basis || !exactKeys(basis, BASIS_KEYS) || !timestamp(basis['asOf']) ||
    Object.entries(basis).some(([key, entry]) => key !== 'asOf' &&
      (typeof entry !== 'string' || !DIGEST_RE.test(entry))) ||
    !counts || !exactKeys(counts, COUNT_KEYS) ||
    Object.values(counts).some((entry) => !integer(entry, 0, MAX_ITEMS)) ||
    !checkpoint || !exactKeys(checkpoint, CHECKPOINT_KEYS) ||
    !integer(checkpoint['sequence'], 0, Number.MAX_SAFE_INTEGER) ||
    (checkpoint['previousCycleDigest'] !== null &&
      (typeof checkpoint['previousCycleDigest'] !== 'string' ||
        !DIGEST_RE.test(checkpoint['previousCycleDigest']))) ||
    (checkpoint['sequence'] === 0) !== (checkpoint['previousCycleDigest'] === null) ||
    !timestamp(checkpoint['nextWakeAt']) || checkpoint['nextWakeAt'] <= basis['asOf'] ||
    typeof checkpoint['checkpointDigest'] !== 'string' || !DIGEST_RE.test(checkpoint['checkpointDigest']) ||
    typeof row['basisDigest'] !== 'string' || !DIGEST_RE.test(row['basisDigest']) ||
    typeof row['cycleDigest'] !== 'string' || !DIGEST_RE.test(row['cycleDigest'])) return null;

  const candidateCount = counts['candidates'] as number;
  const degradedCount = (row['degradedReasons'] as unknown[]).length;
  const observedCount = (counts['observing'] as number) + (counts['effective'] as number) +
    (counts['refuted'] as number) + (counts['guardrailBreached'] as number);
  const allSettled = candidateCount > 0 && counts['stopped'] === candidateCount;
  const identityReasons = row['degradedReasons'] as string[];
  if ((row['lifecycle'] === 'degraded') !== (degradedCount > 0) ||
    (degradedCount > 0 && row['phase'] !== 'sense') ||
    (sources['identity'] === 'healthy' &&
      identityReasons.some((reason) => reason === 'identity-disabled' || reason === 'identity-degraded')) ||
    (sources['identity'] === 'disabled') !== identityReasons.includes('identity-disabled') ||
    (sources['identity'] === 'degraded') !== identityReasons.includes('identity-degraded') ||
    (sources['resourceComplete'] === false) !==
      (row['degradedReasons'] as string[]).includes('resource-source-incomplete') ||
    (sources['evidenceComplete'] === false) !==
      (row['degradedReasons'] as string[]).includes('evidence-source-incomplete') ||
    (counts['allocated'] as number) + (counts['held'] as number) +
      (counts['stopped'] as number) !== candidateCount ||
    (counts['observing'] as number) > (counts['held'] as number) ||
    (counts['allocated'] as number) > candidateCount || (counts['held'] as number) > candidateCount ||
    (counts['stopped'] as number) > candidateCount ||
    (counts['effective'] as number) + (counts['refuted'] as number) +
      (counts['guardrailBreached'] as number) > (counts['stopped'] as number) ||
    (row['lifecycle'] === 'running' && (row['phase'] !== 'allocate' || counts['allocated'] === 0 ||
      observedCount > 0 || allSettled)) ||
    (row['lifecycle'] === 'observing' && (row['phase'] !== 'observe' || observedCount === 0 || allSettled)) ||
    (row['lifecycle'] === 'settled' && (row['phase'] !== 'observe' || !allSettled)) ||
    (row['lifecycle'] === 'holding' && (row['phase'] !== 'sense' || counts['allocated'] !== 0 ||
      observedCount > 0 || allSettled)) ||
    ((row['holdReasons'] as string[]).includes('no-candidates') !== (candidateCount === 0))) return null;

  const expectedBasisDigest = digestValue(basis, 'ashlr:agent-native-kernel:basis:v1');
  if (row['basisDigest'] !== expectedBasisDigest || checkpoint['checkpointDigest'] !== digestValue({
    sequence: checkpoint['sequence'],
    previousCycleDigest: checkpoint['previousCycleDigest'],
    nextWakeAt: checkpoint['nextWakeAt'],
    basisDigest: expectedBasisDigest,
  }, 'ashlr:agent-native-kernel:checkpoint:v1')) return null;
  const unsigned = { ...row };
  delete unsigned['cycleDigest'];
  return row['cycleDigest'] === digestValue(unsigned, 'ashlr:agent-native-kernel:cycle:v1')
    ? snap.value as AgentNativeKernelShadowV1
    : null;
}
