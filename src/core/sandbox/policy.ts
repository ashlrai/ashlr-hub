/**
 * policy.ts — Enrollment registry + kill switch (the gate).
 *
 * SAFETY RULES:
 *  - Enrollment registry persisted at ~/.ashlr/enrollment.json, DEFAULT EMPTY.
 *  - Kill switch backed by the presence of ~/.ashlr/KILL file.
 *  - assertMayMutate ALWAYS throws when the kill switch is on, regardless of
 *    enrollment or allowAnyRepo. allowAnyRepo ONLY bypasses the enrollment
 *    check (for tests operating on tmp repos) — it NEVER bypasses the kill switch.
 *  - enroll/unenroll normalize repo paths to absolute via path.resolve().
 *  - All functions are idempotent; never throw except the intentional assert.
 *  - No new runtime deps; node builtins only.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import {
  currentProcessStartIdentity,
  type ProcessStartIdentitySource,
} from '../fleet/local-store-lock.js';
import type { Enrollment } from '../types.js';
import { fsyncDirectory } from '../util/durability.js';
import {
  acquireOutwardMutationFence,
  ownsOutwardMutationFence,
  releaseOutwardMutationFence,
  type OutwardMutationFence,
} from './mutation-fence.js';
// H6 (PART A — audit completeness): emit an audit() record inside
// enroll/unenroll/setKill so EVERY path (CLI cmdEnroll OR any programmatic
// caller — fixture, daemon, onboard) is captured — see
// docs/contracts/CONTRACT-H6.md §A.2. audit.ts imports only node builtins + a
// `type` from ../types.js and does NOT import policy.ts, so this static import
// creates NO import cycle (re-verified by an H6 [STATIC] test). Metadata only:
// action verb + repo abs path (a path is NOT a secret) + 'ok'.
import { audit } from './audit.js';

// ---------------------------------------------------------------------------
// Path helpers (re-resolved at call time so tests can relocate HOME)
// ---------------------------------------------------------------------------

function canonicalHome(): string | null {
  try {
    const home = homedir();
    if (typeof home !== 'string' || home.length === 0 || !isAbsolute(home)) return null;
    return resolve(home);
  } catch {
    return null;
  }
}

function canonicalWindowsPath(value: string, foldCase: boolean): string | null {
  let normalized = win32.normalize(value);
  if (/^\\\\\?\\UNC\\/iu.test(normalized)) {
    normalized = `\\\\${normalized.slice('\\\\?\\UNC\\'.length)}`;
  } else if (/^\\\\\?\\[A-Za-z]:\\/u.test(normalized)) {
    normalized = normalized.slice('\\\\?\\'.length);
  }

  const driveAbsolute = /^[A-Za-z]:\\/u.test(normalized);
  const uncAbsolute = /^\\\\[^\\]+\\[^\\]+(?:\\|$)/u.test(normalized);
  if ((!driveAbsolute && !uncAbsolute) || !win32.isAbsolute(normalized)) return null;
  const suffix = normalized.slice(win32.parse(normalized).root.length);
  if (suffix.includes('"') || /(?:^|\\)[A-Za-z]:\\/u.test(suffix)) return null;
  return foldCase ? normalized.toLowerCase() : normalized;
}

/** Resolve physical aliases while retaining a deterministic identity for a missing suffix. */
export function canonicalFilesystemPathIdentity(
  value: string,
  options: { foldWindowsCase?: boolean } = {},
): string | null {
  let ancestor: string;
  try {
    ancestor = resolve(value);
  } catch {
    return null;
  }
  const missing: string[] = [];
  let uncertainWindowsSuffix = false;

  while (true) {
    try {
      lstatSync(ancestor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        // Windows may surface UNKNOWN for a missing child below an 8.3-spelled
        // ancestor. Defer that one case until an existing parent can prove the
        // first unresolved component is absent; every other error fails closed.
        if (process.platform !== 'win32' || code !== 'UNKNOWN') return null;
        uncertainWindowsSuffix = true;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) return null;
      missing.push(basename(ancestor));
      ancestor = parent;
      continue;
    }

    try {
      if (uncertainWindowsSuffix) {
        const firstMissing = missing.at(-1);
        if (!firstMissing || /~\d/u.test(firstMissing)) return null;
        const entries = readdirSync(ancestor);
        if (entries.some((entry) => entry.toLowerCase() === firstMissing.toLowerCase())) return null;
      }
      const canonicalAncestor = realpathSync.native(ancestor);
      const canonical = join(canonicalAncestor, ...missing.reverse());
      return process.platform === 'win32'
        ? canonicalWindowsPath(canonical, options.foldWindowsCase !== false)
        : canonical;
    } catch {
      // The prefix was observable but could not be resolved physically. Do not
      // reinterpret permission, replacement, or platform errors as absence.
      return null;
    }
  }
}

/** Persist enrollment authority by full physical target on every platform. */
export function canonicalEnrollmentPath(value: string): string | null {
  return canonicalFilesystemPathIdentity(value, { foldWindowsCase: false });
}

function ashlrDir(): string {
  const home = canonicalHome();
  if (!home) throw new Error('invalid home directory for policy authority');
  return join(home, '.ashlr');
}

/** Path to the enrollment registry file. */
export function enrollmentPath(): string {
  return join(ashlrDir(), 'enrollment.json');
}

/** Path to the kill-switch sentinel file. */
export function killSwitchPath(): string {
  return join(ashlrDir(), 'KILL');
}

// ---------------------------------------------------------------------------
// Internal I/O helpers
// ---------------------------------------------------------------------------

const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_ENROLLED_REPOS = 2_048;
const MAX_REPO_PATH_BYTES = 8 * 1024;
const MAX_REGISTRY_TRANSACTION_BYTES = 2_048;
const KILL_SENTINEL_BYTES = Buffer.from('kill switch active\n', 'utf8');
const DIGEST_RE = /^[a-f0-9]{64}$/;
const NONCE_RE = /^[a-f0-9]{32}$/;

interface RegistryReadResult {
  ok: boolean;
  registry: Enrollment;
  reason: string;
  bytes: Buffer | null;
}

interface RegistryTransaction {
  path: string;
  identity: Stats;
  bytes: Buffer;
  record: RegistryTransactionRecord;
}

interface RegistryTransactionPayload {
  version: 2;
  state: 'prepared';
  pid: number;
  startRef: string;
  startRefVerified: boolean;
  startRefSource: ProcessStartIdentitySource | null;
  nonce: string;
  beforeDigest: string | null;
  afterDigest: string;
  tempName: string;
  backupName: string;
}

interface RegistryTransactionRecord extends RegistryTransactionPayload {
  authentication: string;
}

type LegacyRegistryTransactionPayload = Omit<RegistryTransactionPayload, 'startRefSource'>;

