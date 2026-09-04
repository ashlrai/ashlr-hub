/**
 * Capability Spectrum V1 -- a pure, values-free shadow projection of trusted
 * model, local-compute, worktree, and tool capacity.
 *
 * This module deliberately has no runtime wiring. It reads no clock, file,
 * credential, provider, or process state and grants no reservation or dispatch
 * authority. Callers provide already-public execution-identity metadata and
 * opaque local resource digests.
 */

import { createHash } from 'node:crypto';
import {
  EXECUTION_IDENTITY_V1_MAX_FUTURE_SKEW_MS,
  digestExecutionIdentityModelResourcesV1,
  type ExecutionIdentityPublicResourceV1,
} from './execution-identity.js';

export const CAPABILITY_SPECTRUM_SCHEMA_VERSION = 1 as const;
export const CAPABILITY_SPECTRUM_PROTOCOL = 'capability-spectrum-shadow-v1' as const;
export const CAPABILITY_SPECTRUM_OBSERVATION_MAX_AGE_MS = 5 * 60_000;
export const CAPABILITY_SPECTRUM_MAX_RESOURCES = 128;
export const CAPABILITY_SPECTRUM_MAX_LANES = 64;
export const CAPABILITY_SPECTRUM_MAX_REQUIREMENTS_PER_LANE = 16;

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const LINEAGE_DIGEST_RE = /^(?:sha256:)?[a-f0-9]{64}$/;
const ENGINE_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_UNITS = 1_000_000;
const MAX_OUTPUT_INVENTORY = CAPABILITY_SPECTRUM_MAX_RESOURCES * 2;
const MAX_OUTPUT_CONTENTION = MAX_OUTPUT_INVENTORY +
  CAPABILITY_SPECTRUM_MAX_LANES * CAPABILITY_SPECTRUM_MAX_REQUIREMENTS_PER_LANE;
const MAX_OUTPUT_ALLOCATIONS_PER_REQUIREMENT = MAX_OUTPUT_INVENTORY;

type Digest = `sha256:${string}`;
type LineageDigest = string;
type CapabilityKind = 'model' | 'compute' | 'worktree' | 'tool';
type LocalCapabilityKind = Exclude<CapabilityKind, 'model'>;
type SourceState = 'healthy' | 'degraded' | 'disabled';
type InputCapacityState = 'open' | 'near' | 'unknown' | 'stale' | 'reserved' | 'exhausted' | 'unreachable';
type InventoryReason =
  | 'trusted-open'
  | 'trusted-near'
  | 'source-degraded'
  | 'observation-missing'
  | 'observation-stale'
  | 'observation-future'
  | 'reset-elapsed'
  | 'unavailable-state'
  | 'zero-capacity'
  | 'invalid-reset';

const PUBLIC_IDENTITY_REASONS = new Set([
  'observation-missing', 'observation-stale', 'observed-open', 'observed-near',
  'observed-exhausted', 'observed-unreachable', 'observed-zero-capacity',
  'interactive-reserved', 'backoff-rate-limited', 'backoff-provider-refused',
  'backoff-transport-error',
]);

export interface CapabilitySpectrumIdentityResourceV1 {
  resource: ExecutionIdentityPublicResourceV1;
}

export interface CapabilitySpectrumResetWindowV1 {
  executionIdentityDigest: Digest;
  resetAt: string;
}

export interface CapabilitySpectrumLocalResourceV1 {
  resourceDigest: Digest;
  kind: LocalCapabilityKind;
  classDigest: Digest;
  state: InputCapacityState;
  maxUnits: number;
  trustedUnits: number;
  observedAt: string | null;
  resetAt: string | null;
}

export interface CapabilitySpectrumLaneV1 {
  laneDigest: Digest;
  queueRank: number;
  sourceComplete: boolean;
  requirements: Array<{
    kind: CapabilityKind;
    classDigest: Digest;
    units: number;
  }>;
}

export interface CapabilitySpectrumInputV1 {
  schemaVersion: 1;
  asOf: string;
  sourceDigest: Digest;
  resourceEnvelopeDigest: LineageDigest;
  executionIdentitySourceState: SourceState;
  executionIdentityResources: CapabilitySpectrumIdentityResourceV1[];
  resetWindows: CapabilitySpectrumResetWindowV1[];
  localResources: CapabilitySpectrumLocalResourceV1[];
  lanes: CapabilitySpectrumLaneV1[];
}

export interface CapabilitySpectrumInventoryV1 {
  resourceDigest: Digest;
  kind: CapabilityKind;
  classDigest: Digest;
  state: 'available' | 'unavailable';
  reason: InventoryReason;
  trustedUnits: number;
  maxUnits: number;
  resetAt: string | null;
  spendPriority: number | null;
}

interface CapabilitySpectrumRequirementProjectionV1 {
  kind: CapabilityKind;
  classDigest: Digest;
  requestedUnits: number;
  trustedUnits: number;
  shortageUnits: number;
  allocations: Array<{
    resourceDigest: Digest;
    units: number;
    resetAt: string | null;
  }>;
}

interface CapabilitySpectrumLaneProjectionV1 {
  laneDigest: Digest;
  queueRank: number;
  state: 'ready' | 'degraded';
  reason: 'capacity-ready' | 'lane-source-incomplete' | 'invalid-lane' | 'capability-unavailable';
  requirements: CapabilitySpectrumRequirementProjectionV1[];
  reservationAuthority: false;
  dispatchAuthority: false;
}

