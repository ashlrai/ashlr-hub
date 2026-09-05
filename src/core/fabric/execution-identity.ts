/**
 * Execution Identity V1 — internal private locator registry plus a values-free,
 * shadow-only resource and assignment projection.
 *
 * This module is intentionally absent from src/api exports. V1 never spawns a
 * process, resolves a secret value, contacts a provider, mutates routing, or
 * writes a proposal.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import type {
  AshlrConfig,
  EngineId,
  ExecutionIdentityPlanV1,
  ExecutionIdentityRefV1,
} from '../types.js';
import { resolveEngineSpec } from '../run/engine-registry.js';

export const EXECUTION_IDENTITY_V1_SCHEMA_VERSION = 1 as const;
export const EXECUTION_IDENTITY_V1_MAX_IDENTITIES = 32;
export const EXECUTION_IDENTITY_V1_MAX_CONCURRENT = 32;
export const EXECUTION_IDENTITY_V1_OBSERVATION_MAX_AGE_MS = 5 * 60_000;
export const EXECUTION_IDENTITY_V1_MAX_FUTURE_SKEW_MS = 60_000;
export const EXECUTION_IDENTITY_V1_MAX_BACKOFF_MS = 24 * 60 * 60_000;
const PRIVATE_STORE_MAX_BYTES = 64 * 1024;

const IDENTITY_REF_RE = /^eid_[0-9a-f]{32}$/;
const LOCATOR_REF_RE = /^erl_[0-9a-f]{32}$/;
const IDENTITY_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,79}$/;
const ENGINE_IDS: ReadonlySet<string> = new Set([
  'builtin', 'local-coder', 'ashlrcode', 'aw', 'claude', 'codex', 'hermes',
  'kimi', 'nim', 'opencode', 'grok',
]);

const REGISTRY_DIGEST_DOMAIN = 'ashlr.execution-identity.registry.v1';
const IDENTITY_DIGEST_DOMAIN = 'ashlr.execution-identity.public-ref.v1';
const MODEL_RESOURCE_DIGEST_DOMAIN = 'ashlr.execution-identity.model-resources.v1';
const WORK_DIGEST_DOMAIN = 'ashlr.execution-identity.shadow-work.v1';

interface ExecutionIdentityTestHooks {
  afterPrivateStoreOpen?: (path: string) => void;
}

let executionIdentityTestHooks: ExecutionIdentityTestHooks | undefined;

/** Test-only seam for deterministic pathname replacement after descriptor open. */
export function setExecutionIdentityTestHooksForTests(hooks?: ExecutionIdentityTestHooks): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('execution identity hooks are test-only');
  executionIdentityTestHooks = hooks;
}

type ExecutionIdentityDigestV1 = `sha256:${string}`;

export type ExecutionIdentityV1StopReason =
  | 'feature-not-shadow-only'
  | 'identity-roster-missing'
  | 'identity-roster-limit'
  | 'invalid-identity-record'
  | 'invalid-identity-ref'
  | 'duplicate-identity-ref'
  | 'duplicate-runtime-locator-ref'
  | 'engine-not-allowed'
  | 'engine-not-registered'
  | 'platform-private-store-unsupported'
  | 'private-store-missing'
  | 'private-store-unsafe'
  | 'private-store-malformed'
  | 'private-binding-missing'
  | 'auth-engine-mismatch'
  | 'plan-engine-mismatch'
  | 'plan-policy-missing'
  | 'runtime-locator-invalid'
  | 'phantom-reference-invalid'
  | 'resource-roster-mismatch';

export type ExecutionIdentityResourceReasonV1 =
  | 'observation-missing'
  | 'observation-stale'
  | 'observed-open'
  | 'observed-near'
  | 'observed-exhausted'
  | 'observed-unreachable'
  | 'observed-zero-capacity'
  | 'interactive-reserved'
  | 'backoff-rate-limited'
  | 'backoff-provider-refused'
  | 'backoff-transport-error';

export type ExecutionIdentityBackoffReasonV1 =
  | 'rate-limited'
  | 'provider-refused'
  | 'transport-error';

export interface ExecutionIdentityResourceObservationV1 {
  identityRef: ExecutionIdentityRefV1;
  state: 'open' | 'near' | 'exhausted' | 'unreachable';
  availableSlots: number;
  usedPercent?: number;
  observedAt: string;
}

