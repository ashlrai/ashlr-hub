import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { readBuildIdentity, type BuildIdentity } from '../build-identity.js';
import {
  acquireLocalStoreLock,
  releaseLocalStoreLock,
} from '../fleet/local-store-lock.js';
import { audit } from '../sandbox/audit.js';
import { killSwitchOn, readEnrollmentRegistry } from '../sandbox/policy.js';
import type { AshlrConfig } from '../types.js';
import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { diagnoseGuardHealth } from './guard-health.js';

/**
 * M461 → M470 daemon activation authority.
 *
 * The default for anyone who has not explicitly run `ashlr activation init`
 * is EXACTLY today's behavior: every guard denies, with the same reasons as
 * before. Authority only exists once an operator:
 *
 *   1. Runs `ashlr activation init` — generates an Ed25519 keypair on this
 *      machine (private key never leaves it) and registers the public half
 *      as a trust root in ~/.ashlr/activation/trust-roots.json (0600, dir
 *      0700, owned by the operator's uid — checked on every read).
 *   2. Runs `ashlr activation grant <scope...>` — signs and mints either a
 *      single-use activation PERMIT (scopes: once, resident) consumed by
 *      `daemon start`, or a standing, expiring GRANT (scopes: residentStanding,
 *      conductor, install, automerge, repair, deploy) checked on every call to
 *      the corresponding guard.
 *
 * `resident` is grantable BOTH ways, and both forms remain live:
 *   - one-shot `resident` permit: fixed 2-minute window, requires a human to
 *     run `grant` immediately before `daemon start`. Unusable after a reboot
 *     with nobody present.
 *   - standing `residentStanding` grant: up to the normal 30-day cap, checked
 *     at resident-daemon startup instead of requiring a fresh permit — this is
 *     what lets a launchd/systemd/Task-Scheduler-triggered restart authorize
 *     itself with no human in the loop. `daemon start` (resident mode) tries
 *     the standing grant first and falls back to the one-shot permit path
 *     unchanged, so an operator who never grants `residentStanding` sees
 *     EXACTLY today's one-shot-only behavior.
 *
 * Both permits and grants are Ed25519-signed, scoped, expiring, and
 * independently revocable (`ashlr activation revoke`). Every init / grant /
 * revoke / consume / denial writes an audit row via ../sandbox/audit.js so
 * an operator can answer "who activated this fleet, when, with what scope."
 *
 * Revocation of a standing grant is file-based: it stops the NEXT
 * authorization check, immediately. For `residentStanding` specifically it is
 * stronger than that — because standing grants are not single-use (unlike the
 * one-shot capability, which a resident loop must consume exactly once), a
 * resident daemon carries an opaque process-local tick capability and
 * re-checks the underlying standing grant on every tick, stopping at the
 * next one if the grant is revoked, expired, or its trust root is revoked —
 * not just at the next `daemon start`. It cannot interrupt a tick already in
 * flight.
 *
 * File loading fails CLOSED on every ambiguity: missing, unreadable, wrong
 * permissions, wrong owner, symlinked, malformed, or non-canonically
 * encoded trust-root/grant/permit files are all treated as "no authority" —
 * never as "trust everything." This holds on Windows too: node:fs chmod()
 * on Windows does not restrict per-user read access on NTFS (it only toggles
 * the read-only attribute), so the "operator-only" invariant is instead
 * enforced by ../util/private-storage.js's Windows adapter, which shells out
 * to PowerShell to apply and verify an exact current-user+SYSTEM protected
 * DACL (owner-only FullControl, inheritance disabled) and to reject reparse
 * points on the target AND on every ancestor up to the ~/.ashlr anchor —
 * the Windows analog of POSIX's 0600/0700 mode bits + O_NOFOLLOW, which have
 * no direct Windows equivalent (chmod doesn't restrict NTFS readers, and
 * Node's fs has no portable no-follow open flag on win32). Trust-root/grant/
 * permit stores and the once/resident permit path are validated this way on
 * both platforms; if the DACL adapter is unavailable or errors, every caller
 * fails closed with a distinct `<store>:<adapter-reason>` code — never a
 * silent pass. Goal-conductor proposal permits (`consumeGoalConductorWithAuthority`
 * below) remain Windows-denied for now — out of scope for this pass.
 */

const POLICY_VERSION = 'm461-proposal-once-v1';
const SIGNING_DOMAIN = 'ashlr:daemon-activation-permit:m461:v1\0';
const GRANT_SIGNING_DOMAIN = 'ashlr:daemon-activation-grant:v1\0';
const MAX_PERMIT_BYTES = 32 * 1024;
const MAX_VALIDITY_MS = 120_000;
const MAX_FUTURE_SKEW_MS = 30_000;
const LOCK_WAIT_MS = 2_000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DIGEST_RE = /^[a-f0-9]{64}$/u;
const ID_RE = /^[a-f0-9]{32}$/u;
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MAX_TRUST_STORE_BYTES = 256 * 1024;
const MAX_GRANTS_BYTES = 512 * 1024;
const MAX_LABEL_LENGTH = 200;
/** Hard cap on any standing grant's validity window (30 days). */
export const MAX_STANDING_GRANT_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;
/** Default TTL `ashlr activation grant` uses when --ttl is not given (24h). */
export const DEFAULT_STANDING_GRANT_VALIDITY_MS = 24 * 60 * 60 * 1000;

const capabilityBrand: unique symbol = Symbol('ashlr.daemon-activation-capability');
const residentTickCapabilityBrand: unique symbol = Symbol('ashlr.daemon-resident-tick-capability');

/** Every independently grantable scope key, in canonical order. Used by the CLI to validate `grant`/status output. */
export const DAEMON_ACTIVATION_SCOPE_KEYS = [
  'once',
  'resident',
  'residentStanding',
  'conductor',
  'automerge',
  'repair',
  'deploy',
  'install',
  'proposalOnly',
] as const;
const SCOPE_KEYS = DAEMON_ACTIVATION_SCOPE_KEYS;

export type DaemonActivationScopeKey = typeof SCOPE_KEYS[number];

/** A real, independently grantable capability set. Unknown fields are rejected. */
export type DaemonActivationGrantScope = { [K in DaemonActivationScopeKey]: boolean };

/** All-false scope — the base every CLI `grant` invocation flips bits on top of. */
export const EMPTY_DAEMON_ACTIVATION_SCOPE: DaemonActivationGrantScope = Object.freeze({
  once: false,
  resident: false,
  residentStanding: false,
  conductor: false,
  automerge: false,
  repair: false,
  deploy: false,
  install: false,
  proposalOnly: false,
});

/** Preserves pre-M470 test/caller behavior when `buildDaemonActivationPermitPayload` omits `scope`. */
const LEGACY_ONCE_PROPOSAL_SCOPE: DaemonActivationGrantScope = Object.freeze({
  ...EMPTY_DAEMON_ACTIVATION_SCOPE,
  once: true,
  proposalOnly: true,
});

/**
 * Runtime authority is nominal and process-local. Objects that merely match
 * this public shape are rejected by isDaemonActivationCapability(). `scope`
 * is readable without consuming the capability — only isDaemonActivationCapability()
 * consumes the single-use claim.
 */
export interface DaemonActivationCapability {
  readonly kind: 'proposal-once';
  readonly permitId: string;
  readonly scope: DaemonActivationGrantScope;
  readonly [capabilityBrand]: true;
}

/**
 * Opaque process-local authority carried by a verified daemon run into each
 * resident tick. The capability intentionally exposes neither its granted
 * scope nor a serializable claim: loop.ts keeps the live object in a private
 * WeakMap and rejects lookalike objects. Only runDaemon may issue one after it
 * has consumed a one-shot DaemonActivationCapability or received a currently
 * verified residentStanding grant from consumeDaemonActivationPermit().
 */
export interface DaemonResidentTickCapability {
  readonly kind: 'daemon-resident-tick';
  readonly [residentTickCapabilityBrand]: true;
}

export interface DaemonActivationOptions {
  once?: boolean;
  dryRun?: boolean;
  /** Any present drain mode is denied; unknown preserves structural loop compatibility. */
  drain?: unknown;
  drainLimit?: number;
}

export interface DaemonActivationPermitResult {
  authorized: boolean;
  required: boolean;
  reason: string;
  permitId?: string;
  receiptPath?: string;
  capability?: DaemonActivationCapability;
  configSnapshot?: AshlrConfig;
  /**
   * Present only when authorized via a standing `residentStanding` grant
   * rather than a one-shot permit. This is verified data returned to the
   * daemon entrypoint, not authority accepted by tick(): runDaemon must wrap
   * it in its process-local DaemonResidentTickCapability before use.
   */
  scope?: DaemonActivationGrantScope;
  /** Present only when `scope` is, so callers can re-check liveness per use. */
  grantId?: string;
}

export interface DaemonActivationReadiness {
  schemaVersion: 1;
  policyVersion: typeof POLICY_VERSION;
  authority: 'observation-only';
  sourceState: 'healthy' | 'degraded';
  state: 'ready' | 'blocked' | 'degraded';
  commandEligible: boolean;
  requestedShape: 'proposal-once' | 'resident';
  trustRootCount: number;
  residentAuthorized: boolean;
  /** Whether a currently valid standing `residentStanding` grant exists, independent of any pending one-shot permit. */
  residentStandingAuthorized: boolean;
  installAuthorized: boolean;
  repairAuthorized: boolean;
  reason: string;
}

export interface DaemonActivationTrustRoot {
  keyId: string;
  publicKeyPem: string;
}

/** Full operator-owned trust-root record, incl. mutable local revocation state. */
export interface DaemonActivationTrustRootRecord extends DaemonActivationTrustRoot {
  createdAt: string;
  /** Mutable, operator-set, NOT part of any signature. Non-null = revoked, immediately. */
  revokedAt: string | null;
  label: string;
}

/** A signed, expiring, independently revocable standing capability grant. */
export interface DaemonActivationGrantRecord {
  schemaVersion: 1;
  grantId: string;
  keyId: string;
  issuedAt: string;
  expiresAt: string;
  scope: DaemonActivationGrantScope;
  signature: string;
  /** Mutable, operator-set, NOT part of the signature. Non-null = revoked, immediately. */
  revokedAt: string | null;
}

export interface DaemonActivationFileBinding {
  path: string;
  sha256: string;
}

export interface DaemonActivationRuntimeContext {
  nowMs: number;
  configDigest: string;
  buildIdentity: BuildIdentity;
  executable: DaemonActivationFileBinding;
  entrypoint: DaemonActivationFileBinding;
  releaseTree: DaemonActivationFileBinding;
  authorityStateDigest: string;
  killSwitchOff: boolean;
  guardHealthHealthy: boolean;
}

export interface DaemonActivationPermitPayload {
  schemaVersion: 1;
  policyVersion: typeof POLICY_VERSION;
  permitId: string;
  nonce: string;
  keyId: string;
  issuedAt: string;
  expiresAt: string;
  scope: DaemonActivationGrantScope;
  bindings: {
    configDigest: string;
    buildIdentity: BuildIdentity;
    executable: DaemonActivationFileBinding;
    entrypoint: DaemonActivationFileBinding;
    releaseTree: DaemonActivationFileBinding;
    authorityStateDigest: string;
    killSwitch: 'off';
    guardHealth: 'healthy';
  };
}

export interface DaemonActivationPermitEnvelope {
  payload: DaemonActivationPermitPayload;
  signature: string;
}

export interface DaemonActivationPermitVerification {
  ok: boolean;
  reason: string;
  permitId?: string;
  payloadDigest?: string;
  /**
   * Populated only when reason === 'permit-runtime-binding-mismatch': the
   * top-level binding field names (of DaemonActivationPermitPayload.bindings)
   * whose signed value differs from the current runtime value. A fail-closed
   * gate that can't say WHICH binding differed is very hard to operate — this
   * turns the single opaque reason code into an actionable diagnostic.
   */
  mismatchedBindings?: readonly string[];
}

export interface DaemonActivationPermitTestConsumerOptions {
  trustRoots: readonly DaemonActivationTrustRoot[];
  context: DaemonActivationRuntimeContext;
  afterReceiptPersisted?: () => void;
}

export interface DaemonActivationPermitTestInspectionOptions {
  trustRoots: readonly DaemonActivationTrustRoot[];
  context: DaemonActivationRuntimeContext;
}

const validCapabilities = new WeakMap<object, () => boolean>();

function mintCapability(
  permitId: string,
  scope: DaemonActivationGrantScope,
  validateAtClaim: () => boolean,
): DaemonActivationCapability {
  const capability = Object.freeze({
    kind: 'proposal-once' as const,
    permitId,
    scope: Object.freeze({ ...scope }),
    [capabilityBrand]: true as const,
  });
  validCapabilities.set(capability, validateAtClaim);
  return capability;
}

