/**
 * M572 — bounded, local-only, enrolled-repo continuous activation.
 *
 * The M461 daemon permit can only ever authorize one proposal tick. That gate
 * is right to refuse a resident loop that could run forever, but "refuses
 * everything" is not the same policy as "refuses unbounded autonomy". This
 * protocol is the narrow shape the gate should be able to say yes to:
 *
 *   - resident (once === false), never a dry run, never a drain
 *   - local-only execution; a cloud or hybrid request is refused outright
 *   - an explicit list of already-enrolled repositories; never "all repos"
 *   - an EXPLICIT BOUND: a wall-clock deadline or a maximum iteration count.
 *     A permit with no bound cannot be classified, cannot be built, cannot be
 *     parsed, and cannot be verified. "Runs forever" has no representation.
 *
 * Trust roots are provisioned the way activation-permit.ts demands: in source,
 * under review, frozen at module load. No environment variable, config field,
 * CLI argument, or writable trust file adds authority at runtime. This module
 * never reads `process.env` and never loads a root from disk or from the
 * config object — see the source-property test in
 * test/m572.continuous-activation-permit.test.ts, which fails if that changes.
 *
 * This is a SEPARATE protocol from both M461 and the goal conductor: its own
 * policy version, its own signing domain, its own trust roots, its own permit
 * path and its own receipts. A daemon permit can never authorize a continuous
 * run, and a continuous permit can never authorize a daemon tick.
 */