export interface PolicyMutationResult {
  ok: boolean;
  changed: boolean;
  /** True only when the requested policy state is installed and linearized. */
  quiesced: boolean;
  reason: string;
}

export type EnrollmentRegistryReadiness =
  | {
      state: 'ready';
      recovered: boolean;
      repos: string[];
      reason: string;
    }
  | {
      state: 'degraded';
      recovered: false;
      reason: string;
    };

function ownedByCurrentUser(stat: Stats): boolean {
  return typeof process.getuid !== 'function' || Number(stat.uid) === process.getuid();
}

function safeAuthorityFileWithLinks(stat: Stats, links: readonly number[]): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && links.includes(Number(stat.nlink)) &&
    ownedByCurrentUser(stat) && (process.platform === 'win32' || (Number(stat.mode) & 0o022) === 0);
}

function safeAuthorityFile(stat: Stats): boolean {
  return safeAuthorityFileWithLinks(stat, [1]);
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function missingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function assureAshlrDir(): boolean {
  try {
    const dir = ashlrDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !ownedByCurrentUser(stat)) return false;
    if (process.platform !== 'win32') chmodSync(dir, 0o700);
    return true;
  } catch {
    return false;
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('policy write made no progress');
    offset += written;
  }
}

function registryTransactionPath(): string {
  return join(ashlrDir(), 'enrollment.transaction');
}

type AuthorityFileRead =
  | { state: 'missing' }
  | { state: 'unsafe' }
  | { state: 'present'; identity: Stats; bytes: Buffer };

function digestBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readAuthorityFile(path: string, maxBytes: number): AuthorityFileRead {
  let fd: number | undefined;
  try {
    let named: Stats;
    try {
      named = lstatSync(path);
    } catch (error) {
      return missingPath(error) ? { state: 'missing' } : { state: 'unsafe' };
    }
    if (!safeAuthorityFile(named) || named.size < 1 || named.size > maxBytes) return { state: 'unsafe' };
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!safeAuthorityFile(opened) || !sameFile(named, opened) ||
      opened.size !== named.size || opened.size > maxBytes) return { state: 'unsafe' };
    const bytes = Buffer.alloc(opened.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return { state: 'unsafe' };
    const after = fstatSync(fd);
    const namedAfter = lstatSync(path);
    if (!safeAuthorityFile(after) || !sameFile(opened, after) || !sameFile(after, namedAfter) ||
      after.size !== opened.size) return { state: 'unsafe' };
    return { state: 'present', identity: after, bytes };
  } catch {
    return { state: 'unsafe' };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort close */ } }
  }
}

interface PolicyAuthorityStartIdentity {
  ref: string;
  verified: true;
  source: ProcessStartIdentitySource;
}

let ownStartIdentity: PolicyAuthorityStartIdentity | undefined;
function currentStartIdentity(): PolicyAuthorityStartIdentity | null {
  if (ownStartIdentity === undefined) {
    const observed = currentProcessStartIdentity();
    if (!observed) return null;
    ownStartIdentity = { ...observed, verified: true };
  }
  return ownStartIdentity;
}

function transactionAuthentication(
  payload: RegistryTransactionPayload | LegacyRegistryTransactionPayload,
): string {
  return createHash('sha256')
    .update('ashlr:enrollment-transaction:v2\0')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function isProcessStartIdentitySource(value: unknown): value is ProcessStartIdentitySource {
  return value === 'self-clock-epoch-second' || value === 'ps-lstart' ||
    value === 'linux-proc-start-ticks' ||
    value === 'windows-start-ticks';
}

function transactionArtifactNames(nonce: string): { tempName: string; backupName: string } {
  return {
    tempName: `.enrollment.${nonce}.tmp`,
    backupName: `.enrollment.${nonce}.backup`,
  };
}

function transactionMarkerTempName(nonce: string): string {
  return `.enrollment.transaction.${nonce}.tmp`;
}

function parseRegistryTransaction(bytes: Buffer): RegistryTransactionRecord | null {
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    const legacyKeys = [
      'version', 'state', 'pid', 'startRef', 'startRefVerified', 'nonce',
      'beforeDigest', 'afterDigest', 'tempName', 'backupName', 'authentication',
    ];
    const hasSource = Object.prototype.hasOwnProperty.call(parsed, 'startRefSource');
    const expectedKeys = hasSource
      ? [...legacyKeys.slice(0, 5), 'startRefSource', ...legacyKeys.slice(5)]
      : legacyKeys;
    if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !keys.includes(key)) ||
      parsed['version'] !== 2 || parsed['state'] !== 'prepared' ||
      !Number.isSafeInteger(parsed['pid']) || Number(parsed['pid']) < 1 ||
      typeof parsed['startRef'] !== 'string' || !DIGEST_RE.test(parsed['startRef']) ||
      typeof parsed['startRefVerified'] !== 'boolean' ||
      (hasSource && !(parsed['startRefSource'] === null ||
        isProcessStartIdentitySource(parsed['startRefSource']))) ||
      typeof parsed['nonce'] !== 'string' || !NONCE_RE.test(parsed['nonce']) ||
      !(parsed['beforeDigest'] === null ||
        (typeof parsed['beforeDigest'] === 'string' && DIGEST_RE.test(parsed['beforeDigest']))) ||
      typeof parsed['afterDigest'] !== 'string' || !DIGEST_RE.test(parsed['afterDigest']) ||
      typeof parsed['tempName'] !== 'string' || typeof parsed['backupName'] !== 'string' ||
      typeof parsed['authentication'] !== 'string' || !DIGEST_RE.test(parsed['authentication'])) return null;
    const names = transactionArtifactNames(parsed['nonce']);
    if (parsed['tempName'] !== names.tempName || parsed['backupName'] !== names.backupName) return null;
    const common = {
      version: 2 as const,
      state: 'prepared' as const,
      pid: Number(parsed['pid']),
      startRef: parsed['startRef'],
      startRefVerified: parsed['startRefVerified'],
      nonce: parsed['nonce'],
      beforeDigest: parsed['beforeDigest'] as string | null,
      afterDigest: parsed['afterDigest'],
      tempName: parsed['tempName'],
      backupName: parsed['backupName'],
    };
    const authenticationPayload: RegistryTransactionPayload | LegacyRegistryTransactionPayload = hasSource
      ? {
          version: common.version,
          state: common.state,
          pid: common.pid,
          startRef: common.startRef,
          startRefVerified: common.startRefVerified,
          startRefSource: parsed['startRefSource'] as ProcessStartIdentitySource | null,
          nonce: common.nonce,
          beforeDigest: common.beforeDigest,
          afterDigest: common.afterDigest,
          tempName: common.tempName,
          backupName: common.backupName,
        }
      : common;
    return transactionAuthentication(authenticationPayload) === parsed['authentication']
      ? {
          ...common,
          startRefSource: hasSource
            ? parsed['startRefSource'] as ProcessStartIdentitySource | null
            : null,
          authentication: parsed['authentication'],
        }
      : null;
  } catch {
    return null;
  }
}