/** Validate and consume a capability exactly once. */
export function isDaemonActivationCapability(
  value: unknown,
): value is DaemonActivationCapability {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const validateAtClaim = validCapabilities.get(value);
  if (!validateAtClaim) return false;
  validCapabilities.delete(value);
  try {
    return validateAtClaim();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalJsonValue(value: unknown, stack: Set<object>): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (typeof value !== 'object') throw new Error('canonical JSON rejects unsupported values');
  if (stack.has(value)) throw new Error('canonical JSON rejects cycles');
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalJsonValue(entry, stack) ?? 'null').join(',')}]`;
    }
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .flatMap((key) => {
        const encoded = canonicalJsonValue((value as Record<string, unknown>)[key], stack);
        return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
      });
    return `{${entries.join(',')}}`;
  } finally {
    stack.delete(value);
  }
}

export function canonicalizeDaemonActivationValue(value: unknown): string {
  const encoded = canonicalJsonValue(value, new Set());
  if (encoded === undefined) throw new Error('canonical JSON requires a value');
  return encoded;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function signingBytes(payload: DaemonActivationPermitPayload): Buffer {
  return Buffer.from(
    `${SIGNING_DOMAIN}${canonicalizeDaemonActivationValue(payload)}`,
    'utf8',
  );
}

export function daemonActivationConfigDigest(cfg: AshlrConfig): string {
  return sha256(canonicalizeDaemonActivationValue(cfg));
}

function freezeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const entry of value) freezeJsonValue(entry);
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) freezeJsonValue(entry);
    return Object.freeze(value);
  }
  return value;
}

function strictConfigSnapshot(cfg: AshlrConfig): AshlrConfig {
  const canonical = canonicalizeDaemonActivationValue(cfg);
  const parsed = JSON.parse(canonical) as unknown;
  if (!isRecord(parsed) || Array.isArray(parsed)) {
    throw new Error('activation config must be a plain JSON object');
  }
  return freezeJsonValue(parsed) as AshlrConfig;
}

function validIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validBuildIdentity(value: unknown): value is BuildIdentity {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ['schemaVersion', 'packageVersion', 'revision', 'dirty', 'provenance'],
  )) return false;
  if (value['schemaVersion'] !== 1 || typeof value['packageVersion'] !== 'string') return false;
  if (typeof value['revision'] !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value['revision'])) {
    return false;
  }
  if (value['provenance'] === 'git') return value['dirty'] === false;
  return value['provenance'] === 'github-actions' && value['dirty'] === null;
}

function validFileBinding(value: unknown): value is DaemonActivationFileBinding {
  return isRecord(value)
    && hasExactKeys(value, ['path', 'sha256'])
    && typeof value['path'] === 'string'
    && isAbsolute(value['path'])
    && DIGEST_RE.test(String(value['sha256']));
}

function validScope(value: unknown): value is DaemonActivationGrantScope {
  if (!isRecord(value) || !hasExactKeys(value, SCOPE_KEYS)) return false;
  return SCOPE_KEYS.every((key) => typeof value[key] === 'boolean');
}

/**
 * Loading a STANDING GRANT record from disk needs a more forgiving check
 * than minting a new one: `validScope` requires every currently-defined
 * scope key to be present, but a standing grant can live for up to 30 days
 * — long enough to span an `npm`/build upgrade that adds a new key to
 * `DAEMON_ACTIVATION_SCOPE_KEYS` (exactly what `residentStanding` is). A
 * strict exact-key check on LOAD would make `hasExactKeys` reject that one
 * older-format record — and `loadGrantStore()` fails the WHOLE store, not
 * just that record, on any single invalid one, which would silently deny
 * every OTHER still-valid standing grant (conductor/install/etc.) too.
 *
 * This accepts any subset of the current scope keys (no unrecognized keys,
 * every present key boolean) and leaves absent keys simply absent. Every
 * read site treats `record.scope[key] !== true` / falsy the same way
 * `undefined` would, so an old record's missing new-generation keys read as
 * "not granted" — never widened, never silently trusted. Signature
 * verification is unaffected: `grantSigningBytes` canonicalizes whatever
 * `scope` object the record actually contains, i.e. exactly what was
 * originally signed, not a backfilled/padded version — so an old record's
 * signature still verifies against its original (smaller) scope shape.
 */
function validStoredScope(value: unknown): value is DaemonActivationGrantScope {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    if (!(SCOPE_KEYS as readonly string[]).includes(key)) return false;
  }
  for (const key of SCOPE_KEYS) {
    if (key in value && typeof value[key] !== 'boolean') return false;
  }
  return true;
}

function validBindings(value: unknown): value is DaemonActivationPermitPayload['bindings'] {
  if (!isRecord(value) || !hasExactKeys(value, [
    'configDigest',
    'buildIdentity',
    'executable',
    'entrypoint',
    'releaseTree',
    'authorityStateDigest',
    'killSwitch',
    'guardHealth',
  ])) return false;
  return DIGEST_RE.test(String(value['configDigest']))
    && validBuildIdentity(value['buildIdentity'])
    && validFileBinding(value['executable'])
    && validFileBinding(value['entrypoint'])
    && validFileBinding(value['releaseTree'])
    && DIGEST_RE.test(String(value['authorityStateDigest']))
    && value['killSwitch'] === 'off'
    && value['guardHealth'] === 'healthy';
}

function parsePayload(value: unknown): DaemonActivationPermitPayload | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion',
    'policyVersion',
    'permitId',
    'nonce',
    'keyId',
    'issuedAt',
    'expiresAt',
    'scope',
    'bindings',
  ])) return null;
  if (
    value['schemaVersion'] !== 1
    || value['policyVersion'] !== POLICY_VERSION
    || typeof value['permitId'] !== 'string'
    || !ID_RE.test(value['permitId'])
    || typeof value['nonce'] !== 'string'
    || !DIGEST_RE.test(value['nonce'])
    || typeof value['keyId'] !== 'string'
    || !KEY_ID_RE.test(value['keyId'])
    || !validIsoTimestamp(value['issuedAt'])
    || !validIsoTimestamp(value['expiresAt'])
    || !validScope(value['scope'])
    || !validBindings(value['bindings'])
  ) return null;
  return value as unknown as DaemonActivationPermitPayload;
}

function parseEnvelope(value: unknown): DaemonActivationPermitEnvelope | null {
  if (!isRecord(value) || !hasExactKeys(value, ['payload', 'signature'])) return null;
  const payload = parsePayload(value['payload']);
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

function trustRootMap(
  roots: readonly DaemonActivationTrustRoot[],
): Map<string, KeyObject> | null {
  const trusted = new Map<string, KeyObject>();
  try {
    for (const root of roots) {
      if (!isRecord(root)
        || !hasExactKeys(root, ['keyId', 'publicKeyPem'])
        || typeof root.keyId !== 'string'
        || !KEY_ID_RE.test(root.keyId)
        || typeof root.publicKeyPem !== 'string'
        || trusted.has(root.keyId)) return null;
      const key = createPublicKey(root.publicKeyPem);
      if (key.asymmetricKeyType !== 'ed25519') return null;
      trusted.set(root.keyId, key);
    }
    return trusted;
  } catch {
    return null;
  }
}

function equalCanonical(left: unknown, right: unknown): boolean {
  return canonicalizeDaemonActivationValue(left) === canonicalizeDaemonActivationValue(right);
}

type BindingKey = keyof DaemonActivationPermitPayload['bindings'];

/** Which top-level binding fields differ, field by field — never a single opaque yes/no. */
function bindingFieldMismatches(
  actual: DaemonActivationPermitPayload['bindings'],
  expected: DaemonActivationPermitPayload['bindings'],
): BindingKey[] {
  const keys = Object.keys(expected) as BindingKey[];
  return keys.filter((key) => !equalCanonical(actual[key], expected[key]));
}

export function verifyDaemonActivationPermit(
  value: unknown,
  context: DaemonActivationRuntimeContext,
  trustRoots: readonly DaemonActivationTrustRoot[],
): DaemonActivationPermitVerification {
  if (trustRoots.length === 0) return { ok: false, reason: 'no-trusted-activation-roots' };
  if (!Number.isSafeInteger(context.nowMs)
    || context.nowMs < 0
    || !DIGEST_RE.test(context.configDigest)
    || !validFileBinding(context.executable)
    || !validFileBinding(context.entrypoint)
    || !validFileBinding(context.releaseTree)
    || !DIGEST_RE.test(context.authorityStateDigest)
    || typeof context.killSwitchOff !== 'boolean'
    || typeof context.guardHealthHealthy !== 'boolean') {
    return { ok: false, reason: 'invalid-runtime-activation-context' };
  }
  const trusted = trustRootMap(trustRoots);
  if (!trusted) return { ok: false, reason: 'invalid-trust-root-set' };
  const envelope = parseEnvelope(value);
  if (!envelope) return { ok: false, reason: 'invalid-permit-schema' };

  const issuedAt = Date.parse(envelope.payload.issuedAt);
  const expiresAt = Date.parse(envelope.payload.expiresAt);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_VALIDITY_MS) {
    return { ok: false, reason: 'invalid-permit-validity-window' };
  }
  if (issuedAt > context.nowMs + MAX_FUTURE_SKEW_MS) {
    return { ok: false, reason: 'permit-issued-too-far-in-future' };
  }
  if (expiresAt <= context.nowMs) return { ok: false, reason: 'permit-expired' };
  if (!context.killSwitchOff) return { ok: false, reason: 'kill-switch-is-on' };
  if (!context.guardHealthHealthy) return { ok: false, reason: 'guard-health-degraded' };
  if (!validBuildIdentity(context.buildIdentity)) {
    return { ok: false, reason: 'runtime-build-identity-untrusted' };
  }

  const expectedBindings: DaemonActivationPermitPayload['bindings'] = {
    configDigest: context.configDigest,
    buildIdentity: context.buildIdentity,
    executable: context.executable,
    entrypoint: context.entrypoint,
    releaseTree: context.releaseTree,
    authorityStateDigest: context.authorityStateDigest,
    killSwitch: 'off',
    guardHealth: 'healthy',
  };
  if (!equalCanonical(envelope.payload.bindings, expectedBindings)) {
    return {
      ok: false,
      reason: 'permit-runtime-binding-mismatch',
      mismatchedBindings: bindingFieldMismatches(envelope.payload.bindings, expectedBindings),
    };
  }

  const publicKey = trusted.get(envelope.payload.keyId);
  if (!publicKey) return { ok: false, reason: 'permit-key-not-trusted' };
  const canonicalPayload = canonicalizeDaemonActivationValue(envelope.payload);
  let signature: Buffer;
  try {
    signature = Buffer.from(envelope.signature, 'base64');
  } catch {
    return { ok: false, reason: 'invalid-permit-signature' };
  }
  if (!verify(null, signingBytes(envelope.payload), publicKey, signature)) {
    return { ok: false, reason: 'invalid-permit-signature' };
  }
  return {
    ok: true,
    reason: 'valid-proposal-once-permit',
    permitId: envelope.payload.permitId,
    payloadDigest: sha256(canonicalPayload),
  };
}

export function buildDaemonActivationPermitPayload(input: {
  permitId: string;
  nonce: string;
  keyId: string;
  issuedAt: string;
  expiresAt: string;
  /** Defaults to the legacy {once, proposalOnly} grant when omitted. */
  scope?: DaemonActivationGrantScope;
  context: DaemonActivationRuntimeContext;
}): DaemonActivationPermitPayload {
  const scope = input.scope ?? LEGACY_ONCE_PROPOSAL_SCOPE;
  const payload: DaemonActivationPermitPayload = {
    schemaVersion: 1,
    policyVersion: POLICY_VERSION,
    permitId: input.permitId,
    nonce: input.nonce,
    keyId: input.keyId,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    scope: { ...scope },
    bindings: {
      configDigest: input.context.configDigest,
      buildIdentity: { ...input.context.buildIdentity },
      executable: { ...input.context.executable },
      entrypoint: { ...input.context.entrypoint },
      releaseTree: { ...input.context.releaseTree },
      authorityStateDigest: input.context.authorityStateDigest,
      killSwitch: 'off',
      guardHealth: 'healthy',
    },
  };
  if (!parsePayload(payload)) throw new Error('invalid daemon activation permit payload input');
  return payload;
}

export function signDaemonActivationPermit(
  payload: DaemonActivationPermitPayload,
  privateKey: string | KeyObject,
): DaemonActivationPermitEnvelope {
  if (!parsePayload(payload)) throw new Error('invalid daemon activation permit payload');
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('daemon activation permits require an Ed25519 private key');
  }
  const bytes = signingBytes(payload);
  return { payload, signature: sign(null, bytes, key).toString('base64') };
}

function safeOwnedFile(stat: BigIntStats): boolean {
  const owned = process.platform === 'win32' || typeof process.getuid !== 'function'
    || stat.uid === BigInt(process.getuid());
  const privateMode = process.platform === 'win32' || (stat.mode & 0o077n) === 0n;
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && owned && privateMode;
}

function safeOwnedDirectory(stat: BigIntStats): boolean {
  const owned = process.platform === 'win32' || typeof process.getuid !== 'function'
    || stat.uid === BigInt(process.getuid());
  const privateMode = process.platform === 'win32' || (stat.mode & 0o077n) === 0n;
  return stat.isDirectory() && !stat.isSymbolicLink() && owned && privateMode;
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

interface PinnedPermitFile {
  fd: number;
  stat: BigIntStats;
  text: string;
}

function openPinnedPermit(path: string, anchorPath: string): PinnedPermitFile {
  const assurance = assurePrivateStoragePath(path, 'file', 'inspect-owned', { anchorPath });
  if (!assurance.ok) throw new Error(`unsafe-permit-path:${assurance.reason}`);
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const namedBefore = lstatSync(path, { bigint: true });
  if (!safeOwnedFile(namedBefore) || namedBefore.size <= 0n
    || namedBefore.size > BigInt(MAX_PERMIT_BYTES)) throw new Error('unsafe-permit-file');
  const fd = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const openedBefore = fstatSync(fd, { bigint: true });
    if (!safeOwnedFile(openedBefore) || !sameFileSnapshot(namedBefore, openedBefore)) {
      throw new Error('permit-changed-during-open');
    }
    const size = Number(openedBefore.size);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, offset);
      if (count <= 0) throw new Error('short-permit-read');
      offset += count;
    }
    const openedAfter = fstatSync(fd, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    if (!sameFileSnapshot(openedBefore, openedAfter)
      || !sameFileSnapshot(openedAfter, namedAfter)) throw new Error('permit-changed-during-read');
    return { fd, stat: openedAfter, text: bytes.toString('utf8') };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function assurePrivateDirectory(path: string, anchorPath: string): void {
  let created = false;
  try {
    mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!created) {
    const existing = assurePrivateStoragePath(
      path,
      'directory',
      'inspect-existing',
      { anchorPath },
    );
    if (!existing.ok) throw new Error(`unsafe-private-directory:${existing.reason}`);
    return;
  }
  if (process.platform !== 'win32') chmodSync(path, PRIVATE_DIRECTORY_MODE);
  const assurance = assurePrivateStoragePath(
    path,
    'directory',
    'secure-created',
    { anchorPath },
  );
  if (!assurance.ok) throw new Error(`unsafe-private-directory:${assurance.reason}`);
  fsyncDirectory(dirname(path));
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count <= 0) throw new Error('receipt-write-made-no-progress');
    offset += count;
  }
}

function persistReceipt(
  path: string,
  receipt: Record<string, unknown>,
  anchorPath: string,
): void {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      PRIVATE_FILE_MODE,
    );
    const initial = fstatSync(fd, { bigint: true });
    if (!safeOwnedFile(initial) || initial.size !== 0n) throw new Error('unsafe-receipt-file');
    fchmodSync(fd, PRIVATE_FILE_MODE);
    const bytes = Buffer.from(`${canonicalizeDaemonActivationValue(receipt)}\n`, 'utf8');
    writeAll(fd, bytes);
    fsyncSync(fd);
    const written = fstatSync(fd, { bigint: true });
    if (!safeOwnedFile(written) || written.size !== BigInt(bytes.length)
      || written.dev !== initial.dev || written.ino !== initial.ino) {
      throw new Error('receipt-changed-during-write');
    }
    const assurance = assurePrivateStoragePath(path, 'file', 'secure-created', { anchorPath });
    if (!assurance.ok) throw new Error(`unsafe-receipt-path:${assurance.reason}`);
    closeSync(fd);
    fd = undefined;
    fsyncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the fail-closed receipt state */ }
    }
  }
}

function hashStableFile(path: string): DaemonActivationFileBinding {
  const requested = resolve(path);
  const canonical = realpathSync(requested);
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(canonical, fsConstants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size < 0n
      || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`runtime binding is not a regular file: ${canonical}`);
    }
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < Number(before.size)) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, Number(before.size) - offset), offset);
      if (count <= 0) throw new Error(`short runtime binding read: ${canonical}`);
      hash.update(chunk.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (!sameFileSnapshot(before, after) || realpathSync(canonical) !== canonical) {
      throw new Error(`runtime binding changed during read: ${canonical}`);
    }
    return { path: canonical, sha256: hash.digest('hex') };
  } finally {
    closeSync(fd);
  }
}

function releasePackageRoot(entrypointPath: string): string {
  let current = dirname(realpathSync(resolve(entrypointPath)));
  for (;;) {
    if (
      existsSync(join(current, 'package.json')) &&
      existsSync(join(current, 'bin', 'ashlr')) &&
      existsSync(join(current, 'dist', 'cli', 'index.js'))
    ) return realpathSync(current);
    const parent = dirname(current);
    if (parent === current) throw new Error('runtime-release-root-unavailable');
    current = parent;
  }
}

function releaseFilePaths(root: string): string[] {
  const files = [join(root, 'package.json'), join(root, 'bin', 'ashlr')];
  const pending = [join(root, 'dist')];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`runtime release contains a symlink: ${path}`);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`runtime release contains an unsupported entry: ${path}`);
      if (files.length + pending.length > 20_000) {
        throw new Error('runtime release file bound exceeded');
      }
    }
  }
  return files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

function releaseFilesDigest(root: string, files: readonly string[]): string {
  const hash = createHash('sha256');
  for (const path of files) {
    const binding = hashStableFile(path);
    const name = relative(root, binding.path).replaceAll('\\', '/');
    if (name.startsWith('../') || name === '..' || isAbsolute(name)) {
      throw new Error('runtime release file escaped package root');
    }
    hash.update(`${name}\0${binding.sha256}\0`, 'utf8');
  }
  return hash.digest('hex');
}

function hashStableReleaseTree(entrypointPath: string): DaemonActivationFileBinding {
  const root = releasePackageRoot(entrypointPath);
  const before = releaseFilePaths(root);
  const firstDigest = releaseFilesDigest(root, before);
  const after = releaseFilePaths(root);
  if (
    before.length !== after.length ||
    before.some((path, index) => path !== after[index])
  ) throw new Error('runtime release tree changed during hashing');
  const secondDigest = releaseFilesDigest(root, after);
  if (firstDigest !== secondDigest) {
    throw new Error('runtime release content changed during hashing');
  }
  return { path: root, sha256: secondDigest };
}

/** Read-only helper for release packaging and substitution verification. */
export function daemonActivationReleaseTreeBinding(
  entrypointPath: string,
): DaemonActivationFileBinding {
  return hashStableReleaseTree(entrypointPath);
}

/**
 * Fingerprints "this authority store instance" — the ~/.ashlr directory a
 * permit is bound to — so a permit can't be replayed against a different
 * store (e.g. copied to another machine, or after a full delete+recreate).
 *
 * Deliberately uses dev+ino, NOT mtime. ~/.ashlr's own mtime changes every
 * time a direct child is created or removed — and ordinary `daemon start`
 * does exactly that before it ever reaches this check: acquireDaemonLock()
 * (src/core/daemon/state.ts) creates ~/.ashlr/daemon.lock via
 * `writeFileSync(..., {flag:'wx'})`, a brand-new direct child of ~/.ashlr.
 * Binding to mtime meant every freshly minted permit was invalidated by the
 * daemon's own startup lock-file creation, 100% reproducibly, before it
 * could ever be consumed — a self-inflicted permit-runtime-binding-mismatch,
 * not a real "different store" signal. dev+ino uniquely and STABLY identify
 * the directory's inode: they survive ordinary child churn (locks, control
 * files, receipts) and change only if ~/.ashlr is deleted and recreated (or
 * moved to a different filesystem) — exactly the case this binding exists
 * to catch.
 */
export function daemonActivationAuthorityStateDigest(): string {
  const home = realpathSync(resolve(homedir()));
  const ashlrHome = realpathSync(join(home, '.ashlr'));
  const state = lstatSync(ashlrHome, { bigint: true });
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error('activation authority store is not a directory');
  }
  const enrollment = readEnrollmentRegistry();
  if (enrollment.state !== 'ready') {
    throw new Error(`activation enrollment source is degraded: ${enrollment.reason}`);
  }
  return sha256(canonicalizeDaemonActivationValue({
    hostname: hostname(),
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    home,
    authorityStore: {
      path: ashlrHome,
      dev: state.dev.toString(),
      ino: state.ino.toString(),
    },
    enrollment: [...enrollment.repos].sort(),
  }));
}

function collectRuntimeContext(cfg: AshlrConfig): DaemonActivationRuntimeContext {
  const entrypoint = process.argv[1];
  if (!entrypoint) throw new Error('runtime-entrypoint-unavailable');
  const guard = diagnoseGuardHealth();
  return {
    nowMs: Date.now(),
    configDigest: daemonActivationConfigDigest(cfg),
    buildIdentity: readBuildIdentity(),
    executable: hashStableFile(process.execPath),
    entrypoint: hashStableFile(entrypoint),
    releaseTree: daemonActivationReleaseTreeBinding(entrypoint),
    authorityStateDigest: daemonActivationAuthorityStateDigest(),
    killSwitchOff: !killSwitchOn(),
    guardHealthHealthy: !guard.blocked,
  };
}

export function daemonActivationPermitPath(): string {
  return join(homedir(), '.ashlr', 'control', 'daemon-activation-permit.json');
}

export function daemonActivationReceiptPath(permitId: string): string {
  if (!ID_RE.test(permitId)) throw new Error('invalid daemon activation permit id');
  return join(homedir(), '.ashlr', 'control', 'activation-receipts', `${permitId}.json`);
}

function daemonActivationNonceReceiptPath(nonceDigest: string): string {
  if (!DIGEST_RE.test(nonceDigest)) throw new Error('invalid daemon activation nonce digest');
  return join(
    homedir(),
    '.ashlr',
    'control',
    'activation-receipts',
    'by-nonce',
    `${nonceDigest}.json`,
  );
}

// ---------------------------------------------------------------------------
// Operator authority store — trust roots + standing grants.
//
// Root of trust is OS-level file ownership/permissions on the operator's own
// machine (mirrors the one-shot permit's existing safety model), not a
// central registry. Every store read fails CLOSED to "no authority" on any
// ambiguity: missing file, unreadable, wrong owner, wrong permissions,
// symlinked path, malformed JSON, non-canonical encoding, or duplicate ids.
// ---------------------------------------------------------------------------

export function daemonActivationDirPath(): string {
  return join(homedir(), '.ashlr', 'activation');
}

export function daemonActivationTrustRootsPath(): string {
  return join(daemonActivationDirPath(), 'trust-roots.json');
}

export function daemonActivationGrantsPath(): string {
  return join(daemonActivationDirPath(), 'grants.json');
}

export function daemonActivationOperatorKeyPath(): string {
  return join(daemonActivationDirPath(), 'operator-private-key.pem');
}

function daemonActivationStoreLockPath(): string {
  return join(daemonActivationDirPath(), 'activation-store.lock');
}

function pathEntryPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Safe, non-consuming read of a canonical-JSON-array operator store file. */
function safeReadOwnedJsonArray(
  path: string,
  anchorPath: string,
  maxBytes: number,
): { ok: true; value: unknown[] } | { ok: false; reason: string } {
  let dirStat: BigIntStats;
  try {
    dirStat = lstatSync(dirname(path), { bigint: true });
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'stat-failed' };
  }
  if (!safeOwnedDirectory(dirStat)) return { ok: false, reason: 'unsafe-directory' };
  const dirAssurance = assurePrivateStoragePath(dirname(path), 'directory', 'inspect-owned', { anchorPath });
  if (!dirAssurance.ok) return { ok: false, reason: `unsafe-directory:${dirAssurance.reason}` };

  // Open first, then validate the fd — the check (owner/mode/regular-file/
  // size) and the read below share one file description, so there is no
  // window between "checked" and "used" for an attacker to swap the path.
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'open-failed' };
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!safeOwnedFile(opened) || opened.size <= 0n || opened.size > BigInt(maxBytes)) {
      return { ok: false, reason: 'unsafe-file' };
    }
    const size = Number(opened.size);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, offset);
      if (count <= 0) return { ok: false, reason: 'short-read' };
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (!sameFileSnapshot(opened, after)) return { ok: false, reason: 'changed-during-read' };
    const text = bytes.toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'invalid-json' };
    }
    if (`${canonicalizeDaemonActivationValue(parsed)}\n` !== text) {
      return { ok: false, reason: 'noncanonical-encoding' };
    }
    if (!Array.isArray(parsed)) return { ok: false, reason: 'not-an-array' };
    const fileAssurance = assurePrivateStoragePath(path, 'file', 'inspect-owned', { anchorPath });
    if (!fileAssurance.ok) return { ok: false, reason: `unsafe-file:${fileAssurance.reason}` };
    return { ok: true, value: parsed };
  } finally {
    closeSync(fd);
  }
}

/** Atomically replace a canonical-JSON-array operator store file (temp write + rename). */
function writeCanonicalJsonArrayFileAtomic(
  path: string,
  value: readonly unknown[],
  anchorPath: string,
): void {
  assurePrivateDirectory(dirname(path), anchorPath);
  const tmpPath = `${path}.tmp-${randomBytes(8).toString('hex')}`;
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = openSync(
      tmpPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      PRIVATE_FILE_MODE,
    );
    const initial = fstatSync(fd, { bigint: true });
    if (!safeOwnedFile(initial) || initial.size !== 0n) throw new Error('unsafe-activation-store-temp-file');
    fchmodSync(fd, PRIVATE_FILE_MODE);
    const bytes = Buffer.from(`${canonicalizeDaemonActivationValue(value)}\n`, 'utf8');
    writeAll(fd, bytes);
    fsyncSync(fd);
    const written = fstatSync(fd, { bigint: true });
    if (!safeOwnedFile(written) || written.size !== BigInt(bytes.length)) {
      throw new Error('activation-store-temp-file-changed-during-write');
    }
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, path);
    const assurance = assurePrivateStoragePath(path, 'file', 'secure-created', { anchorPath });
    if (!assurance.ok) throw new Error(`unsafe-activation-store-path:${assurance.reason}`);
    fsyncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort */ }
    }
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch { /* best-effort cleanup */ }
  }
}

function withActivationStoreLock<T>(fn: () => T): T {
  const home = resolve(homedir());
  // Two single-level creates: ~/.ashlr may not exist yet on a machine where
  // `activation init` is the very first ashlr command ever run.
  assurePrivateDirectory(join(homedir(), '.ashlr'), home);
  assurePrivateDirectory(daemonActivationDirPath(), home);
  const lock = acquireLocalStoreLock(daemonActivationStoreLockPath(), LOCK_WAIT_MS, {
    anchorPath: home,
    exactPrivateStorage: true,
  });
  if (!lock) throw new Error('activation-store-lock-unavailable');
  let result: T;
  try {
    result = fn();
  } catch (error) {
    releaseLocalStoreLock(lock);
    throw error;
  }
  if (!releaseLocalStoreLock(lock)) throw new Error('activation-store-lock-release-failed');
  return result;
}

function readOperatorPrivateKeyPem(): string {
  const path = daemonActivationOperatorKeyPath();
  const home = resolve(homedir());
  // Open first, then validate the fd. The owner/mode/size check and the read
  // below run against the same file description, so the path cannot be
  // swapped between "checked" and "used".
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!safeOwnedFile(opened) || opened.size <= 0n || opened.size > BigInt(MAX_PERMIT_BYTES)) {
      throw new Error('unsafe-operator-key-file');
    }
    const size = Number(opened.size);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, offset);
      if (count <= 0) throw new Error('short-operator-key-read');
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (!sameFileSnapshot(opened, after)) throw new Error('operator-key-changed-during-read');
    const assurance = assurePrivateStoragePath(path, 'file', 'inspect-owned', { anchorPath: home });
    if (!assurance.ok) throw new Error(`unsafe-operator-key-path:${assurance.reason}`);
    return bytes.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function validTrustRootRecord(value: unknown): value is DaemonActivationTrustRootRecord {
  if (!isRecord(value) || !hasExactKeys(value, ['keyId', 'publicKeyPem', 'createdAt', 'revokedAt', 'label'])) {
    return false;
  }
  if (typeof value['keyId'] !== 'string' || !KEY_ID_RE.test(value['keyId'])) return false;
  if (typeof value['publicKeyPem'] !== 'string') return false;
  try {
    const key = createPublicKey(value['publicKeyPem']);
    if (key.asymmetricKeyType !== 'ed25519') return false;
  } catch {
    return false;
  }
  if (!validIsoTimestamp(value['createdAt'])) return false;
  if (value['revokedAt'] !== null && !validIsoTimestamp(value['revokedAt'])) return false;
  if (typeof value['label'] !== 'string' || value['label'].length > MAX_LABEL_LENGTH) return false;
  return true;
}

function loadTrustRootStore():
  { ok: true; records: readonly DaemonActivationTrustRootRecord[] } | { ok: false; reason: string } {
  const read = safeReadOwnedJsonArray(daemonActivationTrustRootsPath(), resolve(homedir()), MAX_TRUST_STORE_BYTES);
  if (!read.ok) {
    if (read.reason === 'missing') return { ok: true, records: [] };
    return { ok: false, reason: read.reason };
  }
  const records: DaemonActivationTrustRootRecord[] = [];
  const seen = new Set<string>();
  for (const entry of read.value) {
    if (!validTrustRootRecord(entry) || seen.has(entry.keyId)) {
      return { ok: false, reason: 'invalid-trust-root-store' };
    }
    seen.add(entry.keyId);
    records.push(entry);
  }
  return { ok: true, records };
}

/**
 * The ONLY source of production trust roots: an operator-owned, protected
 * file the operator populates via `ashlr activation init`. Missing, unsafe,
 * or malformed → []  — identical denial to before this file loading existed.
 */
export function loadDaemonActivationTrustRoots(): readonly DaemonActivationTrustRoot[] {
  const loaded = loadTrustRootStore();
  if (!loaded.ok) return [];
  return loaded.records
    .filter((record) => record.revokedAt === null)
    .map((record) => ({ keyId: record.keyId, publicKeyPem: record.publicKeyPem }));
}

/** Full trust-root status (incl. revoked history) for `ashlr activation status`. */
export function daemonActivationTrustRootStatus():
  { ok: true; records: readonly DaemonActivationTrustRootRecord[] } | { ok: false; reason: string } {
  return loadTrustRootStore();
}

function activeTrustRootKeyMap(): Map<string, KeyObject> | null {
  const loaded = loadTrustRootStore();
  if (!loaded.ok) return null;
  const active = loaded.records
    .filter((record) => record.revokedAt === null)
    .map((record) => ({ keyId: record.keyId, publicKeyPem: record.publicKeyPem }));
  return trustRootMap(active);
}

function validGrantRecord(value: unknown): value is DaemonActivationGrantRecord {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion', 'grantId', 'keyId', 'issuedAt', 'expiresAt', 'scope', 'signature', 'revokedAt',
  ])) return false;
  if (value['schemaVersion'] !== 1) return false;
  if (typeof value['grantId'] !== 'string' || !ID_RE.test(value['grantId'])) return false;
  if (typeof value['keyId'] !== 'string' || !KEY_ID_RE.test(value['keyId'])) return false;
  if (!validIsoTimestamp(value['issuedAt']) || !validIsoTimestamp(value['expiresAt'])) return false;
  // validStoredScope (not validScope): a persisted STANDING grant may
  // predate a newly-added scope key by up to 30 days — see its doc comment.
  if (!validStoredScope(value['scope'])) return false;
  if (typeof value['signature'] !== 'string') return false;
  try {
    const sig = Buffer.from(value['signature'], 'base64');
    if (sig.length !== 64 || sig.toString('base64') !== value['signature']) return false;
  } catch {
    return false;
  }
  if (value['revokedAt'] !== null && !validIsoTimestamp(value['revokedAt'])) return false;
  return true;
}

function loadGrantStore():
  { ok: true; records: readonly DaemonActivationGrantRecord[] } | { ok: false; reason: string } {
  const read = safeReadOwnedJsonArray(daemonActivationGrantsPath(), resolve(homedir()), MAX_GRANTS_BYTES);
  if (!read.ok) {
    if (read.reason === 'missing') return { ok: true, records: [] };
    return { ok: false, reason: read.reason };
  }
  const records: DaemonActivationGrantRecord[] = [];
  const seen = new Set<string>();
  for (const entry of read.value) {
    if (!validGrantRecord(entry) || seen.has(entry.grantId)) {
      return { ok: false, reason: 'invalid-grant-store' };
    }
    seen.add(entry.grantId);
    records.push(entry);
  }
  return { ok: true, records };
}

/** Full standing-grant status (incl. revoked/expired history) for `ashlr activation status`. */
export function daemonActivationGrantStatus():
  { ok: true; records: readonly DaemonActivationGrantRecord[] } | { ok: false; reason: string } {
  return loadGrantStore();
}

function grantSigningCore(
  record: Pick<DaemonActivationGrantRecord, 'schemaVersion' | 'grantId' | 'keyId' | 'issuedAt' | 'expiresAt' | 'scope'>,
): Pick<DaemonActivationGrantRecord, 'schemaVersion' | 'grantId' | 'keyId' | 'issuedAt' | 'expiresAt' | 'scope'> {
  return {
    schemaVersion: record.schemaVersion,
    grantId: record.grantId,
    keyId: record.keyId,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    scope: record.scope,
  };
}

function grantSigningBytes(
  core: Pick<DaemonActivationGrantRecord, 'schemaVersion' | 'grantId' | 'keyId' | 'issuedAt' | 'expiresAt' | 'scope'>,
): Buffer {
  return Buffer.from(`${GRANT_SIGNING_DOMAIN}${canonicalizeDaemonActivationValue(core)}`, 'utf8');
}

export function signDaemonActivationGrant(input: {
  grantId: string;
  keyId: string;
  issuedAt: string;
  expiresAt: string;
  scope: DaemonActivationGrantScope;
  privateKey: string | KeyObject;
}): DaemonActivationGrantRecord {
  const core = grantSigningCore({
    schemaVersion: 1,
    grantId: input.grantId,
    keyId: input.keyId,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    scope: { ...input.scope },
  });
  const key = typeof input.privateKey === 'string' ? createPrivateKey(input.privateKey) : input.privateKey;
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('daemon activation grants require an Ed25519 private key');
  }
  const signature = sign(null, grantSigningBytes(core), key).toString('base64');
  const record: DaemonActivationGrantRecord = { ...core, signature, revokedAt: null };
  if (!validGrantRecord(record)) throw new Error('invalid daemon activation grant record');
  return record;
}

function auditActivationEvent(action: string, summary: string, result: 'ok' | 'refused' | 'error'): void {
  audit({ action, repo: null, sandboxId: null, summary, result });
}

/**
 * Checks whether ANY non-revoked, non-expired, validly-signed standing grant
 * (from a non-revoked trust root) currently grants `scopeKey`. Unlike the
 * one-shot permit, standing grants are NOT bound to exact executable/
 * entrypoint/release-tree hashes — they must remain valid across routine
 * rebuilds within their expiry window. They ARE bound to kill-switch-off,
 * guard-health-healthy, and a non-revoked trust root, and always expire.
 */
/**
 * Shared core of `daemonActivationScopeGranted`. Returns the matched grant
 * RECORD (not just a boolean) so callers that need to act on it — currently
 * only the resident-standing startup path — can read its scope and grantId
 * without a second, redundant store read. Same checks, same order, as the
 * pre-refactor inline body of `daemonActivationScopeGranted`.
 */
function findGrantedRecord(
  scopeKey: DaemonActivationScopeKey,
): { granted: true; record: DaemonActivationGrantRecord } | { granted: false; reason: string } {
  if (killSwitchOn()) return { granted: false, reason: 'kill-switch-is-on' };
  let guardHealthy: boolean;
  try {
    guardHealthy = !diagnoseGuardHealth().blocked;
  } catch {
    return { granted: false, reason: 'guard-health-check-failed' };
  }
  if (!guardHealthy) return { granted: false, reason: 'guard-health-degraded' };
  const trusted = activeTrustRootKeyMap();
  if (!trusted || trusted.size === 0) return { granted: false, reason: 'no-trusted-activation-roots' };
  const grants = loadGrantStore();
  if (!grants.ok) return { granted: false, reason: `activation-grant-store-${grants.reason}` };
  const nowMs = Date.now();
  for (const record of grants.records) {
    if (record.revokedAt !== null) continue;
    if (record.scope[scopeKey] !== true) continue;
    const publicKey = trusted.get(record.keyId);
    if (!publicKey) continue;
    if (Date.parse(record.expiresAt) <= nowMs) continue;
    let signature: Buffer;
    try {
      signature = Buffer.from(record.signature, 'base64');
    } catch {
      continue;
    }
    if (!verify(null, grantSigningBytes(grantSigningCore(record)), publicKey, signature)) continue;
    return { granted: true, record };
  }
  return { granted: false, reason: 'no-matching-standing-grant' };
}

export function daemonActivationScopeGranted(
  scopeKey: DaemonActivationScopeKey,
): { granted: boolean; reason: string } {
  const found = findGrantedRecord(scopeKey);
  return found.granted
    ? { granted: true, reason: `granted-by-${found.record.grantId}` }
    : { granted: false, reason: found.reason };
}

/**
 * The goal and simple conductors consult this every cycle. Real, gated,
 * revocable authority: granted only after `ashlr activation init` +
 * `ashlr activation grant conductor`. Default (no grant) is denied, exactly
 * as before this mechanism existed. Every check is audited.
 */
export function liveConductorActivationAuthorized(): boolean {
  const check = daemonActivationScopeGranted('conductor');
  auditActivationEvent(
    'daemon-activation:conductor-check',
    `conductor activation ${check.granted ? 'authorized' : 'denied'}: ${check.reason}`,
    check.granted ? 'ok' : 'refused',
  );
  return check.granted;
}

// ---------------------------------------------------------------------------
// Operator authority mutation — init / grant / revoke. Called from
// `src/cli/activation.ts`; kept here so all signing/writing stays alongside
// the verification it must satisfy.
// ---------------------------------------------------------------------------

export function generateDaemonActivationOperatorKeypair(): { privateKeyPem: string; publicKeyPem: string } {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function sanitizeKeyId(candidate: string): string {
  const cleaned = candidate.replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 55);
  const seeded = cleaned.length > 0 && /^[A-Za-z0-9]/u.test(cleaned) ? cleaned : `k${cleaned}`;
  return seeded.slice(0, 63) || 'operator';
}

/**
 * Generates an Ed25519 keypair on THIS machine (private key never leaves it,
 * written 0600 under an 0700 directory) and registers the public half as a
 * new active trust root. Refuses to silently clobber an existing active
 * root or key file unless `force` is set (key rotation: the new root is
 * ADDED, not swapped in place, so grants signed by an older still-active
 * root keep working until explicitly revoked).
 */
export function daemonActivationInit(input: { label?: string; force?: boolean }):
  | { ok: true; keyId: string; publicKeyPem: string; rotated: boolean }
  | { ok: false; reason: string } {
  return withActivationStoreLock(():
    | { ok: true; keyId: string; publicKeyPem: string; rotated: boolean }
    | { ok: false; reason: string } => {
    const existing = loadTrustRootStore();
    if (!existing.ok) return { ok: false, reason: existing.reason };
    const activeCount = existing.records.filter((record) => record.revokedAt === null).length;
    if (activeCount > 0 && input.force !== true) {
      return { ok: false, reason: 'trust-root-already-initialized' };
    }
    const keyPath = daemonActivationOperatorKeyPath();
    if (pathEntryPresent(keyPath) && input.force !== true) {
      return { ok: false, reason: 'operator-key-file-already-exists' };
    }
    const { privateKeyPem, publicKeyPem } = generateDaemonActivationOperatorKeypair();
    const keyId = sanitizeKeyId(`${hostname()}-${randomBytes(4).toString('hex')}`);
    const now = new Date().toISOString();
    const record: DaemonActivationTrustRootRecord = {
      keyId,
      publicKeyPem,
      createdAt: now,
      revokedAt: null,
      label: (input.label ?? '').slice(0, MAX_LABEL_LENGTH),
    };
    const home = resolve(homedir());
    assurePrivateDirectory(daemonActivationDirPath(), home);
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    let fd: number | undefined;
    try {
      if (pathEntryPresent(keyPath)) unlinkSync(keyPath);
      fd = openSync(keyPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, PRIVATE_FILE_MODE);
      const initial = fstatSync(fd, { bigint: true });
      if (!safeOwnedFile(initial) || initial.size !== 0n) throw new Error('unsafe-operator-key-file');
      fchmodSync(fd, PRIVATE_FILE_MODE);
      writeAll(fd, Buffer.from(privateKeyPem, 'utf8'));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      const keyAssurance = assurePrivateStoragePath(keyPath, 'file', 'secure-created', { anchorPath: home });
      if (!keyAssurance.ok) throw new Error(`unsafe-operator-key-path:${keyAssurance.reason}`);
      fsyncDirectory(dirname(keyPath));
    } catch (error) {
      return { ok: false, reason: (error as Error).message || 'operator-key-write-failed' };
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* best-effort */ }
      }
    }
    writeCanonicalJsonArrayFileAtomic(daemonActivationTrustRootsPath(), [...existing.records, record], home);
    auditActivationEvent(
      'daemon-activation:init',
      `trust root registered: keyId=${keyId} label=${JSON.stringify(record.label)} rotated=${activeCount > 0}`,
      'ok',
    );
    return { ok: true, keyId, publicKeyPem, rotated: activeCount > 0 };
  });
}

export function daemonActivationRevokeTrustRoot(keyId: string): { ok: true } | { ok: false; reason: string } {
  if (!KEY_ID_RE.test(keyId)) return { ok: false, reason: 'invalid-key-id' };
  return withActivationStoreLock((): { ok: true } | { ok: false; reason: string } => {
    const existing = loadTrustRootStore();
    if (!existing.ok) return { ok: false, reason: existing.reason };
    const index = existing.records.findIndex((record) => record.keyId === keyId);
    if (index === -1) return { ok: false, reason: 'trust-root-not-found' };
    if (existing.records[index]!.revokedAt !== null) {
      auditActivationEvent('daemon-activation:revoke-root', `trust root already revoked: keyId=${keyId}`, 'ok');
      return { ok: true };
    }
    const revokedAt = new Date().toISOString();
    const updated = existing.records.map((record, i) => (i === index ? { ...record, revokedAt } : record));
    writeCanonicalJsonArrayFileAtomic(daemonActivationTrustRootsPath(), updated, resolve(homedir()));
    auditActivationEvent('daemon-activation:revoke-root', `trust root revoked: keyId=${keyId}`, 'ok');
    return { ok: true };
  });
}

export function daemonActivationRevokeGrant(grantId: string): { ok: true } | { ok: false; reason: string } {
  if (!ID_RE.test(grantId)) return { ok: false, reason: 'invalid-grant-id' };
  return withActivationStoreLock((): { ok: true } | { ok: false; reason: string } => {
    const existing = loadGrantStore();
    if (!existing.ok) return { ok: false, reason: existing.reason };
    const index = existing.records.findIndex((record) => record.grantId === grantId);
    if (index === -1) return { ok: false, reason: 'grant-not-found' };
    if (existing.records[index]!.revokedAt !== null) {
      auditActivationEvent('daemon-activation:revoke-grant', `standing grant already revoked: grantId=${grantId}`, 'ok');
      return { ok: true };
    }
    const revokedAt = new Date().toISOString();
    const updated = existing.records.map((record, i) => (i === index ? { ...record, revokedAt } : record));
    writeCanonicalJsonArrayFileAtomic(daemonActivationGrantsPath(), updated, resolve(homedir()));
    auditActivationEvent('daemon-activation:revoke-grant', `standing grant revoked: grantId=${grantId}`, 'ok');
    return { ok: true };
  });
}

/** Mints a signed, expiring standing grant (conductor/automerge/repair/deploy/install/proposalOnly). */
export function daemonActivationMintStandingGrant(input: { scope: DaemonActivationGrantScope; ttlMs: number }):
  | { ok: true; record: DaemonActivationGrantRecord }
  | { ok: false; reason: string } {
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > MAX_STANDING_GRANT_VALIDITY_MS) {
    return { ok: false, reason: 'invalid-grant-ttl' };
  }
  if (!validScope(input.scope)) return { ok: false, reason: 'invalid-grant-scope' };
  return withActivationStoreLock((): { ok: true; record: DaemonActivationGrantRecord } | { ok: false; reason: string } => {
    const trustStore = loadTrustRootStore();
    if (!trustStore.ok) return { ok: false, reason: trustStore.reason };
    const active = trustStore.records.filter((record) => record.revokedAt === null);
    if (active.length === 0) return { ok: false, reason: 'no-trusted-activation-roots' };
    if (active.length > 1) return { ok: false, reason: 'ambiguous-signing-key-run-activation-status' };
    const root = active[0]!;
    let privateKeyPem: string;
    try {
      privateKeyPem = readOperatorPrivateKeyPem();
    } catch (error) {
      return { ok: false, reason: (error as Error).message || 'operator-key-unreadable' };
    }
    const existingGrants = loadGrantStore();
    if (!existingGrants.ok) return { ok: false, reason: existingGrants.reason };
    const now = Date.now();
    const record = signDaemonActivationGrant({
      grantId: randomBytes(16).toString('hex'),
      keyId: root.keyId,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + input.ttlMs).toISOString(),
      scope: input.scope,
      privateKey: privateKeyPem,
    });
    writeCanonicalJsonArrayFileAtomic(daemonActivationGrantsPath(), [...existingGrants.records, record], resolve(homedir()));
    auditActivationEvent(
      'daemon-activation:grant',
      `standing grant minted: grantId=${record.grantId} keyId=${root.keyId} `
      + `scope=${canonicalizeDaemonActivationValue(record.scope)} expiresAt=${record.expiresAt}`,
      'ok',
    );
    return { ok: true, record };
  });
}

/**
 * Mints and pins a single-use activation permit (once/resident scopes) to
 * daemonActivationPermitPath(), ready for `ashlr daemon start` to consume.
 * Signs against THIS exact machine's current build (executable/entrypoint/
 * release-tree hashes) — an operator runs this locally, immediately before
 * starting the daemon it authorizes.
 */
export function daemonActivationMintOneShotPermit(input: { cfg: AshlrConfig; scope: DaemonActivationGrantScope }):
  | { ok: true; permitId: string; permitPath: string; expiresAt: string }
  | { ok: false; reason: string } {
  if (!validScope(input.scope)) return { ok: false, reason: 'invalid-grant-scope' };
  return withActivationStoreLock(():
    | { ok: true; permitId: string; permitPath: string; expiresAt: string }
    | { ok: false; reason: string } => {
    const trustStore = loadTrustRootStore();
    if (!trustStore.ok) return { ok: false, reason: trustStore.reason };
    const active = trustStore.records.filter((record) => record.revokedAt === null);
    if (active.length === 0) return { ok: false, reason: 'no-trusted-activation-roots' };
    if (active.length > 1) return { ok: false, reason: 'ambiguous-signing-key-run-activation-status' };
    const root = active[0]!;
    let privateKeyPem: string;
    try {
      privateKeyPem = readOperatorPrivateKeyPem();
    } catch (error) {
      return { ok: false, reason: (error as Error).message || 'operator-key-unreadable' };
    }
    let configSnapshot: AshlrConfig;
    try {
      configSnapshot = strictConfigSnapshot(input.cfg);
    } catch {
      return { ok: false, reason: 'activation-config-not-strict-json' };
    }
    // Cheap, context-independent check first: no point collecting a full
    // runtime context (file hashing, release-tree walk) if there is already
    // a pending permit occupying the single fixed path.
    const permitPath = daemonActivationPermitPath();
    if (pathEntryPresent(permitPath)) return { ok: false, reason: 'activation-permit-already-pending' };
    let context: DaemonActivationRuntimeContext;
    try {
      context = collectRuntimeContext(configSnapshot);
    } catch (error) {
      return { ok: false, reason: `runtime-context-unavailable:${(error as Error).message}` };
    }
    if (!context.killSwitchOff) return { ok: false, reason: 'kill-switch-is-on' };
    if (!context.guardHealthHealthy) return { ok: false, reason: 'guard-health-degraded' };
    if (!validBuildIdentity(context.buildIdentity)) {
      // Most commonly: a `git` provenance build with a dirty working tree
      // (dist/ was built from uncommitted changes). Fail closed — a permit
      // bound to an untrusted build identity would never verify anyway.
      return { ok: false, reason: 'runtime-build-identity-untrusted' };
    }
    const now = Date.now();
    const permitId = randomBytes(16).toString('hex');
    let payload: DaemonActivationPermitPayload;
    let envelope: DaemonActivationPermitEnvelope;
    try {
      payload = buildDaemonActivationPermitPayload({
        permitId,
        nonce: randomBytes(32).toString('hex'),
        keyId: root.keyId,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + MAX_VALIDITY_MS).toISOString(),
        scope: input.scope,
        context,
      });
      envelope = signDaemonActivationPermit(payload, privateKeyPem);
    } catch (error) {
      return { ok: false, reason: (error as Error).message || 'activation-permit-build-failed' };
    }
    const home = resolve(homedir());
    assurePrivateDirectory(dirname(permitPath), home);
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    let fd: number | undefined;
    try {
      fd = openSync(permitPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, PRIVATE_FILE_MODE);
      const initial = fstatSync(fd, { bigint: true });
      if (!safeOwnedFile(initial) || initial.size !== 0n) throw new Error('unsafe-activation-permit-file');
      fchmodSync(fd, PRIVATE_FILE_MODE);
      const bytes = Buffer.from(`${canonicalizeDaemonActivationValue(envelope)}\n`, 'utf8');
      writeAll(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      const assurance = assurePrivateStoragePath(permitPath, 'file', 'secure-created', { anchorPath: home });
      if (!assurance.ok) throw new Error(`unsafe-activation-permit-path:${assurance.reason}`);
      fsyncDirectory(dirname(permitPath));
    } catch (error) {
      return { ok: false, reason: (error as Error).message || 'activation-permit-write-failed' };
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* best-effort */ }
      }
    }
    auditActivationEvent(
      'daemon-activation:grant',
      `one-shot permit minted: permitId=${permitId} keyId=${root.keyId} `
      + `scope=${canonicalizeDaemonActivationValue(input.scope)} expiresAt=${payload.expiresAt}`,
      'ok',
    );
    return { ok: true, permitId, permitPath, expiresAt: payload.expiresAt };
  });
}

// ---------------------------------------------------------------------------
// One-shot permit inspection / consumption — `ashlr daemon start` [--once].
// ---------------------------------------------------------------------------

function activationReadiness(
  state: DaemonActivationReadiness['state'],
  reason: string,
  trustRootCount: number,
  extra?: {
    requestedShape?: DaemonActivationReadiness['requestedShape'];
    residentAuthorized?: boolean;
    residentStandingAuthorized?: boolean;
    installAuthorized?: boolean;
    repairAuthorized?: boolean;
  },
): DaemonActivationReadiness {
  return {
    schemaVersion: 1,
    policyVersion: POLICY_VERSION,
    authority: 'observation-only',
    sourceState: state === 'degraded' ? 'degraded' : 'healthy',
    state,
    commandEligible: state === 'ready',
    requestedShape: extra?.requestedShape ?? 'proposal-once',
    trustRootCount,
    residentAuthorized: extra?.residentAuthorized ?? false,
    residentStandingAuthorized: extra?.residentStandingAuthorized ?? false,
    installAuthorized: extra?.installAuthorized ?? false,
    repairAuthorized: extra?.repairAuthorized ?? false,
    reason,
  };
}

/** Maps the internal scope-key shape to the DaemonActivationReadiness label. */
function requestedShapeLabel(shape: 'once' | 'resident'): DaemonActivationReadiness['requestedShape'] {
  return shape === 'once' ? 'proposal-once' : 'resident';
}

/**
 * What activation shape (if any) `opts` is structurally eligible to have
 * authorized at all — independent of whether any permit/trust root exists.
 * `null` means "denied before ever reading a permit," matching the pre-M470
 * behavior for drain modes and any dry-run other than {once:true,dryRun:true}.
 */
function requestedActivationShape(opts: DaemonActivationOptions): 'once' | 'resident' | null {
  if (opts.drain !== undefined || opts.drainLimit !== undefined) return null;
  if (opts.dryRun === true) return null;
  if (opts.once === true) return 'once';
  if (opts.once === false) return 'resident';
  return null;
}

function needsPermit(opts: DaemonActivationOptions): boolean {
  return !(opts.once === true && opts.dryRun === true);
}

export interface DaemonActivationPendingPermitBindingDiagnosis {
  ok: boolean;
  reason: string;
  /** Field name -> {signed at mint time, computed right now}. Only present for mismatched fields. */
  mismatches?: Record<string, { signed: unknown; current: unknown }>;
}

/**
 * Read-only diagnostic (never authorizes, never consumes) for `ashlr
 * activation status`: peeks the pending one-shot permit, recomputes the
 * current runtime context, and reports exactly which binding field(s)
 * differ and what the two values were. `permit-runtime-binding-mismatch`
 * alone can't tell an operator what to fix — this can.
 */
export function daemonActivationDiagnosePendingPermitBindings(
  cfg: AshlrConfig,
): DaemonActivationPendingPermitBindingDiagnosis {
  const permitPath = daemonActivationPermitPath();
  let pinned: PinnedPermitFile;
  try {
    pinned = openPinnedPermit(permitPath, resolve(homedir()));
  } catch (error) {
    return {
      ok: false,
      reason: (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'activation-permit-missing'
        : 'activation-permit-inspection-failed',
    };
  }
  try {
    let envelope: unknown;
    try {
      envelope = JSON.parse(pinned.text) as unknown;
    } catch {
      return { ok: false, reason: 'invalid-permit-json' };
    }
    const parsed = parseEnvelope(envelope);
    if (!parsed) return { ok: false, reason: 'invalid-permit-schema' };

    let configSnapshot: AshlrConfig;
    try {
      configSnapshot = strictConfigSnapshot(cfg);
    } catch {
      return { ok: false, reason: 'activation-config-not-strict-json' };
    }
    let context: DaemonActivationRuntimeContext;
    try {
      context = collectRuntimeContext(configSnapshot);
    } catch (error) {
      return { ok: false, reason: `runtime-context-unavailable:${(error as Error).message}` };
    }
    if (!context.killSwitchOff) return { ok: false, reason: 'kill-switch-is-on' };
    if (!context.guardHealthHealthy) return { ok: false, reason: 'guard-health-degraded' };

    const expectedBindings: DaemonActivationPermitPayload['bindings'] = {
      configDigest: context.configDigest,
      buildIdentity: context.buildIdentity,
      executable: context.executable,
      entrypoint: context.entrypoint,
      releaseTree: context.releaseTree,
      authorityStateDigest: context.authorityStateDigest,
      killSwitch: 'off',
      guardHealth: 'healthy',
    };
    const mismatchedKeys = bindingFieldMismatches(parsed.payload.bindings, expectedBindings);
    if (mismatchedKeys.length === 0) return { ok: true, reason: 'bindings-match' };
    const mismatches: Record<string, { signed: unknown; current: unknown }> = {};
    for (const key of mismatchedKeys) {
      mismatches[key] = { signed: parsed.payload.bindings[key], current: expectedBindings[key] };
    }
    return { ok: false, reason: 'permit-runtime-binding-mismatch', mismatches };
  } finally {
    try { closeSync(pinned.fd); } catch { /* diagnostic-only; best-effort close */ }
  }
}

function inspectPinnedActivationPermit(
  pinned: PinnedPermitFile,
  permitPath: string,
  cfg: AshlrConfig,
  trustRoots: readonly DaemonActivationTrustRoot[],
  suppliedContext: DaemonActivationRuntimeContext | undefined,
  requestedShape: 'once' | 'resident',
  standingAuth: { install: boolean; repair: boolean; residentStanding: boolean },
): DaemonActivationReadiness {
  const shapeLabel = requestedShapeLabel(requestedShape);
  const extraBase = {
    requestedShape: shapeLabel,
    installAuthorized: standingAuth.install,
    repairAuthorized: standingAuth.repair,
    residentStandingAuthorized: standingAuth.residentStanding,
  };
  let envelope: unknown;
  try {
    envelope = JSON.parse(pinned.text) as unknown;
  } catch {
    return activationReadiness('degraded', 'invalid-permit-json', trustRoots.length, extraBase);
  }
  if (`${canonicalizeDaemonActivationValue(envelope)}\n` !== pinned.text) {
    return activationReadiness('degraded', 'noncanonical-permit-encoding', trustRoots.length, extraBase);
  }
  const parsed = parseEnvelope(envelope);
  if (!parsed) {
    return activationReadiness('degraded', 'invalid-permit-schema', trustRoots.length, extraBase);
  }

  let configSnapshot: AshlrConfig;
  try {
    configSnapshot = strictConfigSnapshot(cfg);
  } catch {
    return activationReadiness('degraded', 'activation-config-not-strict-json', trustRoots.length, extraBase);
  }
  const context = suppliedContext ?? collectRuntimeContext(configSnapshot);
  if (context.configDigest !== daemonActivationConfigDigest(configSnapshot)) {
    return activationReadiness('blocked', 'runtime-config-digest-mismatch', trustRoots.length, extraBase);
  }
  const verification = verifyDaemonActivationPermit(parsed, context, trustRoots);
  if (!verification.ok || !verification.permitId) {
    return activationReadiness('blocked', verification.reason, trustRoots.length, extraBase);
  }
  const residentAuthorized = parsed.payload.scope.resident === true;
  if (parsed.payload.scope[requestedShape] !== true) {
    return activationReadiness(
      'blocked',
      'activation-permit-scope-does-not-grant-requested-shape',
      trustRoots.length,
      { ...extraBase, residentAuthorized },
    );
  }

  const nonceDigest = sha256(parsed.payload.nonce);
  if (
    pathEntryPresent(daemonActivationReceiptPath(verification.permitId))
    || pathEntryPresent(daemonActivationNonceReceiptPath(nonceDigest))
  ) {
    return activationReadiness('blocked', 'activation-permit-already-consumed', trustRoots.length, { ...extraBase, residentAuthorized });
  }

  const openedAfterInspection = fstatSync(pinned.fd, { bigint: true });
  const namedAfterInspection = lstatSync(permitPath, { bigint: true });
  if (!sameFileSnapshot(pinned.stat, openedAfterInspection)
    || !sameFileSnapshot(openedAfterInspection, namedAfterInspection)) {
    return activationReadiness('degraded', 'activation-permit-changed-during-inspection', trustRoots.length, { ...extraBase, residentAuthorized });
  }
  const readyReason = requestedShape === 'once' ? 'valid-proposal-once-permit' : 'valid-resident-permit';
  return activationReadiness('ready', readyReason, trustRoots.length, { ...extraBase, residentAuthorized });
}

function inspectWithAuthority(
  cfg: AshlrConfig,
  opts: DaemonActivationOptions,
  trustRoots: readonly DaemonActivationTrustRoot[],
  suppliedContext: DaemonActivationRuntimeContext | undefined,
): DaemonActivationReadiness {
  const standingAuth = {
    install: daemonActivationScopeGranted('install').granted,
    repair: daemonActivationScopeGranted('repair').granted,
    residentStanding: daemonActivationScopeGranted('residentStanding').granted,
  };
  const standingAuthorizedFields = {
    installAuthorized: standingAuth.install,
    repairAuthorized: standingAuth.repair,
    residentStandingAuthorized: standingAuth.residentStanding,
  };
  if (!needsPermit(opts)) {
    return activationReadiness(
      'ready',
      'dry-run-once-does-not-require-activation-permit',
      trustRoots.length,
      standingAuthorizedFields,
    );
  }
  const requestedShape = requestedActivationShape(opts);
  if (!requestedShape) {
    return activationReadiness(
      'blocked',
      'activation-permit-cannot-authorize-requested-start-shape',
      trustRoots.length,
      standingAuthorizedFields,
    );
  }
  const shapeLabel = requestedShapeLabel(requestedShape);
  if (trustRoots.length === 0) {
    return activationReadiness('blocked', 'no-trusted-activation-roots', 0, {
      requestedShape: shapeLabel,
      ...standingAuthorizedFields,
    });
  }
  // A valid standing `residentStanding` grant means `daemon start` (resident)
  // would succeed RIGHT NOW without ever touching the one-shot permit file —
  // report that directly instead of inspecting a possibly-stale/unreadable
  // one-shot permit that resident no longer depends on. This is the fix for
  // status previously showing `resident: degraded
  // (activation-permit-inspection-failed)` when a stale one-shot permit file
  // was lying around: that inspection is simply skipped once a standing grant
  // covers it.
  if (requestedShape === 'resident' && standingAuth.residentStanding) {
    return activationReadiness(
      'ready',
      'ready-via-standing-resident-grant',
      trustRoots.length,
      { requestedShape: shapeLabel, residentAuthorized: true, ...standingAuthorizedFields },
    );
  }

  const permitPath = daemonActivationPermitPath();
  let pinned: PinnedPermitFile | undefined;
  let result: DaemonActivationReadiness;
  try {
    pinned = openPinnedPermit(permitPath, resolve(homedir()));
    result = inspectPinnedActivationPermit(
      pinned,
      permitPath,
      cfg,
      trustRoots,
      suppliedContext,
      requestedShape,
      standingAuth,
    );
  } catch (error) {
    result = activationReadiness(
      (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'blocked' : 'degraded',
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'activation-permit-missing'
        : 'activation-permit-inspection-failed',
      trustRoots.length,
      { requestedShape: shapeLabel, installAuthorized: standingAuth.install, repairAuthorized: standingAuth.repair },
    );
  }
  if (pinned) {
    try {
      closeSync(pinned.fd);
    } catch {
      return activationReadiness(
        'degraded',
        'activation-permit-close-failed',
        trustRoots.length,
        { requestedShape: shapeLabel, installAuthorized: standingAuth.install, repairAuthorized: standingAuth.repair },
      );
    }
  }
  return result;
}

