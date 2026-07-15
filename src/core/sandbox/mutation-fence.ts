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

function preparePrivateDirectory(path: string, anchorPath: string): boolean {
  let created = false;
  try {
    mkdirSync(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
  }

  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isDirectory()) return false;
    if (process.platform !== 'win32') {
      chmodSync(path, 0o700);
      return true;
    }
    const assurance = assurePrivateStoragePath(
      path,
      'directory',
      created ? 'secure-created' : 'inspect-owned',
      { anchorPath },
    );
    if (!assurance.ok) return false;
    const after = lstatSync(path);
    return after.isDirectory() && !after.isSymbolicLink() &&
      before.dev === after.dev && before.ino === after.ino;
  } catch {
    return false;
  }
}

function prepareOutwardAuthorityRoot(): boolean {
  const home = canonicalHome();
  if (!home) return false;
  const root = join(home, '.ashlr');
  if (!preparePrivateDirectory(root, home)) return false;
  return preparePrivateDirectory(join(root, 'authority'), root);
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
