import {
  createHash,
  createPrivateKey,
  createPublicKey,
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
import { killSwitchOn, readEnrollmentRegistry } from '../sandbox/policy.js';
import type { AshlrConfig } from '../types.js';
import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { diagnoseGuardHealth } from './guard-health.js';
import {
  DAEMON_ACTIVATION_TRUST_ROOTS,
  type DaemonActivationTrustRoot,
} from './activation-trust-roots.js';

export { DAEMON_ACTIVATION_TRUST_ROOTS } from './activation-trust-roots.js';
export type { DaemonActivationTrustRoot } from './activation-trust-roots.js';

const POLICY_VERSION = 'm461-proposal-once-v1';
const SIGNING_DOMAIN = 'ashlr:daemon-activation-permit:m461:v1\0';
const MAX_PERMIT_BYTES = 32 * 1024;
const MAX_VALIDITY_MS = 120_000;
const MAX_FUTURE_SKEW_MS = 30_000;
const LOCK_WAIT_MS = 2_000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DIGEST_RE = /^[a-f0-9]{64}$/u;
const ID_RE = /^[a-f0-9]{32}$/u;
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

const capabilityBrand: unique symbol = Symbol('ashlr.daemon-activation-capability');

/**
 * Runtime authority is nominal and process-local. Objects that merely match
 * this public shape are rejected by isDaemonActivationCapability().
 */
export interface DaemonActivationCapability {
  readonly kind: 'proposal-once';
  readonly permitId: string;
  readonly [capabilityBrand]: true;
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
}

export interface DaemonActivationReadiness {
  schemaVersion: 1;
  policyVersion: typeof POLICY_VERSION;
  authority: 'observation-only';
  sourceState: 'healthy' | 'degraded';
  state: 'ready' | 'blocked' | 'degraded';
  commandEligible: boolean;
  requestedShape: 'proposal-once';
  trustRootCount: number;
  residentAuthorized: false;
  installAuthorized: false;
  repairAuthorized: false;
  reason: string;
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
  scope: {
    action: 'daemon-proposal-once';
    once: true;
    dryRun: false;
    resident: false;
    drain: false;
    drainLimit: null;
    proposalOnly: true;
    automerge: false;
    repair: false;
    deploy: false;
    install: false;
    selfTarget: false;
  };
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
}

export interface DaemonActivationPermitTestConsumerOptions {
  trustRoots: readonly DaemonActivationTrustRoot[];
  context: DaemonActivationRuntimeContext;
  afterReceiptPersisted?: () => void;
}

export interface DaemonActivationPermitTestInspectionOptions {
  trustRoots: readonly DaemonActivationTrustRoot[];
  context: DaemonActivationRuntimeContext;
  platform?: NodeJS.Platform;
}

const validCapabilities = new WeakMap<object, () => boolean>();

function mintCapability(
  permitId: string,
  validateAtClaim: () => boolean,
): DaemonActivationCapability {
  const capability = Object.freeze({
    kind: 'proposal-once' as const,
    permitId,
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

/**
 * Goal and simple conductors have broader authority than M461's one-item
 * proposal profile. They remain dormant until a separately reviewed permit
 * contract exists for those entry points.
 */
export function liveConductorActivationAuthorized(): boolean {
  return false;
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

function validScope(value: unknown): value is DaemonActivationPermitPayload['scope'] {
  if (!isRecord(value) || !hasExactKeys(value, [
    'action',
    'once',
    'dryRun',
    'resident',
    'drain',
    'drainLimit',
    'proposalOnly',
    'automerge',
    'repair',
    'deploy',
    'install',
    'selfTarget',
  ])) return false;
  return value['action'] === 'daemon-proposal-once'
    && value['once'] === true
    && value['dryRun'] === false
    && value['resident'] === false
    && value['drain'] === false
    && value['drainLimit'] === null
    && value['proposalOnly'] === true
    && value['automerge'] === false
    && value['repair'] === false
    && value['deploy'] === false
    && value['install'] === false
    && value['selfTarget'] === false;
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
    return { ok: false, reason: 'permit-runtime-binding-mismatch' };
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
  context: DaemonActivationRuntimeContext;
}): DaemonActivationPermitPayload {
  const payload: DaemonActivationPermitPayload = {
    schemaVersion: 1,
    policyVersion: POLICY_VERSION,
    permitId: input.permitId,
    nonce: input.nonce,
    keyId: input.keyId,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    scope: {
      action: 'daemon-proposal-once',
      once: true,
      dryRun: false,
      resident: false,
      drain: false,
      drainLimit: null,
      proposalOnly: true,
      automerge: false,
      repair: false,
      deploy: false,
      install: false,
      selfTarget: false,
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

function currentAuthorityStateDigest(): string {
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
      mtimeNs: state.mtimeNs.toString(),
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
    authorityStateDigest: currentAuthorityStateDigest(),
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

function activationReadiness(
  state: DaemonActivationReadiness['state'],
  reason: string,
  trustRootCount: number,
): DaemonActivationReadiness {
  return {
    schemaVersion: 1,
    policyVersion: POLICY_VERSION,
    authority: 'observation-only',
    sourceState: state === 'degraded' ? 'degraded' : 'healthy',
    state,
    commandEligible: state === 'ready',
    requestedShape: 'proposal-once',
    trustRootCount,
    residentAuthorized: false,
    installAuthorized: false,
    repairAuthorized: false,
    reason,
  };
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

function inspectPinnedActivationPermit(
  pinned: PinnedPermitFile,
  permitPath: string,
  cfg: AshlrConfig,
  trustRoots: readonly DaemonActivationTrustRoot[],
  suppliedContext: DaemonActivationRuntimeContext | undefined,
): DaemonActivationReadiness {
  let envelope: unknown;
  try {
    envelope = JSON.parse(pinned.text) as unknown;
  } catch {
    return activationReadiness('degraded', 'invalid-permit-json', trustRoots.length);
  }
  if (`${canonicalizeDaemonActivationValue(envelope)}\n` !== pinned.text) {
    return activationReadiness('degraded', 'noncanonical-permit-encoding', trustRoots.length);
  }
  const parsed = parseEnvelope(envelope);
  if (!parsed) {
    return activationReadiness('degraded', 'invalid-permit-schema', trustRoots.length);
  }

  let configSnapshot: AshlrConfig;
  try {
    configSnapshot = strictConfigSnapshot(cfg);
  } catch {
    return activationReadiness('degraded', 'activation-config-not-strict-json', trustRoots.length);
  }
  const context = suppliedContext ?? collectRuntimeContext(configSnapshot);
  if (context.configDigest !== daemonActivationConfigDigest(configSnapshot)) {
    return activationReadiness('blocked', 'runtime-config-digest-mismatch', trustRoots.length);
  }
  const verification = verifyDaemonActivationPermit(parsed, context, trustRoots);
  if (!verification.ok || !verification.permitId) {
    return activationReadiness('blocked', verification.reason, trustRoots.length);
  }

  const nonceDigest = sha256(parsed.payload.nonce);
  if (
    pathEntryPresent(daemonActivationReceiptPath(verification.permitId))
    || pathEntryPresent(daemonActivationNonceReceiptPath(nonceDigest))
  ) {
    return activationReadiness('blocked', 'activation-permit-already-consumed', trustRoots.length);
  }

  const openedAfterInspection = fstatSync(pinned.fd, { bigint: true });
  const namedAfterInspection = lstatSync(permitPath, { bigint: true });
  if (!sameFileSnapshot(pinned.stat, openedAfterInspection)
    || !sameFileSnapshot(openedAfterInspection, namedAfterInspection)) {
    return activationReadiness('degraded', 'activation-permit-changed-during-inspection', trustRoots.length);
  }
  return activationReadiness('ready', 'valid-proposal-once-permit', trustRoots.length);
}

function inspectWithAuthority(
  cfg: AshlrConfig,
  opts: DaemonActivationOptions,
  trustRoots: readonly DaemonActivationTrustRoot[],
  suppliedContext: DaemonActivationRuntimeContext | undefined,
  platform: NodeJS.Platform = process.platform,
): DaemonActivationReadiness {
  if (!needsPermit(opts)) {
    return activationReadiness(
      'ready',
      'dry-run-once-does-not-require-activation-permit',
      trustRoots.length,
    );
  }
  if (!supportedProposalOnceShape(opts)) {
    return activationReadiness(
      'blocked',
      'activation-permit-cannot-authorize-requested-start-shape',
      trustRoots.length,
    );
  }
  if (trustRoots.length === 0) {
    return activationReadiness('blocked', 'no-trusted-activation-roots', 0);
  }
  if (platform === 'win32') {
    return activationReadiness(
      'blocked',
      'activation-permit-v1-unsupported-on-windows',
      trustRoots.length,
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
    );
  } catch (error) {
    result = activationReadiness(
      (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'blocked' : 'degraded',
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'activation-permit-missing'
        : 'activation-permit-inspection-failed',
      trustRoots.length,
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
      );
    }
  }
  return result;
}

function needsPermit(opts: DaemonActivationOptions): boolean {
  return !(opts.once === true && opts.dryRun === true);
}

function supportedProposalOnceShape(opts: DaemonActivationOptions): boolean {
  return opts.once === true
    && opts.dryRun !== true
    && opts.drain === undefined
    && opts.drainLimit === undefined;
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
  if (!supportedProposalOnceShape(opts)) {
    return {
      authorized: false,
      required: true,
      reason: 'activation-permit-cannot-authorize-requested-start-shape',
    };
  }
  if (trustRoots.length === 0) {
    return { authorized: false, required: true, reason: 'no-trusted-activation-roots' };
  }
  if (process.platform === 'win32') {
    return {
      authorized: false,
      required: true,
      reason: 'activation-permit-v1-unsupported-on-windows',
    };
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
      reason: 'proposal-once-activation-authorized',
      permitId: verification.permitId,
      receiptPath,
      ...(mayMintCapability
        ? {
            capability: mintCapability(verification.permitId, () => {
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
 * Runtime entrypoint. Its immutable repository-owned roots are the only path
 * that can mint an in-process activation capability.
 */
export function consumeDaemonActivationPermit(
  cfg: AshlrConfig,
  opts: DaemonActivationOptions,
): DaemonActivationPermitResult {
  return consumeWithAuthority(
    cfg,
    opts,
    DAEMON_ACTIVATION_TRUST_ROOTS,
    undefined,
    undefined,
    true,
  );
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
    DAEMON_ACTIVATION_TRUST_ROOTS,
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
    options.platform,
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
