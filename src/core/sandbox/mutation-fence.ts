import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  acquireLocalStoreLock,
  ownsLocalStoreLock,
  releaseLocalStoreLock,
  type LocalStoreLock,
} from '../fleet/local-store-lock.js';

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

export function acquireOutwardMutationFence(waitMs = 2_000): OutwardMutationFence | null {
  try {
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
