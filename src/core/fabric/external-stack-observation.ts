/**
 * Pure, observation-only adapter for caller-supplied Stack manifest bytes.
 *
 * This module performs no discovery. It reads no files, environment variables,
 * processes, providers, network endpoints, or credentials. A valid manifest is
 * still local-unverified data: its digest proves only canonical consistency.
 * V1 is pinned to the audited Stack 0.2.x producer family. Phantom exposes an
 * aggregate key-presence count, never key names or bare hashes that callers
 * could reverse with a low-entropy dictionary.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export const STACK_OBSERVATION_MANIFEST_PROTOCOL = 'ashlr-stack-observation-manifest-v1' as const;
export const STACK_OBSERVATION_PROTOCOL = 'ashlr-stack-observation-v1' as const;
export const STACK_OBSERVATION_MAX_BYTES = 128 * 1024;
export const STACK_OBSERVATION_MAX_LIFETIME_MS = 10 * 60_000;
export const STACK_OBSERVATION_MAX_FUTURE_SKEW_MS = 60_000;

const MAX_COMPONENTS = 4_096;
const MAX_CONNECTIONS = 64;
const MAX_RESOURCES = 1_000_000;
const MAX_RESOURCE_CLASSES = 64;
const MAX_KEY_PRESENCE_COUNT = 1_000_000;
const MAX_CANONICAL_DEPTH = 16;
const MAX_CANONICAL_NODES = 20_000;
const SEMVER_RE = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const STACK_SOURCE_VERSION_RE = /^0\.2\.(?:0|[1-9][0-9]*)$/;
const COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

const COMPONENT_KINDS = [
  'control-plane',
  'human-interface',
  'local-runtime',
  'reasoning-plane',
  'secret-broker',
  'tool-gateway',
] as const;
const RESOURCE_KINDS = ['compute', 'model', 'tool', 'workspace'] as const;
const RESOURCE_STATES = ['available', 'constrained', 'unavailable', 'unknown'] as const;

type StackComponentKindV1 = typeof COMPONENT_KINDS[number];
type StackResourceKindV1 = typeof RESOURCE_KINDS[number];
type StackResourceStateV1 = typeof RESOURCE_STATES[number];

export interface StackObservationManifestV1 {
  schemaVersion: 1;
  protocol: typeof STACK_OBSERVATION_MANIFEST_PROTOCOL;
  source: {
    product: 'stack';
    version: string;
    commit: string;
  };
  generatedAt: string;
  expiresAt: string;
  topology: {
    componentCount: number;
    connectionCount: number;
    components: Array<{
      kind: StackComponentKindV1;
      count: number;
    }>;
    connections: Array<{
      from: StackComponentKindV1;
      to: StackComponentKindV1;
      count: number;
    }>;
  };
  resources: {
    resourceCount: number;
    classes: Array<{
      kind: StackResourceKindV1;
      classDigest: string;
      state: StackResourceStateV1;
      count: number;
    }>;
  };
  phantom: null | {
    installed: boolean;
    version: string | null;
    vaultStatus: 'locked' | 'unlocked' | 'unavailable' | 'unknown';
    /** Aggregate only. Per-key names or hashes are forbidden to prevent dictionary attacks. */
    keyPresenceCount: number;
  };
  manifestDigest: string;
}

export interface ExternalStackObservationV1 {
  schemaVersion: 1;
  protocol: typeof STACK_OBSERVATION_PROTOCOL;
  recordType: 'external-stack-observation';
  authority: 'observation-only';
  effectAuthority: false;
  verification: 'local-unverified';
  authenticated: false;
  trusted: false;
  source: StackObservationManifestV1['source'];
  generatedAt: string;
  expiresAt: string;
  manifestDigest: string;
  topology: {
    componentCount: number;
    connectionCount: number;
    componentKinds: number;
  };
  resources: {
    resourceCount: number;
    classCount: number;
    available: number;
    constrained: number;
    unavailable: number;
    unknown: number;
  };
  phantom: StackObservationManifestV1['phantom'];
  planningAuthority: false;
  executionAuthority: false;
  proposalAuthority: false;
  routingAuthority: false;
  reservationAuthority: false;
  budgetAuthority: false;
  learningAuthority: false;
  policyAuthority: false;
  promotionAuthority: false;
  verificationAuthority: false;
  mergeAuthority: false;
  releaseAuthority: false;
  deployAuthority: false;
  publicationAuthority: false;
  externalMutationAuthority: false;
  policyEligible: false;
  promotionEligible: false;
  effects: {
    files: false;
    models: false;
    providers: false;
    processes: false;
    network: false;
    credentials: false;
    secrets: false;
    dispatches: false;
    goals: false;
    proposals: false;
    merges: false;
    releases: false;
    deployments: false;
    publications: false;
    externalMutations: false;
    budgets: false;
    learning: false;
  };
  observationDigest: string;
}