/** Any transaction marker, including malformed or uninspectable state, is restrictive. */
function registryTransactionIncomplete(): boolean {
  try {
    lstatSync(registryTransactionPath());
    return true;
  } catch (error) {
    return !missingPath(error);
  }
}

type TransactionMarkerFileRead =
  | { state: 'missing' }
  | { state: 'unsafe' }
  | { state: 'present'; identity: Stats; bytes: Buffer };

function readTransactionMarkerFile(path: string): TransactionMarkerFileRead {
  let fd: number | undefined;
  try {
    let named: Stats;
    try {
      named = lstatSync(path);
    } catch (error) {
      return missingPath(error) ? { state: 'missing' } : { state: 'unsafe' };
    }
    if (!safeAuthorityFileWithLinks(named, [1, 2]) || named.size > MAX_REGISTRY_TRANSACTION_BYTES) {
      return { state: 'unsafe' };
    }
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!safeAuthorityFileWithLinks(opened, [1, 2]) || !sameFile(named, opened) ||
      opened.size !== named.size) return { state: 'unsafe' };
    const bytes = Buffer.alloc(opened.size);
    if (bytes.length > 0 && readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) {
      return { state: 'unsafe' };
    }
    const after = fstatSync(fd);
    const namedAfter = lstatSync(path);
    if (!safeAuthorityFileWithLinks(after, [1, 2]) || !sameFile(opened, after) ||
      !sameFile(after, namedAfter) || after.size !== opened.size || after.nlink !== namedAfter.nlink) {
      return { state: 'unsafe' };
    }
    return { state: 'present', identity: after, bytes };
  } catch {
    return { state: 'unsafe' };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort close */ } }
  }
}

function settlePublishedTransactionMarker(
  path: string,
  read: Extract<TransactionMarkerFileRead, { state: 'present' }>,
  record: RegistryTransactionRecord,
): Extract<TransactionMarkerFileRead, { state: 'present' }> | null {
  if (read.identity.nlink === 1) return read;
  const alias = join(ashlrDir(), transactionMarkerTempName(record.nonce));
  try {
    const canonical = lstatSync(path);
    const candidate = lstatSync(alias);
    if (!safeAuthorityFileWithLinks(canonical, [2]) || !safeAuthorityFileWithLinks(candidate, [2]) ||
      !sameFile(canonical, read.identity) || !sameFile(candidate, read.identity)) return null;
    unlinkSync(alias);
    fsyncDirectory(ashlrDir());
    const settled = readTransactionMarkerFile(path);
    return settled.state === 'present' && settled.identity.nlink === 1 &&
      sameFile(settled.identity, read.identity) && settled.bytes.equals(read.bytes)
      ? settled
      : null;
  } catch {
    return null;
  }
}

function beginRegistryTransaction(record: RegistryTransactionRecord): RegistryTransaction | null {
  const path = registryTransactionPath();
  const markerTemp = join(ashlrDir(), transactionMarkerTempName(record.nonce));
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
  let fd: number | undefined;
  let published = false;
  let publicationDurable = false;
  try {
    if (!record.startRefVerified || !record.startRefSource ||
      bytes.length > MAX_REGISTRY_TRANSACTION_BYTES) return null;
    fd = openSync(
      markerTemp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const opened = fstatSync(fd);
    if (!safeAuthorityFile(opened)) return null;
    writeAll(fd, bytes);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    const prepared = readAuthorityFile(markerTemp, MAX_REGISTRY_TRANSACTION_BYTES);
    if (prepared.state !== 'present' || !sameFile(prepared.identity, opened) ||
      !prepared.bytes.equals(bytes)) return null;
    linkSync(markerTemp, path);
    published = true;
    fsyncDirectory(ashlrDir());
    publicationDurable = true;
    unlinkSync(markerTemp);
    fsyncDirectory(ashlrDir());

    const observed = readRegistryTransaction();
    return observed.state === 'present' && observed.transaction.bytes.equals(bytes)
      ? observed.transaction
      : null;
  } catch {
    if (publicationDurable) {
      const observed = readRegistryTransaction();
      if (observed.state === 'present' && observed.transaction.bytes.equals(bytes)) {
        return observed.transaction;
      }
    }
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort close */ } }
    if (!published || publicationDurable) {
      try { unlinkSync(markerTemp); } catch { /* best-effort cleanup */ }
    }
  }
}

function readRegistryTransaction():
  | { state: 'missing' }
  | { state: 'partial'; marker: Extract<TransactionMarkerFileRead, { state: 'present' }> }
  | { state: 'invalid' }
  | { state: 'present'; transaction: RegistryTransaction } {
  let path: string;
  try {
    path = registryTransactionPath();
  } catch {
    return { state: 'invalid' };
  }
  const read = readTransactionMarkerFile(path);
  if (read.state === 'missing') return read;
  if (read.state === 'unsafe') return { state: 'invalid' };
  if (read.bytes.length === 0 || read.bytes[read.bytes.length - 1] !== 0x0a) {
    if (read.bytes.length > 0) {
      try {
        JSON.parse(read.bytes.toString('utf8'));
        return { state: 'invalid' };
      } catch { /* a syntactically incomplete legacy write may be recoverable */ }
    }
    return read.identity.nlink === 1
      ? { state: 'partial', marker: read }
      : { state: 'invalid' };
  }
  const record = parseRegistryTransaction(read.bytes);
  if (!record) return { state: 'invalid' };
  const settled = settlePublishedTransactionMarker(path, read, record);
  return settled
    ? { state: 'present', transaction: { path, identity: settled.identity, bytes: settled.bytes, record } }
    : { state: 'invalid' };
}

function transactionOwnerState(record: RegistryTransactionRecord): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
  }
  // Never infer death from a process-start timestamp mismatch. Clock changes,
  // suspend/resume, and local-time ps output are not stable ownership proofs.
  // A live PID remains authoritative until the OS reports ESRCH.
  return 'alive';
}

function artifactDigestState(path: string, expected: string):
  | { state: 'missing' }
  | { state: 'match'; read: Extract<AuthorityFileRead, { state: 'present' }> }
  | { state: 'tampered' } {
  const read = readAuthorityFile(path, MAX_REGISTRY_BYTES);
  if (read.state === 'missing') return read;
  if (read.state === 'unsafe' || digestBytes(read.bytes) !== expected) return { state: 'tampered' };
  return { state: 'match', read };
}