import {
  createPrivateKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { closeSync, fstatSync, lstatSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import {
  assureDaemonActivationPrivateDirectory,
  canonicalizeDaemonActivationValue,
  collectDaemonActivationRuntimeContext,
  daemonActivationConfigDigest,
  daemonActivationEqualCanonical,
  daemonActivationHasExactKeys,
  daemonActivationIsRecord,
  daemonActivationPathEntryPresent,
  daemonActivationSameFileSnapshot,
  daemonActivationSha256,
  daemonActivationStrictConfigSnapshot,
  daemonActivationTrustRootMap,
  DAEMON_ACTIVATION_DIGEST_RE,
  DAEMON_ACTIVATION_ID_RE,
  DAEMON_ACTIVATION_KEY_ID_RE,
  DAEMON_ACTIVATION_LOCK_WAIT_MS,
  DAEMON_ACTIVATION_MAX_FUTURE_SKEW_MS,
  DAEMON_ACTIVATION_MAX_VALIDITY_MS,
  openDaemonActivationPinnedFile,
  persistDaemonActivationReceipt,
  validDaemonActivationBindings,
  validDaemonActivationRuntimeContext,
  type DaemonActivationPermitPayload,
  type DaemonActivationPermitVerification,
  type DaemonActivationPinnedFile,
  type DaemonActivationRuntimeContext,
  type DaemonActivationTrustRoot,
} from './activation-permit.js';
import {
  acquireLocalStoreLock,
  releaseLocalStoreLock,
} from '../fleet/local-store-lock.js';
import { readEnrollmentRegistry } from '../sandbox/policy.js';
import type { AshlrConfig } from '../types.js';
import { fsyncDirectory } from '../util/durability.js';

export const CONTINUOUS_ACTIVATION_POLICY_VERSION = 'continuous-bounded-local-v1';
const CONTINUOUS_SIGNING_DOMAIN = 'ashlr:daemon-continuous-activation-permit:v1\0';

/**
 * Ceilings are defence in depth, not the bound itself. A request must still
 * carry its own explicit bound; these only cap how large that bound may be.
 */
export const CONTINUOUS_ACTIVATION_MAX_WALL_MS = 12 * 60 * 60_000;
export const CONTINUOUS_ACTIVATION_MAX_ITERATIONS = 500;
export const CONTINUOUS_ACTIVATION_MAX_REPOS = 32;

/**
 * Provisioning this root required a reviewed source change, and replacing or
 * rotating it requires another one. No environment variable, config field, CLI
 * argument, or writable trust file can add authority at runtime.
 *
 * The matching private key is deliberately NOT in this repository. Whoever
 * holds it can mint continuous permits, and can still only mint permits of the
 * one bounded, local-only, enrolled-repo shape this protocol can express.
 */
export const CONTINUOUS_ACTIVATION_TRUST_ROOTS:
readonly Readonly<DaemonActivationTrustRoot>[] = Object.freeze([
  Object.freeze({
    keyId: 'ashlr-continuous-bounded-local-2026-09',
    publicKeyPem: '-----BEGIN PUBLIC KEY-----\n'
      + 'MCowBQYDK2VwAyEApsrShMeW2GivDqSUWURY47d9nL2QjL4RqFESAiHeaEA=\n'
      + '-----END PUBLIC KEY-----\n',
  }),
]);

// ---------------------------------------------------------------------------
// Request and scope shapes
// ---------------------------------------------------------------------------

/**
 * Widened deliberately: a cloud request must be *representable* so the gate has
 * something concrete to refuse, rather than being excluded by the type system
 * and silently unreachable at runtime.
 */
export type ContinuousExecutionMode = 'local-only' | 'cloud' | 'hybrid';

/**
 * At least one field must be non-null. A bound where both are null is exactly
 * "runs forever", and is refused at every layer.
 */
export interface ContinuousActivationBound {
  notAfter: string | null;
  maxIterations: number | null;
}

export interface ContinuousActivationRequest {
  /** A continuous run is exactly `once === false`. */
  once: boolean;
  dryRun?: boolean;
  drain?: unknown;
  drainLimit?: number;
  execution: ContinuousExecutionMode;
  repos: readonly string[];
  bound: ContinuousActivationBound | null;
  automerge?: boolean;
}

export interface ContinuousActivationScope {
  action: 'daemon-continuous-bounded-local';
  continuous: true;
  once: false;
  dryRun: false;
  execution: 'local-only';
  allowCloud: false;
  allowAnyRepo: false;
  bound: ContinuousActivationBound;
  repos: string[];
  /** The owner has authorized auto-merge with himself out of the loop. */
  automerge: boolean;
  proposalOnly: boolean;
  repair: false;
  deploy: false;
  install: false;
  selfTarget: false;
  drain: false;
  drainLimit: null;
}

export type ContinuousActivationShapeRefusal =
  | 'continuous-activation-requires-resident-shape'
  | 'continuous-activation-refuses-dry-run-shape'
  | 'continuous-activation-refuses-drain-shape'
  | 'continuous-activation-refuses-nonlocal-execution'
  | 'continuous-activation-requires-explicit-bound'
  | 'continuous-activation-invalid-bound'
  | 'continuous-activation-bound-exceeds-ceiling'
  | 'continuous-activation-bound-already-elapsed'
  | 'continuous-activation-requires-enrolled-repos'
  | 'continuous-activation-too-many-repos'
  | 'continuous-activation-invalid-repo-path'
  | 'continuous-activation-repo-not-enrolled';

export type ContinuousActivationShapeResult =
  | { ok: true; scope: ContinuousActivationScope }
  | { ok: false; reason: ContinuousActivationShapeRefusal };

export interface ContinuousActivationRuntimeContext extends DaemonActivationRuntimeContext {
  enrolledRepos: readonly string[];
}

export interface ContinuousActivationPermitPayload {
  schemaVersion: 1;
  policyVersion: typeof CONTINUOUS_ACTIVATION_POLICY_VERSION;
  permitId: string;
  nonce: string;
  keyId: string;
  issuedAt: string;
  expiresAt: string;
  scope: ContinuousActivationScope;
  bindings: DaemonActivationPermitPayload['bindings'] & {
    enrollmentDigest: string;
  };
}

export interface ContinuousActivationPermitEnvelope {
  payload: ContinuousActivationPermitPayload;
  signature: string;
}

export interface ContinuousActivationPermitResult {
  authorized: boolean;
  required: boolean;
  reason: string;
  permitId?: string;
  receiptPath?: string;
  capability?: ContinuousActivationCapability;
  configSnapshot?: AshlrConfig;
}

export interface ContinuousActivationReadiness {
  schemaVersion: 1;
  policyVersion: typeof CONTINUOUS_ACTIVATION_POLICY_VERSION;
  authority: 'observation-only';
  sourceState: 'healthy' | 'degraded';
  state: 'ready' | 'blocked' | 'degraded';
  commandEligible: boolean;
  requestedShape: 'continuous-bounded-local';
  trustRootCount: number;
  bound: ContinuousActivationBound | null;
  reason: string;
}

export interface ContinuousActivationTestConsumerOptions {
  trustRoots: readonly DaemonActivationTrustRoot[];
  context: ContinuousActivationRuntimeContext;
  afterReceiptPersisted?: () => void;
}

export interface ContinuousActivationTestInspectionOptions {
  trustRoots: readonly DaemonActivationTrustRoot[];
  context: ContinuousActivationRuntimeContext;
  platform?: NodeJS.Platform;
}

// ---------------------------------------------------------------------------
// Shape classification — the gate, before any I/O
// ---------------------------------------------------------------------------

function canonicalRepoPath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && isAbsolute(value)
    && resolve(value) === value;
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Refusals that do not need to know which repositories are enrolled. Split out
 * so an unbounded or cloud-touching request is refused before this process
 * touches the enrollment registry at all.
 */
function classifyContinuousRequestShape(
  request: ContinuousActivationRequest,
  nowMs: number,
): { ok: true; bound: ContinuousActivationBound } | { ok: false; reason: ContinuousActivationShapeRefusal } {
  if (request.once !== false) {
    return { ok: false, reason: 'continuous-activation-requires-resident-shape' };
  }
  if (request.dryRun === true) {
    return { ok: false, reason: 'continuous-activation-refuses-dry-run-shape' };
  }
  if (request.drain !== undefined || request.drainLimit !== undefined) {
    return { ok: false, reason: 'continuous-activation-refuses-drain-shape' };
  }
  if (request.execution !== 'local-only') {
    return { ok: false, reason: 'continuous-activation-refuses-nonlocal-execution' };
  }

  const bound = request.bound;
  if (!daemonActivationIsRecord(bound)
    || !daemonActivationHasExactKeys(bound, ['notAfter', 'maxIterations'])) {
    return { ok: false, reason: 'continuous-activation-requires-explicit-bound' };
  }
  const notAfter = (bound as ContinuousActivationBound).notAfter;
  const maxIterations = (bound as ContinuousActivationBound).maxIterations;
  if (notAfter === null && maxIterations === null) {
    return { ok: false, reason: 'continuous-activation-requires-explicit-bound' };
  }
  if (notAfter !== null) {
    if (typeof notAfter !== 'string') {
      return { ok: false, reason: 'continuous-activation-invalid-bound' };
    }
    const parsed = Date.parse(notAfter);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== notAfter) {
      return { ok: false, reason: 'continuous-activation-invalid-bound' };
    }
    if (parsed - nowMs > CONTINUOUS_ACTIVATION_MAX_WALL_MS) {
      return { ok: false, reason: 'continuous-activation-bound-exceeds-ceiling' };
    }
    if (parsed <= nowMs) {
      return { ok: false, reason: 'continuous-activation-bound-already-elapsed' };
    }
  }
  if (maxIterations !== null) {
    if (typeof maxIterations !== 'number' || !positiveInteger(maxIterations)) {
      return { ok: false, reason: 'continuous-activation-invalid-bound' };
    }
    if (maxIterations > CONTINUOUS_ACTIVATION_MAX_ITERATIONS) {
      return { ok: false, reason: 'continuous-activation-bound-exceeds-ceiling' };
    }
  }
  return { ok: true, bound: { notAfter, maxIterations } };
}

/**
 * Classify a continuous request against the enrolled repository set. The only
 * `ok: true` result is a bounded, local-only run over already-enrolled repos.
 */
export function classifyContinuousActivationShape(
  request: ContinuousActivationRequest,
  env: { nowMs: number; enrolledRepos: readonly string[] },
): ContinuousActivationShapeResult {
  const shape = classifyContinuousRequestShape(request, env.nowMs);
  if (!shape.ok) return shape;

  const requested = request.repos;
  if (!Array.isArray(requested) || requested.length === 0) {
    return { ok: false, reason: 'continuous-activation-requires-enrolled-repos' };
  }
  if (requested.length > CONTINUOUS_ACTIVATION_MAX_REPOS) {
    return { ok: false, reason: 'continuous-activation-too-many-repos' };
  }
  for (const repo of requested) {
    if (!canonicalRepoPath(repo)) {
      return { ok: false, reason: 'continuous-activation-invalid-repo-path' };
    }
  }
  const enrolled = new Set(env.enrolledRepos);
  for (const repo of requested) {
    if (!enrolled.has(repo)) {
      return { ok: false, reason: 'continuous-activation-repo-not-enrolled' };
    }
  }

  const repos = [...new Set(requested)].sort();
  const automerge = request.automerge === true;
  return {
    ok: true,
    scope: {
      action: 'daemon-continuous-bounded-local',
      continuous: true,
      once: false,
      dryRun: false,
      execution: 'local-only',
      allowCloud: false,
      allowAnyRepo: false,
      bound: { ...shape.bound },
      repos,
      automerge,
      proposalOnly: !automerge,
      repair: false,
      deploy: false,
      install: false,
      selfTarget: false,
      drain: false,
      drainLimit: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Payload schema — an unbounded permit has no valid representation
// ---------------------------------------------------------------------------

export function continuousActivationEnrollmentDigest(repos: readonly string[]): string {
  return daemonActivationSha256(
    canonicalizeDaemonActivationValue([...new Set(repos)].sort()),
  );
}

function validContinuousBound(value: unknown): value is ContinuousActivationBound {
  if (!daemonActivationIsRecord(value)
    || !daemonActivationHasExactKeys(value, ['notAfter', 'maxIterations'])) return false;
  const notAfter = value['notAfter'];
  const maxIterations = value['maxIterations'];
  if (notAfter === null && maxIterations === null) return false;
  if (notAfter !== null) {
    if (typeof notAfter !== 'string') return false;
    const parsed = Date.parse(notAfter);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== notAfter) return false;
  }
  if (maxIterations !== null) {
    if (typeof maxIterations !== 'number'
      || !positiveInteger(maxIterations)
      || maxIterations > CONTINUOUS_ACTIVATION_MAX_ITERATIONS) return false;
  }
  return true;
}

function validContinuousScope(value: unknown): value is ContinuousActivationScope {
  if (!daemonActivationIsRecord(value) || !daemonActivationHasExactKeys(value, [
    'action', 'continuous', 'once', 'dryRun', 'execution', 'allowCloud',
    'allowAnyRepo', 'bound', 'repos', 'automerge', 'proposalOnly', 'repair',
    'deploy', 'install', 'selfTarget', 'drain', 'drainLimit',
  ])) return false;
  if (value['action'] !== 'daemon-continuous-bounded-local'
    || value['continuous'] !== true
    || value['once'] !== false
    || value['dryRun'] !== false
    || value['execution'] !== 'local-only'
    || value['allowCloud'] !== false
    || value['allowAnyRepo'] !== false
    || value['repair'] !== false
    || value['deploy'] !== false
    || value['install'] !== false
    || value['selfTarget'] !== false
    || value['drain'] !== false
    || value['drainLimit'] !== null) return false;
  if (typeof value['automerge'] !== 'boolean'
    || value['proposalOnly'] !== !value['automerge']) return false;
  if (!validContinuousBound(value['bound'])) return false;

  const repos = value['repos'];
  if (!Array.isArray(repos)
    || repos.length === 0
    || repos.length > CONTINUOUS_ACTIVATION_MAX_REPOS) return false;
  let previous: string | null = null;
  for (const repo of repos) {
    if (!canonicalRepoPath(repo)) return false;
    if (previous !== null && repo <= previous) return false;
    previous = repo;
  }
  return true;
}

function parseContinuousPayload(value: unknown): ContinuousActivationPermitPayload | null {
  if (!daemonActivationIsRecord(value) || !daemonActivationHasExactKeys(value, [
    'schemaVersion', 'policyVersion', 'permitId', 'nonce', 'keyId',
    'issuedAt', 'expiresAt', 'scope', 'bindings',
  ])) return null;
  if (value['schemaVersion'] !== 1
    || value['policyVersion'] !== CONTINUOUS_ACTIVATION_POLICY_VERSION
    || typeof value['permitId'] !== 'string'
    || !DAEMON_ACTIVATION_ID_RE.test(value['permitId'])
    || typeof value['nonce'] !== 'string'
    || !DAEMON_ACTIVATION_DIGEST_RE.test(value['nonce'])
    || typeof value['keyId'] !== 'string'
    || !DAEMON_ACTIVATION_KEY_ID_RE.test(value['keyId'])
    || !validIsoTimestamp(value['issuedAt'])
    || !validIsoTimestamp(value['expiresAt'])
    || !validContinuousScope(value['scope'])) return null;

  const bindings = value['bindings'];
  if (!daemonActivationIsRecord(bindings) || !daemonActivationHasExactKeys(bindings, [
    'configDigest', 'buildIdentity', 'executable', 'entrypoint', 'releaseTree',
    'authorityStateDigest', 'killSwitch', 'guardHealth', 'enrollmentDigest',
  ])) return null;
  if (!DAEMON_ACTIVATION_DIGEST_RE.test(String(bindings['enrollmentDigest']))) return null;
  if (!validDaemonActivationBindings({
    configDigest: bindings['configDigest'],
    buildIdentity: bindings['buildIdentity'],
    executable: bindings['executable'],
    entrypoint: bindings['entrypoint'],
    releaseTree: bindings['releaseTree'],
    authorityStateDigest: bindings['authorityStateDigest'],
    killSwitch: bindings['killSwitch'],
    guardHealth: bindings['guardHealth'],
  })) return null;
  return value as unknown as ContinuousActivationPermitPayload;
}

function validIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function parseContinuousActivationPermitEnvelope(
  value: unknown,
): ContinuousActivationPermitEnvelope | null {
  if (!daemonActivationIsRecord(value)
    || !daemonActivationHasExactKeys(value, ['payload', 'signature'])) return null;
  const payload = parseContinuousPayload(value['payload']);
  if (!payload || typeof value['signature'] !== 'string') return null;
  let signature: Buffer;
  try {
    signature = Buffer.from(value['signature'], 'base64');
  } catch {
    return null;
  }
  if (signature.length !== 64 || signature.toString('base64') !== value['signature']) return null;
  return { payload, signature: value['signature'] };
}

function continuousSigningBytes(payload: ContinuousActivationPermitPayload): Buffer {
  return Buffer.from(
    `${CONTINUOUS_SIGNING_DOMAIN}${canonicalizeDaemonActivationValue(payload)}`,
    'utf8',
  );
}

export function buildContinuousActivationPermitPayload(input: {
  permitId: string;
  nonce: string;
  keyId: string;
  issuedAt: string;
  expiresAt: string;
  scope: ContinuousActivationScope;
  context: ContinuousActivationRuntimeContext;
}): ContinuousActivationPermitPayload {
  const payload: ContinuousActivationPermitPayload = {
    schemaVersion: 1,
    policyVersion: CONTINUOUS_ACTIVATION_POLICY_VERSION,
    permitId: input.permitId,
    nonce: input.nonce,
    keyId: input.keyId,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    scope: {
      ...input.scope,
      bound: { ...input.scope.bound },
      repos: [...input.scope.repos],
    },
    bindings: {
      configDigest: input.context.configDigest,
      buildIdentity: { ...input.context.buildIdentity },
      executable: { ...input.context.executable },
      entrypoint: { ...input.context.entrypoint },
      releaseTree: { ...input.context.releaseTree },
      authorityStateDigest: input.context.authorityStateDigest,
      killSwitch: 'off',
      guardHealth: 'healthy',
      enrollmentDigest: continuousActivationEnrollmentDigest(input.context.enrolledRepos),
    },
  };
  if (!parseContinuousPayload(payload)) {
    throw new Error('invalid continuous activation permit payload input');
  }
  return payload;
}

export function signContinuousActivationPermit(
  payload: ContinuousActivationPermitPayload,
  privateKey: string | KeyObject,
): ContinuousActivationPermitEnvelope {
  if (!parseContinuousPayload(payload)) {
    throw new Error('invalid continuous activation permit payload');
  }
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('continuous activation permits require an Ed25519 private key');
  }
  return {
    payload,
    signature: sign(null, continuousSigningBytes(payload), key).toString('base64'),
  };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function validContinuousContext(context: ContinuousActivationRuntimeContext): boolean {
  if (!validDaemonActivationRuntimeContext(context)) return false;
  if (!Array.isArray(context.enrolledRepos)) return false;
  return context.enrolledRepos.every((repo) => canonicalRepoPath(repo));
}

export function verifyContinuousActivationPermit(
  value: unknown,
  context: ContinuousActivationRuntimeContext,
  trustRoots: readonly DaemonActivationTrustRoot[],
): DaemonActivationPermitVerification {
  if (trustRoots.length === 0) {
    return { ok: false, reason: 'no-trusted-continuous-activation-roots' };
  }
  const envelope = parseContinuousActivationPermitEnvelope(value);
  if (!envelope) return { ok: false, reason: 'invalid-continuous-permit-schema' };
  if (!validContinuousContext(context)) {
    return { ok: false, reason: 'invalid-runtime-continuous-context' };
  }

  const issuedAt = Date.parse(envelope.payload.issuedAt);
  const expiresAt = Date.parse(envelope.payload.expiresAt);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > DAEMON_ACTIVATION_MAX_VALIDITY_MS) {
    return { ok: false, reason: 'invalid-continuous-permit-validity-window' };
  }
  if (issuedAt > context.nowMs + DAEMON_ACTIVATION_MAX_FUTURE_SKEW_MS) {
    return { ok: false, reason: 'permit-issued-too-far-in-future' };
  }
  if (expiresAt <= context.nowMs) return { ok: false, reason: 'permit-expired' };
  if (!context.killSwitchOff) return { ok: false, reason: 'kill-switch-is-on' };
  if (!context.guardHealthHealthy) return { ok: false, reason: 'guard-health-degraded' };

  // The bound, re-checked against the moment of issue. A permit whose deadline
  // outlives the ceiling is refused even with a valid signature.
  const bound = envelope.payload.scope.bound;
  if (bound.notAfter !== null) {
    const notAfter = Date.parse(bound.notAfter);
    if (notAfter - issuedAt > CONTINUOUS_ACTIVATION_MAX_WALL_MS) {
      return { ok: false, reason: 'continuous-permit-bound-exceeds-ceiling' };
    }
    if (notAfter <= context.nowMs) {
      return { ok: false, reason: 'continuous-permit-bound-already-elapsed' };
    }
  }

  // Enrolment is checked before the binding digest so a repo that has since
  // been un-enrolled reports the precise reason rather than a generic mismatch.
  const enrolled = new Set(context.enrolledRepos);
  for (const repo of envelope.payload.scope.repos) {
    if (!enrolled.has(repo)) {
      return { ok: false, reason: 'continuous-permit-repo-not-enrolled' };
    }
  }

  const expectedBindings: ContinuousActivationPermitPayload['bindings'] = {
    configDigest: context.configDigest,
    buildIdentity: context.buildIdentity,
    executable: context.executable,
    entrypoint: context.entrypoint,
    releaseTree: context.releaseTree,
    authorityStateDigest: context.authorityStateDigest,
    killSwitch: 'off',
    guardHealth: 'healthy',
    enrollmentDigest: continuousActivationEnrollmentDigest(context.enrolledRepos),
  };
  if (!daemonActivationEqualCanonical(envelope.payload.bindings, expectedBindings)) {
    return { ok: false, reason: 'continuous-permit-runtime-binding-mismatch' };
  }

  const trusted = daemonActivationTrustRootMap(trustRoots);
  if (!trusted) return { ok: false, reason: 'invalid-trust-root-set' };
  const publicKey = trusted.get(envelope.payload.keyId);
  if (!publicKey) return { ok: false, reason: 'permit-key-not-trusted' };
  let signature: Buffer;
  try {
    signature = Buffer.from(envelope.signature, 'base64');
  } catch {
    return { ok: false, reason: 'invalid-permit-signature' };
  }
  if (!verify(null, continuousSigningBytes(envelope.payload), publicKey, signature)) {
    return { ok: false, reason: 'invalid-permit-signature' };
  }
  return {
    ok: true,
    reason: 'valid-continuous-bounded-local-permit',
    permitId: envelope.payload.permitId,
    payloadDigest: daemonActivationSha256(
      canonicalizeDaemonActivationValue(envelope.payload),
    ),
  };
}

// ---------------------------------------------------------------------------
// The run budget — where a signed bound becomes an enforced one
// ---------------------------------------------------------------------------

export type ContinuousIterationClaim =
  | { ok: true; remainingIterations: number | null; msRemaining: number | null }
  | {
      ok: false;
      reason:
        | 'continuous-capability-not-recognized'
        | 'continuous-capability-revoked'
        | 'continuous-bound-deadline-passed'
        | 'continuous-bound-iterations-exhausted';
    };

interface BudgetState {
  deadlineMs: number | null;
  remainingIterations: number | null;
  revoked: boolean;
  revalidate: () => boolean;
}

const budgetBrand: unique symbol = Symbol('ashlr.continuous-run-budget');

export interface ContinuousRunBudget {
  readonly bound: Readonly<ContinuousActivationBound>;
  readonly [budgetBrand]: true;
}

const budgets = new WeakMap<object, BudgetState>();

/**
 * A signed bound only means something if something enforces it. This is that
 * something: it counts down, it trips on the deadline, and it fails closed the
 * moment the permit stops revalidating (kill switch, guard health, a changed
 * release tree). Once a budget trips it stays tripped.
 */
export function createContinuousRunBudget(
  bound: ContinuousActivationBound,
  options: { revalidate?: () => boolean } = {},
): ContinuousRunBudget {
  if (!validContinuousBound(bound)) {
    throw new Error('a continuous run budget requires an explicit bound');
  }
  const budget = Object.freeze({
    bound: Object.freeze({ ...bound }),
    [budgetBrand]: true as const,
  });
  budgets.set(budget, {
    deadlineMs: bound.notAfter === null ? null : Date.parse(bound.notAfter),
    remainingIterations: bound.maxIterations,
    revoked: false,
    revalidate: options.revalidate ?? ((): boolean => true),
  });
  return budget;
}

function claimFromState(state: BudgetState, nowMs: number): ContinuousIterationClaim {
  if (state.revoked) return { ok: false, reason: 'continuous-capability-revoked' };
  let healthy: boolean;
  try {
    healthy = state.revalidate();
  } catch {
    healthy = false;
  }
  if (!healthy) {
    state.revoked = true;
    return { ok: false, reason: 'continuous-capability-revoked' };
  }
  if (state.deadlineMs !== null && nowMs >= state.deadlineMs) {
    state.revoked = true;
    return { ok: false, reason: 'continuous-bound-deadline-passed' };
  }
  if (state.remainingIterations !== null && state.remainingIterations <= 0) {
    state.revoked = true;
    return { ok: false, reason: 'continuous-bound-iterations-exhausted' };
  }
  if (state.remainingIterations !== null) state.remainingIterations -= 1;
  return {
    ok: true,
    remainingIterations: state.remainingIterations,
    msRemaining: state.deadlineMs === null ? null : state.deadlineMs - nowMs,
  };
}

/** Claim one iteration against a budget. Unrecognised objects are refused. */
export function claimContinuousRunIteration(
  value: unknown,
  nowMs: number,
): ContinuousIterationClaim {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, reason: 'continuous-capability-not-recognized' };
  }
  const state = budgets.get(value);
  if (!state) return { ok: false, reason: 'continuous-capability-not-recognized' };
  return claimFromState(state, nowMs);
}