export interface CapabilitySpectrumShadowV1 {
  schemaVersion: 1;
  protocol: typeof CAPABILITY_SPECTRUM_PROTOCOL;
  recordType: 'capability-spectrum';
  mode: 'shadow';
  authority: 'observation-only';
  globalHalt: false;
  projectionState: 'healthy' | 'degraded';
  asOf: string;
  sourceDigest: Digest;
  executionIdentityModelDigest: Digest;
  resourceEnvelopeDigest: LineageDigest;
  inventory: CapabilitySpectrumInventoryV1[];
  contention: Array<{
    kind: CapabilityKind;
    classDigest: Digest;
    requestedUnits: number;
    trustedUnits: number;
    shortageUnits: number;
    state: 'clear' | 'contended' | 'unavailable';
  }>;
  lanes: CapabilitySpectrumLaneProjectionV1[];
  quarantine: {
    invalidIdentityResources: number;
    invalidResetWindows: number;
    invalidLocalResources: number;
    invalidLanes: number;
  };
  executionAuthority: false;
  routingAuthority: false;
  reservationAuthority: false;
  budgetAuthority: false;
  mutationAuthority: false;
  effects: {
    files: false;
    models: false;
    providers: false;
    processes: false;
    worktrees: false;
    tools: false;
    dispatches: false;
    reservations: false;
    budgets: false;
    externalMutations: false;
  };
  projectionDigest: Digest;
}

export type CapabilitySpectrumBuildResultV1 =
  | { ok: true; globalHalt: false; spectrum: CapabilitySpectrumShadowV1; issues: [] }
  | {
      ok: false;
      globalHalt: true;
      spectrum: null;
      issues: Array<'invalid-input' | 'shared-resource-identity-collision' | 'shared-lane-identity-collision' | 'shared-reset-window-conflict'>;
    };