function removeVerifiedArtifact(
  path: string,
  read: Extract<AuthorityFileRead, { state: 'present' }>,
): boolean {
  try {
    const current = lstatSync(path);
    if (!safeAuthorityFile(current) || !sameFile(current, read.identity) ||
      current.size !== read.bytes.length) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function validInitialRegistryTemp(bytes: Buffer): boolean {
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 || !Array.isArray(parsed['repos']) ||
      parsed['repos'].length < 1 || parsed['repos'].length > MAX_ENROLLED_REPOS) return false;
    const repos = new Set<string>();
    for (const value of parsed['repos']) {
      if (typeof value !== 'string' || value.length === 0 || resolve(value) !== value ||
        Buffer.byteLength(value, 'utf8') > MAX_REPO_PATH_BYTES || repos.has(value)) return false;
      repos.add(value);
    }
    return true;
  } catch {
    return false;
  }
}

function clearPartialRegistryTransaction(
  path: string,
  marker: Extract<TransactionMarkerFileRead, { state: 'present' }>,
): boolean {
  let fd: number | undefined;
  try {
    const current = lstatSync(path);
    if (!safeAuthorityFile(current) || !sameFile(current, marker.identity) ||
      current.size !== marker.bytes.length) return false;
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    const readback = Buffer.alloc(marker.bytes.length);
    if (!safeAuthorityFile(opened) || !sameFile(current, opened) ||
      (readback.length > 0 && readSync(fd, readback, 0, readback.length, 0) !== readback.length) ||
      !readback.equals(marker.bytes)) return false;
    const namedAfter = lstatSync(path);
    if (!safeAuthorityFile(namedAfter) || !sameFile(opened, namedAfter)) return false;
    closeSync(fd);
    fd = undefined;
    unlinkSync(path);
    fsyncDirectory(ashlrDir());
    try {
      lstatSync(path);
      return false;
    } catch (error) {
      return missingPath(error);
    }
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort close */ } }
  }
}

function recoverPartialInitialRegistryTransaction(
  marker: Extract<TransactionMarkerFileRead, { state: 'present' }>,
): { ok: boolean; reason: string } {
  try {
    const dir = ashlrDir();
    if (readAuthorityFile(enrollmentPath(), MAX_REGISTRY_BYTES).state !== 'missing') {
      return { ok: false, reason: 'registry-transaction-tampered' };
    }
    const entries = readdirSync(dir);
    if (entries.some((name) => /^\.enrollment\.[a-f0-9]{32}\.backup$/.test(name)) ||
      entries.some((name) => /^\.enrollment\.transaction\.[a-f0-9]{32}\.tmp$/.test(name))) {
      return { ok: false, reason: 'registry-transaction-tampered' };
    }
    const tempNames = entries.filter((name) => /^\.enrollment\.[a-f0-9]{32}\.tmp$/.test(name));
    if (tempNames.length !== 1) return { ok: false, reason: 'registry-transaction-tampered' };
    const nonce = tempNames[0]!.slice('.enrollment.'.length, -'.tmp'.length);
    const disclosedNonce = marker.bytes.toString('utf8').match(/"nonce":"([a-f0-9]{32})"/)?.[1];
    if (disclosedNonce !== undefined && disclosedNonce !== nonce) {
      return { ok: false, reason: 'registry-transaction-tampered' };
    }
    const tempPath = join(dir, tempNames[0]!);
    const temp = readAuthorityFile(tempPath, MAX_REGISTRY_BYTES);
    if (temp.state !== 'present' || !validInitialRegistryTemp(temp.bytes)) {
      return { ok: false, reason: 'registry-transaction-tampered' };
    }
    if (!clearPartialRegistryTransaction(registryTransactionPath(), marker)) {
      return { ok: false, reason: 'registry-transaction-recovery-failed' };
    }
    if (removeVerifiedArtifact(tempPath, temp)) {
      fsyncDirectory(dir);
    }
    return { ok: true, reason: 'registry-transaction-aborted-before-effect' };
  } catch {
    return { ok: false, reason: 'registry-transaction-recovery-failed' };
  }
}

function recoverRegistryTransaction(): { ok: boolean; reason: string } {
  const observed = readRegistryTransaction();
  if (observed.state === 'missing') return { ok: true, reason: 'no-transaction' };
  if (observed.state === 'partial') return recoverPartialInitialRegistryTransaction(observed.marker);
  if (observed.state === 'invalid') return { ok: false, reason: 'registry-transaction-tampered' };
  const transaction = observed.transaction;
  const owner = transactionOwnerState(transaction.record);
  if (owner !== 'dead') {
    return { ok: false, reason: `registry-transaction-owner-${owner}` };
  }

  const dir = ashlrDir();
  const dest = enrollmentPath();
  const temp = join(dir, transaction.record.tempName);
  const backup = join(dir, transaction.record.backupName);
  const destRead = readAuthorityFile(dest, MAX_REGISTRY_BYTES);
  const destDigest = destRead.state === 'present' ? digestBytes(destRead.bytes) : null;
  const destState = destRead.state === 'missing'
    ? 'missing'
    : destRead.state === 'unsafe'
      ? 'tampered'
      : destDigest === transaction.record.afterDigest
        ? 'after'
        : destDigest === transaction.record.beforeDigest
          ? 'before'
          : 'tampered';
  const tempState = artifactDigestState(temp, transaction.record.afterDigest);
  const backupState = transaction.record.beforeDigest === null
    ? readAuthorityFile(backup, MAX_REGISTRY_BYTES)
    : artifactDigestState(backup, transaction.record.beforeDigest);
  if (destState === 'tampered' || tempState.state === 'tampered' ||
    backupState.state === 'unsafe' || backupState.state === 'tampered' ||
    (transaction.record.beforeDigest === null && backupState.state === 'present')) {
    return { ok: false, reason: 'registry-transaction-tampered' };
  }

  const destIsAfter = destState === 'after';
  const destIsBefore = transaction.record.beforeDigest === null
    ? destState === 'missing'
    : destState === 'before';
  const tempPresent = tempState.state === 'match';
  const backupPresent = backupState.state === 'present' || backupState.state === 'match';
  const prepared = destIsBefore && tempPresent && !backupPresent;
  const backedUp = transaction.record.beforeDigest !== null && destState === 'missing' &&
    tempPresent && backupPresent;
  const installed = destIsAfter && !tempPresent && backupPresent;
  const committed = destIsAfter && !tempPresent && !backupPresent;
  // Recovery may itself crash after durably removing the prepared temp but
  // before clearing the marker. The authenticated pre-state plus absence of
  // both transaction artifacts is a completed rollback, not tampering.
  const rolledBack = destIsBefore && !tempPresent && !backupPresent;
  if (!prepared && !backedUp && !installed && !committed && !rolledBack) {
    return { ok: false, reason: 'registry-transaction-tampered' };
  }

  try {
    if (prepared) {
      if (tempState.state !== 'match' || !removeVerifiedArtifact(temp, tempState.read)) {
        return { ok: false, reason: 'registry-transaction-recovery-failed' };
      }
    } else if (backedUp) {
      const backupRead = backupState as { state: 'match'; read: Extract<AuthorityFileRead, { state: 'present' }> };
      const current = lstatSync(backup);
      if (!safeAuthorityFile(current) || !sameFile(current, backupRead.read.identity)) {
        return { ok: false, reason: 'registry-transaction-recovery-failed' };
      }
      renameSync(backup, dest);
      fsyncDirectory(dir);
      const restored = artifactDigestState(dest, transaction.record.beforeDigest!);
      if (restored.state !== 'match' || tempState.state !== 'match' ||
        !removeVerifiedArtifact(temp, tempState.read)) {
        return { ok: false, reason: 'registry-transaction-recovery-failed' };
      }
    } else if (installed) {
      const backupRead = backupState as { state: 'match'; read: Extract<AuthorityFileRead, { state: 'present' }> };
      if (!removeVerifiedArtifact(backup, backupRead.read)) {
        return { ok: false, reason: 'registry-transaction-recovery-failed' };
      }
    }
    fsyncDirectory(dir);
    if (!clearRegistryTransaction(transaction)) {
      return { ok: false, reason: 'registry-transaction-recovery-failed' };
    }
    return {
      ok: true,
      reason: installed || committed ? 'registry-transaction-committed' : 'registry-transaction-rolled-back',
    };
  } catch {
    return { ok: false, reason: 'registry-transaction-recovery-failed' };
  }
}

