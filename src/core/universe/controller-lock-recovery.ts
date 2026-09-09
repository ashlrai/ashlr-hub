import { lstatSync, opendirSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock, type LocalStoreLock } from '../fleet/local-store-lock.js';
import { inspectPrivateDirectory } from './artifacts.js';
import { portfolioControllerDirectory } from './portfolio-controller-store.js';
import { ControllerRecoveryError } from './controller-recovery-error.js';

function emptyStaging(path: string): boolean {
  const directory = opendirSync(path);
  try { return directory.readSync() === null; }
  finally { directory.closeSync(); }
}

/** Reclaim only an abandoned writer mutex before a strict controller read.
 * This is not publication recovery: staged records remain untouched and held.
 */
export function recoverControllerRecordLock(id: string, options: { root: string }, execution: LocalStoreLock): void {
  const directory = portfolioControllerDirectory(id, options);
  const assertOwned = (): void => {
    if (execution.path !== join(directory, '.execution.lock') || !ownsLocalStoreLock(execution)) {
      throw new ControllerRecoveryError('controller-execution-ownership-unavailable');
    }
  };
  assertOwned();
  inspectPrivateDirectory(directory);
  const ledger = join(directory, 'ledger');
  try { lstatSync(ledger); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const paths = [ledger, join(ledger, 'records'), join(ledger, 'staging')];
  const identities = paths.map((path) => {
    inspectPrivateDirectory(path);
    return lstatSync(path, { bigint: true });
  });
  const lockPath = join(ledger, '.records.lock');
  try { lstatSync(lockPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  // Inspect a single entry rather than loading an unbounded staging directory.
  if (!emptyStaging(paths[2]!)) throw new ControllerRecoveryError('controller-publication-recovery-required');
  assertOwned();
  const acquired = acquireLocalStoreLockWithOutcome(lockPath, 0, { anchorPath: directory, exactPrivateStorage: true });
  if (acquired.state !== 'acquired') throw new ControllerRecoveryError(acquired.state === 'contended'
    ? 'controller-record-writer-busy' : 'controller-record-ownership-unavailable');
  let released = false;
  try {
    assertOwned();
    for (const [index, path] of paths.entries()) {
      inspectPrivateDirectory(path);
      const current = lstatSync(path, { bigint: true });
      if (current.dev !== identities[index]!.dev || current.ino !== identities[index]!.ino) {
        throw new ControllerRecoveryError('controller-record-storage-changed');
      }
    }
    if (!emptyStaging(paths[2]!)) throw new ControllerRecoveryError('controller-publication-recovery-required');
  } finally {
    // Strict readers reject any writer mutex, including our own; release first.
    released = releaseLocalStoreLock(acquired.lock);
  }
  if (!released) throw new ControllerRecoveryError('controller-record-release-failed');
}