const INPUT_KEYS = new Set([
  'schemaVersion', 'asOf', 'sourceDigest', 'resourceEnvelopeDigest', 'executionIdentitySourceState',
  'executionIdentityResources', 'resetWindows', 'localResources', 'lanes',
]);
const IDENTITY_WRAPPER_KEYS = new Set(['resource']);
const IDENTITY_KEYS = new Set([
  'executionIdentityDigest', 'engine', 'state', 'trustedSlots', 'maxConcurrent',
  'usedPercent', 'observedAt', 'reason',
]);
const RESET_KEYS = new Set(['executionIdentityDigest', 'resetAt']);
const LOCAL_KEYS = new Set([
  'resourceDigest', 'kind', 'classDigest', 'state', 'maxUnits', 'trustedUnits',
  'observedAt', 'resetAt',
]);
const LANE_KEYS = new Set(['laneDigest', 'queueRank', 'sourceComplete', 'requirements']);
const REQUIREMENT_KEYS = new Set(['kind', 'classDigest', 'units']);

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => {
      const descriptor = descriptors[String(key)];
      return !descriptor || !descriptor.enumerable || !('value' in descriptor);
    })) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function digest(value: unknown, domain: string): Digest {
  return `sha256:${createHash('sha256').update(domain, 'utf8').update('\0')
    .update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
}

function isDigest(value: unknown): value is Digest {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

function isLineageDigest(value: unknown): value is LineageDigest {
  return typeof value === 'string' && LINEAGE_DIGEST_RE.test(value);
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function kind(value: unknown): value is CapabilityKind {
  return ['model', 'compute', 'worktree', 'tool'].includes(String(value));
}

function localKind(value: unknown): value is LocalCapabilityKind {
  return ['compute', 'worktree', 'tool'].includes(String(value));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Hash a non-secret capability label before it enters the public projection. */
export function digestCapabilityClassV1(capabilityKind: CapabilityKind, label: unknown): Digest | null {
  if (!kind(capabilityKind) || typeof label !== 'string' || !ENGINE_RE.test(label)) return null;
  return digest({ capabilityKind, label }, 'ashlr:capability-spectrum:class:v1');
}

function identityResource(value: unknown): ExecutionIdentityPublicResourceV1 | null {
  const wrapper = record(value);
  const resource = wrapper && exactKeys(wrapper, IDENTITY_WRAPPER_KEYS) ? record(wrapper['resource']) : null;
  if (!resource || !exactKeys(resource, IDENTITY_KEYS) || !isDigest(resource['executionIdentityDigest']) ||
    typeof resource['engine'] !== 'string' || !ENGINE_RE.test(resource['engine']) ||
    !['open', 'near', 'exhausted', 'unreachable', 'unknown'].includes(String(resource['state'])) ||
    !integer(resource['trustedSlots'], 0, 32) || !integer(resource['maxConcurrent'], 0, 32) ||
    Number(resource['trustedSlots']) > Number(resource['maxConcurrent']) ||
    (resource['usedPercent'] !== null && (typeof resource['usedPercent'] !== 'number' ||
      !Number.isFinite(resource['usedPercent']) || resource['usedPercent'] < 0 || resource['usedPercent'] > 100)) ||
    (resource['observedAt'] !== null && !timestamp(resource['observedAt'])) ||
    !PUBLIC_IDENTITY_REASONS.has(String(resource['reason']))) return null;
  const state = String(resource['state']);
  const reason = String(resource['reason']);
  const trustedSlots = Number(resource['trustedSlots']);
  const observedAt = resource['observedAt'];
  const consistent =
    (state === 'open' && reason === 'observed-open' && trustedSlots > 0 && observedAt !== null) ||
    (state === 'near' && reason === 'observed-near' && trustedSlots > 0 && observedAt !== null) ||
    (state === 'unreachable' && reason === 'observed-unreachable' && trustedSlots === 0 && observedAt !== null) ||
    (state === 'exhausted' && trustedSlots === 0 && [
      'observed-exhausted', 'observed-zero-capacity', 'backoff-rate-limited',
      'backoff-provider-refused', 'backoff-transport-error',
    ].includes(reason)) ||
    (state === 'unknown' && trustedSlots === 0 && [
      'observation-missing', 'observation-stale', 'interactive-reserved',
    ].includes(reason));
  if (!consistent) return null;
  return {
    executionIdentityDigest: resource['executionIdentityDigest'],
    engine: resource['engine'] as ExecutionIdentityPublicResourceV1['engine'],
    state: resource['state'] as ExecutionIdentityPublicResourceV1['state'],
    trustedSlots: Number(resource['trustedSlots']),
    maxConcurrent: Number(resource['maxConcurrent']),
    usedPercent: resource['usedPercent'] as number | null,
    observedAt: resource['observedAt'] as string | null,
    reason: resource['reason'] as ExecutionIdentityPublicResourceV1['reason'],
  };
}

function resetWindow(value: unknown): CapabilitySpectrumResetWindowV1 | null {
  const row = record(value);
  return row && exactKeys(row, RESET_KEYS) && isDigest(row['executionIdentityDigest']) && timestamp(row['resetAt'])
    ? { executionIdentityDigest: row['executionIdentityDigest'], resetAt: row['resetAt'] }
    : null;
}

function localResource(value: unknown): CapabilitySpectrumLocalResourceV1 | null {
  const row = record(value);
  if (!row || !exactKeys(row, LOCAL_KEYS) || !isDigest(row['resourceDigest']) ||
    !localKind(row['kind']) || !isDigest(row['classDigest']) ||
    !['open', 'near', 'unknown', 'stale', 'reserved', 'exhausted', 'unreachable'].includes(String(row['state'])) ||
    !integer(row['maxUnits'], 0, MAX_UNITS) || !integer(row['trustedUnits'], 0, MAX_UNITS) ||
    Number(row['trustedUnits']) > Number(row['maxUnits']) ||
    (row['observedAt'] !== null && !timestamp(row['observedAt'])) ||
    (row['resetAt'] !== null && !timestamp(row['resetAt']))) return null;
  return {
    resourceDigest: row['resourceDigest'], kind: row['kind'], classDigest: row['classDigest'],
    state: row['state'] as InputCapacityState, maxUnits: Number(row['maxUnits']),
    trustedUnits: Number(row['trustedUnits']), observedAt: row['observedAt'] as string | null,
    resetAt: row['resetAt'] as string | null,
  };
}

function lane(value: unknown): CapabilitySpectrumLaneV1 | null {
  const row = record(value);
  if (!row || !exactKeys(row, LANE_KEYS) || !isDigest(row['laneDigest']) ||
    !integer(row['queueRank'], 1, 1_000_000) || typeof row['sourceComplete'] !== 'boolean' ||
    !Array.isArray(row['requirements']) || row['requirements'].length < 1 ||
    row['requirements'].length > CAPABILITY_SPECTRUM_MAX_REQUIREMENTS_PER_LANE) return null;
  const requirements: CapabilitySpectrumLaneV1['requirements'] = [];
  const seen = new Set<string>();
  for (const candidate of row['requirements']) {
    const requirement = record(candidate);
    if (!requirement || !exactKeys(requirement, REQUIREMENT_KEYS) || !kind(requirement['kind']) ||
      !isDigest(requirement['classDigest']) || !integer(requirement['units'], 1, MAX_UNITS)) return null;
    const key = `${requirement['kind']}:${requirement['classDigest']}`;
    if (seen.has(key)) return null;
    seen.add(key);
    requirements.push({
      kind: requirement['kind'], classDigest: requirement['classDigest'], units: Number(requirement['units']),
    });
  }
  requirements.sort((left, right) => compareText(left.kind, right.kind) ||
    compareText(left.classDigest, right.classDigest));
  return {
    laneDigest: row['laneDigest'], queueRank: Number(row['queueRank']),
    sourceComplete: row['sourceComplete'], requirements,
  };
}

function freshness(observedAt: string | null, asOfMs: number): InventoryReason | null {
  if (observedAt === null) return 'observation-missing';
  const observedMs = Date.parse(observedAt);
  if (observedMs > asOfMs + EXECUTION_IDENTITY_V1_MAX_FUTURE_SKEW_MS) return 'observation-future';
  if (asOfMs - observedMs > CAPABILITY_SPECTRUM_OBSERVATION_MAX_AGE_MS) return 'observation-stale';
  return null;
}

function unavailableInventory(
  resourceDigest: Digest,
  capabilityKind: CapabilityKind,
  classDigest: Digest,
  maxUnits: number,
  resetAt: string | null,
  reason: InventoryReason,
): CapabilitySpectrumInventoryV1 {
  return {
    resourceDigest, kind: capabilityKind, classDigest, state: 'unavailable', reason,
    trustedUnits: 0, maxUnits, resetAt, spendPriority: null,
  };
}

function normalizeIdentityInventory(
  resource: ExecutionIdentityPublicResourceV1,
  resetAt: string | null,
  resetInvalid: boolean,
  sourceState: SourceState,
  asOfMs: number,
): CapabilitySpectrumInventoryV1 {
  const classDigest = digestCapabilityClassV1('model', resource.engine)!;
  if (sourceState !== 'healthy') return unavailableInventory(
    resource.executionIdentityDigest, 'model', classDigest, resource.maxConcurrent, resetAt, 'source-degraded',
  );
  if (resetInvalid) return unavailableInventory(
    resource.executionIdentityDigest, 'model', classDigest, resource.maxConcurrent, null, 'invalid-reset',
  );
  if (resetAt !== null && Date.parse(resetAt) <= asOfMs) return unavailableInventory(
    resource.executionIdentityDigest, 'model', classDigest, resource.maxConcurrent, resetAt, 'reset-elapsed',
  );
  const freshnessReason = freshness(resource.observedAt, asOfMs);
  if (freshnessReason) return unavailableInventory(
    resource.executionIdentityDigest, 'model', classDigest, resource.maxConcurrent, resetAt, freshnessReason,
  );
  if (!['open', 'near'].includes(resource.state)) return unavailableInventory(
    resource.executionIdentityDigest, 'model', classDigest, resource.maxConcurrent, resetAt, 'unavailable-state',
  );
  if (resource.trustedSlots === 0) return unavailableInventory(
    resource.executionIdentityDigest, 'model', classDigest, resource.maxConcurrent, resetAt, 'zero-capacity',
  );
  return {
    resourceDigest: resource.executionIdentityDigest, kind: 'model', classDigest,
    state: 'available', reason: resource.state === 'near' ? 'trusted-near' : 'trusted-open',
    trustedUnits: resource.trustedSlots, maxUnits: resource.maxConcurrent, resetAt, spendPriority: null,
  };
}

function normalizeLocalInventory(resource: CapabilitySpectrumLocalResourceV1, asOfMs: number): CapabilitySpectrumInventoryV1 {
  if (resource.resetAt !== null && Date.parse(resource.resetAt) <= asOfMs) return unavailableInventory(
    resource.resourceDigest, resource.kind, resource.classDigest, resource.maxUnits, resource.resetAt, 'reset-elapsed',
  );
  const freshnessReason = freshness(resource.observedAt, asOfMs);
  if (freshnessReason) return unavailableInventory(
    resource.resourceDigest, resource.kind, resource.classDigest, resource.maxUnits, resource.resetAt, freshnessReason,
  );
  if (!['open', 'near'].includes(resource.state)) return unavailableInventory(
    resource.resourceDigest, resource.kind, resource.classDigest, resource.maxUnits, resource.resetAt, 'unavailable-state',
  );
  if (resource.trustedUnits === 0) return unavailableInventory(
    resource.resourceDigest, resource.kind, resource.classDigest, resource.maxUnits, resource.resetAt, 'zero-capacity',
  );
  return {
    resourceDigest: resource.resourceDigest, kind: resource.kind, classDigest: resource.classDigest,
    state: 'available', reason: resource.state === 'near' ? 'trusted-near' : 'trusted-open',
    trustedUnits: resource.trustedUnits, maxUnits: resource.maxUnits, resetAt: resource.resetAt, spendPriority: null,
  };
}

function spendOrder(left: CapabilitySpectrumInventoryV1, right: CapabilitySpectrumInventoryV1): number {
  const leftReset = left.resetAt === null ? Number.POSITIVE_INFINITY : Date.parse(left.resetAt);
  const rightReset = right.resetAt === null ? Number.POSITIVE_INFINITY : Date.parse(right.resetAt);
  return leftReset - rightReset || compareText(left.resourceDigest, right.resourceDigest);
}

function assignSpendPriorities(inventory: CapabilitySpectrumInventoryV1[]): void {
  const groups = new Map<string, CapabilitySpectrumInventoryV1[]>();
  for (const item of inventory.filter((candidate) => candidate.state === 'available')) {
    const key = `${item.kind}:${item.classDigest}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort(spendOrder).forEach((item, index) => { item.spendPriority = index + 1; });
  }
}