function clearRegistryTransaction(transaction: RegistryTransaction): boolean {
  let fd: number | undefined;
  try {
    const current = lstatSync(transaction.path);
    if (!safeAuthorityFile(current) || !sameFile(current, transaction.identity) ||
      current.size !== transaction.bytes.length) return false;
    fd = openSync(transaction.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    const readback = Buffer.alloc(transaction.bytes.length);
    if (!safeAuthorityFile(opened) || !sameFile(current, opened) ||
      readSync(fd, readback, 0, readback.length, 0) !== readback.length ||
      !readback.equals(transaction.bytes)) return false;
    const namedAfter = lstatSync(transaction.path);
    if (!safeAuthorityFile(namedAfter) || !sameFile(opened, namedAfter)) return false;
    closeSync(fd);
    fd = undefined;
    unlinkSync(transaction.path);
    fsyncDirectory(ashlrDir());
    try {
      lstatSync(transaction.path);
      return false;
    } catch (error) {
      return missingPath(error);
    }
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort close */ } }
  }
}

/** Missing is a valid empty registry. Existing malformed or unsafe state is degraded. */
function readRegistryDetailed(): RegistryReadResult {
  let fd: number | undefined;
  try {
    const p = enrollmentPath();
    if (registryTransactionIncomplete()) {
      return { ok: false, registry: { repos: [] }, reason: 'registry-transaction-incomplete', bytes: null };
    }
    let pathBefore: Stats;
    try {
      pathBefore = lstatSync(p);
    } catch (error) {
      if (!missingPath(error)) {
        return { ok: false, registry: { repos: [] }, reason: 'uninspectable-registry', bytes: null };
      }
      return registryTransactionIncomplete()
        ? { ok: false, registry: { repos: [] }, reason: 'registry-transaction-incomplete', bytes: null }
        : { ok: true, registry: { repos: [] }, reason: 'missing-empty', bytes: null };
    }
    if (!safeAuthorityFile(pathBefore) || pathBefore.size > MAX_REGISTRY_BYTES) {
      return { ok: false, registry: { repos: [] }, reason: 'unsafe-or-oversized-registry', bytes: null };
    }
    fd = openSync(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!safeAuthorityFile(before) || !sameFile(pathBefore, before) || before.size > MAX_REGISTRY_BYTES) {
      return { ok: false, registry: { repos: [] }, reason: 'registry-identity-changed', bytes: null };
    }
    const bytes = Buffer.alloc(before.size);
    if (before.size > 0 && readSync(fd, bytes, 0, before.size, 0) !== before.size) {
      return { ok: false, registry: { repos: [] }, reason: 'short-registry-read', bytes: null };
    }
    const after = fstatSync(fd);
    const pathAfter = lstatSync(p);
    if (!safeAuthorityFile(after) || !sameFile(before, after) || !sameFile(after, pathAfter) ||
      after.size !== before.size) {
      return { ok: false, registry: { repos: [] }, reason: 'registry-identity-changed', bytes: null };
    }
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 1 &&
      Array.isArray((parsed as Record<string, unknown>)['repos'])
    ) {
      const rawRepos = (parsed as Record<string, unknown>)['repos'] as unknown[];
      if (rawRepos.length > MAX_ENROLLED_REPOS) {
        return { ok: false, registry: { repos: [] }, reason: 'too-many-enrolled-repos', bytes: null };
      }
      const repos: string[] = [];
      for (const value of rawRepos) {
        if (typeof value !== 'string' || value.length === 0 ||
          Buffer.byteLength(value, 'utf8') > MAX_REPO_PATH_BYTES || resolve(value) !== value ||
          repos.includes(value)) {
          return { ok: false, registry: { repos: [] }, reason: 'invalid-enrollment-entry', bytes: null };
        }
        repos.push(value);
      }
      return registryTransactionIncomplete()
        ? { ok: false, registry: { repos: [] }, reason: 'registry-transaction-incomplete', bytes: null }
        : { ok: true, registry: { repos }, reason: 'healthy', bytes };
    }
  } catch {
    return { ok: false, registry: { repos: [] }, reason: 'unreadable-registry', bytes: null };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort close */ }
    }
  }
  return { ok: false, registry: { repos: [] }, reason: 'malformed-registry', bytes: null };
}

function readRegistry(): Enrollment {
  return readRegistryDetailed().registry;
}

/**
 * Recover an interrupted enrollment transaction, then return registry readiness.
 * Callers must branch on `state`; degraded results intentionally omit `repos` so
 * an unreadable registry cannot be mistaken for the valid empty default.
 */
export function recoverEnrollmentRegistry(
  opts: { waitMs?: number } = {},
): EnrollmentRegistryReadiness {
  const fence = acquireOutwardMutationFence(opts.waitMs ?? 2_000);
  if (!ownsOutwardMutationFence(fence)) {
    releaseOutwardMutationFence(fence);
    return {
      state: 'degraded',
      recovered: false,
      reason: 'outward mutation fence unavailable',
    };
  }

  try {
    const recovery = recoverRegistryTransaction();
    if (!recovery.ok) {
      return { state: 'degraded', recovered: false, reason: recovery.reason };
    }
    const read = readRegistryDetailed();
    if (!read.ok) {
      return { state: 'degraded', recovered: false, reason: read.reason };
    }
    return {
      state: 'ready',
      recovered: recovery.reason !== 'no-transaction',
      repos: [...read.registry.repos],
      reason: recovery.reason === 'no-transaction' ? read.reason : recovery.reason,
    };
  } finally {
    releaseOutwardMutationFence(fence);
  }
}

