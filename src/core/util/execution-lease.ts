import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  acquireLocalStoreLock,
  ownsLocalStoreLock,
  releaseLocalStoreLock,
  type LocalStoreLock,
} from '../fleet/local-store-lock.js';
import { assurePrivateStoragePath } from './private-storage.js';

const SCHEMA_VERSION = 1 as const;
const DOMAIN = 'ashlr:execution-authority:v1';
const MAX_EXECUTION_ID_BYTES = 4_096;
const MAX_MARKER_BYTES = 1_024;
const O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;

export type ExecutionAuthorityNamespace = 'run' | 'swarm';
export type ExecutionAuthorityFailureReason = 'active' | 'ambiguous' | 'unavailable';

interface ExecutionAuthorityMarker {
  schemaVersion: typeof SCHEMA_VERSION;
  namespace: ExecutionAuthorityNamespace;
  identityHash: string;
  phase: 'claimed' | 'executing';
  token: string;
  createdAtMs: number;
  executingAtMs?: number;
}

export interface ExecutionAuthority {
  namespace: ExecutionAuthorityNamespace;
  identityHash: string;
  token: string;
  markerPath: string;
  directory: { path: string; dev: number; ino: number };
  lock: LocalStoreLock;
}

export type ExecutionAuthorityAcquireResult =
  | { ok: true; authority: ExecutionAuthority }
  | { ok: false; reason: ExecutionAuthorityFailureReason };

function owned(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

function stateRoot(): string {
  return join(homedir(), '.ashlr');
}

export function executionAuthorityDirectory(): string {
  return join(stateRoot(), 'execution-leases');
}

function identityHash(namespace: ExecutionAuthorityNamespace, id: string): string {
  if (
    typeof id !== 'string' || id.length === 0 ||
    Buffer.byteLength(id, 'utf8') > MAX_EXECUTION_ID_BYTES
  ) throw new TypeError('execution identity is empty or unreasonably large');
  return createHash('sha256')
    .update(JSON.stringify([DOMAIN, namespace, id.toLowerCase()]))
    .digest('hex');
}

export function executionAuthorityStatePath(
  namespace: ExecutionAuthorityNamespace,
  id: string,
): string {
  return join(executionAuthorityDirectory(), `.state-v1-${identityHash(namespace, id)}.json`);
}

function executionAuthorityLockPath(hash: string): string {
  return join(executionAuthorityDirectory(), `.lock-v1-${hash}`);
}

function ensureAuthorityDirectory(): { path: string; dev: number; ino: number } {
  const root = stateRoot();
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || !owned(rootStat.uid)) {
    throw new Error('unsafe Ashlr state root for execution authority');
  }
  chmodSync(root, 0o700);

  const dir = executionAuthorityDirectory();
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  const before = lstatSync(dir);
  if (before.isSymbolicLink() || !before.isDirectory() || !owned(before.uid)) {
    throw new Error('unsafe execution authority directory');
  }
  chmodSync(dir, 0o700);
  const assurance = assurePrivateStoragePath(dir, 'directory', 'secure-created', { anchorPath: root });
  if (!assurance.ok) throw new Error(`unable to secure execution authority directory: ${assurance.reason}`);
  const after = lstatSync(dir);
  if (
    after.isSymbolicLink() || !after.isDirectory() || !owned(after.uid) ||
    after.dev !== before.dev || after.ino !== before.ino
  ) throw new Error('execution authority directory changed during validation');
  return { path: dir, dev: after.dev, ino: after.ino };
}

function sameDirectory(directory: ExecutionAuthority['directory']): boolean {
  try {
    const stat = lstatSync(directory.path);
    return !stat.isSymbolicLink() && stat.isDirectory() && owned(stat.uid) &&
      stat.dev === directory.dev && stat.ino === directory.ino;
  } catch {
    return false;
  }
}