function projectLanes(
  lanes: CapabilitySpectrumLaneV1[],
  invalidLaneDigests: Digest[],
  inventory: CapabilitySpectrumInventoryV1[],
): CapabilitySpectrumLaneProjectionV1[] {
  const remaining = new Map(inventory.map((item) => [item.resourceDigest, item.trustedUnits]));
  const projected: CapabilitySpectrumLaneProjectionV1[] = invalidLaneDigests.map((laneDigest) => ({
    laneDigest, queueRank: 1_000_000, state: 'degraded', reason: 'invalid-lane', requirements: [],
    reservationAuthority: false, dispatchAuthority: false,
  }));
  for (const candidate of lanes.sort((left, right) => left.queueRank - right.queueRank ||
    compareText(left.laneDigest, right.laneDigest))) {
    if (!candidate.sourceComplete) {
      projected.push({
        laneDigest: candidate.laneDigest, queueRank: candidate.queueRank, state: 'degraded',
        reason: 'lane-source-incomplete', requirements: candidate.requirements.map((requirement) => ({
          kind: requirement.kind, classDigest: requirement.classDigest,
          requestedUnits: requirement.units, trustedUnits: 0, shortageUnits: requirement.units, allocations: [],
        })), reservationAuthority: false, dispatchAuthority: false,
      });
      continue;
    }
    const tentative = new Map(remaining);
    const requirements = candidate.requirements.map((requirement): CapabilitySpectrumRequirementProjectionV1 => {
      let needed = requirement.units;
      const allocations: CapabilitySpectrumRequirementProjectionV1['allocations'] = [];
      const resources = inventory.filter((item) => item.state === 'available' &&
        item.kind === requirement.kind && item.classDigest === requirement.classDigest)
        .sort(spendOrder);
      const trustedUnits = resources.reduce((sum, item) => sum + (tentative.get(item.resourceDigest) ?? 0), 0);
      for (const resource of resources) {
        const available = tentative.get(resource.resourceDigest) ?? 0;
        const units = Math.min(available, needed);
        if (units > 0) {
          allocations.push({ resourceDigest: resource.resourceDigest, units, resetAt: resource.resetAt });
          tentative.set(resource.resourceDigest, available - units);
          needed -= units;
        }
        if (needed === 0) break;
      }
      return {
        kind: requirement.kind, classDigest: requirement.classDigest,
        requestedUnits: requirement.units, trustedUnits, shortageUnits: needed, allocations,
      };
    });
    const ready = requirements.every((requirement) => requirement.shortageUnits === 0);
    if (ready) {
      for (const [resourceDigest, units] of tentative) remaining.set(resourceDigest, units);
    } else {
      for (const requirement of requirements) requirement.allocations = [];
    }
    projected.push({
      laneDigest: candidate.laneDigest, queueRank: candidate.queueRank,
      state: ready ? 'ready' : 'degraded', reason: ready ? 'capacity-ready' : 'capability-unavailable',
      requirements, reservationAuthority: false, dispatchAuthority: false,
    });
  }
  return projected.sort((left, right) => left.queueRank - right.queueRank ||
    compareText(left.laneDigest, right.laneDigest));
}

