/**
 * Pure, observation-only consumer for caller-supplied Locus workspace identity
 * bytes. A valid digest proves canonical consistency, not producer identity,
 * workspace truth, release provenance, or authority.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export const LOCUS_WORKSPACE_IDENTITY_OBSERVATION_PROTOCOL =
  'ashlr-locus-workspace-identity-observation-v1' as const;
export const EXTERNAL_LOCUS_WORKSPACE_IDENTITY_PROTOCOL =
  'ashlr-external-locus-workspace-identity-observation-v1' as const;
export const LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_BYTES = 16 * 1024;
export const LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_LIFETIME_MS = 5 * 60_000;
export const LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_FUTURE_SKEW_MS = 60_000;
export const LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
export const LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST = `sha256:${'0'.repeat(64)}`;

const PRODUCER_RECORD_TYPE = 'locus-workspace-identity-observation' as const;
const MAX_AGGREGATE_COUNT = 1_000_000;
const MAX_CANONICAL_DEPTH = 12;
const MAX_CANONICAL_NODES = 256;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SEMVER_RE = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const LOCUS_SOURCE_VERSION_RE = /^0\.5\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DIGEST_DOMAIN = 'ashlr:locus-workspace-identity-observation:v1\0';
const OUTPUT_DIGEST_DOMAIN = 'ashlr:external-locus-workspace-identity-observation:v1\0';

const TOP_LEVEL_KEYS = [
  'adapterManifestDigest', 'approvalStore', 'audienceDigest', 'authority', 'authorityAnchor',
  'effectAuthority', 'effects', 'executionAuthority', 'expiresAt', 'identityPosture',
  'mcpRegistered', 'observationDigest', 'observedAt', 'phantomAvailable', 'pinPosture',
  'planningAuthority', 'previousObservationDigest', 'privacyClass', 'producer', 'protocol',
  'recordType', 'schemaVersion', 'sequence', 'sourceState', 'unresolvedCredentials',
  'workspaceDigest', 'workspacePolicy',
] as const;
const UNSIGNED_KEYS = TOP_LEVEL_KEYS.filter((key) => key !== 'observationDigest');
const PRODUCER_KEYS = ['commit', 'product', 'version'] as const;
const WORKSPACE_POLICY_KEYS = ['pinAllowed', 'requirePin', 'state'] as const;
const MCP_REGISTERED_KEYS = ['claude', 'codex', 'cursor', 'grok'] as const;
const APPROVAL_STORE_KEYS = ['dualControlWaiting', 'pending', 'state'] as const;
const EFFECT_KEYS = [
  'approvals', 'budgets', 'credentials', 'deployments', 'dispatches', 'externalMutations',
  'files', 'learning', 'merges', 'pins', 'proposals', 'providers', 'publications', 'releases',
] as const;

export type LocusWorkspaceIdentityPostureV1 = 'ready' | 'protected' | 'unsafe' | 'unknown';
export type LocusWorkspacePinPostureV1 = 'absent' | 'valid' | 'frozen' | 'expired' | 'invalid' | 'unknown';
export type LocusAuthorityAnchorObservationV1 = 'verified' | 'unverified' | 'unavailable';
export type LocusWorkspacePolicyStateV1 = 'valid' | 'missing' | 'invalid';
export type LocusApprovalStoreStateV1 = 'healthy' | 'degraded' | 'unavailable';

export interface LocusWorkspaceIdentityObservationV1 {
  schemaVersion: 1;
  protocol: typeof LOCUS_WORKSPACE_IDENTITY_OBSERVATION_PROTOCOL;
  recordType: typeof PRODUCER_RECORD_TYPE;
  authority: 'observation_only';
  sourceState: 'local_unverified';
  privacyClass: 'metadata_only';
  planningAuthority: false;
  executionAuthority: false;
  effectAuthority: false;
  producer: { product: 'locus'; version: string; commit: string };
  observedAt: string;
  expiresAt: string;
  sequence: number;
  previousObservationDigest: string;
  audienceDigest: string;
  workspaceDigest: string;
  identityPosture: LocusWorkspaceIdentityPostureV1;
  pinPosture: LocusWorkspacePinPostureV1;
  authorityAnchor: LocusAuthorityAnchorObservationV1;
  workspacePolicy: {
    state: LocusWorkspacePolicyStateV1;
    requirePin: boolean;
    pinAllowed: boolean | null;
  };
  mcpRegistered: { claude: boolean; cursor: boolean; codex: boolean; grok: boolean };
  adapterManifestDigest: string | null;
  phantomAvailable: boolean;
  unresolvedCredentials: number;
  approvalStore: {
    state: LocusApprovalStoreStateV1;
    pending: number;
    dualControlWaiting: number;
  };
  effects: {
    files: false;
    providers: false;
    credentials: false;
    pins: false;
    approvals: false;
    dispatches: false;
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

export interface ExternalLocusWorkspaceIdentityObservationV1 {
  schemaVersion: 1;
  protocol: typeof EXTERNAL_LOCUS_WORKSPACE_IDENTITY_PROTOCOL;
  recordType: 'external-locus-workspace-identity-observation';
  authority: 'observation-only';
  sourceState: 'local-unverified';
  verification: 'canonical-digest-consistency-only';
  canonicalBytesVerified: true;
  digestVerified: true;
  freshnessVerified: true;
  originAuthenticated: false;
  truthVerified: false;
  releaseProvenanceVerified: false;
  trusted: false;
  producer: LocusWorkspaceIdentityObservationV1['producer'];
  observedAt: string;
  expiresAt: string;
  sequence: number;
  previousObservationDigest: string;
  audienceDigest: string;
  workspaceDigest: string;
  sourceObservationDigest: string;
  reportedPosture: {
    identity: LocusWorkspaceIdentityPostureV1;
    pin: LocusWorkspacePinPostureV1;
    authorityAnchor: LocusAuthorityAnchorObservationV1;
    workspacePolicy: LocusWorkspaceIdentityObservationV1['workspacePolicy'];
  };
  mcpRegistered: LocusWorkspaceIdentityObservationV1['mcpRegistered'];
  adapterManifestDigest: string | null;
  phantomAvailable: boolean;
  unresolvedCredentials: number;
  approvalStore: LocusWorkspaceIdentityObservationV1['approvalStore'];
  planningAuthority: false;
  executionAuthority: false;
  effectAuthority: false;
  proposalAuthority: false;
  routingAuthority: false;
  reservationAuthority: false;
  budgetAuthority: false;
  credentialAuthority: false;
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
    pins: false;
    approvals: false;
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

export type ExternalLocusWorkspaceIdentityIssueV1 =
  | 'invalid-bytes'
  | 'oversized-observation'
  | 'non-canonical-json'
  | 'unsupported-version'
  | 'invalid-observation'
  | 'invalid-lineage'
  | 'invalid-workspace-policy'
  | 'invalid-approval-store'
  | 'invalid-posture'
  | 'binding-mismatch'
  | 'lineage-mismatch'
  | 'future-observation'
  | 'stale-observation'
  | 'observation-digest-mismatch';

export type ExternalLocusWorkspaceIdentityResultV1 =
  | { ok: true; observation: ExternalLocusWorkspaceIdentityObservationV1; issues: [] }
  | { ok: false; observation: null; issues: [ExternalLocusWorkspaceIdentityIssueV1] };

export interface ExternalLocusWorkspaceIdentityExpectationsV1 {
  audienceDigest: string;
  workspaceDigest: string;
  sequence: number;
  previousObservationDigest: string;
}

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
  if (state.nodes > MAX_CANONICAL_NODES || state.depth > MAX_CANONICAL_DEPTH) {
    throw new TypeError('value exceeds bounds');
  }
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
    return bytes.length <= LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

function sha(domain: string, bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(domain, 'utf8').update(bytes).digest('hex')}`;
}

function sameText(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const first = Buffer.from(left, 'utf8');
  const second = Buffer.from(right, 'utf8');
  return first.length === second.length && timingSafeEqual(first, second);
}

function immutable<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) immutable(nested, seen);
  return Object.freeze(value);
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function enumValue(value: unknown, values: readonly string[]): value is string {
  return typeof value === 'string' && values.includes(value);
}

function validProducer(value: unknown): value is LocusWorkspaceIdentityObservationV1['producer'] {
  const producer = record(value);
  return Boolean(producer && exactKeys(producer, PRODUCER_KEYS) && producer['product'] === 'locus' &&
    typeof producer['version'] === 'string' && producer['version'].length <= 32 &&
    LOCUS_SOURCE_VERSION_RE.test(producer['version']) &&
    typeof producer['commit'] === 'string' && COMMIT_RE.test(producer['commit']));
}

function unsupportedProducer(value: unknown): boolean {
  const producer = record(value);
  return Boolean(producer && exactKeys(producer, PRODUCER_KEYS) && producer['product'] === 'locus' &&
    typeof producer['version'] === 'string' && producer['version'].length <= 32 && SEMVER_RE.test(producer['version']) &&
    !LOCUS_SOURCE_VERSION_RE.test(producer['version']) && typeof producer['commit'] === 'string' &&
    COMMIT_RE.test(producer['commit']));
}

function validWorkspacePolicy(value: unknown): value is LocusWorkspaceIdentityObservationV1['workspacePolicy'] {
  const policy = record(value);
  if (!policy || !exactKeys(policy, WORKSPACE_POLICY_KEYS) ||
    !enumValue(policy['state'], ['valid', 'missing', 'invalid']) ||
    typeof policy['requirePin'] !== 'boolean' ||
    (policy['pinAllowed'] !== null && typeof policy['pinAllowed'] !== 'boolean')) return false;
  return policy['state'] === 'valid' ||
    (policy['requirePin'] === false && policy['pinAllowed'] === null);
}

function validMcp(value: unknown): value is LocusWorkspaceIdentityObservationV1['mcpRegistered'] {
  const mcp = record(value);
  return Boolean(mcp && exactKeys(mcp, MCP_REGISTERED_KEYS) &&
    MCP_REGISTERED_KEYS.every((key) => typeof mcp[key] === 'boolean'));
}

function validApprovalStore(value: unknown): value is LocusWorkspaceIdentityObservationV1['approvalStore'] {
  const approval = record(value);
  return Boolean(approval && exactKeys(approval, APPROVAL_STORE_KEYS) &&
    enumValue(approval['state'], ['healthy', 'degraded', 'unavailable']) &&
    integer(approval['pending'], 0, MAX_AGGREGATE_COUNT) &&
    integer(approval['dualControlWaiting'], 0, MAX_AGGREGATE_COUNT) &&
    Number(approval['dualControlWaiting']) <= Number(approval['pending']) &&
    (approval['state'] !== 'unavailable' ||
      (approval['pending'] === 0 && approval['dualControlWaiting'] === 0)));
}

function validEffects(value: unknown): value is LocusWorkspaceIdentityObservationV1['effects'] {
  const effects = record(value);
  return Boolean(effects && exactKeys(effects, EFFECT_KEYS) && EFFECT_KEYS.every((key) => effects[key] === false));
}

function structuralIssue(value: unknown): ExternalLocusWorkspaceIdentityIssueV1 | null {
  const observation = record(value);
  if (!observation || !exactKeys(observation, TOP_LEVEL_KEYS)) return 'invalid-observation';
  if (observation['schemaVersion'] !== 1 || observation['protocol'] !== LOCUS_WORKSPACE_IDENTITY_OBSERVATION_PROTOCOL ||
    observation['recordType'] !== PRODUCER_RECORD_TYPE) return 'unsupported-version';
  if (unsupportedProducer(observation['producer'])) return 'unsupported-version';
  if (!validProducer(observation['producer']) || observation['authority'] !== 'observation_only' ||
    observation['sourceState'] !== 'local_unverified' || observation['privacyClass'] !== 'metadata_only' ||
    observation['planningAuthority'] !== false || observation['executionAuthority'] !== false ||
    observation['effectAuthority'] !== false || !validEffects(observation['effects']) ||
    !canonicalIso(observation['observedAt']) || !canonicalIso(observation['expiresAt']) ||
    typeof observation['observationDigest'] !== 'string' || !DIGEST_RE.test(observation['observationDigest']) ||
    typeof observation['audienceDigest'] !== 'string' || !DIGEST_RE.test(observation['audienceDigest']) ||
    typeof observation['workspaceDigest'] !== 'string' || !DIGEST_RE.test(observation['workspaceDigest']) ||
    (observation['adapterManifestDigest'] !== null &&
      (typeof observation['adapterManifestDigest'] !== 'string' || !DIGEST_RE.test(observation['adapterManifestDigest']))) ||
    typeof observation['phantomAvailable'] !== 'boolean' ||
    !integer(observation['unresolvedCredentials'], 0, MAX_AGGREGATE_COUNT) || !validMcp(observation['mcpRegistered'])) {
    return 'invalid-observation';
  }
  if (!integer(observation['sequence'], 1, LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_SEQUENCE) ||
    typeof observation['previousObservationDigest'] !== 'string' ||
    !DIGEST_RE.test(observation['previousObservationDigest']) ||
    (observation['sequence'] === 1 &&
      observation['previousObservationDigest'] !== LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST) ||
    (Number(observation['sequence']) > 1 &&
      observation['previousObservationDigest'] === LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST)) {
    return 'invalid-lineage';
  }
  if (!validWorkspacePolicy(observation['workspacePolicy'])) return 'invalid-workspace-policy';
  if (!validApprovalStore(observation['approvalStore'])) return 'invalid-approval-store';
  if (!enumValue(observation['identityPosture'], ['ready', 'protected', 'unsafe', 'unknown']) ||
    !enumValue(observation['pinPosture'], ['absent', 'valid', 'frozen', 'expired', 'invalid', 'unknown']) ||
    !enumValue(observation['authorityAnchor'], ['verified', 'unverified', 'unavailable']) ||
    (observation['identityPosture'] === 'ready' && observation['pinPosture'] !== 'valid') ||
    (observation['identityPosture'] === 'ready' &&
      !Object.values(observation['mcpRegistered'] as Record<string, boolean>).some(Boolean)) ||
    (observation['pinPosture'] === 'valid' && observation['authorityAnchor'] === 'unavailable') ||
    (observation['pinPosture'] === 'absent' && observation['authorityAnchor'] !== 'unavailable') ||
    (record(observation['workspacePolicy'])?.['state'] === 'invalid' && observation['identityPosture'] !== 'unsafe') ||
    (observation['authorityAnchor'] === 'verified' &&
      (observation['pinPosture'] === 'absent' || observation['pinPosture'] === 'unknown'))) {
    return 'invalid-posture';
  }
  const observedAt = Date.parse(observation['observedAt'] as string);
  const expiresAt = Date.parse(observation['expiresAt'] as string);
  return expiresAt <= observedAt || expiresAt - observedAt > LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_LIFETIME_MS
    ? 'stale-observation'
    : null;
}

function unsignedProjection(value: LocusWorkspaceIdentityObservationV1): Record<string, unknown> {
  return Object.fromEntries(UNSIGNED_KEYS.map((key) => [key, value[key]]));
}

/** Canonical bytes for one structurally valid producer observation. */
export function canonicalLocusWorkspaceIdentityObservationBytesV1(value: unknown): Buffer | null {
  return structuralIssue(value) === null ? canonicalBytes(value) : null;
}

