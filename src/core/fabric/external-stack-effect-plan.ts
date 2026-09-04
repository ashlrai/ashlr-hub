/**
 * Pure compiler for caller-supplied Stack effect proposals.
 *
 * Parsing and digest verification never constitute approval. This module has
 * no discovery or execution surface: no files, environment, processes,
 * providers, network, credentials, or secrets are read. Targets, predicates,
 * diffs, rollback plans, and idempotency keys are accepted only as opaque
 * digests. V1 is pinned to the audited stable Stack 0.2.x producer family.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export const STACK_PLANNED_EFFECT_MANIFEST_PROTOCOL = 'ashlr-stack-planned-effect-manifest-v1' as const;
export const EXTERNAL_STACK_EFFECT_PLAN_PROTOCOL = 'ashlr-external-stack-effect-plan-v1' as const;
export const STACK_PLANNED_EFFECT_MAX_BYTES = 64 * 1024;
export const STACK_PLANNED_EFFECT_MAX_LIFETIME_MS = 10 * 60_000;
export const STACK_PLANNED_EFFECT_MAX_FUTURE_SKEW_MS = 60_000;

const MAX_CANONICAL_DEPTH = 12;
const MAX_CANONICAL_NODES = 2_000;
const MAX_ESTIMATED_COST_MICRO_UNITS = 1_000_000_000_000;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SEMVER_RE = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const STACK_SOURCE_VERSION_RE = /^0\.2\.(?:0|[1-9][0-9]*)$/;

export const STACK_EFFECT_CLASSES_V1 = [
  'configuration',
  'deployment',
  'filesystem',
  'provider-resource',
  'runtime',
  'source-control',
] as const;

export const STACK_EFFECT_VERBS_V1 = [
  'apply',
  'create',
  'delete',
  'deploy',
  'restart',
  'revert',
  'rollback',
  'start',
  'stop',
  'update',
] as const;

const CURRENCIES = ['CAD', 'EUR', 'GBP', 'USD'] as const;
const SECRET_CAPABILITY_CLASSES = [
  'artifact-publisher',
  'deployment-control',
  'provider-control',
  'source-control',
] as const;
const ROLLBACK_CLASSES = ['automatic', 'not-applicable', 'operator-assisted'] as const;

export type StackEffectClassV1 = typeof STACK_EFFECT_CLASSES_V1[number];
export type StackEffectVerbV1 = typeof STACK_EFFECT_VERBS_V1[number];
export type StackEffectCurrencyV1 = typeof CURRENCIES[number];
export type StackSecretCapabilityClassV1 = typeof SECRET_CAPABILITY_CLASSES[number];
export type StackRollbackClassV1 = typeof ROLLBACK_CLASSES[number];

export type StackEstimatedCostV1 =
  | { known: true; amountMicroUnits: number; currency: StackEffectCurrencyV1 }
  | { known: false; amountMicroUnits: null; currency: null };

export interface StackPlannedEffectManifestV1 {
  schemaVersion: 1;
  protocol: typeof STACK_PLANNED_EFFECT_MANIFEST_PROTOCOL;
  artifactClass: 'effect-proposal';
  source: {
    product: 'stack';
    version: string;
    commit: string;
  };
  generatedAt: string;
  expiresAt: string;
  targetDigest: string;
  effect: {
    class: StackEffectClassV1;
    verb: StackEffectVerbV1;
  };
  observationManifestDigest: string;
  preconditionsDigest: string;
  expectedDiffDigest: string;
  idempotencyKeyDigest: string;
  estimatedCost: StackEstimatedCostV1;
  requiredSecretCapabilityClass: StackSecretCapabilityClassV1 | null;
  rollback: {
    class: StackRollbackClassV1;
    planDigest: string | null;
  };
  acceptancePredicateDigest: string;
  manifestDigest: string;
}

export interface ExternalStackEffectPlanV1 {
  schemaVersion: 1;
  protocol: typeof EXTERNAL_STACK_EFFECT_PLAN_PROTOCOL;
  recordType: 'external-stack-effect-plan';
  artifactClass: 'effect-proposal';
  verification: 'local-unverified';
  authenticated: false;
  trusted: false;
  authority: false;
  effectAuthority: false;
  planningAuthority: false;
  executionAuthority: false;
  proposalAuthority: false;
  approvalAuthority: false;
  policyAuthority: false;
  promotionAuthority: false;
  mergeAuthority: false;
  releaseAuthority: false;
  deployAuthority: false;
  publicationAuthority: false;
  externalMutationAuthority: false;
  secretAccessAuthority: false;
  eligible: false;
  planningEligible: false;
  executionEligible: false;
  policyEligible: false;
  promotionEligible: false;
  approved: false;
  performed: false;
  effectPerformed: false;
  source: StackPlannedEffectManifestV1['source'];
  generatedAt: string;
  expiresAt: string;
  targetDigest: string;
  effect: StackPlannedEffectManifestV1['effect'];
  observationManifestDigest: string;
  preconditionsDigest: string;
  expectedDiffDigest: string;
  idempotencyKeyDigest: string;
  estimatedCost: StackEstimatedCostV1;
  requiredSecretCapabilityClass: StackSecretCapabilityClassV1 | null;
  rollback: StackPlannedEffectManifestV1['rollback'];
  acceptancePredicateDigest: string;
  manifestDigest: string;
  planDigest: string;
}

export type ExternalStackEffectPlanIssueV1 =
  | 'invalid-bytes'
  | 'oversized-manifest'
  | 'non-canonical-json'
  | 'invalid-manifest'
  | 'unsupported-version'
  | 'future-manifest'
  | 'stale-manifest'
  | 'manifest-digest-mismatch'
  | 'invalid-effect'
  | 'invalid-cost'
  | 'invalid-rollback';

export type ExternalStackEffectPlanResultV1 =
  | { ok: true; plan: ExternalStackEffectPlanV1; issues: [] }
  | { ok: false; plan: null; issues: [ExternalStackEffectPlanIssueV1] };

const MANIFEST_KEYS = [
  'acceptancePredicateDigest', 'artifactClass', 'effect', 'estimatedCost', 'expectedDiffDigest', 'expiresAt',
  'generatedAt', 'idempotencyKeyDigest', 'manifestDigest', 'observationManifestDigest', 'preconditionsDigest',
  'protocol', 'requiredSecretCapabilityClass', 'rollback', 'schemaVersion', 'source', 'targetDigest',
] as const;
const UNSIGNED_MANIFEST_KEYS = MANIFEST_KEYS.filter((key) => key !== 'manifestDigest');
const SOURCE_KEYS = ['commit', 'product', 'version'] as const;
const EFFECT_KEYS = ['class', 'verb'] as const;
const COST_KEYS = ['amountMicroUnits', 'currency', 'known'] as const;
const ROLLBACK_KEYS = ['class', 'planDigest'] as const;

const VERBS_BY_CLASS: Readonly<Record<StackEffectClassV1, readonly StackEffectVerbV1[]>> = {
  configuration: ['apply', 'revert'],
  deployment: ['deploy', 'rollback'],
  filesystem: ['create', 'delete', 'update'],
  'provider-resource': ['create', 'delete', 'update'],
  runtime: ['restart', 'start', 'stop'],
  'source-control': ['apply', 'revert'],
};

type Canonical = null | boolean | number | string | Canonical[] | { [key: string]: Canonical };

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || !descriptors[String(key)]?.enumerable ||
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
  if (state.nodes > MAX_CANONICAL_NODES || state.depth > MAX_CANONICAL_DEPTH) throw new TypeError('value exceeds bounds');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number');
    return Object.is(value, -0) ? 0 : value;
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
    return bytes.length <= STACK_PLANNED_EFFECT_MAX_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

function sha(domain: string, value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(domain, 'utf8').update('\0').update(value).digest('hex')}`;
}

function sameText(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function immutable<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) immutable(nested, seen);
  return Object.freeze(value);
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function enumValue(value: unknown, values: readonly string[]): value is string {
  return typeof value === 'string' && values.includes(value);
}

function validSource(value: unknown): value is StackPlannedEffectManifestV1['source'] {
  const source = record(value);
  return Boolean(source && exactKeys(source, SOURCE_KEYS) && source['product'] === 'stack' &&
    typeof source['version'] === 'string' && source['version'].length <= 80 &&
    STACK_SOURCE_VERSION_RE.test(source['version']) && typeof source['commit'] === 'string' &&
    COMMIT_RE.test(source['commit']));
}

function unsupportedSourceVersion(value: unknown): boolean {
  const source = record(value);
  return Boolean(source && exactKeys(source, SOURCE_KEYS) && source['product'] === 'stack' &&
    typeof source['version'] === 'string' && source['version'].length <= 80 && SEMVER_RE.test(source['version']) &&
    !STACK_SOURCE_VERSION_RE.test(source['version']) && typeof source['commit'] === 'string' &&
    COMMIT_RE.test(source['commit']));
}

function validEffect(value: unknown): value is StackPlannedEffectManifestV1['effect'] {
  const effect = record(value);
  if (!effect || !exactKeys(effect, EFFECT_KEYS) || !enumValue(effect['class'], STACK_EFFECT_CLASSES_V1) ||
    !enumValue(effect['verb'], STACK_EFFECT_VERBS_V1)) return false;
  return VERBS_BY_CLASS[effect['class'] as StackEffectClassV1].includes(effect['verb'] as StackEffectVerbV1);
}

function validCost(value: unknown): value is StackEstimatedCostV1 {
  const cost = record(value);
  if (!cost || !exactKeys(cost, COST_KEYS) || typeof cost['known'] !== 'boolean') return false;
  if (!cost['known']) return cost['amountMicroUnits'] === null && cost['currency'] === null;
  return Number.isSafeInteger(cost['amountMicroUnits']) && Number(cost['amountMicroUnits']) >= 0 &&
    Number(cost['amountMicroUnits']) <= MAX_ESTIMATED_COST_MICRO_UNITS && enumValue(cost['currency'], CURRENCIES);
}

function validRollback(value: unknown): value is StackPlannedEffectManifestV1['rollback'] {
  const rollback = record(value);
  if (!rollback || !exactKeys(rollback, ROLLBACK_KEYS) || !enumValue(rollback['class'], ROLLBACK_CLASSES)) return false;
  return rollback['class'] === 'not-applicable'
    ? rollback['planDigest'] === null
    : typeof rollback['planDigest'] === 'string' && DIGEST_RE.test(rollback['planDigest']);
}

function unsignedManifest(value: unknown): Omit<StackPlannedEffectManifestV1, 'manifestDigest'> | null {
  const manifest = record(value);
  if (!manifest || !exactKeys(manifest, MANIFEST_KEYS) || manifest['schemaVersion'] !== 1 ||
    manifest['protocol'] !== STACK_PLANNED_EFFECT_MANIFEST_PROTOCOL || manifest['artifactClass'] !== 'effect-proposal' ||
    !validSource(manifest['source']) || !canonicalIso(manifest['generatedAt']) ||
    !canonicalIso(manifest['expiresAt']) || typeof manifest['targetDigest'] !== 'string' ||
    !DIGEST_RE.test(manifest['targetDigest']) || !validEffect(manifest['effect']) ||
    typeof manifest['observationManifestDigest'] !== 'string' || !DIGEST_RE.test(manifest['observationManifestDigest']) ||
    typeof manifest['preconditionsDigest'] !== 'string' || !DIGEST_RE.test(manifest['preconditionsDigest']) ||
    typeof manifest['expectedDiffDigest'] !== 'string' || !DIGEST_RE.test(manifest['expectedDiffDigest']) ||
    typeof manifest['idempotencyKeyDigest'] !== 'string' || !DIGEST_RE.test(manifest['idempotencyKeyDigest']) ||
    !validCost(manifest['estimatedCost']) ||
    (manifest['requiredSecretCapabilityClass'] !== null &&
      !enumValue(manifest['requiredSecretCapabilityClass'], SECRET_CAPABILITY_CLASSES)) ||
    !validRollback(manifest['rollback']) || typeof manifest['acceptancePredicateDigest'] !== 'string' ||
    !DIGEST_RE.test(manifest['acceptancePredicateDigest']) || typeof manifest['manifestDigest'] !== 'string' ||
    !DIGEST_RE.test(manifest['manifestDigest'])) return null;
  return Object.fromEntries(UNSIGNED_MANIFEST_KEYS.map((key) => [key, manifest[key]])) as
    Omit<StackPlannedEffectManifestV1, 'manifestDigest'>;
}

/** Canonical exact proposal bytes. Unknown or privacy-bearing fields fail. */
export function canonicalStackPlannedEffectManifestBytesV1(value: unknown): Buffer | null {
  return unsignedManifest(value) ? canonicalBytes(value) : null;
}