function consumeWithAuthority(
  cfg: AshlrConfig,
  opts: DaemonActivationOptions,
  trustRoots: readonly DaemonActivationTrustRoot[],
  suppliedContext: DaemonActivationRuntimeContext | undefined,
  afterReceiptPersisted: (() => void) | undefined,
  mayMintCapability: boolean,
): DaemonActivationPermitResult {
  if (!needsPermit(opts)) {
    return {
      authorized: true,
      required: false,
      reason: 'dry-run-once-does-not-require-activation-permit',
    };
  }
  const requestedShape = requestedActivationShape(opts);
  if (!requestedShape) {
    return {
      authorized: false,
      required: true,
      reason: 'activation-permit-cannot-authorize-requested-start-shape',
    };
  }
  if (trustRoots.length === 0) {
    return { authorized: false, required: true, reason: 'no-trusted-activation-roots' };
  }
  let configSnapshot: AshlrConfig;
  try {
    configSnapshot = strictConfigSnapshot(cfg);
  } catch {
    return { authorized: false, required: true, reason: 'activation-config-not-strict-json' };
  }

  const home = resolve(homedir());
  const permitPath = daemonActivationPermitPath();
  const lockPath = join(dirname(permitPath), 'daemon-activation-permit.lock');
  const lock = acquireLocalStoreLock(lockPath, LOCK_WAIT_MS, {
    anchorPath: home,
    exactPrivateStorage: true,
  });
  if (!lock) return { authorized: false, required: true, reason: 'activation-permit-lock-unavailable' };

  let pinned: PinnedPermitFile | undefined;
  let result: DaemonActivationPermitResult = {
    authorized: false,
    required: true,
    reason: 'activation-permit-consumption-failed',
  };
  try {
    pinned = openPinnedPermit(permitPath, home);
    let envelope: unknown;
    try {
      envelope = JSON.parse(pinned.text) as unknown;
    } catch {
      result = { authorized: false, required: true, reason: 'invalid-permit-json' };
      return result;
    }
    if (`${canonicalizeDaemonActivationValue(envelope)}\n` !== pinned.text) {
      result = {
        authorized: false,
        required: true,
        reason: 'noncanonical-permit-encoding',
      };
      return result;
    }
    const context = suppliedContext ?? collectRuntimeContext(configSnapshot);
    if (context.configDigest !== daemonActivationConfigDigest(configSnapshot)) {
      result = { authorized: false, required: true, reason: 'runtime-config-digest-mismatch' };
      return result;
    }
    const verification = verifyDaemonActivationPermit(envelope, context, trustRoots);
    if (!verification.ok || !verification.permitId || !verification.payloadDigest) {
      result = { authorized: false, required: true, reason: verification.reason };
      return result;
    }
    const parsed = parseEnvelope(envelope);
    if (!parsed) {
      result = { authorized: false, required: true, reason: 'invalid-permit-schema' };
      return result;
    }
    if (parsed.payload.scope[requestedShape] !== true) {
      result = {
        authorized: false,
        required: true,
        reason: 'activation-permit-scope-does-not-grant-requested-shape',
        permitId: verification.permitId,
      };
      return result;
    }

    const receiptsDir = dirname(daemonActivationReceiptPath(verification.permitId));
    assurePrivateDirectory(receiptsDir, home);
    const receiptPath = daemonActivationReceiptPath(verification.permitId);
    const nonceDigest = sha256(parsed.payload.nonce);
    const nonceReceiptPath = daemonActivationNonceReceiptPath(nonceDigest);
    assurePrivateDirectory(dirname(nonceReceiptPath), home);
    const receipt = {
      schemaVersion: 1,
      state: 'consumed-before-permit-unlink',
      permitId: verification.permitId,
      keyId: parsed.payload.keyId,
      payloadDigest: verification.payloadDigest,
      nonceDigest,
      configDigest: context.configDigest,
      buildRevision: context.buildIdentity.revision,
      consumedAt: new Date(context.nowMs).toISOString(),
    };
    try {
      persistReceipt(nonceReceiptPath, {
        ...receipt,
        index: 'nonce',
      }, home);
      persistReceipt(receiptPath, receipt, home);
    } catch (error) {
      result = {
        authorized: false,
        required: true,
        reason: (error as NodeJS.ErrnoException).code === 'EEXIST'
          ? 'activation-permit-already-consumed'
          : 'activation-receipt-persistence-failed',
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
        reason: 'activation-interrupted-after-durable-receipt',
        permitId: verification.permitId,
        receiptPath,
      };
      return result;
    }

    if (suppliedContext === undefined) {
      const postReceiptContext = collectRuntimeContext(configSnapshot);
      const postVerification = verifyDaemonActivationPermit(
        parsed,
        postReceiptContext,
        trustRoots,
      );
      if (!postVerification.ok) {
        result = {
          authorized: false,
          required: true,
          reason: `post-receipt-${postVerification.reason}`,
          permitId: verification.permitId,
          receiptPath,
        };
        return result;
      }
    }

    const openedAfterReceipt = fstatSync(pinned.fd, { bigint: true });
    const namedAfterReceipt = lstatSync(permitPath, { bigint: true });
    if (!sameFileSnapshot(pinned.stat, openedAfterReceipt)
      || !sameFileSnapshot(openedAfterReceipt, namedAfterReceipt)) {
      result = {
        authorized: false,
        required: true,
        reason: 'activation-permit-changed-before-unlink',
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
      reason: requestedShape === 'once' ? 'proposal-once-activation-authorized' : 'resident-activation-authorized',
      permitId: verification.permitId,
      receiptPath,
      ...(mayMintCapability
        ? {
            capability: mintCapability(verification.permitId, parsed.payload.scope, () => {
              const claimContext = collectRuntimeContext(configSnapshot);
              return verifyDaemonActivationPermit(
                parsed,
                claimContext,
                trustRoots,
              ).ok;
            }),
            configSnapshot,
          }
        : {}),
    };
    return result;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    result = {
      authorized: false,
      required: true,
      reason: code === 'ENOENT' ? 'activation-permit-missing' : 'activation-permit-consumption-failed',
    };
    return result;
  } finally {
    if (pinned) {
      try {
        closeSync(pinned.fd);
      } catch {
        result.authorized = false;
        result.reason = 'activation-permit-close-failed';
        delete result.capability;
      }
    }
    if (!releaseLocalStoreLock(lock)) {
      result.authorized = false;
      result.reason = 'activation-permit-lock-release-failed';
      delete result.capability;
    }
  }
}

/**
 * Runtime entrypoint. Trust roots come ONLY from the operator-owned store
 * (see loadDaemonActivationTrustRoots); an npm consumer who never runs
 * `ashlr activation init` sees the store as empty and gets today's exact
 * denial. Every consume attempt — authorized or refused — is audited.
 */
export function consumeDaemonActivationPermit(
  cfg: AshlrConfig,
  opts: DaemonActivationOptions,
): DaemonActivationPermitResult {
  // A resident start tries the standing `residentStanding` grant FIRST. This
  // is what makes an unattended, launchd/systemd/Task-Scheduler-triggered
  // restart after reboot possible: there is nobody present to mint a fresh
  // one-shot permit, but a still-valid, still-signed, non-revoked standing
  // grant needs no human in the loop. It goes through every check
  // `daemonActivationScopeGranted` does (platform, kill switch, guard health,
  // trust root, expiry, revocation, signature) — deliberately NOT the
  // one-shot permit's build-identity binding, matching every other standing
  // grant (conductor/install/automerge/repair/deploy), because a standing
  // grant must keep working across routine rebuilds within its expiry
  // window. If no standing grant matches, this falls through to the
  // one-shot permit path unchanged — an operator who has only ever granted
  // the one-shot form (or nothing) sees EXACTLY today's behavior.
  if (requestedActivationShape(opts) === 'resident') {
    const standing = findGrantedRecord('residentStanding');
    if (standing.granted) {
      const result: DaemonActivationPermitResult = {
        authorized: true,
        required: true,
        reason: `resident-standing-activation-authorized:${standing.record.grantId}`,
        scope: standing.record.scope,
        grantId: standing.record.grantId,
      };
      auditActivationEvent(
        'daemon-activation:consume',
        `daemon activation consume authorized: ${result.reason}`,
        'ok',
      );
      return result;
    }
    auditActivationEvent(
      'daemon-activation:resident-standing-check',
      `resident standing grant unavailable (${standing.reason}); falling back to one-shot permit`,
      'refused',
    );
  }
  const result = consumeWithAuthority(
    cfg,
    opts,
    loadDaemonActivationTrustRoots(),
    undefined,
    undefined,
    true,
  );
  // The dry-run-once bypass (`required: false`) never touches a permit or
  // any authority state — it is not a consume attempt, so nothing is audited.
  if (result.required) {
    auditActivationEvent(
      'daemon-activation:consume',
      `daemon activation consume ${result.authorized ? 'authorized' : 'refused'}: ${result.reason}`,
      result.authorized ? 'ok' : 'refused',
    );
  }
  return result;
}

/**
 * Read-only advisory inspection. A ready result is never authority: daemon
 * start must still reopen, revalidate, durably consume, and mint a capability.
 */
export function inspectDaemonActivationPermit(
  cfg: AshlrConfig,
  opts: DaemonActivationOptions,
): DaemonActivationReadiness {
  return inspectWithAuthority(
    cfg,
    opts,
    loadDaemonActivationTrustRoots(),
    undefined,
  );
}

/** Test-only inspection with injected roots/context; it cannot mint authority. */
export function inspectDaemonActivationPermitForVerification(
  cfg: AshlrConfig,
  opts: DaemonActivationOptions,
  options: DaemonActivationPermitTestInspectionOptions,
): DaemonActivationReadiness {
  return inspectWithAuthority(
    cfg,
    opts,
    options.trustRoots,
    options.context,
  );
}

/**
 * Testable consumption path. It exercises signature, replay, locking, and
 * durability with injected roots, but deliberately cannot mint authority.
 */
export function consumeDaemonActivationPermitForVerification(
  cfg: AshlrConfig,
  opts: DaemonActivationOptions,
  options: DaemonActivationPermitTestConsumerOptions,
): DaemonActivationPermitResult {
  return consumeWithAuthority(
    cfg,
    opts,
    options.trustRoots,
    options.context,
    options.afterReceiptPersisted,
    false,
  );
}

// ---------------------------------------------------------------------------
// Dormant signed one-shot goal-conductor authority.
//
// This is deliberately a separate protocol from M461. A daemon permit can
// never authorize a goal advance, and a conductor permit can never authorize a
// daemon tick. Production roots remain empty; only verification tests inject a
// root. A reviewed source change is therefore still required before live use.
// ---------------------------------------------------------------------------

const GOAL_CONDUCTOR_POLICY_VERSION = 'goal-conductor-proposal-once-v1';
const GOAL_CONDUCTOR_SIGNING_DOMAIN = 'ashlr:goal-conductor-activation-permit:v1\0';
export const GOAL_CONDUCTOR_ONCE_MAX_TOKENS = 50_000;
export const GOAL_CONDUCTOR_ONCE_MAX_STEPS = 12;

const goalConductorCapabilityBrand: unique symbol = Symbol(
  'ashlr.goal-conductor-activation-capability',
);

export interface GoalConductorActivationTarget {
  goalId: string;
  milestoneId: string;
  goalDigest: string;
  projectPath: string;
}

export interface GoalConductorActivationContext extends DaemonActivationRuntimeContext {
  target: GoalConductorActivationTarget;
}

export interface GoalConductorActivationPermitPayload {
  schemaVersion: 1;
  policyVersion: typeof GOAL_CONDUCTOR_POLICY_VERSION;
  permitId: string;
  nonce: string;
  keyId: string;
  issuedAt: string;
  expiresAt: string;
  scope: {
    action: 'goal-conductor-proposal-once';
    once: true;
    dryRun: false;
    resident: false;
    maxGoals: 1;
    maxMilestones: 1;
    maxRetries: 0;
    allowCloud: false;
    allowAnyRepo: false;
    daemonFallback: false;
    proposalOnly: true;
    automerge: false;
    repair: false;
    deploy: false;
    install: false;
    selfTarget: false;
    maxTokens: typeof GOAL_CONDUCTOR_ONCE_MAX_TOKENS;
    maxSteps: typeof GOAL_CONDUCTOR_ONCE_MAX_STEPS;
  };
  bindings: DaemonActivationPermitPayload['bindings'] & {
    target: GoalConductorActivationTarget;
  };
}

export interface GoalConductorActivationPermitEnvelope {
  payload: GoalConductorActivationPermitPayload;
  signature: string;
}

export interface GoalConductorActivationCapability {
  readonly kind: 'goal-conductor-proposal-once';
  readonly permitId: string;
  readonly target: Readonly<GoalConductorActivationTarget>;
  readonly [goalConductorCapabilityBrand]: true;
}

export interface GoalConductorActivationPermitResult {
  authorized: boolean;
  reason: string;
  permitId?: string;
  receiptPath?: string;
  capability?: GoalConductorActivationCapability;
  configSnapshot?: AshlrConfig;
}

export interface GoalConductorActivationTestConsumerOptions {
  trustRoots: readonly DaemonActivationTrustRoot[];
  context?: GoalConductorActivationContext;
  afterReceiptPersisted?: () => void;
}

/** Immutable repository-owned roots. Intentionally empty in production. */
export const GOAL_CONDUCTOR_ACTIVATION_TRUST_ROOTS:
readonly Readonly<DaemonActivationTrustRoot>[] = Object.freeze([]);

const validGoalConductorCapabilities = new WeakMap<object, () => boolean>();

function validGoalConductorTarget(value: unknown): value is GoalConductorActivationTarget {
  return isRecord(value)
    && hasExactKeys(value, ['goalId', 'milestoneId', 'goalDigest', 'projectPath'])
    && typeof value['goalId'] === 'string'
    && value['goalId'].length > 0
    && value['goalId'].length <= 256
    && typeof value['milestoneId'] === 'string'
    && value['milestoneId'].length > 0
    && value['milestoneId'].length <= 320
    && DIGEST_RE.test(String(value['goalDigest']))
    && typeof value['projectPath'] === 'string'
    && isAbsolute(value['projectPath']);
}

function validGoalConductorScope(
  value: unknown,
): value is GoalConductorActivationPermitPayload['scope'] {
  if (!isRecord(value) || !hasExactKeys(value, [
    'action', 'once', 'dryRun', 'resident', 'maxGoals', 'maxMilestones',
    'maxRetries', 'allowCloud', 'allowAnyRepo', 'daemonFallback',
    'proposalOnly', 'automerge', 'repair', 'deploy', 'install', 'selfTarget',
    'maxTokens', 'maxSteps',
  ])) return false;
  return value['action'] === 'goal-conductor-proposal-once'
    && value['once'] === true
    && value['dryRun'] === false
    && value['resident'] === false
    && value['maxGoals'] === 1
    && value['maxMilestones'] === 1
    && value['maxRetries'] === 0
    && value['allowCloud'] === false
    && value['allowAnyRepo'] === false
    && value['daemonFallback'] === false
    && value['proposalOnly'] === true
    && value['automerge'] === false
    && value['repair'] === false
    && value['deploy'] === false
    && value['install'] === false
    && value['selfTarget'] === false
    && value['maxTokens'] === GOAL_CONDUCTOR_ONCE_MAX_TOKENS
    && value['maxSteps'] === GOAL_CONDUCTOR_ONCE_MAX_STEPS;
}

function parseGoalConductorPayload(value: unknown): GoalConductorActivationPermitPayload | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion', 'policyVersion', 'permitId', 'nonce', 'keyId',
    'issuedAt', 'expiresAt', 'scope', 'bindings',
  ])) return null;
  if (value['schemaVersion'] !== 1
    || value['policyVersion'] !== GOAL_CONDUCTOR_POLICY_VERSION
    || typeof value['permitId'] !== 'string'
    || !ID_RE.test(value['permitId'])
    || typeof value['nonce'] !== 'string'
    || !DIGEST_RE.test(value['nonce'])
    || typeof value['keyId'] !== 'string'
    || !KEY_ID_RE.test(value['keyId'])
    || !validIsoTimestamp(value['issuedAt'])
    || !validIsoTimestamp(value['expiresAt'])
    || !validGoalConductorScope(value['scope'])
    || !isRecord(value['bindings'])
    || !hasExactKeys(value['bindings'], [
      'configDigest', 'buildIdentity', 'executable', 'entrypoint', 'releaseTree',
      'authorityStateDigest', 'killSwitch', 'guardHealth', 'target',
    ])
    || !validBindings({
      configDigest: value['bindings']['configDigest'],
      buildIdentity: value['bindings']['buildIdentity'],
      executable: value['bindings']['executable'],
      entrypoint: value['bindings']['entrypoint'],
      releaseTree: value['bindings']['releaseTree'],
      authorityStateDigest: value['bindings']['authorityStateDigest'],
      killSwitch: value['bindings']['killSwitch'],
      guardHealth: value['bindings']['guardHealth'],
    })
    || !validGoalConductorTarget(value['bindings']['target'])) return null;
  return value as unknown as GoalConductorActivationPermitPayload;
}