type PrivateRuntimeBindingV1 =
  | { ref: string; kind: 'vendor-home'; env: 'CODEX_HOME' | 'CLAUDE_CONFIG_DIR'; locator: string }
  | { ref: string; kind: 'local-runtime' }
  | { ref: string; kind: 'phantom-env'; secretNames: string[] };

interface PrivateExecutionIdentityV1 {
  ref: ExecutionIdentityRefV1;
  digest: ExecutionIdentityDigestV1;
  engine: EngineId;
  binding: PrivateRuntimeBindingV1;
  plan: ExecutionIdentityPlanV1;
}

interface PrivateRegistryV1 {
  identities: PrivateExecutionIdentityV1[];
  configDigest: string;
}

type PrivateRegistryResultV1 =
  | { ok: true; registry: PrivateRegistryV1 }
  | { ok: false; stopReasons: ExecutionIdentityV1StopReason[] };

export type ResolvedExecutionIdentityRuntimeV1 =
  | {
      ok: true;
      engine: EngineId;
      executionIdentityDigest: ExecutionIdentityDigestV1;
      env: Readonly<Partial<Record<'CODEX_HOME' | 'CLAUDE_CONFIG_DIR', string>>>;
      phantomSecretNames: readonly string[];
    }
  | { ok: false; reason: 'disabled' | 'identity-not-found' | ExecutionIdentityV1StopReason };

export interface ExecutionIdentityPublicResourceV1 {
  executionIdentityDigest: ExecutionIdentityDigestV1;
  engine: EngineId;
  state: 'open' | 'near' | 'exhausted' | 'unreachable' | 'unknown';
  trustedSlots: number;
  maxConcurrent: number;
  usedPercent: number | null;
  observedAt: string | null;
  reason: ExecutionIdentityResourceReasonV1;
}

export interface ExecutionIdentityShadowAssignmentV1 {
  workItemDigest: `sha256:${string}`;
  engine: EngineId;
  executionIdentityDigest: ExecutionIdentityDigestV1;
  authority: 'shadow-only';
  executionAuthority: false;
}

export interface ExecutionIdentityShadowUnassignedV1 {
  workItemDigest: `sha256:${string}`;
  engine: EngineId | null;
  reason: 'invalid-work-item' | 'no-trusted-capacity';
}

export interface ExecutionIdentityShadowStatusV1 {
  schemaVersion: typeof EXECUTION_IDENTITY_V1_SCHEMA_VERSION;
  authority: 'shadow-only';
  enabled: boolean;
  shadowOnly: true;
  sourceState: 'disabled' | 'healthy' | 'degraded';
  stopReasons: ExecutionIdentityV1StopReason[];
  configuredIdentityCount: number;
  identities: ExecutionIdentityPublicResourceV1[];
  assignments: ExecutionIdentityShadowAssignmentV1[];
  unassigned: ExecutionIdentityShadowUnassignedV1[];
  executionAuthority: false;
  proposalAuthority: false;
  routingMutation: false;
}

export interface ExecutionIdentityShadowWorkV1 { id: string; engine: EngineId }