/** Domain-separated consistency digest; this does not authenticate Locus. */
export function locusWorkspaceIdentityObservationDigestV1(value: unknown): string | null {
  try {
    const row = record(value);
    if (!row) return null;
    const full = exactKeys(row, TOP_LEVEL_KEYS);
    const unsigned = exactKeys(row, UNSIGNED_KEYS);
    if (!full && !unsigned) return null;
    const candidate = full ? unsignedProjection(value as LocusWorkspaceIdentityObservationV1) : row;
    const synthetic = { ...candidate, observationDigest: `sha256:${'0'.repeat(64)}` };
    if (structuralIssue(synthetic) !== null) return null;
    const bytes = canonicalBytes(candidate);
    return bytes ? sha(DIGEST_DOMAIN, bytes) : null;
  } catch {
    return null;
  }
}

function fail(issue: ExternalLocusWorkspaceIdentityIssueV1): ExternalLocusWorkspaceIdentityResultV1 {
  return immutable({ ok: false, observation: null, issues: [issue] });
}

function observationOf(source: LocusWorkspaceIdentityObservationV1): ExternalLocusWorkspaceIdentityObservationV1 {
  const unsigned = {
    schemaVersion: 1 as const,
    protocol: EXTERNAL_LOCUS_WORKSPACE_IDENTITY_PROTOCOL,
    recordType: 'external-locus-workspace-identity-observation' as const,
    authority: 'observation-only' as const,
    sourceState: 'local-unverified' as const,
    verification: 'canonical-digest-consistency-only' as const,
    canonicalBytesVerified: true as const,
    digestVerified: true as const,
    freshnessVerified: true as const,
    originAuthenticated: false as const,
    truthVerified: false as const,
    releaseProvenanceVerified: false as const,
    trusted: false as const,
    producer: { ...source.producer },
    observedAt: source.observedAt,
    expiresAt: source.expiresAt,
    sequence: source.sequence,
    previousObservationDigest: source.previousObservationDigest,
    audienceDigest: source.audienceDigest,
    workspaceDigest: source.workspaceDigest,
    sourceObservationDigest: source.observationDigest,
    reportedPosture: {
      identity: source.identityPosture,
      pin: source.pinPosture,
      authorityAnchor: source.authorityAnchor,
      workspacePolicy: { ...source.workspacePolicy },
    },
    mcpRegistered: { ...source.mcpRegistered },
    adapterManifestDigest: source.adapterManifestDigest,
    phantomAvailable: source.phantomAvailable,
    unresolvedCredentials: source.unresolvedCredentials,
    approvalStore: { ...source.approvalStore },
    planningAuthority: false as const,
    executionAuthority: false as const,
    effectAuthority: false as const,
    proposalAuthority: false as const,
    routingAuthority: false as const,
    reservationAuthority: false as const,
    budgetAuthority: false as const,
    credentialAuthority: false as const,
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
      pins: false as const,
      approvals: false as const,
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
    observationDigest: sha(OUTPUT_DIGEST_DOMAIN, canonicalBytes(unsigned)!),
  });
}

