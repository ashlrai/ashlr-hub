import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  acquireLocalStoreLock,
  ownsLocalStoreLock,
  releaseLocalStoreLock,
  type LocalStoreLock,
} from '../fleet/local-store-lock.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';

/**
 * Global serialization boundary for autonomous Git and host mutations.
 *
 * Lock order is proposal mutation lock -> outward mutation fence. Policy
 * writers acquire only this fence, so kill/unenrollment cannot deadlock on a
 * proposal while still linearizing against every outward effect.
 */
export type OutwardMutationFence = Readonly<LocalStoreLock>;

const acquiredFences = new WeakSet<object>();

interface PrivateDirectoryProof {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

interface WindowsAuthorityProof {
  readonly home: string;
  readonly root: PrivateDirectoryProof;
  readonly authority: PrivateDirectoryProof;
}

// ACL assurance proves that only current-user/SYSTEM/Administrators can mutate
// or replace these objects. Reuse is therefore bounded to exact bigint file
// identities; any pathname or object change discards the proof and re-assures.
let windowsAuthorityProof: WindowsAuthorityProof | null = null;

function isAcquiredFence(
  fence: OutwardMutationFence | null | undefined,
): fence is OutwardMutationFence {
  return typeof fence === 'object' && fence !== null && acquiredFences.has(fence);
}

function canonicalHome(): string | null {
  try {
    const home = homedir();
    if (typeof home !== 'string' || home.length === 0 || !isAbsolute(home)) return null;
    return resolve(home);
  } catch {
    return null;
  }
}

export function outwardMutationFencePath(): string {
  const home = canonicalHome();
  if (!home) throw new Error('invalid home directory for outward mutation authority');
  return join(home, '.ashlr', 'authority', 'outward-mutation.lock');
}

function readPrivateDirectoryProof(path: string): PrivateDirectoryProof | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.ino <= 0n) return null;
    return { path, dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function samePrivateDirectory(
  expected: PrivateDirectoryProof,
  observed: PrivateDirectoryProof | null,
): boolean {
  return observed !== null && expected.path === observed.path &&
    expected.dev === observed.dev && expected.ino === observed.ino;
}

function cachedWindowsAuthorityIsExact(
  home: string,
  rootPath: string,
  authorityPath: string,
): boolean {
  const cached = windowsAuthorityProof;
  if (!cached || cached.home !== home ||
    cached.root.path !== rootPath || cached.authority.path !== authorityPath) return false;

  const rootBefore = readPrivateDirectoryProof(rootPath);
  const authorityBefore = readPrivateDirectoryProof(authorityPath);
  const rootAfter = readPrivateDirectoryProof(rootPath);
  const authorityAfter = readPrivateDirectoryProof(authorityPath);
  return samePrivateDirectory(cached.root, rootBefore) &&
    samePrivateDirectory(cached.authority, authorityBefore) &&
    samePrivateDirectory(cached.root, rootAfter) &&
    samePrivateDirectory(cached.authority, authorityAfter);
}

function preparePrivateDirectory(
  path: string,
  anchorPath: string,
): PrivateDirectoryProof | null {
  let created = false;
  try {
    mkdirSync(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
  }

  try {
    const before = readPrivateDirectoryProof(path);
    if (!before) return null;
    if (process.platform !== 'win32') {
      chmodSync(path, 0o700);
      const after = readPrivateDirectoryProof(path);
      return samePrivateDirectory(before, after) ? after : null;
    }
    const assurance = assurePrivateStoragePath(
      path,
      'directory',
      created ? 'secure-created' : 'inspect-owned',
      { anchorPath },
    );
    if (!assurance.ok) return null;
    const after = readPrivateDirectoryProof(path);
    return samePrivateDirectory(before, after) ? after : null;
  } catch {
    return null;
  }
}

function prepareOutwardAuthorityRoot(): boolean {
  const home = canonicalHome();
  if (!home) return false;
  const rootPath = join(home, '.ashlr');
  const authorityPath = join(rootPath, 'authority');
  if (process.platform === 'win32') {
    if (cachedWindowsAuthorityIsExact(home, rootPath, authorityPath)) return true;
    windowsAuthorityProof = null;
  }

  const root = preparePrivateDirectory(rootPath, home);
  if (!root) return false;
  const authority = preparePrivateDirectory(authorityPath, rootPath);
  if (!authority) return false;

  if (process.platform === 'win32') {
    const rootAfter = readPrivateDirectoryProof(rootPath);
    const authorityAfter = readPrivateDirectoryProof(authorityPath);
    if (!samePrivateDirectory(root, rootAfter) ||
      !samePrivateDirectory(authority, authorityAfter)) return false;
    windowsAuthorityProof = { home, root, authority };
  }
  return true;
}

export function acquireOutwardMutationFence(waitMs = 2_000): OutwardMutationFence | null {
  try {
    if (!prepareOutwardAuthorityRoot()) return null;
    const fence = acquireLocalStoreLock(outwardMutationFencePath(), waitMs);
    if (fence) acquiredFences.add(fence);
    return fence;
  } catch {
    return null;
  }
}

/**
 * Acquire the fence WITHOUT blocking the event loop.
 *
 * `acquireOutwardMutationFence` spins on `Atomics.wait`, which is a
 * SYNCHRONOUS sleep: for its whole `waitMs` nothing else in the process runs —
 * no timer, no I/O callback, no abort handler, no HTTP route. That is
 * tolerable at the 2s default and catastrophic at anything longer on a daemon,
 * where the same loop also owns the hang watchdog (a `setTimeout`), the queue
 * lease renewer (a `setInterval`, whose missed fence lets another machine
 * steal the claim), the shutdown signal handler and the operator's own control
 * plane. Worse, the contending holder is usually IN THIS PROCESS and holds the
 * fence across awaits, so a synchronous waiter can never win: it burns the
 * entire wait with the loop frozen and then fails anyway.
 *
 * This variant makes each attempt as short as the lock allows and yields
 * between attempts, so everything else keeps running while a turn waits.
 */
export async function acquireOutwardMutationFenceAsync(
  waitMs = 2_000,
  opts?: { pollMs?: number; signal?: AbortSignal },
): Promise<OutwardMutationFence | null> {
  const pollMs = Math.max(1, Math.min(250, opts?.pollMs ?? 25));
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    if (opts?.signal?.aborted === true) return null;
    // A 1ms per-attempt bound keeps each synchronous spin to a single sleep
    // tick; the waiting happens in the timer below, off the critical path.
    const fence = acquireOutwardMutationFence(1);
    if (fence !== null) return fence;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => { setTimeout(resolve, pollMs); });
  }
}

export function ownsOutwardMutationFence(
  fence: OutwardMutationFence | null | undefined,
): boolean {
  if (!isAcquiredFence(fence)) return false;
  try {
    return fence.path === outwardMutationFencePath() && ownsLocalStoreLock(fence);
  } catch {
    return false;
  }
}

export function releaseOutwardMutationFence(
  fence: OutwardMutationFence | null | undefined,
): void {
  if (!isAcquiredFence(fence)) return;
  releaseLocalStoreLock(fence);
}