interface PrivateStoreOptionsV1 {
  /** Internal/test injection only. This value is never accepted from AshlrConfig. */
  privateStorePath?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sha256(domain: string, value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(domain, 'utf8').update('\0').update(value, 'utf8').digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
}

/** Canonical lineage digest for the public model-capacity roster only. */
export function digestExecutionIdentityModelResourcesV1(
  sourceState: ExecutionIdentityShadowStatusV1['sourceState'],
  resources: readonly ExecutionIdentityPublicResourceV1[],
): ExecutionIdentityDigestV1 {
  const sorted = [...resources].map((resource) => ({ ...resource }))
    .sort((left, right) => left.executionIdentityDigest.localeCompare(right.executionIdentityDigest));
  return sha256(MODEL_RESOURCE_DIGEST_DOMAIN, canonicalJson({ sourceState, resources: sorted }));
}

export function isExecutionIdentityRefV1(value: unknown): value is ExecutionIdentityRefV1 {
  return typeof value === 'string' && IDENTITY_REF_RE.test(value);
}

function isRuntimeLocatorRefV1(value: unknown): value is string {
  return typeof value === 'string' && LOCATOR_REF_RE.test(value);
}

export function isExecutionIdentityDigestV1(value: unknown): value is ExecutionIdentityDigestV1 {
  return typeof value === 'string' && IDENTITY_DIGEST_RE.test(value);
}

export function digestExecutionIdentityRefV1(value: unknown): ExecutionIdentityDigestV1 | null {
  return isExecutionIdentityRefV1(value) ? sha256(IDENTITY_DIGEST_DOMAIN, value) : null;
}

export function executionIdentityPrivateStorePathV1(): string {
  return join(homedir(), '.ashlr', 'private', 'execution-identities-v1.json');
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function privateMode(stat: { mode: number }, expected: number): boolean {
  return process.platform !== 'win32' && (stat.mode & 0o777) === expected;
}

function currentOwner(stat: { uid: number }): boolean {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function inspectPrivateLocator(locator: unknown): boolean {
  try {
    if (typeof locator !== 'string' || locator.length < 2 || locator.length > 4096 ||
        !isAbsolute(locator) || resolve(locator) !== locator || locator === parse(locator).root) return false;
    const named = lstatSync(locator);
    return !named.isSymbolicLink() && named.isDirectory() && realpathSync(locator) === locator &&
      currentOwner(named) && privateMode(named, 0o700);
  } catch {
    return false;
  }
}

function readPrivateStore(
  options: PrivateStoreOptionsV1,
): { ok: true; bindings: Map<string, PrivateRuntimeBindingV1> } |
  { ok: false; reason: ExecutionIdentityV1StopReason } {
  if (process.platform === 'win32') {
    return { ok: false, reason: 'platform-private-store-unsupported' };
  }
  const path = options.privateStorePath ?? executionIdentityPrivateStorePathV1();
  let fd: number | undefined;
  try {
    if (!isAbsolute(path) || resolve(path) !== path || path === parse(path).root) {
      return { ok: false, reason: 'private-store-unsafe' };
    }
    const parent = dirname(path);
    const parentBefore = lstatSync(parent);
    if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory() ||
        !currentOwner(parentBefore) || !privateMode(parentBefore, 0o700) ||
        realpathSync(parent) !== parent) return { ok: false, reason: 'private-store-unsafe' };
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    try {
      fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { ok: false, reason: 'private-store-missing' };
      if (code === 'ELOOP' || code === 'EMLINK') {
        return { ok: false, reason: 'private-store-unsafe' };
      }
      throw error;
    }
    const opened = fstatSync(fd);
    executionIdentityTestHooks?.afterPrivateStoreOpen?.(path);
    const namedBefore = lstatSync(path);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size <= 0 ||
        opened.size > PRIVATE_STORE_MAX_BYTES || !currentOwner(opened) ||
        !privateMode(opened, 0o600) || namedBefore.isSymbolicLink() ||
        !namedBefore.isFile() || namedBefore.nlink !== 1 || namedBefore.size !== opened.size ||
        !currentOwner(namedBefore) || !privateMode(namedBefore, 0o600) ||
        !sameFile(opened, namedBefore) || realpathSync(path) !== path) {
      return { ok: false, reason: 'private-store-unsafe' };
    }
    const bytes = Buffer.alloc(PRIVATE_STORE_MAX_BYTES + 1);
    const byteLength = readSync(fd, bytes, 0, bytes.length, 0);
    if (byteLength <= 0 || byteLength > PRIVATE_STORE_MAX_BYTES) {
      return { ok: false, reason: 'private-store-unsafe' };
    }
    const raw = bytes.subarray(0, byteLength).toString('utf8');
    const openedAfter = fstatSync(fd);
    const after = lstatSync(path);
    const parentAfter = lstatSync(parent);
    if (!sameFile(namedBefore, after) || !sameFile(parentBefore, parentAfter) ||
        !sameFile(opened, openedAfter) || !sameFile(after, openedAfter) ||
        after.isSymbolicLink() || !after.isFile() || after.nlink !== 1 ||
        after.size <= 0 || after.size > PRIVATE_STORE_MAX_BYTES ||
        !currentOwner(after) || !privateMode(after, 0o600) ||
        !openedAfter.isFile() || openedAfter.nlink !== 1 ||
        openedAfter.size <= 0 || openedAfter.size > PRIVATE_STORE_MAX_BYTES ||
        !currentOwner(openedAfter) || !privateMode(openedAfter, 0o600) ||
        openedAfter.size !== opened.size || openedAfter.mtimeMs !== opened.mtimeMs ||
        openedAfter.ctimeMs !== opened.ctimeMs || byteLength !== openedAfter.size ||
        parentAfter.isSymbolicLink() || !parentAfter.isDirectory() ||
        !currentOwner(parentAfter) || !privateMode(parentAfter, 0o700) ||
        realpathSync(parent) !== parent || realpathSync(path) !== path) {
      return { ok: false, reason: 'private-store-unsafe' };
    }
    const parsed = record(JSON.parse(raw));
    if (!parsed || !exactKeys(parsed, ['schemaVersion', 'bindings']) || parsed['schemaVersion'] !== 1 ||
        !Array.isArray(parsed['bindings']) || parsed['bindings'].length === 0 ||
        parsed['bindings'].length > EXECUTION_IDENTITY_V1_MAX_IDENTITIES) {
      return { ok: false, reason: 'private-store-malformed' };
    }
    const bindings = new Map<string, PrivateRuntimeBindingV1>();
    for (const value of parsed['bindings']) {
      const binding = record(value);
      if (!binding || !isRuntimeLocatorRefV1(binding['ref']) || bindings.has(binding['ref'])) {
        return { ok: false, reason: 'private-store-malformed' };
      }
      if (binding['kind'] === 'vendor-home') {
        if (!exactKeys(binding, ['ref', 'kind', 'env', 'locator']) ||
            !['CODEX_HOME', 'CLAUDE_CONFIG_DIR'].includes(String(binding['env'])) ||
            !inspectPrivateLocator(binding['locator'])) {
          return { ok: false, reason: 'runtime-locator-invalid' };
        }
        bindings.set(binding['ref'], {
          ref: binding['ref'], kind: 'vendor-home',
          env: binding['env'] as 'CODEX_HOME' | 'CLAUDE_CONFIG_DIR', locator: binding['locator'] as string,
        });
      } else if (binding['kind'] === 'local-runtime') {
        if (!exactKeys(binding, ['ref', 'kind'])) return { ok: false, reason: 'private-store-malformed' };
        bindings.set(binding['ref'], { ref: binding['ref'], kind: 'local-runtime' });
      } else if (binding['kind'] === 'phantom-env') {
        const names = binding['secretNames'];
        if (!exactKeys(binding, ['ref', 'kind', 'secretNames']) || !Array.isArray(names) ||
            names.length < 1 || names.length > 8 ||
            names.some((name) => typeof name !== 'string' || !SECRET_NAME_RE.test(name)) ||
            new Set(names).size !== names.length) {
          return { ok: false, reason: 'phantom-reference-invalid' };
        }
        bindings.set(binding['ref'], {
          ref: binding['ref'], kind: 'phantom-env', secretNames: [...names] as string[],
        });
      } else return { ok: false, reason: 'private-store-malformed' };
    }
    return { ok: true, bindings };
  } catch (error) {
    return {
      ok: false,
      reason: (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
        ? 'private-store-missing'
        : 'private-store-malformed',
    };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* read-only cleanup */ }
    }
  }
}