export function continuousRunBudgetExhausted(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  const state = budgets.get(value);
  return state ? state.revoked : true;
}

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

const capabilityBrand: unique symbol = Symbol('ashlr.continuous-activation-capability');

export interface ContinuousActivationCapability {
  readonly kind: 'continuous-bounded-local';
  readonly permitId: string;
  readonly bound: Readonly<ContinuousActivationBound>;
  readonly repos: readonly string[];
  readonly automerge: boolean;
  readonly budget: ContinuousRunBudget;
  readonly [capabilityBrand]: true;
}

const validCapabilities = new WeakSet<object>();

function mintContinuousCapability(
  permitId: string,
  scope: ContinuousActivationScope,
  revalidate: () => boolean,
): ContinuousActivationCapability {
  const capability = Object.freeze({
    kind: 'continuous-bounded-local' as const,
    permitId,
    bound: Object.freeze({ ...scope.bound }),
    repos: Object.freeze([...scope.repos]),
    automerge: scope.automerge,
    budget: createContinuousRunBudget(scope.bound, { revalidate }),
    [capabilityBrand]: true as const,
  });
  validCapabilities.add(capability);
  return capability;
}

/**
 * Nominal, process-local authority. An object that merely matches the public
 * shape is rejected. Unlike the one-shot M461 capability this is not consumed
 * on first inspection — a continuous run is bounded by its budget, not by a
 * single use — but it does go dead as soon as that budget trips.
 */
