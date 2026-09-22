import { join, resolve } from 'node:path';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock,
  type LocalStoreLock } from '../fleet/local-store-lock.js';
import { defaultUniverseRoot, inspectPrivateDirectory } from './artifacts.js';
import { universePath } from './store.js';
import { assertCampaignSeedEvaluatorsSettled } from './campaign-store.js';
import { assertPreparationMeasurementsSettled } from './preparation-measurement-capture-store.js';
import { assertBuiltinTrialEvaluatorsSettled } from './builtin-trial-custody.js';
import type { UniverseStoreOptions } from './types.js';

/** Acquire experiment ownership; distinguish verified live contention from unavailable ownership. */
export function acquireUniverseExecution(id: string, options: UniverseStoreOptions) {
  const root = inspectPrivateDirectory(resolve(options.root ?? defaultUniverseRoot()));
  inspectPrivateDirectory(join(root, 'universes'));
  const directory = inspectPrivateDirectory(universePath(root, id));
  const outcome = acquireLocalStoreLockWithOutcome(join(directory, '.execution.lock'), 0,
    { anchorPath: directory, exactPrivateStorage: true });
  if (outcome.state === 'acquired') {
    try { assertCampaignSeedEvaluatorsSettled(id, { root }); assertPreparationMeasurementsSettled(directory);
      assertBuiltinTrialEvaluatorsSettled(directory); }
    catch (error) { releaseLocalStoreLock(outcome.lock); throw error; }
  }
  return outcome;
}

/** One owner spans an entire campaign, including the gaps between generations. */
export async function withUniverseExecution<T>(id: string, options: UniverseStoreOptions,
  operation: (lock: LocalStoreLock) => Promise<T>): Promise<T> {
  const result = acquireUniverseExecution(id, options);
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