function validConcurrent(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 &&
    Number(value) <= EXECUTION_IDENTITY_V1_MAX_CONCURRENT;
}

function validPlan(
  engine: EngineId,
  spec: NonNullable<ReturnType<typeof resolveEngineSpec>>,
  bindingKind: PrivateRuntimeBindingV1['kind'],
  value: unknown,
): value is ExecutionIdentityPlanV1 {
  const plan = record(value);
  if (!plan || !exactKeys(plan, ['kind', 'class', 'maxConcurrent'])) return false;
  if (engine === 'codex') {
    return bindingKind === 'vendor-home' && plan['kind'] === 'subscription' &&
      (plan['class'] === 'codex-max' || plan['class'] === 'codex-custom') &&
      validConcurrent(plan['maxConcurrent']);
  }
  if (engine === 'claude') {
    if (bindingKind !== 'vendor-home') return false;
    if (plan['kind'] === 'agent-credit' && plan['class'] === 'claude-agent-sdk-credit') {
      return validConcurrent(plan['maxConcurrent']);
    }
    return plan['kind'] === 'interactive-reserved' && plan['class'] === 'claude-max' &&
      plan['maxConcurrent'] === 0;
  }
  if (spec.kind === 'api-model' && spec.api?.envKey === '' && bindingKind === 'local-runtime') {
    return plan['kind'] === 'local' && plan['class'] === 'local-runtime' && validConcurrent(plan['maxConcurrent']);
  }
  if (spec.kind === 'api-model' && typeof spec.api?.envKey === 'string' && spec.api.envKey.length > 0 &&
      bindingKind === 'phantom-env') {
    return plan['kind'] === 'metered' && plan['class'] === 'api-metered' && validConcurrent(plan['maxConcurrent']);
  }
  return (spec.kind === 'builtin' || spec.kind === 'cli-agent') && bindingKind === 'local-runtime' &&
    plan['kind'] === 'local' && plan['class'] === 'local-runtime' && validConcurrent(plan['maxConcurrent']);
}