/** Compile exact canonical caller bytes into one inert, local-unverified Hub projection. */
export function compileExternalLocusWorkspaceIdentityObservationV1(
  bytes: Uint8Array,
  expectations: ExternalLocusWorkspaceIdentityExpectationsV1,
  now: Date = new Date(),
): ExternalLocusWorkspaceIdentityResultV1 {
  try {
    if (!(bytes instanceof Uint8Array)) return fail('invalid-bytes');
    if (bytes.byteLength > LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_BYTES) return fail('oversized-observation');
    if (bytes.byteLength < 2 || !(now instanceof Date) || !Number.isFinite(now.getTime())) return fail('invalid-bytes');
    const copied = Buffer.from(bytes);
    const text = copied.toString('utf8');
    if (!copied.equals(Buffer.from(text, 'utf8'))) return fail('invalid-bytes');
    let parsed: unknown;
    try { parsed = JSON.parse(text) as unknown; } catch { return fail('non-canonical-json'); }
    const issue = structuralIssue(parsed);
    if (issue) return fail(issue);
    const canonical = canonicalBytes(parsed);
    if (!canonical || !canonical.equals(copied)) return fail('non-canonical-json');
    const observation = parsed as LocusWorkspaceIdentityObservationV1;
    if (!expectations || !DIGEST_RE.test(expectations.audienceDigest) ||
      !DIGEST_RE.test(expectations.workspaceDigest) ||
      !integer(expectations.sequence, 1, LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_SEQUENCE) ||
      !DIGEST_RE.test(expectations.previousObservationDigest)) return fail('invalid-bytes');
    if (!sameText(observation.audienceDigest, expectations.audienceDigest) ||
      !sameText(observation.workspaceDigest, expectations.workspaceDigest)) return fail('binding-mismatch');
    if (observation.sequence !== expectations.sequence ||
      !sameText(observation.previousObservationDigest, expectations.previousObservationDigest)) {
      return fail('lineage-mismatch');
    }
    const observedAt = Date.parse(observation.observedAt);
    const expiresAt = Date.parse(observation.expiresAt);
    if (observedAt > now.getTime() + LOCUS_WORKSPACE_IDENTITY_OBSERVATION_MAX_FUTURE_SKEW_MS) {
      return fail('future-observation');
    }
    if (expiresAt <= now.getTime()) return fail('stale-observation');
    const expectedDigest = locusWorkspaceIdentityObservationDigestV1(observation);
    if (!expectedDigest || !sameText(expectedDigest, observation.observationDigest)) {
      return fail('observation-digest-mismatch');
    }
    return immutable({ ok: true, observation: observationOf(observation), issues: [] });
  } catch {
    return fail('invalid-bytes');
  }
}