function projectContention(
  lanes: CapabilitySpectrumLaneV1[],
  inventory: CapabilitySpectrumInventoryV1[],
): CapabilitySpectrumShadowV1['contention'] {
  const keys = new Set<string>();
  for (const item of inventory) keys.add(`${item.kind}:${item.classDigest}`);
  for (const laneEntry of lanes.filter((candidate) => candidate.sourceComplete)) {
    for (const requirement of laneEntry.requirements) keys.add(`${requirement.kind}:${requirement.classDigest}`);
  }
  return [...keys].map((key) => {
    const separator = key.indexOf(':');
    const capabilityKind = key.slice(0, separator) as CapabilityKind;
    const classDigest = key.slice(separator + 1) as Digest;
    const requestedUnits = lanes.filter((candidate) => candidate.sourceComplete)
      .flatMap((candidate) => candidate.requirements)
      .filter((requirement) => requirement.kind === capabilityKind && requirement.classDigest === classDigest)
      .reduce((sum, requirement) => sum + requirement.units, 0);
    const trustedUnits = inventory.filter((item) => item.state === 'available' &&
      item.kind === capabilityKind && item.classDigest === classDigest)
      .reduce((sum, item) => sum + item.trustedUnits, 0);
    const shortageUnits = Math.max(0, requestedUnits - trustedUnits);
    return {
      kind: capabilityKind, classDigest, requestedUnits, trustedUnits, shortageUnits,
      state: trustedUnits === 0 && requestedUnits > 0 ? 'unavailable' as const
        : shortageUnits > 0 ? 'contended' as const : 'clear' as const,
    };
  }).sort((left, right) => compareText(left.kind, right.kind) || compareText(left.classDigest, right.classDigest));
}