function bindingMatchesEngine(
  engine: EngineId,
  spec: NonNullable<ReturnType<typeof resolveEngineSpec>>,
  binding: PrivateRuntimeBindingV1,
): boolean {
  if (binding.kind === 'vendor-home') {
    return (engine === 'codex' && binding.env === 'CODEX_HOME') ||
      (engine === 'claude' && binding.env === 'CLAUDE_CONFIG_DIR');
  }
  if (engine === 'codex' || engine === 'claude') return false;
  if (spec.kind === 'api-model') {
    return spec.api?.envKey === '' ? binding.kind === 'local-runtime' :
      typeof spec.api?.envKey === 'string' && spec.api.envKey.length > 0 && binding.kind === 'phantom-env' &&
      binding.secretNames.length === 1 && binding.secretNames[0] === spec.api.envKey;
  }
  return (spec.kind === 'builtin' || spec.kind === 'cli-agent') && binding.kind === 'local-runtime';
}

function privateRegistry(cfg: AshlrConfig, options: PrivateStoreOptionsV1 = {}): PrivateRegistryResultV1 {
  const feature = cfg.foundry?.executionIdentityV1;
  if (feature?.enabled !== true || feature.shadowOnly !== true) {
    return { ok: false, stopReasons: ['feature-not-shadow-only'] };
  }
  const rows: unknown = feature.identities;
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, stopReasons: ['identity-roster-missing'] };
  if (rows.length > EXECUTION_IDENTITY_V1_MAX_IDENTITIES) return { ok: false, stopReasons: ['identity-roster-limit'] };
  const privateStore = readPrivateStore(options);
  if (!privateStore.ok) return { ok: false, stopReasons: [privateStore.reason] };

  const allowed = new Set<string>(cfg.foundry?.allowedBackends ?? ['builtin']);
  const seenIdentityRefs = new Set<string>();
  const seenLocatorRefs = new Set<string>();
  const identities: PrivateExecutionIdentityV1[] = [];
  const reasons = new Set<ExecutionIdentityV1StopReason>();
  for (const raw of rows) {
    const row = record(raw);
    if (!row || !exactKeys(row, ['ref', 'engine', 'privateRuntimeLocatorRef', 'plan'])) {
      reasons.add('invalid-identity-record');
      continue;
    }
    if (!isExecutionIdentityRefV1(row['ref']) || !isRuntimeLocatorRefV1(row['privateRuntimeLocatorRef'])) {
      reasons.add('invalid-identity-ref');
      continue;
    }
    if (seenIdentityRefs.has(row['ref'])) { reasons.add('duplicate-identity-ref'); continue; }
    if (seenLocatorRefs.has(row['privateRuntimeLocatorRef'])) { reasons.add('duplicate-runtime-locator-ref'); continue; }
    seenIdentityRefs.add(row['ref']);
    seenLocatorRefs.add(row['privateRuntimeLocatorRef']);
    if (typeof row['engine'] !== 'string' || !ENGINE_IDS.has(row['engine'])) {
      reasons.add('engine-not-registered');
      continue;
    }
    const engine = row['engine'] as EngineId;
    if (!allowed.has(engine)) { reasons.add('engine-not-allowed'); continue; }
    const spec = resolveEngineSpec(engine, cfg);
    if (!spec) { reasons.add('engine-not-registered'); continue; }
    const binding = privateStore.bindings.get(row['privateRuntimeLocatorRef']);
    if (!binding) { reasons.add('private-binding-missing'); continue; }
    if (!bindingMatchesEngine(engine, spec, binding)) { reasons.add('auth-engine-mismatch'); continue; }
    if (row['plan'] === undefined) { reasons.add('plan-policy-missing'); continue; }
    if (!validPlan(engine, spec, binding.kind, row['plan'])) { reasons.add('plan-engine-mismatch'); continue; }
    const digest = digestExecutionIdentityRefV1(row['ref']);
    if (!digest) { reasons.add('invalid-identity-ref'); continue; }
    identities.push({ ref: row['ref'], digest, engine, binding, plan: row['plan'] });
  }
  if (reasons.size > 0 || identities.length !== rows.length) {
    return { ok: false, stopReasons: [...reasons].sort() };
  }
  const configDigest = sha256(REGISTRY_DIGEST_DOMAIN, JSON.stringify(identities.map((identity) => ({
    ref: identity.ref, engine: identity.engine, binding: identity.binding, plan: identity.plan,
  }))));
  return { ok: true, registry: { identities, configDigest } };
}