function strictMarker(value: unknown): ExecutionAuthorityMarker | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const phase = row['phase'];
  const expected = phase === 'executing'
    ? ['createdAtMs', 'executingAtMs', 'identityHash', 'namespace', 'phase', 'schemaVersion', 'token']
    : ['createdAtMs', 'identityHash', 'namespace', 'phase', 'schemaVersion', 'token'];
  if (Object.keys(row).sort().join(',') !== expected.join(',')) return null;
  if (
    row['schemaVersion'] !== SCHEMA_VERSION ||
    (row['namespace'] !== 'run' && row['namespace'] !== 'swarm') ||
    typeof row['identityHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(row['identityHash']) ||
    (phase !== 'claimed' && phase !== 'executing') ||
    typeof row['token'] !== 'string' || !/^[0-9a-f-]{36}$/.test(row['token']) ||
    !Number.isSafeInteger(row['createdAtMs']) || Number(row['createdAtMs']) < 0 ||
    (phase === 'executing' &&
      (!Number.isSafeInteger(row['executingAtMs']) || Number(row['executingAtMs']) < Number(row['createdAtMs'])))
  ) return null;
  return row as unknown as ExecutionAuthorityMarker;
}

function readMarker(
  path: string,
  directory: ExecutionAuthority['directory'],
): { kind: 'absent' } | { kind: 'valid'; marker: ExecutionAuthorityMarker } | { kind: 'invalid' } {
  let fd: number | undefined;
  try {
    if (!sameDirectory(directory)) return { kind: 'invalid' };
    const before = lstatSync(path);
    if (
      before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || !owned(before.uid) ||
      before.size < 2 || before.size > MAX_MARKER_BYTES ||
      (process.platform !== 'win32' && (before.mode & 0o077) !== 0)
    ) return { kind: 'invalid' };
    const assurance = assurePrivateStoragePath(path, 'file', 'inspect-existing', { anchorPath: stateRoot() });
    if (!assurance.ok) return { kind: 'invalid' };
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 ||
      opened.size !== before.size
    ) return { kind: 'invalid' };
    const bytes = Buffer.alloc(opened.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return { kind: 'invalid' };
    const after = lstatSync(path);
    if (
      after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      !sameDirectory(directory)
    ) return { kind: 'invalid' };
    const marker = strictMarker(JSON.parse(bytes.toString('utf8')));
    return marker ? { kind: 'valid', marker } : { kind: 'invalid' };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'invalid' };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function fsyncDirectory(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY);
    fsyncSync(fd);
    return true;
  } catch { return false; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } } }
}