export function parseGoalConductorActivationPermitEnvelope(
  value: unknown,
): GoalConductorActivationPermitEnvelope | null {
  if (!isRecord(value) || !hasExactKeys(value, ['payload', 'signature'])) return null;
  const payload = parseGoalConductorPayload(value['payload']);
  if (!payload || typeof value['signature'] !== 'string') return null;
  const bytes = Buffer.from(value['signature'], 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== value['signature']) return null;
  return { payload, signature: value['signature'] };
}

function goalConductorSigningBytes(payload: GoalConductorActivationPermitPayload): Buffer {
  return Buffer.from(
    `${GOAL_CONDUCTOR_SIGNING_DOMAIN}${canonicalizeDaemonActivationValue(payload)}`,
    'utf8',
  );
}

export function buildGoalConductorActivationPermitPayload(input: {
  permitId: string;
  nonce: string;
  keyId: string;
  issuedAt: string;
  expiresAt: string;
  context: GoalConductorActivationContext;
}): GoalConductorActivationPermitPayload {
  const payload: GoalConductorActivationPermitPayload = {
    schemaVersion: 1,
    policyVersion: GOAL_CONDUCTOR_POLICY_VERSION,
    permitId: input.permitId,
    nonce: input.nonce,
    keyId: input.keyId,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    scope: {
      action: 'goal-conductor-proposal-once', once: true, dryRun: false,
      resident: false, maxGoals: 1, maxMilestones: 1, maxRetries: 0,
      allowCloud: false, allowAnyRepo: false, daemonFallback: false,
      proposalOnly: true, automerge: false, repair: false, deploy: false,
      install: false, selfTarget: false,
      maxTokens: GOAL_CONDUCTOR_ONCE_MAX_TOKENS,
      maxSteps: GOAL_CONDUCTOR_ONCE_MAX_STEPS,
    },
    bindings: {
      configDigest: input.context.configDigest,
      buildIdentity: { ...input.context.buildIdentity },
      executable: { ...input.context.executable },
      entrypoint: { ...input.context.entrypoint },
      releaseTree: { ...input.context.releaseTree },
      authorityStateDigest: input.context.authorityStateDigest,
      killSwitch: 'off', guardHealth: 'healthy',
      target: { ...input.context.target },
    },
  };
  if (!parseGoalConductorPayload(payload)) throw new Error('invalid goal conductor permit payload input');
  return payload;
}