/** Resolve one exact private runtime binding without executing or contacting it. */
export function resolveExecutionIdentityRuntimeV1(
  cfg: AshlrConfig,
  identityRef: unknown,
  options: PrivateStoreOptionsV1 = {},
): ResolvedExecutionIdentityRuntimeV1 {
  if (cfg.foundry?.executionIdentityV1?.enabled !== true) return { ok: false, reason: 'disabled' };
  const resolved = privateRegistry(cfg, options);
  if (!resolved.ok) return { ok: false, reason: resolved.stopReasons[0] ?? 'invalid-identity-record' };
  if (!isExecutionIdentityRefV1(identityRef)) return { ok: false, reason: 'identity-not-found' };
  const identity = resolved.registry.identities.find((candidate) => candidate.ref === identityRef);
  if (!identity) return { ok: false, reason: 'identity-not-found' };
  if (identity.binding.kind === 'vendor-home') {
    return {
      ok: true, engine: identity.engine, executionIdentityDigest: identity.digest,
      env: Object.freeze({ [identity.binding.env]: identity.binding.locator }),
      phantomSecretNames: Object.freeze([]),
    };
  }
  if (identity.binding.kind === 'phantom-env') {
    return {
      ok: true, engine: identity.engine, executionIdentityDigest: identity.digest,
      env: Object.freeze({}), phantomSecretNames: Object.freeze([...identity.binding.secretNames]),
    };
  }
  return {
    ok: true, engine: identity.engine, executionIdentityDigest: identity.digest,
    env: Object.freeze({}), phantomSecretNames: Object.freeze([]),
  };
}

interface PrivateResourceV1 {
  state: ExecutionIdentityPublicResourceV1['state'];
  trustedSlots: number;
  maxConcurrent: number;
  usedPercent: number | null;
  observedAt: string | null;
  reason: ExecutionIdentityResourceReasonV1;
}

/** Identity-scoped, in-memory resource evidence for shadow planning only. */
export class ExecutionIdentityResourceBookV1 {
  readonly configDigest: string | null;
  readonly stopReasons: readonly ExecutionIdentityV1StopReason[];
  readonly #identities = new Map<string, PrivateExecutionIdentityV1>();
  readonly #observations = new Map<string, ExecutionIdentityResourceObservationV1>();
  readonly #backoffs = new Map<string, { untilMs: number; reason: ExecutionIdentityBackoffReasonV1 }>();

  constructor(cfg: AshlrConfig, options: PrivateStoreOptionsV1 = {}) {
    const resolved = privateRegistry(cfg, options);
    if (!resolved.ok) {
      this.configDigest = null;
      this.stopReasons = Object.freeze([...resolved.stopReasons]);
      return;
    }
    this.configDigest = resolved.registry.configDigest;
    this.stopReasons = Object.freeze([]);
    for (const identity of resolved.registry.identities) this.#identities.set(identity.ref, identity);
  }

