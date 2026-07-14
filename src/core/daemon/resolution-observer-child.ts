import { fileURLToPath } from 'node:url';
import {
  runResolutionObserver,
  writeResolutionObserverCheckpoint,
  writeResolutionObserverRunSummary,
  type ResolutionObserverOutcome,
  type RunResolutionObserverOptions,
} from '../fleet/resolution-observer.js';
import { recordResolutionWitness } from '../fleet/resolution-witness-ledger.js';
import {
  acquireOutwardMutationFence,
  ownsOutwardMutationFence,
  releaseOutwardMutationFence,
} from '../sandbox/mutation-fence.js';
import { canonicalFilesystemPathIdentity, killSwitchOn } from '../sandbox/policy.js';

type ObserverDependencies = NonNullable<RunResolutionObserverOptions['deps']>;

export interface ResolutionObserverChildDependencies {
  runObserver?: typeof runResolutionObserver;
  killSwitchOn?: () => boolean;
  acquireFence?: typeof acquireOutwardMutationFence;
  ownsFence?: typeof ownsOutwardMutationFence;
  releaseFence?: typeof releaseOutwardMutationFence;
  writeCheckpoint?: NonNullable<ObserverDependencies['writeCheckpoint']>;
  writeRunSummary?: NonNullable<ObserverDependencies['writeRunSummary']>;
  recordWitness?: NonNullable<ObserverDependencies['recordWitness']>;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function observerOutcomeSucceeded(outcome: ResolutionObserverOutcome): boolean {
  return outcome === 'seeded' || outcome === 'completed' || outcome === 'duplicate' || outcome === 'stale';
}

export function runResolutionObserverChild(
  args: readonly string[] = process.argv.slice(2),
  deps: ResolutionObserverChildDependencies = {},
): number {
  const deadlineMs = positiveInteger(args[0], 250);
  const maxRepos = positiveInteger(args[1], 24);
  const expectedBacklogGeneratedAt = args[2];
  const expectedBacklogSnapshotId = args[3];
  const acquireFence = deps.acquireFence ?? acquireOutwardMutationFence;
  const ownsFence = deps.ownsFence ?? ownsOutwardMutationFence;
  const releaseFence = deps.releaseFence ?? releaseOutwardMutationFence;
  const killIsOn = deps.killSwitchOn ?? killSwitchOn;
  const writeCheckpoint = deps.writeCheckpoint ?? ((value) =>
    writeResolutionObserverCheckpoint(value, { lockWaitMs: 20 }));
  const writeRunSummary = deps.writeRunSummary ?? ((value) =>
    writeResolutionObserverRunSummary(value, { lockWaitMs: 20 }));
  const recordWitness = deps.recordWitness ?? ((value) =>
    recordResolutionWitness(value, { lockWaitMs: 20 }));
  let fence: ReturnType<typeof acquireOutwardMutationFence> = null;
  let authorityRefused = false;

  try {
    fence = acquireFence();
    if (!ownsFence(fence) || killIsOn()) return 1;

    const authorizedForWrite = (): boolean => {
      const authorized = ownsFence(fence) && !killIsOn();
      if (!authorized) authorityRefused = true;
      return authorized;
    };
    if (!authorizedForWrite()) return 1;

    const result = (deps.runObserver ?? runResolutionObserver)({
      signal: AbortSignal.timeout(deadlineMs),
      deadlineMs,
      maxRepos,
      ...(expectedBacklogGeneratedAt ? { expectedBacklogGeneratedAt } : {}),
      ...(expectedBacklogSnapshotId ? { expectedBacklogSnapshotId } : {}),
      deps: {
        writeCheckpoint: (value) => authorizedForWrite() && writeCheckpoint(value),
        writeRunSummary: (value) => authorizedForWrite() && writeRunSummary(value),
        recordWitness: (value) => authorizedForWrite()
          ? recordWitness(value)
          : { attempted: 1, recorded: 0, replayed: 0, conflicted: 0, invalid: 0, failed: 1 },
      },
    });
    return !authorityRefused && observerOutcomeSucceeded(result.outcome) ? 0 : 1;
  } catch {
    return 1;
  } finally {
    releaseFence(fence);
  }
}

function invokedAsEntrypoint(invokedEntry: string | undefined): boolean {
  if (!invokedEntry) return false;
  try {
    const invokedIdentity = canonicalFilesystemPathIdentity(invokedEntry);
    const moduleIdentity = canonicalFilesystemPathIdentity(fileURLToPath(import.meta.url));
    return invokedIdentity !== null && moduleIdentity !== null && invokedIdentity === moduleIdentity;
  } catch {
    return false;
  }
}

if (invokedAsEntrypoint(process.argv[1])) {
  process.exitCode = runResolutionObserverChild();
}