export function isContinuousActivationCapability(
  value: unknown,
): value is ContinuousActivationCapability {
  if (typeof value !== 'object' || value === null) return false;
  if (!validCapabilities.has(value)) return false;
  return !continuousRunBudgetExhausted((value as ContinuousActivationCapability).budget);
}

/** Claim one iteration against a capability's bound. */
export function claimContinuousActivationIteration(
  value: unknown,
  nowMs: number,
): ContinuousIterationClaim {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, reason: 'continuous-capability-not-recognized' };
  }
  if (!validCapabilities.has(value)) {
    return { ok: false, reason: 'continuous-capability-not-recognized' };
  }
  return claimContinuousRunIteration(
    (value as ContinuousActivationCapability).budget,
    nowMs,
  );
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function continuousActivationPermitPath(): string {
  return join(homedir(), '.ashlr', 'control', 'continuous-activation-permit.json');
}

export function continuousActivationReceiptPath(permitId: string): string {
  if (!DAEMON_ACTIVATION_ID_RE.test(permitId)) {
    throw new Error('invalid continuous activation permit id');
  }
  return join(
    homedir(), '.ashlr', 'control', 'activation-receipts', 'continuous', `${permitId}.json`,
  );
}

function continuousActivationNonceReceiptPath(nonceDigest: string): string {
  if (!DAEMON_ACTIVATION_DIGEST_RE.test(nonceDigest)) {
    throw new Error('invalid continuous activation nonce digest');
  }
  return join(
    homedir(), '.ashlr', 'control', 'activation-receipts', 'continuous',
    'by-nonce', `${nonceDigest}.json`,
  );
}