  recordObservation(value: unknown): boolean {
    const observation = record(value);
    if (!observation || !exactKeys(observation, observation['usedPercent'] === undefined
      ? ['identityRef', 'state', 'availableSlots', 'observedAt']
      : ['identityRef', 'state', 'availableSlots', 'usedPercent', 'observedAt'])) return false;
    const ref = observation['identityRef'];
    const state = observation['state'];
    const slots = observation['availableSlots'];
    const used = observation['usedPercent'];
    if (!isExecutionIdentityRefV1(ref) || !this.#identities.has(ref) ||
        !['open', 'near', 'exhausted', 'unreachable'].includes(String(state)) ||
        !Number.isSafeInteger(slots) || Number(slots) < 0 || Number(slots) > EXECUTION_IDENTITY_V1_MAX_CONCURRENT ||
        !canonicalTimestamp(observation['observedAt']) ||
        (used !== undefined && (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100))) return false;
    this.#observations.set(ref, {
      identityRef: ref, state: state as ExecutionIdentityResourceObservationV1['state'],
      availableSlots: Number(slots), ...(used !== undefined ? { usedPercent: Number(used) } : {}),
      observedAt: observation['observedAt'],
    });
    return true;
  }

  recordBackoff(identityRef: unknown, retryAfterMs: unknown, reason: unknown, nowMs = Date.now()): boolean {
    if (!isExecutionIdentityRefV1(identityRef) || !this.#identities.has(identityRef) ||
        typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0 ||
        retryAfterMs > EXECUTION_IDENTITY_V1_MAX_BACKOFF_MS ||
        !['rate-limited', 'provider-refused', 'transport-error'].includes(String(reason)) || !Number.isFinite(nowMs)) {
      return false;
    }
    this.#backoffs.set(identityRef, {
      untilMs: nowMs + Math.floor(retryAfterMs), reason: reason as ExecutionIdentityBackoffReasonV1,
    });
    return true;
  }

  clearBackoff(identityRef: unknown): boolean {
    return isExecutionIdentityRefV1(identityRef) && this.#backoffs.delete(identityRef);
  }

  privateState(identityRef: string, nowMs: number): PrivateResourceV1 | null {
    const identity = this.#identities.get(identityRef);
    if (!identity) return null;
    const maximum = identity.plan.maxConcurrent;
    if (identity.plan.kind === 'interactive-reserved') {
      return {
        state: 'unknown', trustedSlots: 0, maxConcurrent: 0,
        usedPercent: null, observedAt: null, reason: 'interactive-reserved',
      };
    }
    const backoff = this.#backoffs.get(identityRef);
    if (backoff && backoff.untilMs > nowMs) {
      return {
        state: 'exhausted', trustedSlots: 0, maxConcurrent: maximum,
        usedPercent: null, observedAt: null, reason: `backoff-${backoff.reason}`,
      };
    }
    const observation = this.#observations.get(identityRef);
    if (!observation) {
      return {
        state: 'unknown', trustedSlots: 0, maxConcurrent: maximum,
        usedPercent: null, observedAt: null, reason: 'observation-missing',
      };
    }
    const observedMs = Date.parse(observation.observedAt);
    if (observedMs > nowMs + EXECUTION_IDENTITY_V1_MAX_FUTURE_SKEW_MS ||
        nowMs - observedMs > EXECUTION_IDENTITY_V1_OBSERVATION_MAX_AGE_MS) {
      return {
        state: 'unknown', trustedSlots: 0, maxConcurrent: maximum,
        usedPercent: null, observedAt: observation.observedAt, reason: 'observation-stale',
      };
    }
    if (observation.state === 'unreachable' || observation.state === 'exhausted') {
      return {
        state: observation.state, trustedSlots: 0, maxConcurrent: maximum,
        usedPercent: observation.usedPercent ?? null, observedAt: observation.observedAt,
        reason: observation.state === 'unreachable' ? 'observed-unreachable' : 'observed-exhausted',
      };
    }
    const slots = Math.min(maximum, observation.availableSlots);
    if (slots === 0) {
      return {
        state: 'exhausted', trustedSlots: 0, maxConcurrent: maximum,
        usedPercent: observation.usedPercent ?? null, observedAt: observation.observedAt,
        reason: 'observed-zero-capacity',
      };
    }
    return {
      state: observation.state, trustedSlots: slots, maxConcurrent: maximum,
      usedPercent: observation.usedPercent ?? null, observedAt: observation.observedAt,
      reason: observation.state === 'near' ? 'observed-near' : 'observed-open',
    };
  }

  publicResources(nowMs = Date.now()): ExecutionIdentityPublicResourceV1[] {
    if (!Number.isFinite(nowMs)) return [];
    const rows: ExecutionIdentityPublicResourceV1[] = [];
    for (const identity of this.#identities.values()) {
      const state = this.privateState(identity.ref, nowMs);
      if (state) rows.push({ executionIdentityDigest: identity.digest, engine: identity.engine, ...state });
    }
    return rows.sort((a, b) => a.engine.localeCompare(b.engine) ||
      a.executionIdentityDigest.localeCompare(b.executionIdentityDigest));
  }
}

