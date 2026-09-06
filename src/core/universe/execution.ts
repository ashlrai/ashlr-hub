import { join, resolve } from 'node:path';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock,
  type LocalStoreLock } from '../fleet/local-store-lock.js';
import { defaultUniverseRoot, inspectPrivateDirectory } from './artifacts.js';
import { universePath } from './store.js';
import type { UniverseStoreOptions } from './types.js';

/** One owner spans an entire campaign, including the gaps between generations. */
export async function withUniverseExecution<T>(id: string, options: UniverseStoreOptions,
  operation: (lock: LocalStoreLock) => Promise<T>): Promise<T> {
  const root = inspectPrivateDirectory(resolve(options.root ?? defaultUniverseRoot()));
  inspectPrivateDirectory(join(root, 'universes'));
  const directory = inspectPrivateDirectory(universePath(root, id));
  const result = acquireLocalStoreLockWithOutcome(join(directory, '.execution.lock'), 0,
    { anchorPath: directory, exactPrivateStorage: true });
  if (result.state !== 'acquired') {
    throw new Error(result.state === 'contended' ? 'Universe already has an active execution owner' :
      'Universe execution ownership unavailable');
  }
  try { return await operation(result.lock); }
  finally { releaseLocalStoreLock(result.lock); }
}

export function assertUniverseExecution(directory: string, lock: LocalStoreLock): void {
  if (lock.path !== join(directory, '.execution.lock') || !ownsLocalStoreLock(lock)) {
    throw new Error('Universe execution ownership lost');
  }
}