export function signGoalConductorActivationPermit(
  payload: GoalConductorActivationPermitPayload,
  privateKey: string | KeyObject,
): GoalConductorActivationPermitEnvelope {
  if (!parseGoalConductorPayload(payload)) throw new Error('invalid goal conductor permit payload');
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('goal conductor activation permits require an Ed25519 private key');
  }
  return { payload, signature: sign(null, goalConductorSigningBytes(payload), key).toString('base64') };
}

export function verifyGoalConductorActivationPermit(
  value: unknown,
  context: GoalConductorActivationContext,
  roots: readonly DaemonActivationTrustRoot[],
): DaemonActivationPermitVerification {
  if (roots.length === 0) return { ok: false, reason: 'no-trusted-goal-conductor-activation-roots' };
  const envelope = parseGoalConductorActivationPermitEnvelope(value);
  if (!envelope) return { ok: false, reason: 'invalid-goal-conductor-permit-schema' };
  if (!Number.isSafeInteger(context.nowMs) || context.nowMs < 0
    || !validGoalConductorTarget(context.target)
    || !context.killSwitchOff || !context.guardHealthHealthy
    || !validBuildIdentity(context.buildIdentity)
    || !validFileBinding(context.executable)
    || !validFileBinding(context.entrypoint)
    || !validFileBinding(context.releaseTree)
    || !DIGEST_RE.test(context.configDigest)
    || !DIGEST_RE.test(context.authorityStateDigest)) {
    return { ok: false, reason: 'invalid-runtime-goal-conductor-context' };
  }
  const issuedAt = Date.parse(envelope.payload.issuedAt);
  const expiresAt = Date.parse(envelope.payload.expiresAt);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_VALIDITY_MS) {
    return { ok: false, reason: 'invalid-goal-conductor-permit-validity-window' };
  }
  if (issuedAt > context.nowMs + MAX_FUTURE_SKEW_MS) return { ok: false, reason: 'permit-issued-too-far-in-future' };
  if (expiresAt <= context.nowMs) return { ok: false, reason: 'permit-expired' };
  const expectedBindings = {
    configDigest: context.configDigest,
    buildIdentity: context.buildIdentity,
    executable: context.executable,
    entrypoint: context.entrypoint,
    releaseTree: context.releaseTree,
    authorityStateDigest: context.authorityStateDigest,
    killSwitch: 'off', guardHealth: 'healthy', target: context.target,
  };
  if (!equalCanonical(envelope.payload.bindings, expectedBindings)) {
    return { ok: false, reason: 'goal-conductor-permit-runtime-binding-mismatch' };
  }
  const trusted = trustRootMap(roots);
  const publicKey = trusted?.get(envelope.payload.keyId);
  if (!publicKey) return { ok: false, reason: trusted ? 'permit-key-not-trusted' : 'invalid-trust-root-set' };
  if (!verify(null, goalConductorSigningBytes(envelope.payload), publicKey, Buffer.from(envelope.signature, 'base64'))) {
    return { ok: false, reason: 'invalid-permit-signature' };
  }
  return {
    ok: true,
    reason: 'valid-goal-conductor-proposal-once-permit',
    permitId: envelope.payload.permitId,
    payloadDigest: sha256(canonicalizeDaemonActivationValue(envelope.payload)),
  };
}

