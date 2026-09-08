/** Shared foreground quota ownership; a pending fence survives uncertain cleanup. */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLocalStoreLock, acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock,
  type LocalStoreLock } from '../fleet/local-store-lock.js';
import { privateDirectory } from '../universe/artifacts.js';
import { fsyncDirectory } from '../util/durability.js';
import { readResourceJson } from './pool-runtime.js';

export interface ResourceQuotaRefreshLease {
  assertOwnership(): void;
  /** Publish durably before the first native metadata contact. */
  markPending(): void;
  /** The caller must await native teardown before requesting marker removal. */
  close(preservePending?: boolean): void;
}

/** One explicit private root, shared by console and bounded metadata collectors. */
export async function acquireResourceQuotaRefreshLease(root: string,
  options: { waitMs?: number; signal?: AbortSignal } = {}): Promise<ResourceQuotaRefreshLease> {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root || root === parse(root).root ||
      root.length > 4096 || [...root].some((character) => character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159)) {
    throw new Error('Invalid resource quota collector root');
  }
  const waitMs = options.waitMs === undefined ? 0 : options.waitMs;
  const signal = options.signal;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60_000) {
    throw new Error('Invalid resource quota collector wait budget');
  }
  const deadline = waitMs > 0 ? performance.now() + waitMs : null;
  const assertActive = (): void => {
    if (signal?.aborted || deadline !== null && performance.now() >= deadline) throw new Error();
  };
  let lock: LocalStoreLock | null = null;
  const pendingPath = join(root, '.resource-quota-refresh-pending.json');
  try {
    assertActive();
    privateDirectory(root);
    const lockPath = join(root, '.resource-quota-refresh.lock');
    const lockOptions = { anchorPath: root, exactPrivateStorage: true };
    if (deadline === null) lock = acquireLocalStoreLock(lockPath, 500, lockOptions);
    else {
      for (;;) {
        assertActive();
        const attempt = acquireLocalStoreLockWithOutcome(lockPath, 0, lockOptions);
        lock = attempt.lock;
        // Acquisition performs synchronous identity checks. A late acquisition
        // is released by the catch below, before it may publish a contact marker.
        assertActive();
        if (lock) break;
        if (attempt.state !== 'contended') throw new Error();
        // Only a verified live owner is waitable. Yield so a same-process owner
        // can finish; do not block its cleanup with a longer synchronous wait.
        await delay(Math.min(250, Math.max(1, Math.ceil(deadline - performance.now()))),
          undefined, { signal });
      }
    }
    assertActive();
    if (!lock) throw new Error();
    let pendingExists = true;
    try { lstatSync(pendingPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') pendingExists = false; else throw error; }
    if (pendingExists) throw new Error();
  } catch {
    const released = lock ? releaseLocalStoreLock(lock) : true;
    throw new Error(released
      ? 'Resource quota collector already owned or unavailable; prior pending work requires operator reconciliation'
      : 'Resource quota collector unavailable: acquisition cleanup unconfirmed');
  }

  let pending: { dev: bigint; ino: bigint; record: string } | null = null;
  let closed = false; let closeError: Error | null = null;
  function assertOwnership(): void {
    if (closed || !ownsLocalStoreLock(lock)) throw new Error('Quota collection ownership lost');
    if (!pending) return;
    try {
      const stat = lstatSync(pendingPath, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.dev !== pending.dev || stat.ino !== pending.ino ||
          typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()) ||
          process.platform !== 'win32' && (stat.mode & 0o777n) !== 0o600n ||
          JSON.stringify(readResourceJson(pendingPath, 512)) !== pending.record) throw new Error();
    } catch { throw new Error('Quota collection marker changed'); }
  }
  function markPending(): void {
    assertOwnership();
    let fd: number | undefined;
    try {
      fd = openSync(pendingPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      // A failed publication remains fenced. Do not infer successful native
      // cleanup or remove an unverified marker after a write/fsync failure.
      const record = JSON.stringify({ schemaVersion: 1, scope: 'codex-native-metadata',
        state: 'pending', startedAt: new Date().toISOString() });
      writeFileSync(fd, record + '\n'); fsyncSync(fd); fsyncDirectory(root); assertOwnership();
      const stat = fstatSync(fd, { bigint: true }); pending = { dev: stat.dev, ino: stat.ino, record };
      assertOwnership();
    } catch { throw new Error('Resource quota collector pending marker unavailable'); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  function close(preservePending = false): void {
    if (closed) { if (closeError) throw closeError; return; }
    try {
      assertOwnership();
      if (!preservePending && pending) {
        unlinkSync(pendingPath); fsyncDirectory(root); pending = null;
      }
    } catch { closeError = new Error('Resource quota collector shutdown uncertain'); }
    finally {
      closed = true;
      if (!releaseLocalStoreLock(lock)) closeError ??= new Error('Resource quota collector shutdown uncertain');
    }
    if (closeError) throw closeError;
  }
  return Object.freeze({ assertOwnership, markPending, close });
}
