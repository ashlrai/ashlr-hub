import { runResolutionObserver } from '../fleet/resolution-observer.js';

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const deadlineMs = positiveInteger(process.argv[2], 250);
const maxRepos = positiveInteger(process.argv[3], 24);
const expectedBacklogGeneratedAt = process.argv[4];
const expectedBacklogSnapshotId = process.argv[5];

runResolutionObserver({
  signal: AbortSignal.timeout(deadlineMs),
  deadlineMs,
  maxRepos,
  ...(expectedBacklogGeneratedAt ? { expectedBacklogGeneratedAt } : {}),
  ...(expectedBacklogSnapshotId ? { expectedBacklogSnapshotId } : {}),
});