// ---------------------------------------------------------------------------
// Inspection and consumption
// ---------------------------------------------------------------------------

function readiness(
  state: ContinuousActivationReadiness['state'],
  reason: string,
  trustRootCount: number,
  bound: ContinuousActivationBound | null = null,
): ContinuousActivationReadiness {
  return {
    schemaVersion: 1,
    policyVersion: CONTINUOUS_ACTIVATION_POLICY_VERSION,
    authority: 'observation-only',
    sourceState: state === 'degraded' ? 'degraded' : 'healthy',
    state,
    commandEligible: state === 'ready',
    requestedShape: 'continuous-bounded-local',
    trustRootCount,
    bound,
    reason,
  };
}

/**
 * Enrolment comes from the registry, never from the request or the config. A
 * degraded registry is a refusal, not an empty allow-list.
 */
function enrolledReposOrRefusal(): { ok: true; repos: string[] } | { ok: false; reason: string } {
  let snapshot: ReturnType<typeof readEnrollmentRegistry>;
  try {
    snapshot = readEnrollmentRegistry();
  } catch {
    return { ok: false, reason: 'continuous-activation-enrollment-source-unreadable' };
  }
  if (snapshot.state !== 'ready') {
    return { ok: false, reason: 'continuous-activation-enrollment-source-degraded' };
  }
  return { ok: true, repos: [...snapshot.repos] };
}