function writeDurableMarkerInPlace(
  path: string,
  marker: ExecutionAuthorityMarker,
  directory: ExecutionAuthority['directory'],
): boolean {
  let fd: number | undefined;
  try {
    if (!sameDirectory(directory)) return false;
    const before = lstatSync(path);
    if (
      before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || !owned(before.uid)
    ) return false;
    const assurance = assurePrivateStoragePath(path, 'file', 'inspect-existing', { anchorPath: stateRoot() });
    if (!assurance.ok) return false;
    fd = openSync(path, fsConstants.O_WRONLY | O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 ||
      !opened.isFile() || !owned(opened.uid)
    ) return false;
    const bytes = Buffer.from(`${JSON.stringify(marker)}\n`, 'utf8');
    if (bytes.length > MAX_MARKER_BYTES) return false;
    // Windows cannot portably fsync a directory through Node. Updating the
    // existing claimed marker in place avoids a durability-dependent rename.
    // A crash during this sequence leaves an invalid marker and therefore
    // fails closed; a successful file fsync makes the executing state durable.
    ftruncateSync(fd, 0);
    if (writeSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return false;
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const flushed = fstatSync(fd);
    if (
      flushed.dev !== before.dev || flushed.ino !== before.ino ||
      flushed.nlink !== 1 || flushed.size !== bytes.length
    ) return false;
    return sameDirectory(directory);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function writeMarker(
  path: string,
  marker: ExecutionAuthorityMarker,
  directory: ExecutionAuthority['directory'],
  durable: boolean,
): boolean {
  if (durable && process.platform === 'win32') {
    return writeDurableMarkerInPlace(path, marker, directory);
  }
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    if (!sameDirectory(directory)) return false;
    fd = openSync(
      tmp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !owned(opened.uid)) return false;
    const assurance = assurePrivateStoragePath(tmp, 'file', 'secure-created', { anchorPath: stateRoot() });
    if (!assurance.ok) return false;
    const installed = lstatSync(tmp);
    if (
      installed.isSymbolicLink() || !installed.isFile() || installed.nlink !== 1 ||
      installed.dev !== opened.dev || installed.ino !== opened.ino || !sameDirectory(directory)
    ) return false;
    const bytes = Buffer.from(`${JSON.stringify(marker)}\n`, 'utf8');
    if (bytes.length > MAX_MARKER_BYTES || writeSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return false;
    fchmodSync(fd, 0o600);
    // Only the executing transition must survive a power loss before effects.
    // A lost claimed marker is safe to reacquire because execution has not begun.
    if (durable) fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    if (durable && !fsyncDirectory(directory.path)) return false;
    return sameDirectory(directory);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    try { unlinkSync(tmp); } catch { /* renamed or best effort */ }
  }
}

function ownsAuthority(authority: ExecutionAuthority): boolean {
  return sameDirectory(authority.directory) && ownsLocalStoreLock(authority.lock);
}

export function acquireExecutionAuthority(
  namespace: ExecutionAuthorityNamespace,
  id: string,
  waitMs = 250,
): ExecutionAuthorityAcquireResult {
  let lock: LocalStoreLock | null = null;
  try {
    const hash = identityHash(namespace, id);
    const directory = ensureAuthorityDirectory();
    lock = acquireLocalStoreLock(executionAuthorityLockPath(hash), waitMs);
    if (!lock) return { ok: false, reason: 'active' };
    const markerPath = executionAuthorityStatePath(namespace, id);
    const existing = readMarker(markerPath, directory);
    if (existing.kind === 'invalid') return { ok: false, reason: 'unavailable' };
    if (existing.kind === 'valid') {
      if (existing.marker.identityHash !== hash || existing.marker.namespace !== namespace) {
        return { ok: false, reason: 'unavailable' };
      }
      if (existing.marker.phase === 'executing') return { ok: false, reason: 'ambiguous' };
    }
    const token = randomUUID();
    const marker: ExecutionAuthorityMarker = {
      schemaVersion: SCHEMA_VERSION,
      namespace,
      identityHash: hash,
      phase: 'claimed',
      token,
      createdAtMs: Date.now(),
    };
    if (!writeMarker(markerPath, marker, directory, false)) return { ok: false, reason: 'unavailable' };
    const authority = { namespace, identityHash: hash, token, markerPath, directory, lock };
    lock = null;
    return { ok: true, authority };
  } catch {
    return { ok: false, reason: 'unavailable' };
  } finally {
    releaseLocalStoreLock(lock);
  }
}

export function beginExecutionAuthority(authority: ExecutionAuthority): boolean {
  if (!ownsAuthority(authority)) return false;
  const current = readMarker(authority.markerPath, authority.directory);
  if (
    current.kind !== 'valid' || current.marker.phase !== 'claimed' ||
    current.marker.token !== authority.token ||
    current.marker.identityHash !== authority.identityHash ||
    current.marker.namespace !== authority.namespace
  ) return false;
  const next: ExecutionAuthorityMarker = {
    ...current.marker,
    phase: 'executing',
    executingAtMs: Date.now(),
  };
  if (!writeMarker(authority.markerPath, next, authority.directory, true) || !ownsAuthority(authority)) return false;
  const installed = readMarker(authority.markerPath, authority.directory);
  return installed.kind === 'valid' && installed.marker.phase === 'executing' &&
    installed.marker.token === authority.token;
}

export function finishExecutionAuthority(authority: ExecutionAuthority | null | undefined): void {
  if (!authority) return;
  try {
    if (!ownsAuthority(authority)) return;
    const current = readMarker(authority.markerPath, authority.directory);
    if (current.kind !== 'valid' || current.marker.token !== authority.token) return;
    const stat = lstatSync(authority.markerPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || !owned(stat.uid)) return;
    const confirmed = readMarker(authority.markerPath, authority.directory);
    if (confirmed.kind !== 'valid' || confirmed.marker.token !== authority.token) return;
    const latest = lstatSync(authority.markerPath);
    if (latest.dev !== stat.dev || latest.ino !== stat.ino) return;
    unlinkSync(authority.markerPath);
    // Failure to persist cleanup can only resurrect an executing marker and
    // produce a conservative ambiguous refusal; it cannot authorize a replay.
  } catch { /* uncertainty leaves the marker fail-closed */ }
  finally { releaseLocalStoreLock(authority.lock); }
}

/** Release the live owner while retaining an executing marker as fail-closed evidence. */
export function abandonExecutionAuthority(authority: ExecutionAuthority | null | undefined): void {
  if (!authority) return;
  releaseLocalStoreLock(authority.lock);
}