export function goalConductorActivationPermitPath(): string {
  return join(
    homedir(), '.ashlr', 'control', 'goal-conductor-permit-publication',
    'records', 'goal-conductor-activation-permit.json',
  );
}

export function goalConductorActivationReceiptPath(permitId: string): string {
  if (!ID_RE.test(permitId)) throw new Error('invalid goal conductor activation permit id');
  return join(homedir(), '.ashlr', 'control', 'activation-receipts', 'goal-conductor', `${permitId}.json`);
}

export function goalConductorActivationNonceReceiptPath(nonceDigest: string): string {
  if (!DIGEST_RE.test(nonceDigest)) throw new Error('invalid goal conductor nonce digest');
  return join(
    homedir(), '.ashlr', 'control', 'activation-receipts', 'goal-conductor',
    'by-nonce', `${nonceDigest}.json`,
  );
}

/** Collect the same read-only runtime binding used at permit consumption. */
export function collectGoalConductorActivationContext(
  cfg: AshlrConfig,
  target: GoalConductorActivationTarget,
): GoalConductorActivationContext {
  if (!validGoalConductorTarget(target)) {
    throw new Error('invalid goal conductor target');
  }
  return { ...collectRuntimeContext(strictConfigSnapshot(cfg)), target: { ...target } };
}