function classifyForRuntime(
  request: ContinuousActivationRequest,
  nowMs: number,
  suppliedContext: ContinuousActivationRuntimeContext | undefined,
): ContinuousActivationShapeResult | { ok: false; reason: string } {
  // Shape refusals that need no enrolment answer come first, so an unbounded
  // or cloud-touching request never reaches the registry at all.
  const shape = classifyContinuousRequestShape(request, nowMs);
  if (!shape.ok) return shape;
  if (suppliedContext) {
    return classifyContinuousActivationShape(request, {
      nowMs,
      enrolledRepos: suppliedContext.enrolledRepos,
    });
  }
  const enrolled = enrolledReposOrRefusal();
  if (!enrolled.ok) return enrolled;
  return classifyContinuousActivationShape(request, { nowMs, enrolledRepos: enrolled.repos });
}

function inspectWithAuthority(
  cfg: AshlrConfig,
  request: ContinuousActivationRequest,
  trustRoots: readonly DaemonActivationTrustRoot[],
  suppliedContext: ContinuousActivationRuntimeContext | undefined,
  platform: NodeJS.Platform = process.platform,
): ContinuousActivationReadiness {
  const nowMs = suppliedContext?.nowMs ?? Date.now();
  const classified = classifyForRuntime(request, nowMs, suppliedContext);
  if (!classified.ok) return readiness('blocked', classified.reason, trustRoots.length);
  const scope = classified.scope;

  if (trustRoots.length === 0) {
    return readiness('blocked', 'no-trusted-continuous-activation-roots', 0, scope.bound);
  }
  if (platform === 'win32') {
    return readiness(
      'blocked',
      'continuous-activation-v1-unsupported-on-windows',
      trustRoots.length,
      scope.bound,
    );
  }

  let configSnapshot: AshlrConfig;
  try {
    configSnapshot = daemonActivationStrictConfigSnapshot(cfg);
  } catch {
    return readiness(
      'degraded', 'activation-config-not-strict-json', trustRoots.length, scope.bound,
    );
  }

  const permitPath = continuousActivationPermitPath();
  // Reported separately only so an absent permit reads as absent rather than as
  // a generic failure. The authoritative check is still the pinned open below.
  if (!daemonActivationPathEntryPresent(permitPath)) {
    return readiness(
      'blocked', 'continuous-activation-permit-missing', trustRoots.length, scope.bound,
    );
  }
  let pinned: DaemonActivationPinnedFile | undefined;
  let result: ContinuousActivationReadiness;
  try {
    pinned = openDaemonActivationPinnedFile(permitPath, resolve(homedir()));
    result = inspectPinned(pinned, permitPath, configSnapshot, scope, trustRoots, suppliedContext);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    result = readiness(
      missing ? 'blocked' : 'degraded',
      missing ? 'continuous-activation-permit-missing' : 'continuous-activation-inspection-failed',
      trustRoots.length,
      scope.bound,
    );
  }
  if (pinned) {
    try {
      closeSync(pinned.fd);
    } catch {
      return readiness(
        'degraded', 'continuous-activation-permit-close-failed', trustRoots.length, scope.bound,
      );
    }
  }
  return result;
}