/** Build a deterministic shadow view. Only shared identity collisions halt it. */
export function buildCapabilitySpectrumShadowV1(value: unknown): CapabilitySpectrumBuildResultV1 {
  const input = record(value);
  if (!input || !exactKeys(input, INPUT_KEYS) || input['schemaVersion'] !== 1 ||
    !timestamp(input['asOf']) || !isDigest(input['sourceDigest']) ||
    !isLineageDigest(input['resourceEnvelopeDigest']) ||
    !['healthy', 'degraded', 'disabled'].includes(String(input['executionIdentitySourceState'])) ||
    !Array.isArray(input['executionIdentityResources']) ||
    input['executionIdentityResources'].length > CAPABILITY_SPECTRUM_MAX_RESOURCES ||
    !Array.isArray(input['resetWindows']) || input['resetWindows'].length > CAPABILITY_SPECTRUM_MAX_RESOURCES ||
    !Array.isArray(input['localResources']) || input['localResources'].length > CAPABILITY_SPECTRUM_MAX_RESOURCES ||
    !Array.isArray(input['lanes']) || input['lanes'].length > CAPABILITY_SPECTRUM_MAX_LANES) {
    return { ok: false, globalHalt: true, spectrum: null, issues: ['invalid-input'] };
  }

  const validIdentities = input['executionIdentityResources'].map(identityResource).filter((item) => item !== null);
  const validResets = input['resetWindows'].map(resetWindow).filter((item) => item !== null);
  const validLocals = input['localResources'].map(localResource).filter((item) => item !== null);
  const validLanes = input['lanes'].map(lane).filter((item) => item !== null);
  const identityDigests = input['executionIdentityResources'].map((candidate) => {
    const wrapper = record(candidate);
    const resource = wrapper ? record(wrapper['resource']) : null;
    return resource && isDigest(resource['executionIdentityDigest']) ? resource['executionIdentityDigest'] : null;
  }).filter((candidate): candidate is Digest => candidate !== null);
  const localDigests = input['localResources'].map((candidate) => {
    const row = record(candidate);
    return row && isDigest(row['resourceDigest']) ? row['resourceDigest'] : null;
  }).filter((candidate): candidate is Digest => candidate !== null);
  const resourceDigests = [...identityDigests, ...localDigests];
  if (new Set(resourceDigests).size !== resourceDigests.length) {
    return { ok: false, globalHalt: true, spectrum: null, issues: ['shared-resource-identity-collision'] };
  }
  const laneDigests = input['lanes'].map((candidate) => {
    const row = record(candidate);
    return row && isDigest(row['laneDigest']) ? row['laneDigest'] : null;
  }).filter((candidate): candidate is Digest => candidate !== null);
  if (new Set(laneDigests).size !== laneDigests.length) {
    return { ok: false, globalHalt: true, spectrum: null, issues: ['shared-lane-identity-collision'] };
  }
  const resetDigests = input['resetWindows'].map((candidate) => {
    const row = record(candidate);
    return row && isDigest(row['executionIdentityDigest']) ? row['executionIdentityDigest'] : null;
  }).filter((candidate): candidate is Digest => candidate !== null);
  if (new Set(resetDigests).size !== resetDigests.length) {
    return { ok: false, globalHalt: true, spectrum: null, issues: ['shared-reset-window-conflict'] };
  }

  const invalidResetDigests = new Set<Digest>();
  for (const candidate of input['resetWindows']) {
    const row = record(candidate);
    if (!resetWindow(candidate) && row && isDigest(row['executionIdentityDigest'])) {
      invalidResetDigests.add(row['executionIdentityDigest']);
    }
  }
  const resetByIdentity = new Map(validResets.map((item) => [item.executionIdentityDigest, item.resetAt]));
  const asOfMs = Date.parse(input['asOf']);
  const executionIdentityModelDigest = digestExecutionIdentityModelResourcesV1(
    input['executionIdentitySourceState'] as SourceState,
    validIdentities,
  );
  const inventory = [
    ...validIdentities.map((item) => normalizeIdentityInventory(
      item, resetByIdentity.get(item.executionIdentityDigest) ?? null,
      invalidResetDigests.has(item.executionIdentityDigest), input['executionIdentitySourceState'] as SourceState, asOfMs,
    )),
    ...validLocals.map((item) => normalizeLocalInventory(item, asOfMs)),
  ];
  assignSpendPriorities(inventory);
  inventory.sort((left, right) => compareText(left.kind, right.kind) ||
    compareText(left.classDigest, right.classDigest) || spendOrder(left, right));

  const invalidLaneDigests = input['lanes'].map((candidate) => {
    const row = record(candidate);
    return !lane(candidate) && row && isDigest(row['laneDigest']) ? row['laneDigest'] : null;
  }).filter((candidate): candidate is Digest => candidate !== null);
  const lanes = projectLanes(validLanes, invalidLaneDigests, inventory);
  const contention = projectContention(validLanes, inventory);
  const orphanResetWindows = validResets.filter((item) =>
    !validIdentities.some((identity) => identity.executionIdentityDigest === item.executionIdentityDigest)).length;
  const quarantine = {
    invalidIdentityResources: input['executionIdentityResources'].length - validIdentities.length,
    invalidResetWindows: input['resetWindows'].length - validResets.length + orphanResetWindows,
    invalidLocalResources: input['localResources'].length - validLocals.length,
    invalidLanes: input['lanes'].length - validLanes.length,
  };
  const degraded = input['executionIdentitySourceState'] !== 'healthy' ||
    Object.values(quarantine).some((count) => count > 0) ||
    inventory.some((item) => item.state === 'unavailable') || lanes.some((item) => item.state === 'degraded');
  const unsigned: Omit<CapabilitySpectrumShadowV1, 'projectionDigest'> = {
    schemaVersion: 1, protocol: CAPABILITY_SPECTRUM_PROTOCOL, recordType: 'capability-spectrum',
    mode: 'shadow', authority: 'observation-only', globalHalt: false,
    projectionState: degraded ? 'degraded' : 'healthy', asOf: input['asOf'], sourceDigest: input['sourceDigest'],
    executionIdentityModelDigest, resourceEnvelopeDigest: input['resourceEnvelopeDigest'],
    inventory, contention, lanes, quarantine,
    executionAuthority: false, routingAuthority: false, reservationAuthority: false,
    budgetAuthority: false, mutationAuthority: false,
    effects: {
      files: false, models: false, providers: false, processes: false, worktrees: false,
      tools: false, dispatches: false, reservations: false, budgets: false, externalMutations: false,
    },
  };
  return {
    ok: true, globalHalt: false, issues: [],
    spectrum: { ...unsigned, projectionDigest: digest(unsigned, 'ashlr:capability-spectrum:projection:v1') },
  };
}

const OUTPUT_KEYS = new Set([
  'schemaVersion', 'protocol', 'recordType', 'mode', 'authority', 'globalHalt', 'projectionState',
  'asOf', 'sourceDigest', 'executionIdentityModelDigest', 'resourceEnvelopeDigest',
  'inventory', 'contention', 'lanes', 'quarantine', 'executionAuthority',
  'routingAuthority', 'reservationAuthority', 'budgetAuthority', 'mutationAuthority', 'effects',
  'projectionDigest',
]);
const EFFECT_KEYS = new Set([
  'files', 'models', 'providers', 'processes', 'worktrees', 'tools', 'dispatches',
  'reservations', 'budgets', 'externalMutations',
]);
const QUARANTINE_KEYS = new Set([
  'invalidIdentityResources', 'invalidResetWindows', 'invalidLocalResources', 'invalidLanes',
]);

/**
 * Verify bounded output semantics, fixed non-authority, and digest integrity.
 * The unkeyed digest detects internal inconsistency; it is not authentication or
 * proof that the projection came from a trusted producer.
 */
export function verifyCapabilitySpectrumShadowV1(value: unknown): CapabilitySpectrumShadowV1 | null {
  try {
    return verifyCapabilitySpectrumShadowEnvelopeV1(value);
  } catch {
    // Proxy traps, cycles, and otherwise hostile objects are invalid envelopes.
    return null;
  }
}