/** Domain-separated consistency digest over every manifest field except itself. */
export function stackPlannedEffectManifestDigestV1(value: unknown): string | null {
  const manifest = record(value);
  if (!manifest) return null;
  const unsigned = exactKeys(manifest, UNSIGNED_MANIFEST_KEYS)
    ? manifest
    : exactKeys(manifest, MANIFEST_KEYS)
      ? Object.fromEntries(UNSIGNED_MANIFEST_KEYS.map((key) => [key, manifest[key]]))
      : null;
  const bytes = unsigned ? canonicalBytes(unsigned) : null;
  return bytes ? sha('ashlr:stack-planned-effect-manifest:v1', bytes) : null;
}

function fail(issue: ExternalStackEffectPlanIssueV1): ExternalStackEffectPlanResultV1 {
  return immutable({ ok: false, plan: null, issues: [issue] });
}

function planOf(manifest: StackPlannedEffectManifestV1): ExternalStackEffectPlanV1 {
  const plan = {
    schemaVersion: 1 as const,
    protocol: EXTERNAL_STACK_EFFECT_PLAN_PROTOCOL,
    recordType: 'external-stack-effect-plan' as const,
    artifactClass: 'effect-proposal' as const,
    verification: 'local-unverified' as const,
    authenticated: false as const,
    trusted: false as const,
    authority: false as const,
    effectAuthority: false as const,
    planningAuthority: false as const,
    executionAuthority: false as const,
    proposalAuthority: false as const,
    approvalAuthority: false as const,
    policyAuthority: false as const,
    promotionAuthority: false as const,
    mergeAuthority: false as const,
    releaseAuthority: false as const,
    deployAuthority: false as const,
    publicationAuthority: false as const,
    externalMutationAuthority: false as const,
    secretAccessAuthority: false as const,
    eligible: false as const,
    planningEligible: false as const,
    executionEligible: false as const,
    policyEligible: false as const,
    promotionEligible: false as const,
    approved: false as const,
    performed: false as const,
    effectPerformed: false as const,
    source: manifest.source,
    generatedAt: manifest.generatedAt,
    expiresAt: manifest.expiresAt,
    targetDigest: manifest.targetDigest,
    effect: manifest.effect,
    observationManifestDigest: manifest.observationManifestDigest,
    preconditionsDigest: manifest.preconditionsDigest,
    expectedDiffDigest: manifest.expectedDiffDigest,
    idempotencyKeyDigest: manifest.idempotencyKeyDigest,
    estimatedCost: manifest.estimatedCost,
    requiredSecretCapabilityClass: manifest.requiredSecretCapabilityClass,
    rollback: manifest.rollback,
    acceptancePredicateDigest: manifest.acceptancePredicateDigest,
    manifestDigest: manifest.manifestDigest,
  };
  return immutable({
    ...plan,
    planDigest: sha('ashlr:external-stack-effect-plan:v1', canonicalBytes(plan)!),
  });
}