function inspectPinned(
  pinned: DaemonActivationPinnedFile,
  permitPath: string,
  configSnapshot: AshlrConfig,
  scope: ContinuousActivationScope,
  trustRoots: readonly DaemonActivationTrustRoot[],
  suppliedContext: ContinuousActivationRuntimeContext | undefined,
): ContinuousActivationReadiness {
  let envelope: unknown;
  try {
    envelope = JSON.parse(pinned.text) as unknown;
  } catch {
    return readiness('degraded', 'invalid-permit-json', trustRoots.length, scope.bound);
  }
  if (`${canonicalizeDaemonActivationValue(envelope)}\n` !== pinned.text) {
    return readiness(
      'degraded', 'noncanonical-permit-encoding', trustRoots.length, scope.bound,
    );
  }
  const parsed = parseContinuousActivationPermitEnvelope(envelope);
  if (!parsed) {
    return readiness(
      'degraded', 'invalid-continuous-permit-schema', trustRoots.length, scope.bound,
    );
  }
  const context = suppliedContext ?? collectContinuousRuntimeContext(configSnapshot);
  if (context.configDigest !== daemonActivationConfigDigest(configSnapshot)) {
    return readiness(
      'blocked', 'runtime-config-digest-mismatch', trustRoots.length, scope.bound,
    );
  }
  // The permit must authorize the run that was actually requested.
  if (!daemonActivationEqualCanonical(parsed.payload.scope, scope)) {
    return readiness(
      'blocked', 'continuous-permit-scope-mismatch', trustRoots.length, scope.bound,
    );
  }
  const verification = verifyContinuousActivationPermit(parsed, context, trustRoots);
  if (!verification.ok || !verification.permitId) {
    return readiness('blocked', verification.reason, trustRoots.length, scope.bound);
  }
  const nonceDigest = daemonActivationSha256(parsed.payload.nonce);
  if (daemonActivationPathEntryPresent(continuousActivationReceiptPath(verification.permitId))
    || daemonActivationPathEntryPresent(continuousActivationNonceReceiptPath(nonceDigest))) {
    return readiness(
      'blocked', 'continuous-activation-permit-already-consumed', trustRoots.length, scope.bound,
    );
  }
  const openedAfter = fstatSync(pinned.fd, { bigint: true });
  const namedAfter = lstatSync(permitPath, { bigint: true });
  if (!daemonActivationSameFileSnapshot(pinned.stat, openedAfter)
    || !daemonActivationSameFileSnapshot(openedAfter, namedAfter)) {
    return readiness(
      'degraded',
      'continuous-activation-permit-changed-during-inspection',
      trustRoots.length,
      scope.bound,
    );
  }
  return readiness(
    'ready', 'valid-continuous-bounded-local-permit', trustRoots.length, scope.bound,
  );
}

/** Collect the read-only runtime binding used at permit consumption. */
export function collectContinuousRuntimeContext(
  cfg: AshlrConfig,
): ContinuousActivationRuntimeContext {
  const enrolled = enrolledReposOrRefusal();
  if (!enrolled.ok) throw new Error(enrolled.reason);
  return {
    ...collectDaemonActivationRuntimeContext(daemonActivationStrictConfigSnapshot(cfg)),
    enrolledRepos: enrolled.repos,
  };
}

function refusal(reason: string): ContinuousActivationPermitResult {
  return { authorized: false, required: true, reason };
}