/** Persist the enrollment registry with a private unique temp and durable rename. */
function writeRegistry(reg: Enrollment, beforeBytes: Buffer | null): { ok: boolean; reason: string } {
  let dir: string;
  try {
    dir = ashlrDir();
  } catch {
    return { ok: false, reason: 'invalid-home-directory' };
  }
  let fd: number | undefined;
  let tmp: string | undefined;
  let backup: string | undefined;
  let backupInstalled = false;
  let installed: Stats | undefined;
  let installedPath = false;
  let committed = false;
  let previous: Stats | undefined;
  let transaction: RegistryTransaction | null = null;
  try {
    if (!assureAshlrDir()) return { ok: false, reason: 'unsafe-ashlr-directory' };
    const dest = enrollmentPath();
    const beforeDigest = beforeBytes === null ? null : digestBytes(beforeBytes);
    const existing = beforeDigest === null
      ? readAuthorityFile(dest, MAX_REGISTRY_BYTES)
      : artifactDigestState(dest, beforeDigest);
    if ((beforeDigest === null && existing.state !== 'missing') ||
      (beforeDigest !== null && existing.state !== 'match')) {
      return { ok: false, reason: 'enrollment-registry-changed-before-write' };
    }
    const start = currentStartIdentity();
    if (!start) return { ok: false, reason: 'registry-process-identity-unavailable' };
    const bytes = Buffer.from(`${JSON.stringify(reg, null, 2)}\n`, 'utf8');
    if (bytes.length > MAX_REGISTRY_BYTES) return { ok: false, reason: 'registry-too-large' };
    const nonce = randomBytes(16).toString('hex');
    const names = transactionArtifactNames(nonce);
    tmp = join(dir, names.tempName);
    backup = join(dir, names.backupName);
    fd = openSync(
      tmp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const opened = fstatSync(fd);
    if (!safeAuthorityFile(opened)) throw new Error('unsafe enrollment temp file');
    writeAll(fd, bytes);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const payload: RegistryTransactionPayload = {
      version: 2,
      state: 'prepared',
      pid: process.pid,
      startRef: start.ref,
      startRefVerified: start.verified,
      startRefSource: start.source,
      nonce,
      beforeDigest,
      afterDigest: digestBytes(bytes),
      tempName: names.tempName,
      backupName: names.backupName,
    };
    transaction = beginRegistryTransaction({
      ...payload,
      authentication: transactionAuthentication(payload),
    });
    if (!transaction) return { ok: false, reason: 'registry-transaction-unavailable' };
    if (beforeBytes !== null) {
      const current = lstatSync(dest);
      previous = current;
      renameSync(dest, backup);
      backupInstalled = true;
      fsyncDirectory(dir);
      const moved = lstatSync(backup);
      if (!safeAuthorityFile(moved) || !sameFile(current, moved)) {
        throw new Error('registry backup identity changed');
      }
    }
    renameSync(tmp, dest);
    installedPath = true;
    tmp = undefined;
    fsyncDirectory(dir);
    installed = lstatSync(dest);
    const installedRead = artifactDigestState(dest, payload.afterDigest);
    if (!safeAuthorityFile(installed) || installed.size !== bytes.length || installedRead.state !== 'match') {
      throw new Error('registry readback failed');
    }
    committed = true;
    if (backupInstalled) {
      const backupRead = artifactDigestState(backup, beforeDigest!);
      if (backupRead.state !== 'match' || !removeVerifiedArtifact(backup, backupRead.read)) {
        return { ok: false, reason: 'registry-commit-degraded' };
      }
      fsyncDirectory(dir);
      backupInstalled = false;
    }
    if (transaction) {
      const cleared = clearRegistryTransaction(transaction);
      if (!cleared && registryTransactionIncomplete()) {
        return { ok: false, reason: 'registry-commit-degraded' };
      }
      transaction = null;
    }
    return { ok: true, reason: 'persisted' };
  } catch {
    // A permissive policy write may never become visible while its API reports
    // failure. Restore the exact prior pathname (or prior absence) before return.
    if (!committed) {
      let rolledBack = false;
      try {
        const dest = enrollmentPath();
        if (backupInstalled && backup) {
          renameSync(backup, dest);
          backupInstalled = false;
          const restored = lstatSync(dest);
          if (!previous || !safeAuthorityFile(restored) || !sameFile(previous, restored)) {
            throw new Error('registry rollback identity changed');
          }
        } else if (installed) {
          const current = lstatSync(dest);
          if (sameFile(current, installed)) unlinkSync(dest);
        } else if (installedPath) {
          const current = lstatSync(dest);
          if (safeAuthorityFile(current)) unlinkSync(dest);
        }
        fsyncDirectory(dir);
        rolledBack = true;
      } catch { /* the durable transaction marker keeps readers fail-closed */ }
      if (rolledBack && transaction && clearRegistryTransaction(transaction)) transaction = null;
    }
    return { ok: false, reason: 'registry-write-failed' };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort close */ } }
    if (tmp && !transaction) { try { unlinkSync(tmp); } catch { /* best-effort cleanup */ } }
    // Committed residue is retained with the authenticated marker so a later
    // proven-dead recovery can validate and finish it deterministically.
  }
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

function syncExistingKillSentinel(path: string): { ok: boolean; reason: string } {
  let fd: number | undefined;
  try {
    const named = lstatSync(path);
    if (!safeAuthorityFile(named)) return { ok: false, reason: 'unsafe-kill-sentinel' };
    if (named.size !== KILL_SENTINEL_BYTES.length) return { ok: false, reason: 'invalid-kill-sentinel' };
    const access = process.platform === 'win32' ? fsConstants.O_RDWR : fsConstants.O_RDONLY;
    fd = openSync(path, access | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!safeAuthorityFile(opened) || !sameFile(named, opened) ||
      opened.size !== KILL_SENTINEL_BYTES.length) {
      return { ok: false, reason: 'kill-sentinel-identity-changed' };
    }
    const beforeSync = Buffer.alloc(KILL_SENTINEL_BYTES.length);
    if (readSync(fd, beforeSync, 0, beforeSync.length, 0) !== beforeSync.length ||
      !beforeSync.equals(KILL_SENTINEL_BYTES)) {
      return { ok: false, reason: 'invalid-kill-sentinel' };
    }
    fsyncSync(fd);
    const flushed = fstatSync(fd);
    const afterSync = Buffer.alloc(KILL_SENTINEL_BYTES.length);
    if (!safeAuthorityFile(flushed) || !sameFile(opened, flushed) ||
      flushed.size !== KILL_SENTINEL_BYTES.length ||
      readSync(fd, afterSync, 0, afterSync.length, 0) !== afterSync.length ||
      !afterSync.equals(KILL_SENTINEL_BYTES)) {
      return { ok: false, reason: 'kill-sentinel-changed-during-sync' };
    }
    closeSync(fd);
    fd = undefined;
    fsyncDirectory(ashlrDir());
    const after = lstatSync(path);
    return safeAuthorityFile(after) && sameFile(flushed, after) &&
      after.size === KILL_SENTINEL_BYTES.length
      ? { ok: true, reason: 'already-active' }
      : { ok: false, reason: 'kill-sentinel-identity-changed' };
  } catch {
    return { ok: false, reason: 'kill-sentinel-sync-failed' };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort close */ } }
  }
}

