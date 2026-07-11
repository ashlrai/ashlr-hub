import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLocalStoreLock,
  releaseLocalStoreLock,
  type LocalStoreLock,
} from '../fleet/local-store-lock.js';

export interface ProposalMutationLock {
  key: string;
  token: symbol;
}

const held = new Map<string, { lock: LocalStoreLock; handle: ProposalMutationLock }>();

function lockKey(proposalId: string): string | null {
  if (!/^[\w.-]+$/.test(proposalId)) return null;
  return createHash('sha256').update(proposalId).digest('hex');
}

function lockPath(key: string): string {
  return join(homedir(), '.ashlr', 'inbox', '.mutation-locks', `${key}.lock`);
}

/** Cross-process proposal fence. Nested writes must present the exact owner capability. */
export function acquireProposalMutationLock(
  proposalId: string,
  waitMs = 2_000,
): ProposalMutationLock | null {
  const key = lockKey(proposalId);
  if (!key) return null;
  if (held.has(key)) return null;
  const lock = acquireLocalStoreLock(lockPath(key), waitMs);
  if (!lock) return null;
  const handle = { key, token: Symbol(key) };
  held.set(key, { lock, handle });
  return handle;
}

export function ownsProposalMutationLock(
  proposalId: string,
  handle: ProposalMutationLock | null | undefined,
): boolean {
  const key = lockKey(proposalId);
  return key !== null && handle !== undefined && handle !== null &&
    held.get(key)?.handle === handle;
}

export function releaseProposalMutationLock(handle: ProposalMutationLock | null | undefined): void {
  if (!handle) return;
  const current = held.get(handle.key);
  if (!current || current.handle !== handle) return;
  held.delete(handle.key);
  releaseLocalStoreLock(current.lock);
}