export type ExternalStackObservationIssueV1 =
  | 'invalid-bytes'
  | 'oversized-manifest'
  | 'non-canonical-json'
  | 'invalid-manifest'
  | 'unsupported-version'
  | 'future-manifest'
  | 'stale-manifest'
  | 'manifest-digest-mismatch'
  | 'invalid-topology'
  | 'invalid-resources'
  | 'invalid-phantom-metadata';

export type ExternalStackObservationResultV1 =
  | { ok: true; observation: ExternalStackObservationV1; issues: [] }
  | { ok: false; observation: null; issues: [ExternalStackObservationIssueV1] };

const MANIFEST_KEYS = [
  'expiresAt', 'generatedAt', 'manifestDigest', 'phantom', 'protocol', 'resources', 'schemaVersion', 'source', 'topology',
] as const;
const UNSIGNED_MANIFEST_KEYS = MANIFEST_KEYS.filter((key) => key !== 'manifestDigest');
const SOURCE_KEYS = ['commit', 'product', 'version'] as const;
const TOPOLOGY_KEYS = ['componentCount', 'components', 'connectionCount', 'connections'] as const;
const COMPONENT_KEYS = ['count', 'kind'] as const;
const CONNECTION_KEYS = ['count', 'from', 'to'] as const;
const RESOURCES_KEYS = ['classes', 'resourceCount'] as const;
const RESOURCE_CLASS_KEYS = ['classDigest', 'count', 'kind', 'state'] as const;
const PHANTOM_KEYS = ['installed', 'keyPresenceCount', 'vaultStatus', 'version'] as const;

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
    return bytes.length <= STACK_OBSERVATION_MAX_BYTES ? bytes : null;
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

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function enumValue(value: unknown, values: readonly string[]): value is string {
  return typeof value === 'string' && values.includes(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validSource(value: unknown): value is StackObservationManifestV1['source'] {
  const source = record(value);
  return Boolean(source && exactKeys(source, SOURCE_KEYS) && source['product'] === 'stack' &&
    typeof source['version'] === 'string' && source['version'].length <= 80 &&
    STACK_SOURCE_VERSION_RE.test(source['version']) &&
    typeof source['commit'] === 'string' && COMMIT_RE.test(source['commit']));
}

function unsupportedSourceVersion(value: unknown): boolean {
  const source = record(value);
  return Boolean(source && exactKeys(source, SOURCE_KEYS) && source['product'] === 'stack' &&
    typeof source['version'] === 'string' && source['version'].length <= 80 &&
    SEMVER_RE.test(source['version']) && !STACK_SOURCE_VERSION_RE.test(source['version']) &&
    typeof source['commit'] === 'string' && COMMIT_RE.test(source['commit']));
}

function validTopology(value: unknown): value is StackObservationManifestV1['topology'] {
  const topology = record(value);
  if (!topology || !exactKeys(topology, TOPOLOGY_KEYS) ||
    !integer(topology['componentCount'], 1, MAX_COMPONENTS) ||
    !integer(topology['connectionCount'], 0, MAX_RESOURCES) ||
    !Array.isArray(topology['components']) || topology['components'].length < 1 ||
    topology['components'].length > COMPONENT_KINDS.length ||
    !Array.isArray(topology['connections']) || topology['connections'].length > MAX_CONNECTIONS) return false;
  let priorKind = '';
  let componentCount = 0;
  const componentCounts = new Map<string, number>();
  for (const value of topology['components']) {
    const component = record(value);
    if (!component || !exactKeys(component, COMPONENT_KEYS) ||
      !enumValue(component['kind'], COMPONENT_KINDS) || !integer(component['count'], 1, MAX_COMPONENTS) ||
      compareText(priorKind, component['kind']) >= 0) return false;
    priorKind = component['kind'];
    componentCount += component['count'] as number;
    componentCounts.set(component['kind'], component['count'] as number);
  }
  if (componentCount !== topology['componentCount']) return false;
  let priorConnection = '';
  let connectionCount = 0;
  for (const value of topology['connections']) {
    const connection = record(value);
    if (!connection || !exactKeys(connection, CONNECTION_KEYS) ||
      !enumValue(connection['from'], COMPONENT_KINDS) || !enumValue(connection['to'], COMPONENT_KINDS) ||
      connection['from'] === connection['to'] || !integer(connection['count'], 1, MAX_RESOURCES) ||
      !componentCounts.has(connection['from']) || !componentCounts.has(connection['to'])) return false;
    const identity = `${connection['from']}>${connection['to']}`;
    if (compareText(priorConnection, identity) >= 0 ||
      Number(connection['count']) > componentCounts.get(connection['from'])! * componentCounts.get(connection['to'])!) return false;
    priorConnection = identity;
    connectionCount += connection['count'] as number;
  }
  return connectionCount === topology['connectionCount'];
}

function validResources(value: unknown): value is StackObservationManifestV1['resources'] {
  const resources = record(value);
  if (!resources || !exactKeys(resources, RESOURCES_KEYS) ||
    !integer(resources['resourceCount'], 0, MAX_RESOURCES) || !Array.isArray(resources['classes']) ||
    resources['classes'].length > MAX_RESOURCE_CLASSES) return false;
  let prior = '';
  let resourceCount = 0;
  for (const value of resources['classes']) {
    const resource = record(value);
    if (!resource || !exactKeys(resource, RESOURCE_CLASS_KEYS) ||
      !enumValue(resource['kind'], RESOURCE_KINDS) || typeof resource['classDigest'] !== 'string' ||
      !DIGEST_RE.test(resource['classDigest']) || !enumValue(resource['state'], RESOURCE_STATES) ||
      !integer(resource['count'], 1, MAX_RESOURCES)) return false;
    const identity = `${resource['kind']}:${resource['classDigest']}:${resource['state']}`;
    if (compareText(prior, identity) >= 0) return false;
    prior = identity;
    resourceCount += resource['count'] as number;
    if (resourceCount > MAX_RESOURCES) return false;
  }
  return resourceCount === resources['resourceCount'];
}

function validPhantom(value: unknown): value is StackObservationManifestV1['phantom'] {
  if (value === null) return true;
  const phantom = record(value);
  if (!phantom || !exactKeys(phantom, PHANTOM_KEYS) || typeof phantom['installed'] !== 'boolean' ||
    (phantom['version'] !== null && (typeof phantom['version'] !== 'string' ||
      phantom['version'].length > 80 || !SEMVER_RE.test(phantom['version']))) ||
    !enumValue(phantom['vaultStatus'], ['locked', 'unlocked', 'unavailable', 'unknown']) ||
    !integer(phantom['keyPresenceCount'], 0, MAX_KEY_PRESENCE_COUNT)) return false;
  return phantom['installed']
    ? phantom['version'] !== null
    : phantom['version'] === null && phantom['vaultStatus'] === 'unavailable' &&
      phantom['keyPresenceCount'] === 0;
}

function unsignedManifest(value: unknown): Omit<StackObservationManifestV1, 'manifestDigest'> | null {
  const manifest = record(value);
  if (!manifest || !exactKeys(manifest, MANIFEST_KEYS) || manifest['schemaVersion'] !== 1 ||
    manifest['protocol'] !== STACK_OBSERVATION_MANIFEST_PROTOCOL || !validSource(manifest['source']) ||
    !canonicalIso(manifest['generatedAt']) || !canonicalIso(manifest['expiresAt']) ||
    !validTopology(manifest['topology']) || !validResources(manifest['resources']) ||
    !validPhantom(manifest['phantom']) || typeof manifest['manifestDigest'] !== 'string' ||
    !DIGEST_RE.test(manifest['manifestDigest'])) return null;
  return Object.fromEntries(UNSIGNED_MANIFEST_KEYS.map((key) => [key, manifest[key]])) as
    Omit<StackObservationManifestV1, 'manifestDigest'>;
}

/** Canonical exact manifest bytes. Unknown or privacy-bearing fields fail. */
export function canonicalStackObservationManifestBytesV1(value: unknown): Buffer | null {
  return unsignedManifest(value) ? canonicalBytes(value) : null;
}

/** Domain-separated consistency digest over every manifest field except itself. */
export function stackObservationManifestDigestV1(value: unknown): string | null {
  const manifest = record(value);
  if (!manifest) return null;
  const unsigned = exactKeys(manifest, UNSIGNED_MANIFEST_KEYS)
    ? manifest
    : exactKeys(manifest, MANIFEST_KEYS)
      ? Object.fromEntries(UNSIGNED_MANIFEST_KEYS.map((key) => [key, manifest[key]]))
      : null;
  const bytes = unsigned ? canonicalBytes(unsigned) : null;
  return bytes ? sha('ashlr:stack-observation-manifest:v1', bytes) : null;
}

function fail(issue: ExternalStackObservationIssueV1): ExternalStackObservationResultV1 {
  return immutable({ ok: false, observation: null, issues: [issue] });
}

function observationOf(manifest: StackObservationManifestV1): ExternalStackObservationV1 {
  const counts: Record<StackResourceStateV1, number> = {
    available: 0,
    constrained: 0,
    unavailable: 0,
    unknown: 0,
  };
  for (const resource of manifest.resources.classes) counts[resource.state] += resource.count;
  const unsigned = {
    schemaVersion: 1 as const,
    protocol: STACK_OBSERVATION_PROTOCOL,
    recordType: 'external-stack-observation' as const,
    authority: 'observation-only' as const,
    effectAuthority: false as const,
    verification: 'local-unverified' as const,
    authenticated: false as const,
    trusted: false as const,
    source: manifest.source,
    generatedAt: manifest.generatedAt,
    expiresAt: manifest.expiresAt,
    manifestDigest: manifest.manifestDigest,
    topology: {
      componentCount: manifest.topology.componentCount,
      connectionCount: manifest.topology.connectionCount,
      componentKinds: manifest.topology.components.length,
    },
    resources: {
      resourceCount: manifest.resources.resourceCount,
      classCount: manifest.resources.classes.length,
      ...counts,
    },
    phantom: manifest.phantom,
    planningAuthority: false as const,
    executionAuthority: false as const,
    proposalAuthority: false as const,
    routingAuthority: false as const,
    reservationAuthority: false as const,
    budgetAuthority: false as const,
    learningAuthority: false as const,
    policyAuthority: false as const,
    promotionAuthority: false as const,
    verificationAuthority: false as const,
    mergeAuthority: false as const,
    releaseAuthority: false as const,
    deployAuthority: false as const,
    publicationAuthority: false as const,
    externalMutationAuthority: false as const,
    policyEligible: false as const,
    promotionEligible: false as const,
    effects: {
      files: false as const,
      models: false as const,
      providers: false as const,
      processes: false as const,
      network: false as const,
      credentials: false as const,
      secrets: false as const,
      dispatches: false as const,
      goals: false as const,
      proposals: false as const,
      merges: false as const,
      releases: false as const,
      deployments: false as const,
      publications: false as const,
      externalMutations: false as const,
      budgets: false as const,
      learning: false as const,
    },
  };
  return immutable({
    ...unsigned,
    observationDigest: sha('ashlr:external-stack-observation:v1', canonicalBytes(unsigned)!),
  });
}

/** Compile exact canonical caller bytes into an inert, local-unverified receipt. */
export function compileExternalStackObservationV1(
  bytes: Uint8Array,
  now: Date = new Date(),
): ExternalStackObservationResultV1 {
  try {
    if (!(bytes instanceof Uint8Array)) return fail('invalid-bytes');
    if (bytes.byteLength > STACK_OBSERVATION_MAX_BYTES) return fail('oversized-manifest');
    if (bytes.byteLength < 2 || !(now instanceof Date) || !Number.isFinite(now.getTime())) return fail('invalid-bytes');
    const copied = Buffer.from(bytes);
    const text = copied.toString('utf8');
    if (!copied.equals(Buffer.from(text, 'utf8'))) return fail('invalid-bytes');
    let parsed: unknown;
    try { parsed = JSON.parse(text) as unknown; } catch { return fail('non-canonical-json'); }
    const canonical = canonicalStackObservationManifestBytesV1(parsed);
    if (!canonical) {
      const row = record(parsed);
      if (row?.['schemaVersion'] !== 1 || row?.['protocol'] !== STACK_OBSERVATION_MANIFEST_PROTOCOL) {
        return fail('unsupported-version');
      }
      if (unsupportedSourceVersion(row?.['source'])) return fail('unsupported-version');
      if (row && exactKeys(row, MANIFEST_KEYS)) {
        if (!validTopology(row['topology'])) return fail('invalid-topology');
        if (!validResources(row['resources'])) return fail('invalid-resources');
        if (!validPhantom(row['phantom'])) return fail('invalid-phantom-metadata');
      }
      return fail('invalid-manifest');
    }
    if (!canonical.equals(copied)) return fail('non-canonical-json');
    const manifest = parsed as StackObservationManifestV1;
    const generatedAt = Date.parse(manifest.generatedAt);
    const expiresAt = Date.parse(manifest.expiresAt);
    if (generatedAt > now.getTime() + STACK_OBSERVATION_MAX_FUTURE_SKEW_MS) return fail('future-manifest');
    if (expiresAt <= generatedAt || expiresAt - generatedAt > STACK_OBSERVATION_MAX_LIFETIME_MS ||
      expiresAt <= now.getTime()) return fail('stale-manifest');
    const expectedDigest = stackObservationManifestDigestV1(manifest);
    if (!expectedDigest || !sameText(expectedDigest, manifest.manifestDigest)) return fail('manifest-digest-mismatch');
    return immutable({ ok: true, observation: observationOf(manifest), issues: [] });
  } catch {
    return fail('invalid-bytes');
  }
}