function installKillSentinel(): { ok: boolean; changed: boolean; reason: string } {
  let fd: number | undefined;
  let path: string | undefined;
  try {
    path = killSwitchPath();
    if (!assureAshlrDir()) return { ok: false, changed: false, reason: 'unsafe-ashlr-directory' };
    try {
      lstatSync(path);
      const existing = syncExistingKillSentinel(path);
      return { ...existing, changed: false };
    } catch (error) {
      if (!missingPath(error)) return { ok: false, changed: false, reason: 'uninspectable-kill-sentinel' };
    }
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const opened = fstatSync(fd);
    if (!safeAuthorityFile(opened)) return { ok: false, changed: false, reason: 'unsafe-kill-sentinel' };
    writeAll(fd, KILL_SENTINEL_BYTES);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    fsyncDirectory(ashlrDir());
    const installed = syncExistingKillSentinel(path);
    return installed.ok
      ? { ok: true, changed: true, reason: 'kill-armed' }
      : { ok: false, changed: true, reason: installed.reason };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' && path) {
      const existing = syncExistingKillSentinel(path);
      return { ...existing, changed: false };
    }
    return { ok: false, changed: false, reason: 'kill-arm-failed' };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort close */ } }
  }
}

function removeKillSentinel(): { ok: boolean; changed: boolean; reason: string } {
  let removed = false;
  try {
    const path = killSwitchPath();
    let current: Stats;
    try {
      current = lstatSync(path);
    } catch (error) {
      return missingPath(error)
        ? { ok: true, changed: false, reason: 'already-inactive' }
        : { ok: false, changed: false, reason: 'uninspectable-kill-sentinel' };
    }
    if (!safeAuthorityFile(current)) {
      return { ok: false, changed: false, reason: 'unsafe-kill-sentinel' };
    }
    unlinkSync(path);
    removed = true;
    fsyncDirectory(ashlrDir());
    try {
      lstatSync(path);
      return { ok: false, changed: true, reason: 'kill-clear-readback-failed' };
    } catch (error) {
      return missingPath(error)
        ? { ok: true, changed: true, reason: 'kill-cleared' }
        : { ok: false, changed: true, reason: 'kill-clear-readback-failed' };
    }
  } catch {
    if (removed) {
      const restored = installKillSentinel();
      const active = killSwitchOn();
      return {
        ok: false,
        changed: !active,
        reason: restored.ok && active
          ? 'kill-clear-failed-rearmed'
          : 'kill-clear-failed-state-uncertain',
      };
    }
    return { ok: false, changed: false, reason: 'kill-clear-failed' };
  }
}

/**
 * Returns true when the global kill switch is active.
 * Backed by the presence of ~/.ashlr/KILL.
 */
export function killSwitchOn(): boolean {
  try {
    lstatSync(killSwitchPath());
    return true;
  } catch (error) {
    // Any state other than a proven absence is restrictive.
    return !missingPath(error);
  }
}

/**
 * Turn the kill switch on (creates ~/.ashlr/KILL) or off (removes it).
 * Idempotent in both directions.
 */
