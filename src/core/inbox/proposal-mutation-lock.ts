import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLocalStoreLock,
  canRetryLocalStoreLockRelease,
  ownsLocalStoreLock,
  releaseLocalStoreLock,
  type LocalStoreLock,
} from '../fleet/local-store-lock.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';

export interface ProposalMutationLock {
  key: string;
  token: symbol;
}

export interface ProposalStoreMutationLock {
  token: symbol;
}

interface HeldLock<Handle> {
  lock: LocalStoreLock;
  handle: Handle;
  state: 'active' | 'release-pending';
}

const held = new Map<string, HeldLock<ProposalMutationLock>>();
let heldStore: HeldLock<ProposalStoreMutationLock> | undefined;

function releasePending(entry: HeldLock<unknown>): 'released' | 'pending' | 'lost' {
  if (entry.state !== 'release-pending') return 'pending';
  if (releaseLocalStoreLock(entry.lock)) return 'released';
  return canRetryLocalStoreLockRelease(entry.lock) ? 'pending' : 'lost';
}

function lockKey(proposalId: string): string | null {
  if (!/^[\w.-]+$/.test(proposalId)) return null;
  return createHash('sha256').update(proposalId).digest('hex');
}

function lockPath(root: string, key: string): string {
  return join(root, '.proposal-mutation-locks', `${key}.lock`);
}

function storeLockPath(root: string): string {
  return join(root, '.proposal-store-locks', 'writer.lock');
}

function proposalAuthorityRoot(): string | null {
  const parent = homedir();
  const root = join(parent, '.ashlr');
  try {
    const parentBefore = lstatSync(parent);
    if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory() ||
      (typeof process.getuid === 'function' && parentBefore.uid !== process.getuid())) return null;
    let created = false;
    if (!existsSync(root)) {
      created = mkdirSync(root, { recursive: true, mode: 0o700 }) !== undefined;
    }
    const before = lstatSync(root);
    if (before.isSymbolicLink() || !before.isDirectory() ||
      (typeof process.getuid === 'function' && before.uid !== process.getuid())) return null;
    if (process.platform !== 'win32') chmodSync(root, 0o700);
    if (!assurePrivateStoragePath(
      root,
      'directory',
      created ? 'secure-created' : 'inspect-existing',
      { anchorPath: parent },
    ).ok) return null;
    const after = lstatSync(root);
    const parentAfter = lstatSync(parent);
    return !after.isSymbolicLink() && after.isDirectory() &&
      after.dev === before.dev && after.ino === before.ino &&
      !parentAfter.isSymbolicLink() && parentAfter.isDirectory() &&
      parentAfter.dev === parentBefore.dev && parentAfter.ino === parentBefore.ino &&
      (process.platform === 'win32' || (after.mode & 0o777) === 0o700)
      ? root
      : null;
  } catch {
    return null;
  }
}

/** Cross-process fence shared by every durable proposal-file replacement. */
export function acquireProposalStoreMutationLock(waitMs = 2_000): ProposalStoreMutationLock | null {
  if (heldStore?.state === 'active') return null;
  if (heldStore) {
    const release = releasePending(heldStore);
    if (release === 'pending') return null;
    heldStore = undefined;
  }
  const root = proposalAuthorityRoot();
  if (!root) return null;
  const lock = acquireLocalStoreLock(storeLockPath(root), waitMs, {
    anchorPath: root,
  });
  if (!lock) return null;
  const handle = { token: Symbol('proposal-store-writer') };
  heldStore = { lock, handle, state: 'active' };
  return handle;
}

export function ownsProposalStoreMutationLock(
  handle: ProposalStoreMutationLock | null | undefined,
): boolean {
  if (handle === undefined || handle === null || heldStore?.handle !== handle ||
    heldStore.state !== 'active') return false;
  if (ownsLocalStoreLock(heldStore.lock)) return true;
  heldStore.state = 'release-pending';
  if (releasePending(heldStore) !== 'pending') heldStore = undefined;
  return false;
}

export function releaseProposalStoreMutationLock(
  handle: ProposalStoreMutationLock | null | undefined,
): void {
  if (!handle || heldStore?.handle !== handle) return;
  const current = heldStore;
  current.state = 'release-pending';
  if (releasePending(current) !== 'pending') heldStore = undefined;
}

/** Cross-process proposal fence. Nested writes must present the exact owner capability. */
export function acquireProposalMutationLock(
  proposalId: string,
  waitMs = 2_000,
): ProposalMutationLock | null {
  const key = lockKey(proposalId);
  if (!key) return null;
  const existing = held.get(key);
  if (existing?.state === 'active') return null;
  if (existing) {
    const release = releasePending(existing);
    if (release === 'pending') return null;
    held.delete(key);
  }
  const root = proposalAuthorityRoot();
  if (!root) return null;
  const lock = acquireLocalStoreLock(lockPath(root, key), waitMs, {
    anchorPath: root,
  });
  if (!lock) return null;
  const handle = { key, token: Symbol(key) };
  held.set(key, { lock, handle, state: 'active' });
  return handle;
}

export function ownsProposalMutationLock(
  proposalId: string,
  handle: ProposalMutationLock | null | undefined,
): boolean {
  const key = lockKey(proposalId);
  if (key === null || handle === undefined || handle === null) return false;
  const current = held.get(key);
  if (!current || current.handle !== handle || current.state !== 'active') return false;
  if (ownsLocalStoreLock(current.lock)) return true;
  current.state = 'release-pending';
  if (releasePending(current) !== 'pending') held.delete(key);
  return false;
}

export function releaseProposalMutationLock(handle: ProposalMutationLock | null | undefined): void {
  if (!handle) return;
  const current = held.get(handle.key);
  if (!current || current.handle !== handle) return;
  current.state = 'release-pending';
  if (releasePending(current) !== 'pending') held.delete(handle.key);
}
