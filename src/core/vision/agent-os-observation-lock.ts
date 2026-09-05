import { join } from 'node:path';

import {
  acquireLocalStoreLock,
  releaseLocalStoreLock,
  type LocalStoreLock,
} from '../fleet/local-store-lock.js';

const MAX_LOCK_WAIT_MS = 2_000;

/**
 * One lock orders official source publication before snapshot publication.
 * The lock is host-local and does not claim same-user tamper resistance.
 */
export function acquireAgentOsObservationLockV1(anchorPath: string): LocalStoreLock | null {
  return acquireLocalStoreLock(
    join(anchorPath, '.agent-os-observation-transaction-v1.lock'),
    MAX_LOCK_WAIT_MS,
    { anchorPath, exactPrivateStorage: true },
  );
}

export function releaseAgentOsObservationLockV1(lock: LocalStoreLock | null): boolean {
  return releaseLocalStoreLock(lock);
}
