import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  acquireLocalStoreLock,
  ownsLocalStoreLock,
  releaseLocalStoreLock,
  type LocalStoreLock,
} from '../fleet/local-store-lock.js';

const DEFAULT_LIFECYCLE_FENCE_WAIT_MS = 2_000;

export function daemonServiceLifecycleFencePath(homeDir = homedir()): string {
  return join(resolve(homeDir), '.ashlr', 'locks', 'daemon-service-lifecycle.lock');
}

export function acquireDaemonServiceLifecycleFence(
  homeDir = homedir(),
  waitMs = DEFAULT_LIFECYCLE_FENCE_WAIT_MS,
): LocalStoreLock | null {
  const home = resolve(homeDir);
  return acquireLocalStoreLock(
    daemonServiceLifecycleFencePath(home),
    waitMs,
    { anchorPath: home },
  );
}

export function ownsDaemonServiceLifecycleFence(
  fence: LocalStoreLock | null | undefined,
): boolean {
  return ownsLocalStoreLock(fence);
}

export function releaseDaemonServiceLifecycleFence(
  fence: LocalStoreLock | null | undefined,
): boolean {
  return releaseLocalStoreLock(fence);
}