function disabledStatus(): ExecutionIdentityShadowStatusV1 {
  return {
    schemaVersion: 1, authority: 'shadow-only', enabled: false, shadowOnly: true,
    sourceState: 'disabled', stopReasons: [], configuredIdentityCount: 0,
    identities: [], assignments: [], unassigned: [], executionAuthority: false,
    proposalAuthority: false, routingMutation: false,
  };
}

function workDigest(value: string): `sha256:${string}` { return sha256(WORK_DIGEST_DOMAIN, value) }

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Build a values-free shadow assignment/status projection. */
export function buildExecutionIdentityShadowStatusV1(
  cfg: AshlrConfig,
  opts: PrivateStoreOptionsV1 & {
    resourceBook?: ExecutionIdentityResourceBookV1;
    work?: readonly ExecutionIdentityShadowWorkV1[];
    now?: Date;
  } = {},
): ExecutionIdentityShadowStatusV1 {
  if (cfg.foundry?.executionIdentityV1?.enabled !== true) return disabledStatus();
  const configuredIdentityCount = Array.isArray(cfg.foundry.executionIdentityV1.identities)
    ? cfg.foundry.executionIdentityV1.identities.length : 0;
  const resolved = privateRegistry(cfg, opts);
  if (!resolved.ok) {
    return {
      ...disabledStatus(), enabled: true, sourceState: 'degraded',
      stopReasons: [...resolved.stopReasons], configuredIdentityCount,
    };
  }
  const nowMs = opts.now?.getTime() ?? Date.now();
  const resourceBook = opts.resourceBook ?? new ExecutionIdentityResourceBookV1(cfg, opts);
  if (!Number.isFinite(nowMs) || resourceBook.configDigest !== resolved.registry.configDigest) {
    return {
      ...disabledStatus(), enabled: true, sourceState: 'degraded',
      stopReasons: ['resource-roster-mismatch'], configuredIdentityCount,
    };
  }

  const identities = resourceBook.publicResources(nowMs);
  const remaining = new Map(identities.map((identity) => [identity.executionIdentityDigest, identity.trustedSlots]));
  const assignments: ExecutionIdentityShadowAssignmentV1[] = [];
  const unassigned: ExecutionIdentityShadowUnassignedV1[] = [];
  for (const item of opts.work ?? []) {
    const validId = typeof item?.id === 'string' && item.id.length > 0 && item.id.length <= 4096 &&
      !hasControlCharacters(item.id);
    const validEngine = typeof item?.engine === 'string' && ENGINE_IDS.has(item.engine);
    const digest = workDigest(validId ? item.id : 'invalid-work-item');
    if (!validId || !validEngine) {
      unassigned.push({ workItemDigest: digest, engine: null, reason: 'invalid-work-item' });
      continue;
    }
    const candidates = identities
      .filter((identity) => identity.engine === item.engine &&
        (remaining.get(identity.executionIdentityDigest) ?? 0) > 0)
      .sort((a, b) =>
        (remaining.get(b.executionIdentityDigest) ?? 0) - (remaining.get(a.executionIdentityDigest) ?? 0) ||
        a.executionIdentityDigest.localeCompare(b.executionIdentityDigest));
    const selected = candidates[0];
    if (!selected) {
      unassigned.push({ workItemDigest: digest, engine: item.engine, reason: 'no-trusted-capacity' });
      continue;
    }
    remaining.set(selected.executionIdentityDigest,
      (remaining.get(selected.executionIdentityDigest) ?? 1) - 1);
    assignments.push({
      workItemDigest: digest, engine: item.engine,
      executionIdentityDigest: selected.executionIdentityDigest,
      authority: 'shadow-only', executionAuthority: false,
    });
  }
  return {
    schemaVersion: 1, authority: 'shadow-only', enabled: true, shadowOnly: true,
    sourceState: 'healthy', stopReasons: [], configuredIdentityCount, identities,
    assignments, unassigned, executionAuthority: false, proposalAuthority: false,
    routingMutation: false,
  };
}