function consumeWithAuthority(
  cfg: AshlrConfig,
  request: ContinuousActivationRequest,
  trustRoots: readonly DaemonActivationTrustRoot[],
  suppliedContext: ContinuousActivationRuntimeContext | undefined,
  afterReceiptPersisted: (() => void) | undefined,
  mayMintCapability: boolean,
): ContinuousActivationPermitResult {
  const nowMs = suppliedContext?.nowMs ?? Date.now();
  const classified = classifyForRuntime(request, nowMs, suppliedContext);
  if (!classified.ok) return refusal(classified.reason);
  const scope = classified.scope;

  if (trustRoots.length === 0) return refusal('no-trusted-continuous-activation-roots');
  if (process.platform === 'win32') {
    return refusal('continuous-activation-v1-unsupported-on-windows');
  }

  let configSnapshot: AshlrConfig;
  try {
    configSnapshot = daemonActivationStrictConfigSnapshot(cfg);
  } catch {
    return refusal('activation-config-not-strict-json');
  }

  const home = resolve(homedir());
  const permitPath = continuousActivationPermitPath();
  // Reported separately only so an absent permit reads as absent rather than as
  // a generic failure. The authoritative check is still the pinned open below,
  // taken under the lock.
  try {
    if (!daemonActivationPathEntryPresent(permitPath)) {
      return refusal('continuous-activation-permit-missing');
    }
  } catch {
    return refusal('continuous-activation-permit-consumption-failed');
  }
  const lock = acquireLocalStoreLock(`${permitPath}.lock`, DAEMON_ACTIVATION_LOCK_WAIT_MS, {
    anchorPath: home,
    exactPrivateStorage: true,
  });
  if (!lock) return refusal('continuous-activation-permit-lock-unavailable');

  let pinned: DaemonActivationPinnedFile | undefined;
  let result: ContinuousActivationPermitResult = refusal(
    'continuous-activation-permit-consumption-failed',
  );
  try {
    pinned = openDaemonActivationPinnedFile(permitPath, home);
    let envelope: unknown;
    try {
      envelope = JSON.parse(pinned.text) as unknown;
    } catch {
      result = refusal('invalid-permit-json');
      return result;
    }
    if (`${canonicalizeDaemonActivationValue(envelope)}\n` !== pinned.text) {
      result = refusal('noncanonical-permit-encoding');
      return result;
    }
    const parsed = parseContinuousActivationPermitEnvelope(envelope);
    if (!parsed) {
      result = refusal('invalid-continuous-permit-schema');
      return result;
    }
    const context = suppliedContext ?? collectContinuousRuntimeContext(configSnapshot);
    if (context.configDigest !== daemonActivationConfigDigest(configSnapshot)) {
      result = refusal('runtime-config-digest-mismatch');
      return result;
    }
    if (!daemonActivationEqualCanonical(parsed.payload.scope, scope)) {
      result = refusal('continuous-permit-scope-mismatch');
      return result;
    }
    const verification = verifyContinuousActivationPermit(parsed, context, trustRoots);
    if (!verification.ok || !verification.permitId || !verification.payloadDigest) {
      result = refusal(verification.reason);
      return result;
    }

    const receiptPath = continuousActivationReceiptPath(verification.permitId);
    assureDaemonActivationPrivateDirectory(dirname(dirname(receiptPath)), home);
    assureDaemonActivationPrivateDirectory(dirname(receiptPath), home);
    const nonceDigest = daemonActivationSha256(parsed.payload.nonce);
    const nonceReceiptPath = continuousActivationNonceReceiptPath(nonceDigest);
    assureDaemonActivationPrivateDirectory(dirname(nonceReceiptPath), home);
    const receipt = {
      schemaVersion: 1,
      state: 'consumed-before-permit-unlink',
      action: 'daemon-continuous-bounded-local',
      permitId: verification.permitId,
      keyId: parsed.payload.keyId,
      payloadDigest: verification.payloadDigest,
      nonceDigest,
      configDigest: context.configDigest,
      buildRevision: context.buildIdentity.revision,
      boundNotAfter: scope.bound.notAfter,
      boundMaxIterations: scope.bound.maxIterations,
      repos: [...scope.repos],
      automerge: scope.automerge,
      consumedAt: new Date(context.nowMs).toISOString(),
    };
    try {
      persistDaemonActivationReceipt(
        nonceReceiptPath, { ...receipt, index: 'nonce' }, home,
      );
      persistDaemonActivationReceipt(receiptPath, receipt, home);
    } catch (error) {
      result = {
        authorized: false,
        required: true,
        reason: (error as NodeJS.ErrnoException).code === 'EEXIST'
          ? 'continuous-activation-permit-already-consumed'
          : 'continuous-activation-receipt-persistence-failed',
        permitId: verification.permitId,
        receiptPath,
      };
      return result;
    }

    try {
      afterReceiptPersisted?.();
    } catch {
      result = {
        authorized: false,
        required: true,
        reason: 'continuous-activation-interrupted-after-durable-receipt',
        permitId: verification.permitId,
        receiptPath,
      };
      return result;
    }

    const openedAfterReceipt = fstatSync(pinned.fd, { bigint: true });
    const namedAfterReceipt = lstatSync(permitPath, { bigint: true });
    if (!daemonActivationSameFileSnapshot(pinned.stat, openedAfterReceipt)
      || !daemonActivationSameFileSnapshot(openedAfterReceipt, namedAfterReceipt)) {
      result = {
        authorized: false,
        required: true,
        reason: 'continuous-activation-permit-changed-before-unlink',
        permitId: verification.permitId,
        receiptPath,
      };
      return result;
    }
    unlinkSync(permitPath);
    fsyncDirectory(dirname(permitPath));

    result = {
      authorized: true,
      required: true,
      reason: 'continuous-bounded-local-activation-authorized',
      permitId: verification.permitId,
      receiptPath,
      ...(mayMintCapability
        ? {
            capability: mintContinuousCapability(verification.permitId, scope, () => {
              try {
                const claimContext = collectContinuousRuntimeContext(configSnapshot);
                return verifyContinuousActivationPermit(parsed, claimContext, trustRoots).ok;
              } catch {
                return false;
              }
            }),
            configSnapshot,
          }
        : {}),
    };
    return result;
  } catch (error) {
    result = refusal(
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'continuous-activation-permit-missing'
        : 'continuous-activation-permit-consumption-failed',
    );
    return result;
  } finally {
    if (pinned) {
      try {
        closeSync(pinned.fd);
      } catch {
        result.authorized = false;
        result.reason = 'continuous-activation-permit-close-failed';
        delete result.capability;
      }
    }
    if (!releaseLocalStoreLock(lock)) {
      result.authorized = false;
      result.reason = 'continuous-activation-permit-lock-release-failed';
      delete result.capability;
    }
  }
}

/**
 * Runtime entrypoint. The frozen, source-provisioned roots above are the only
 * path that can mint an in-process continuous activation capability.
 */
export function consumeContinuousActivationPermit(
  cfg: AshlrConfig,
  request: ContinuousActivationRequest,
): ContinuousActivationPermitResult {
  return consumeWithAuthority(
    cfg, request, CONTINUOUS_ACTIVATION_TRUST_ROOTS, undefined, undefined, true,
  );
}

/**
 * Read-only advisory inspection. A ready result is never authority: a start
 * must still reopen, revalidate, durably consume, and mint a capability.
 */
export function inspectContinuousActivationPermit(
  cfg: AshlrConfig,
  request: ContinuousActivationRequest,
): ContinuousActivationReadiness {
  return inspectWithAuthority(cfg, request, CONTINUOUS_ACTIVATION_TRUST_ROOTS, undefined);
}

/** Test-only inspection with injected roots/context; it cannot mint authority. */
export function inspectContinuousActivationPermitForVerification(
  cfg: AshlrConfig,
  request: ContinuousActivationRequest,
  options: ContinuousActivationTestInspectionOptions,
): ContinuousActivationReadiness {
  return inspectWithAuthority(
    cfg, request, options.trustRoots, options.context, options.platform,
  );
}

/**
 * Testable consumption path. It exercises signature, scope, replay, locking and
 * durability with injected roots, but deliberately cannot mint authority — the
 * same stance activation-permit.ts takes for its own verification entrypoint.
 */
export function consumeContinuousActivationPermitForVerification(
  cfg: AshlrConfig,
  request: ContinuousActivationRequest,
  options: ContinuousActivationTestConsumerOptions,
): ContinuousActivationPermitResult {
  return consumeWithAuthority(
    cfg, request, options.trustRoots, options.context, options.afterReceiptPersisted, false,
  );
}
