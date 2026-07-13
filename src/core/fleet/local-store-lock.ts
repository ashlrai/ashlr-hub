import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

const INIT_GRACE_MS = 1_000;
const SLEEP = new Int32Array(new SharedArrayBuffer(4));

export interface LocalStoreLock {
  path: string;
  token: string;
  dev: number;
  ino: number;
}

function owned(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

function processStartRef(pid: number): string | undefined {
  try {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 1_000, maxBuffer: 1_024,
    });
    const value = result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : '';
    return value ? createHash('sha256').update(value).digest('hex') : undefined;
  } catch { return undefined; }
}

let ownStartIdentity: { ref: string; verified: boolean } | undefined;
function currentStartIdentity(): { ref: string; verified: boolean } {
  if (!ownStartIdentity) {
    const observed = processStartRef(process.pid);
    ownStartIdentity = observed
      ? { ref: observed, verified: true }
      : {
        ref: createHash('sha256').update(`${process.pid}:${Date.now() - performance.now()}`).digest('hex'),
        verified: false,
      };
  }
  return ownStartIdentity;
}

function safelyUnlink(path: string, expected: { dev: number; ino: number }): boolean {
  const guard = `${path}.unlink-${process.pid}-${randomUUID()}.guard`;
  let guarded = false;
  try {
    const current = lstatSync(path);
    if (
      current.isSymbolicLink() || !current.isFile() || current.nlink !== 1 || !owned(current.uid) ||
      current.dev !== expected.dev || current.ino !== expected.ino
    ) return false;
    // Pin this exact inode under a unique name before removing the canonical
    // path. Cooperating contenders see nlink=2 and fail closed, so none can
    // install a replacement between our final identity check and unlink.
    linkSync(path, guard);
    guarded = true;
    const pinned = lstatSync(guard);
    const stillCurrent = lstatSync(path);
    if (
      pinned.dev !== expected.dev || pinned.ino !== expected.ino || pinned.nlink !== 2 ||
      stillCurrent.dev !== expected.dev || stillCurrent.ino !== expected.ino ||
      stillCurrent.nlink !== 2
    ) return false;
    unlinkSync(path);
    const remaining = lstatSync(guard);
    return remaining.dev === expected.dev && remaining.ino === expected.ino && remaining.nlink === 1;
  } catch { return false; }
  finally {
    if (guarded) { try { unlinkSync(guard); } catch { /* best effort; canonical path is fail-closed */ } }
  }
}

function collapseInstalledCandidate(path: string, expected: { dev: number; ino: number }): boolean {
  const dir = dirname(path);
  const prefix = `${basename(path)}.`;
  try {
    const candidates = readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith('.candidate'));
    for (const name of candidates) {
      const candidate = join(dir, name);
      const stat = lstatSync(candidate);
      if (
        stat.isSymbolicLink() || !stat.isFile() || !owned(stat.uid) ||
        stat.dev !== expected.dev || stat.ino !== expected.ino
      ) continue;
      unlinkSync(candidate);
      const installed = lstatSync(path);
      return installed.dev === expected.dev && installed.ino === expected.ino && installed.nlink === 1;
    }
  } catch { /* uncertain two-link state remains fail-closed */ }
  return false;
}