function verifyCapabilitySpectrumShadowEnvelopeV1(value: unknown): CapabilitySpectrumShadowV1 | null {
  const row = record(value);
  const effects = row ? record(row['effects']) : null;
  const quarantine = row ? record(row['quarantine']) : null;
  if (!row || !exactKeys(row, OUTPUT_KEYS) || row['schemaVersion'] !== 1 ||
    row['protocol'] !== CAPABILITY_SPECTRUM_PROTOCOL || row['recordType'] !== 'capability-spectrum' ||
    row['mode'] !== 'shadow' || row['authority'] !== 'observation-only' || row['globalHalt'] !== false ||
    !['healthy', 'degraded'].includes(String(row['projectionState'])) || !timestamp(row['asOf']) ||
    !isDigest(row['sourceDigest']) || !isDigest(row['executionIdentityModelDigest']) ||
    !isLineageDigest(row['resourceEnvelopeDigest']) || !Array.isArray(row['inventory']) ||
    row['inventory'].length > MAX_OUTPUT_INVENTORY || !Array.isArray(row['contention']) ||
    row['contention'].length > MAX_OUTPUT_CONTENTION || !Array.isArray(row['lanes']) ||
    row['lanes'].length > CAPABILITY_SPECTRUM_MAX_LANES ||
    !quarantine || !exactKeys(quarantine, QUARANTINE_KEYS) ||
    Object.values(quarantine).some((count) => !integer(count, 0, CAPABILITY_SPECTRUM_MAX_RESOURCES)) ||
    row['executionAuthority'] !== false || row['routingAuthority'] !== false ||
    row['reservationAuthority'] !== false || row['budgetAuthority'] !== false || row['mutationAuthority'] !== false ||
    !effects || !exactKeys(effects, EFFECT_KEYS) || Object.values(effects).some((effect) => effect !== false) ||
    !isDigest(row['projectionDigest'])) return null;
  const allowedInventory = new Set([
    'resourceDigest', 'kind', 'classDigest', 'state', 'reason', 'trustedUnits',
    'maxUnits', 'resetAt', 'spendPriority',
  ]);
  const allowedContention = new Set([
    'kind', 'classDigest', 'requestedUnits', 'trustedUnits', 'shortageUnits', 'state',
  ]);
  const allowedLane = new Set([
    'laneDigest', 'queueRank', 'state', 'reason', 'requirements', 'reservationAuthority', 'dispatchAuthority',
  ]);
  const allowedRequirement = new Set([
    'kind', 'classDigest', 'requestedUnits', 'trustedUnits', 'shortageUnits', 'allocations',
  ]);
  const allowedAllocation = new Set(['resourceDigest', 'units', 'resetAt']);
  const strictArray = (items: unknown[], keys: ReadonlySet<string>): boolean =>
    items.every((item) => { const candidate = record(item); return candidate !== null && exactKeys(candidate, keys); });
  if (!strictArray(row['inventory'], allowedInventory) || !strictArray(row['contention'], allowedContention) ||
    !strictArray(row['lanes'], allowedLane)) return null;
  const seenResources = new Set<string>();
  const asOfMs = Date.parse(row['asOf'] as string);
  for (const inventoryEntry of row['inventory']) {
    const candidate = inventoryEntry as Record<string, unknown>;
    if (!isDigest(candidate['resourceDigest']) || seenResources.has(candidate['resourceDigest']) ||
      !kind(candidate['kind']) || !isDigest(candidate['classDigest']) ||
      !['available', 'unavailable'].includes(String(candidate['state'])) ||
      ![
        'trusted-open', 'trusted-near', 'source-degraded', 'observation-missing',
        'observation-stale', 'observation-future', 'reset-elapsed', 'unavailable-state',
        'zero-capacity', 'invalid-reset',
      ].includes(String(candidate['reason'])) ||
      !integer(candidate['trustedUnits'], 0, MAX_UNITS) || !integer(candidate['maxUnits'], 0, MAX_UNITS) ||
      Number(candidate['trustedUnits']) > Number(candidate['maxUnits']) ||
      (candidate['resetAt'] !== null && !timestamp(candidate['resetAt']))) return null;
    seenResources.add(candidate['resourceDigest']);
    if (candidate['state'] === 'available') {
      if (!['trusted-open', 'trusted-near'].includes(String(candidate['reason'])) ||
        Number(candidate['trustedUnits']) < 1 ||
        (candidate['resetAt'] !== null && Date.parse(candidate['resetAt'] as string) <= asOfMs) ||
        !integer(candidate['spendPriority'], 1, CAPABILITY_SPECTRUM_MAX_RESOURCES)) {
        return null;
      }
    } else if (candidate['trustedUnits'] !== 0 || candidate['spendPriority'] !== null) return null;
  }
  for (const contentionEntry of row['contention']) {
    const candidate = contentionEntry as Record<string, unknown>;
    if (!kind(candidate['kind']) || !isDigest(candidate['classDigest']) ||
      !integer(candidate['requestedUnits'], 0, MAX_UNITS * CAPABILITY_SPECTRUM_MAX_LANES) ||
      !integer(candidate['trustedUnits'], 0, MAX_UNITS * CAPABILITY_SPECTRUM_MAX_RESOURCES) ||
      !integer(candidate['shortageUnits'], 0, MAX_UNITS * CAPABILITY_SPECTRUM_MAX_LANES) ||
      Number(candidate['shortageUnits']) !== Math.max(0,
        Number(candidate['requestedUnits']) - Number(candidate['trustedUnits'])) ||
      !['clear', 'contended', 'unavailable'].includes(String(candidate['state']))) return null;
    const expectedState = Number(candidate['trustedUnits']) === 0 && Number(candidate['requestedUnits']) > 0
      ? 'unavailable' : Number(candidate['shortageUnits']) > 0 ? 'contended' : 'clear';
    if (candidate['state'] !== expectedState) return null;
  }
  const typedInventory = row['inventory'] as CapabilitySpectrumInventoryV1[];
  const expectedInventory = typedInventory.map((item) => ({ ...item, spendPriority: null }));
  assignSpendPriorities(expectedInventory);
  expectedInventory.sort((left, right) => compareText(left.kind, right.kind) ||
    compareText(left.classDigest, right.classDigest) || spendOrder(left, right));
  if (canonicalJson(expectedInventory) !== canonicalJson(typedInventory)) return null;

  const seenLanes = new Set<string>();
  for (const laneEntry of row['lanes']) {
    const candidate = laneEntry as Record<string, unknown>;
    if (!isDigest(candidate['laneDigest']) || seenLanes.has(candidate['laneDigest']) ||
      !integer(candidate['queueRank'], 1, 1_000_000) || !['ready', 'degraded'].includes(String(candidate['state'])) ||
      !['capacity-ready', 'lane-source-incomplete', 'invalid-lane', 'capability-unavailable']
        .includes(String(candidate['reason'])) ||
      candidate['reservationAuthority'] !== false || candidate['dispatchAuthority'] !== false ||
      !Array.isArray(candidate['requirements']) ||
      candidate['requirements'].length > CAPABILITY_SPECTRUM_MAX_REQUIREMENTS_PER_LANE ||
      !strictArray(candidate['requirements'], allowedRequirement)) return null;
    seenLanes.add(candidate['laneDigest']);
    if ((candidate['state'] === 'ready') !== (candidate['reason'] === 'capacity-ready')) return null;
    if (candidate['reason'] === 'invalid-lane' && candidate['requirements'].length !== 0) return null;
    for (const requirement of candidate['requirements']) {
      const requirementRow = requirement as Record<string, unknown>;
      if (!kind(requirementRow['kind']) || !isDigest(requirementRow['classDigest']) ||
        !integer(requirementRow['requestedUnits'], 1, MAX_UNITS) ||
        !integer(requirementRow['trustedUnits'], 0, MAX_UNITS * CAPABILITY_SPECTRUM_MAX_RESOURCES) ||
        !integer(requirementRow['shortageUnits'], 0, MAX_UNITS) ||
        Number(requirementRow['shortageUnits']) !== Math.max(0,
          Number(requirementRow['requestedUnits']) - Number(requirementRow['trustedUnits'])) ||
        !Array.isArray(requirementRow['allocations']) ||
        requirementRow['allocations'].length > MAX_OUTPUT_ALLOCATIONS_PER_REQUIREMENT ||
        !strictArray(requirementRow['allocations'], allowedAllocation)) return null;
      let allocated = 0;
      for (const allocation of requirementRow['allocations']) {
        const allocationRow = allocation as Record<string, unknown>;
        if (!isDigest(allocationRow['resourceDigest']) || !integer(allocationRow['units'], 1, MAX_UNITS) ||
          (allocationRow['resetAt'] !== null && !timestamp(allocationRow['resetAt']))) return null;
        allocated += Number(allocationRow['units']);
      }
      if (candidate['state'] === 'ready' && allocated !== requirementRow['requestedUnits']) return null;
      if (candidate['state'] === 'degraded' && allocated !== 0) return null;
    }
  }
  const degraded = Object.values(quarantine).some((count) => Number(count) > 0) ||
    row['inventory'].some((item) => (item as Record<string, unknown>)['state'] === 'unavailable') ||
    row['lanes'].some((item) => (item as Record<string, unknown>)['state'] === 'degraded');
  if (row['projectionState'] === 'healthy' && degraded) return null;
  const typedLanes = row['lanes'] as CapabilitySpectrumLaneProjectionV1[];
  const rebuiltValidLanes: CapabilitySpectrumLaneV1[] = typedLanes
    .filter((item) => item.reason !== 'invalid-lane')
    .map((item) => ({
      laneDigest: item.laneDigest,
      queueRank: item.queueRank,
      sourceComplete: item.reason !== 'lane-source-incomplete',
      requirements: item.requirements.map((requirement) => ({
        kind: requirement.kind,
        classDigest: requirement.classDigest,
        units: requirement.requestedUnits,
      })),
    }));
  const rebuiltInvalidLanes = typedLanes.filter((item) => item.reason === 'invalid-lane')
    .map((item) => item.laneDigest);
  const expectedLanes = projectLanes(rebuiltValidLanes, rebuiltInvalidLanes, typedInventory);
  if (canonicalJson(expectedLanes) !== canonicalJson(typedLanes)) return null;
  const expectedContention = projectContention(rebuiltValidLanes, typedInventory);
  if (canonicalJson(expectedContention) !== canonicalJson(row['contention'])) return null;
  // Hash only after every nested collection is bounded and every leaf is a
  // validated scalar, so hostile/cyclic envelopes cannot amplify canonicalization.
  const unsigned = { ...row };
  delete unsigned['projectionDigest'];
  if (row['projectionDigest'] !== digest(unsigned, 'ashlr:capability-spectrum:projection:v1')) return null;
  return value as CapabilitySpectrumShadowV1;
}