export function setKill(on: boolean, opts: { waitMs?: number } = {}): PolicyMutationResult {
  let result: PolicyMutationResult;
  if (on) {
    // Restrictive intent is durable before waiting. A mutation already inside
    // the fence may finish, but no later effect can enter after observing KILL.
    const armed = installKillSentinel();
    if (!armed.ok) {
      result = { ok: false, changed: armed.changed, quiesced: false, reason: armed.reason };
    } else {
      const fence = acquireOutwardMutationFence(opts.waitMs ?? 2_000);
      const quiesced = ownsOutwardMutationFence(fence);
      if (!quiesced) {
        result = {
          ok: false,
          changed: armed.changed,
          quiesced: false,
          reason: 'kill armed; an outward mutation has not quiesced',
        };
      } else {
        // A concurrent resume may have cleared a pre-existing sentinel while
        // this pause waited. Reinstall and verify under the same fence.
        const confirmed = installKillSentinel();
        result = confirmed.ok && killSwitchOn()
          ? {
              ok: true,
              changed: armed.changed || confirmed.changed,
              quiesced: true,
              reason: confirmed.changed ? 'kill-rearmed' : armed.reason,
            }
          : {
              ok: false,
              changed: armed.changed || confirmed.changed,
              quiesced: false,
              reason: confirmed.ok ? 'kill-readback-failed' : confirmed.reason,
            };
      }
      releaseOutwardMutationFence(fence);
    }
  } else {
    // Resume is permissive, so it may clear KILL only while holding the fence.
    const fence = acquireOutwardMutationFence(opts.waitMs ?? 2_000);
    if (!ownsOutwardMutationFence(fence)) {
      releaseOutwardMutationFence(fence);
      result = {
        ok: false,
        changed: false,
        quiesced: false,
        reason: 'outward mutation fence unavailable; kill remains active',
      };
    } else {
      const cleared = removeKillSentinel();
      releaseOutwardMutationFence(fence);
      result = {
        ok: cleared.ok,
        changed: cleared.changed,
        quiesced: cleared.ok,
        reason: cleared.reason,
      };
    }
  }
  // H6 (§A.2): audit the kill-switch toggle on EVERY call (idempotent on disk;
  // we audit the requested intent). repo is null (not repo-scoped); summary is
  // metadata only. audit() swallows its own errors, so the "never throws"
  // contract of setKill is preserved.
  if (canonicalHome()) {
    audit({
      action: on ? 'kill:on' : 'kill:off',
      repo: null,
      sandboxId: null,
      summary: `kill switch ${on ? 'on' : 'off'}`,
      result: result.ok ? 'ok' : 'error',
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Enrollment registry
// ---------------------------------------------------------------------------

/**
 * Returns true when `repo` (normalized to absolute path) is enrolled
 * for autonomous work.
 */
export function isEnrolled(repo: string): boolean {
  const abs = canonicalEnrollmentPath(repo);
  if (!abs) return false;
  const reg = readRegistry();
  return reg.repos.includes(abs);
}

/**
 * Enroll `repo` for autonomous/sandbox mutation. Idempotent — enrolling
 * an already-enrolled repo is a no-op. Normalizes to absolute path. A caller
 * already inside the global boundary may lend its verified fence; enroll never
 * releases borrowed authority.
 */
export function enroll(
  repo: string,
  opts: { waitMs?: number; borrowedFence?: OutwardMutationFence } = {},
): PolicyMutationResult {
  const lexical = resolve(repo);
  const abs = canonicalEnrollmentPath(repo);
  const borrowed = Object.prototype.hasOwnProperty.call(opts, 'borrowedFence');
  const fence = borrowed
    ? opts.borrowedFence
    : acquireOutwardMutationFence(opts.waitMs ?? 2_000);
  let result: PolicyMutationResult;
  if (!abs) {
    result = { ok: false, changed: false, quiesced: false, reason: 'invalid-enrollment-path' };
  } else if (!ownsOutwardMutationFence(fence)) {
    result = { ok: false, changed: false, quiesced: false, reason: 'outward mutation fence unavailable' };
  } else {
    const recovery = recoverRegistryTransaction();
    const read = recovery.ok ? readRegistryDetailed() : null;
    if (!recovery.ok) {
      result = { ok: false, changed: false, quiesced: false, reason: recovery.reason };
    } else if (!read?.ok) {
      result = { ok: false, changed: false, quiesced: false, reason: read?.reason ?? 'unreadable-registry' };
    } else if (read.registry.repos.includes(abs)) {
      result = { ok: true, changed: false, quiesced: true, reason: 'already-enrolled' };
    } else if (read.registry.repos.length >= MAX_ENROLLED_REPOS ||
      Buffer.byteLength(abs, 'utf8') > MAX_REPO_PATH_BYTES) {
      result = { ok: false, changed: false, quiesced: false, reason: 'enrollment-capacity-exceeded' };
    } else {
      const persisted = writeRegistry({ repos: [...read.registry.repos, abs] }, read.bytes);
      result = {
        ok: persisted.ok,
        changed: persisted.ok,
        quiesced: persisted.ok,
        reason: persisted.ok ? 'enrolled' : persisted.reason,
      };
    }
  }
  if (!borrowed) releaseOutwardMutationFence(fence);
  // H6 (§A.2): audit AFTER the (idempotent) write so a no-op re-enroll STILL
  // records the requested intent. The repo abs path is metadata, never a secret;
  // audit() swallows its own errors so enroll's "never throws" contract holds.
  if (canonicalHome()) {
    audit({
      action: 'enroll:add',
      repo: abs ?? lexical,
      sandboxId: null,
      summary: `enrolled ${abs ?? lexical}`,
      result: result.ok ? 'ok' : 'error',
    });
  }
  return result;
}

/**
 * Remove `repo` from the enrollment registry. Idempotent — unenrolling
 * an absent repo is a no-op. Normalizes to absolute path.
 */
export function unenroll(repo: string, opts: { waitMs?: number } = {}): PolicyMutationResult {
  const lexical = resolve(repo);
  const abs = canonicalEnrollmentPath(repo);
  const fence = acquireOutwardMutationFence(opts.waitMs ?? 2_000);
  let result: PolicyMutationResult;
  if (!abs) {
    result = { ok: false, changed: false, quiesced: false, reason: 'invalid-enrollment-path' };
  } else if (!ownsOutwardMutationFence(fence)) {
    result = { ok: false, changed: false, quiesced: false, reason: 'outward mutation fence unavailable' };
  } else {
    const recovery = recoverRegistryTransaction();
    const read = recovery.ok ? readRegistryDetailed() : null;
    if (!recovery.ok) {
      result = { ok: false, changed: false, quiesced: false, reason: recovery.reason };
    } else if (!read?.ok) {
      result = { ok: false, changed: false, quiesced: false, reason: read?.reason ?? 'unreadable-registry' };
    } else {
      const filtered = read.registry.repos.filter(r => r !== abs && r !== lexical);
      if (filtered.length === read.registry.repos.length) {
        result = { ok: true, changed: false, quiesced: true, reason: 'already-unenrolled' };
      } else {
        const persisted = writeRegistry({ repos: filtered }, read.bytes);
        result = {
          ok: persisted.ok,
          changed: persisted.ok,
          quiesced: persisted.ok,
          reason: persisted.ok ? 'unenrolled' : persisted.reason,
        };
      }
    }
  }
  releaseOutwardMutationFence(fence);
  // H6 (§A.2): audit AFTER the (idempotent) write so a no-op unenroll STILL
  // records the requested intent. Metadata only (abs path is not a secret);
  // audit() swallows its own errors so unenroll's "never throws" contract holds.
  if (canonicalHome()) {
    audit({
      action: 'enroll:remove',
      repo: abs ?? lexical,
      sandboxId: null,
      summary: `unenrolled ${abs ?? lexical}`,
      result: result.ok ? 'ok' : 'error',
    });
  }
  return result;
}

/**
 * Return all enrolled repos (absolute paths). Returns [] when nothing is
 * enrolled (the default state — DEFAULT EMPTY).
 */
export function listEnrolled(): string[] {
  return readRegistry().repos;
}

// ---------------------------------------------------------------------------
// assertMayMutate — the gate every sandbox-mutating op calls first
// ---------------------------------------------------------------------------

/**
 * Assert that autonomous/sandbox mutation of `repo` is permitted.
 *
 * Throws when:
 *  1. The kill switch is on (ALWAYS, regardless of enrollment or opts).
 *  2. `repo` is not enrolled AND `opts.allowAnyRepo` is not true.
 *
 * `opts.allowAnyRepo` is a TEST SEAM only — it bypasses enrollment so tests
 * can operate on tmp repos without enrolling them. It NEVER bypasses the kill
 * switch.
 */
export function assertMayMutate(
  repo: string,
  opts?: { allowAnyRepo?: boolean },
): void {
  // Kill switch check — always enforced, no exceptions.
  if (killSwitchOn()) {
    throw new Error('autonomy kill switch is ON');
  }

  // Enrollment check — bypassed only by the explicit test hatch.
  //
  // H5 CHANGE 3 (env-gate allowAnyRepo): the `allowAnyRepo` hatch is effective
  // ONLY when the process ALSO sets ASHLR_TEST_ALLOW_ANY_REPO=1, so a stray
  // `allowAnyRepo:true` in any PRODUCTION path can NEVER bypass enrollment
  // (mirrors advance.ts:155-157 EXACTLY). The kill-switch check above STAYS
  // first and unconditional — it always wins (verify-safety CHECK 2 still
  // passes). createSandbox passes opts straight through, so it inherits this
  // gate transitively — single source of truth.
  const allowAnyRepo =
    opts?.allowAnyRepo === true &&
    process.env.ASHLR_TEST_ALLOW_ANY_REPO === '1';
  if (!allowAnyRepo && !isEnrolled(repo)) {
    throw new Error(`repo not enrolled for autonomous work: ${canonicalEnrollmentPath(repo) ?? resolve(repo)}`);
  }
}