/** Compile exact canonical caller bytes into an inert, never-approved proposal. */
export function compileExternalStackEffectPlanV1(
  bytes: Uint8Array,
  now: Date = new Date(),
): ExternalStackEffectPlanResultV1 {
  try {
    if (!(bytes instanceof Uint8Array)) return fail('invalid-bytes');
    if (bytes.byteLength > STACK_PLANNED_EFFECT_MAX_BYTES) return fail('oversized-manifest');
    if (bytes.byteLength < 2 || !(now instanceof Date) || !Number.isFinite(now.getTime())) return fail('invalid-bytes');
    const copied = Buffer.from(bytes);
    const text = copied.toString('utf8');
    if (!copied.equals(Buffer.from(text, 'utf8'))) return fail('invalid-bytes');
    let parsed: unknown;
    try { parsed = JSON.parse(text) as unknown; } catch { return fail('non-canonical-json'); }
    const canonical = canonicalStackPlannedEffectManifestBytesV1(parsed);
    if (!canonical) {
      const row = record(parsed);
      if (row?.['schemaVersion'] !== 1 || row?.['protocol'] !== STACK_PLANNED_EFFECT_MANIFEST_PROTOCOL ||
        unsupportedSourceVersion(row?.['source'])) return fail('unsupported-version');
      if (row && exactKeys(row, MANIFEST_KEYS)) {
        if (!validEffect(row['effect'])) return fail('invalid-effect');
        if (!validCost(row['estimatedCost'])) return fail('invalid-cost');
        if (!validRollback(row['rollback'])) return fail('invalid-rollback');
      }
      return fail('invalid-manifest');
    }
    if (!canonical.equals(copied)) return fail('non-canonical-json');
    const manifest = parsed as StackPlannedEffectManifestV1;
    const generatedAt = Date.parse(manifest.generatedAt);
    const expiresAt = Date.parse(manifest.expiresAt);
    if (generatedAt > now.getTime() + STACK_PLANNED_EFFECT_MAX_FUTURE_SKEW_MS) return fail('future-manifest');
    if (expiresAt <= generatedAt || expiresAt - generatedAt > STACK_PLANNED_EFFECT_MAX_LIFETIME_MS ||
      expiresAt <= now.getTime()) return fail('stale-manifest');
    const expectedDigest = stackPlannedEffectManifestDigestV1(manifest);
    if (!expectedDigest || !sameText(expectedDigest, manifest.manifestDigest)) return fail('manifest-digest-mismatch');
    return immutable({ ok: true, plan: planOf(manifest), issues: [] });
  } catch {
    return fail('invalid-bytes');
  }
}