function mintGoalConductorCapability(
  permitId: string,
  target: GoalConductorActivationTarget,
  validateAtClaim: () => boolean,
): GoalConductorActivationCapability {
  const capability = Object.freeze({
    kind: 'goal-conductor-proposal-once' as const,
    permitId,
    target: Object.freeze({ ...target }),
    [goalConductorCapabilityBrand]: true as const,
  });
  validGoalConductorCapabilities.set(capability, validateAtClaim);
  return capability;
}

export function isGoalConductorActivationCapability(
  value: unknown,
  target: GoalConductorActivationTarget,
): value is GoalConductorActivationCapability {
  if (typeof value !== 'object' || value === null) return false;
  const validate = validGoalConductorCapabilities.get(value);
  if (!validate) return false;
  validGoalConductorCapabilities.delete(value);
  const capability = value as GoalConductorActivationCapability;
  try {
    return equalCanonical(capability.target, target) && validate();
  } catch {
    return false;
  }
}

function consumeGoalConductorWithAuthority(
  cfg: AshlrConfig,
  target: GoalConductorActivationTarget,
  roots: readonly DaemonActivationTrustRoot[],
  suppliedContext?: GoalConductorActivationContext,
  afterReceiptPersisted?: () => void,
  mayMintCapability = false,
): GoalConductorActivationPermitResult {
  if (roots.length === 0) return { authorized: false, reason: 'no-trusted-goal-conductor-activation-roots' };
  if (process.platform === 'win32') return { authorized: false, reason: 'goal-conductor-activation-v1-unsupported-on-windows' };
  let configSnapshot: AshlrConfig;
  try { configSnapshot = strictConfigSnapshot(cfg); } catch {
    return { authorized: false, reason: 'activation-config-not-strict-json' };
  }
  const home = resolve(homedir());
  const permitPath = goalConductorActivationPermitPath();
  const lock = acquireLocalStoreLock(`${permitPath}.lock`, LOCK_WAIT_MS, {
    anchorPath: home, exactPrivateStorage: true,
  });
  if (!lock) return { authorized: false, reason: 'goal-conductor-permit-lock-unavailable' };
  let pinned: PinnedPermitFile | undefined;
  let result: GoalConductorActivationPermitResult = {
    authorized: false, reason: 'goal-conductor-permit-consumption-failed',
  };
  try {
    pinned = openPinnedPermit(permitPath, home);
    const envelope = JSON.parse(pinned.text) as unknown;
    if (`${canonicalizeDaemonActivationValue(envelope)}\n` !== pinned.text) {
      result = { authorized: false, reason: 'noncanonical-goal-conductor-permit-encoding' };
      return result;
    }
    const parsed = parseGoalConductorActivationPermitEnvelope(envelope);
    if (!parsed) {
      result = { authorized: false, reason: 'invalid-goal-conductor-permit-schema' };
      return result;
    }
    const context = suppliedContext ?? { ...collectRuntimeContext(configSnapshot), target };
    if (context.configDigest !== daemonActivationConfigDigest(configSnapshot)) {
      result = { authorized: false, reason: 'runtime-config-digest-mismatch' };
      return result;
    }
    if (!equalCanonical(context.target, target)) {
      result = { authorized: false, reason: 'goal-conductor-target-context-mismatch' };
      return result;
    }
    const checked = verifyGoalConductorActivationPermit(parsed, context, roots);
    if (!checked.ok || !checked.permitId || !checked.payloadDigest) {
      result = { authorized: false, reason: checked.reason };
      return result;
    }
    const receiptPath = goalConductorActivationReceiptPath(checked.permitId);
    assurePrivateDirectory(dirname(dirname(receiptPath)), home);
    assurePrivateDirectory(dirname(receiptPath), home);
    const nonceDigest = sha256(parsed.payload.nonce);
    const nonceReceiptPath = goalConductorActivationNonceReceiptPath(nonceDigest);
    assurePrivateDirectory(dirname(nonceReceiptPath), home);
    const receipt = {
      schemaVersion: 1,
      state: 'consumed-before-permit-unlink',
      action: 'goal-conductor-proposal-once',
      permitId: checked.permitId,
      keyId: parsed.payload.keyId,
      payloadDigest: checked.payloadDigest,
      configDigest: context.configDigest,
      goalId: target.goalId,
      milestoneId: target.milestoneId,
      goalDigest: target.goalDigest,
      consumedAt: new Date(context.nowMs).toISOString(),
    };
    try {
      persistReceipt(nonceReceiptPath, { ...receipt, index: 'nonce', nonceDigest }, home);
      persistReceipt(receiptPath, receipt, home);
    } catch (error) {
      result = {
        authorized: false,
        reason: (error as NodeJS.ErrnoException).code === 'EEXIST'
          ? 'goal-conductor-permit-already-consumed'
          : 'goal-conductor-receipt-persistence-failed',
        permitId: checked.permitId,
        receiptPath,
      };
      return result;
    }
    try { afterReceiptPersisted?.(); } catch {
      result = {
        authorized: false, reason: 'goal-conductor-activation-interrupted-after-durable-receipt',
        permitId: checked.permitId, receiptPath,
      };
      return result;
    }
    const opened = fstatSync(pinned.fd, { bigint: true });
    const named = lstatSync(permitPath, { bigint: true });
    if (!sameFileSnapshot(pinned.stat, opened) || !sameFileSnapshot(opened, named)) {
      result = {
        authorized: false, reason: 'goal-conductor-permit-changed-before-unlink',
        permitId: checked.permitId, receiptPath,
      };
      return result;
    }
    unlinkSync(permitPath);
    fsyncDirectory(dirname(permitPath));
    result = {
      authorized: true,
      reason: 'goal-conductor-proposal-once-activation-authorized',
      permitId: checked.permitId,
      receiptPath,
      ...(mayMintCapability ? {
        capability: mintGoalConductorCapability(checked.permitId, target, () => {
          const claimContext = { ...collectRuntimeContext(configSnapshot), target };
          return verifyGoalConductorActivationPermit(parsed, claimContext, roots).ok;
        }),
        configSnapshot,
      } : {}),
    };
    return result;
  } catch (error) {
    result = {
      authorized: false,
      reason: (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'goal-conductor-activation-permit-missing'
        : 'goal-conductor-permit-consumption-failed',
    };
    return result;
  } finally {
    if (pinned) {
      try { closeSync(pinned.fd); } catch {
        result.authorized = false;
        result.reason = 'goal-conductor-permit-close-failed';
        delete result.capability;
      }
    }
    if (!releaseLocalStoreLock(lock)) {
      result.authorized = false;
      result.reason = 'goal-conductor-permit-lock-release-failed';
      delete result.capability;
    }
  }
}

export function consumeGoalConductorActivationPermit(
  cfg: AshlrConfig,
  target: GoalConductorActivationTarget,
): GoalConductorActivationPermitResult {
  return consumeGoalConductorWithAuthority(
    cfg, target, GOAL_CONDUCTOR_ACTIVATION_TRUST_ROOTS, undefined, undefined, true,
  );
}

export function consumeGoalConductorActivationPermitForVerification(
  cfg: AshlrConfig,
  target: GoalConductorActivationTarget,
  options: GoalConductorActivationTestConsumerOptions,
): GoalConductorActivationPermitResult {
  return consumeGoalConductorWithAuthority(
    cfg, target, options.trustRoots, options.context, options.afterReceiptPersisted, false,
  );
}