function ownerState(
  path: string,
  expected: { dev: number; ino: number; mtimeMs: number },
): 'alive' | 'dead' | 'initializing' | 'unknown' {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      !opened.isFile() || opened.nlink < 1 || opened.nlink > 2 || !owned(opened.uid) ||
      opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size < 2 || opened.size > 512
    ) return Date.now() - expected.mtimeMs < INIT_GRACE_MS ? 'initializing' : 'unknown';
    const bytes = Buffer.alloc(opened.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return 'unknown';
    const owner = JSON.parse(bytes.toString('utf8')) as {
      pid?: unknown; token?: unknown; startRef?: unknown; startRefVerified?: unknown;
    };
    if (
      !Number.isInteger(owner.pid) || Number(owner.pid) < 1 ||
      typeof owner.token !== 'string' || owner.token.length > 64
    ) return Date.now() - expected.mtimeMs < INIT_GRACE_MS ? 'initializing' : 'unknown';
    const pid = Number(owner.pid);
    try { process.kill(pid, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'alive'; }
    if (owner.startRef === undefined && owner.startRefVerified === undefined) return 'alive';
    if (
      typeof owner.startRef !== 'string' || !/^[a-f0-9]{64}$/.test(owner.startRef) ||
      typeof owner.startRefVerified !== 'boolean'
    ) return 'unknown';
    if (!owner.startRefVerified) return 'alive';
    const observed = pid === process.pid ? currentStartIdentity().ref : processStartRef(pid);
    return observed && observed !== owner.startRef ? 'dead' : 'alive';
  } catch {
    return Date.now() - expected.mtimeMs < INIT_GRACE_MS ? 'initializing' : 'unknown';
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function acquireReclaimElection(path: string): LocalStoreLock | null {
  const ownerPath = `${path}.reclaim.owner`;
  const token = randomUUID();
  const candidate = `${ownerPath}.${process.pid}.${token}.candidate`;
  let fd: number | undefined;
  let installed: Stats | undefined;
  let election: LocalStoreLock | null = null;
  try {
    fd = openSync(
      candidate,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !owned(opened.uid)) return null;
    const start = currentStartIdentity();
    const bytes = Buffer.from(`${JSON.stringify({
      pid: process.pid,
      token,
      startRef: start.ref,
      startRefVerified: start.verified,
    })}\n`, 'utf8');
    if (writeSync(fd, bytes) !== bytes.length) return null;
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    installed = lstatSync(candidate);
    if (
      installed.isSymbolicLink() || !installed.isFile() || installed.nlink !== 1 ||
      !owned(installed.uid) || installed.dev !== opened.dev || installed.ino !== opened.ino
    ) return null;

    try {
      linkSync(candidate, ownerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      const current = lstatSync(ownerPath);
      if (
        current.isSymbolicLink() || !current.isFile() || !owned(current.uid) ||
        current.nlink < 1 || current.nlink > 2
      ) return null;
      const state = ownerState(ownerPath, {
        dev: current.dev,
        ino: current.ino,
        mtimeMs: current.mtimeMs,
      });
      if (
        state !== 'dead' &&
        !(state === 'unknown' && Date.now() - current.mtimeMs >= INIT_GRACE_MS)
      ) return null;
      // Exact-inode deletion makes stale-reclaimer recovery ABA-safe. If a
      // contender replaces the owner first, this attempt fails closed.
      if (!safelyUnlink(ownerPath, current)) return null;
      linkSync(candidate, ownerPath);
    }
    unlinkSync(candidate);
    installed = lstatSync(ownerPath);
    if (
      installed.isSymbolicLink() || !installed.isFile() || installed.nlink !== 1 ||
      !owned(installed.uid) || installed.dev !== opened.dev || installed.ino !== opened.ino
    ) return null;
    election = { path: ownerPath, token, dev: installed.dev, ino: installed.ino };
    return election;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    if (!election) {
      try {
        const current = installed ?? lstatSync(ownerPath);
        releaseLocalStoreLock({
          path: ownerPath,
          token,
          dev: current.dev,
          ino: current.ino,
        });
      } catch { /* best effort */ }
      try { unlinkSync(candidate); } catch { /* best effort */ }
    }
  }
}

export function acquireLocalStoreLock(path: string, waitMs = 2_000): LocalStoreLock | null {
  const dir = dirname(path);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !owned(stat.uid)) return null;
    chmodSync(dir, 0o700);
  } catch { return null; }

  const token = randomUUID();
  const deadline = performance.now() + waitMs;
  while (true) {
    let fd: number | undefined;
    const candidate = `${path}.${process.pid}.${token}.candidate`;
    try {
      fd = openSync(candidate, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || !owned(stat.uid)) throw new Error('unsafe local store lock');
      const start = currentStartIdentity();
      const bytes = Buffer.from(`${JSON.stringify({
        pid: process.pid,
        token,
        startRef: start.ref,
        startRefVerified: start.verified,
      })}\n`, 'utf8');
      if (writeSync(fd, bytes) !== bytes.length) throw new Error('short local store lock write');
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      linkSync(candidate, path);
      unlinkSync(candidate);
      const linked = lstatSync(path);
      if (
        linked.isSymbolicLink() || !linked.isFile() || linked.nlink !== 1 || !owned(linked.uid) ||
        linked.dev !== stat.dev || linked.ino !== stat.ino
      ) throw new Error('unsafe installed local store lock');
      return { path, token, dev: linked.dev, ino: linked.ino };
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
      try { if (existsSync(candidate)) unlinkSync(candidate); } catch { /* best effort */ }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile() || !owned(stat.uid) || stat.nlink < 1 || stat.nlink > 2) return null;
        const state = ownerState(path, { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs });
        if (state === 'dead' || (state === 'unknown' && Date.now() - stat.mtimeMs >= INIT_GRACE_MS)) {
          const election = acquireReclaimElection(path);
          if (election) {
            try {
              if (stat.nlink === 2 && !collapseInstalledCandidate(path, stat)) return null;
              const installed = lstatSync(path);
              if (installed.dev !== stat.dev || installed.ino !== stat.ino) return null;
              if (!safelyUnlink(path, stat)) return null;
              continue;
            } finally {
              releaseLocalStoreLock(election);
            }
          }
        }
      } catch { /* changing path; retry within bounded deadline */ }
      if (performance.now() >= deadline) return null;
      Atomics.wait(SLEEP, 0, 0, 10);
    }
  }
}

export function ownsLocalStoreLock(lock: LocalStoreLock | null | undefined): boolean {
  if (!lock) return false;
  let fd: number | undefined;
  try {
    const stat = lstatSync(lock.path);
    if (
      stat.dev !== lock.dev || stat.ino !== lock.ino || stat.isSymbolicLink() ||
      !stat.isFile() || stat.nlink !== 1 || !owned(stat.uid)
    ) return false;
    fd = openSync(lock.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      opened.dev !== lock.dev || opened.ino !== lock.ino || opened.nlink !== 1 ||
      opened.size < 2 || opened.size > 512
    ) return false;
    const bytes = Buffer.alloc(opened.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return false;
    const owner = JSON.parse(bytes.toString('utf8')) as { token?: unknown };
    return owner.token === lock.token;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

export function releaseLocalStoreLock(lock: LocalStoreLock | null | undefined): void {
  if (!lock) return;
  let fd: number | undefined;
  try {
    const stat = lstatSync(lock.path);
    if (stat.dev !== lock.dev || stat.ino !== lock.ino || stat.isSymbolicLink() || !stat.isFile()) return;
    fd = openSync(lock.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (opened.dev !== lock.dev || opened.ino !== lock.ino || opened.size < 2 || opened.size > 512) return;
    const bytes = Buffer.alloc(opened.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return;
    const owner = JSON.parse(bytes.toString('utf8')) as { token?: unknown };
    if (owner.token === lock.token) safelyUnlink(lock.path, lock);
  } catch { /* uncertain ownership remains fail-closed */ }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } } }
}
