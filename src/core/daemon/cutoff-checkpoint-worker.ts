import { captureEnrollmentCutoffSnapshotV2 } from '../fleet/enrollment-cutoff-snapshot.js';
import { recordCutoffObservationCheckpoint } from '../fleet/cutoff-observation-checkpoints.js';
import {
  acquireOutwardMutationFence,
  ownsOutwardMutationFence,
  releaseOutwardMutationFence,
} from '../sandbox/mutation-fence.js';
import { killSwitchOn } from '../sandbox/policy.js';
import {
  beginCutoffCaptureCommit,
  readCutoffCaptureSchedulerState,
} from './cutoff-checkpoint-scheduler.js';

export interface CutoffCheckpointWorkerDependencies {
  now?: () => number;
  killSwitchOn?: () => boolean;
  readState?: typeof readCutoffCaptureSchedulerState;
  capture?: typeof captureEnrollmentCutoffSnapshotV2;
  record?: typeof recordCutoffObservationCheckpoint;
  beginCommit?: typeof beginCutoffCaptureCommit;
  acquireFence?: typeof acquireOutwardMutationFence;
  ownsFence?: typeof ownsOutwardMutationFence;
  releaseFence?: typeof releaseOutwardMutationFence;
}

export function runCutoffCheckpointWorker(
  attemptId: string | undefined,
  deadlineAt: string | undefined,
  deps: CutoffCheckpointWorkerDependencies = {},
): number {
  const acquireFence = deps.acquireFence ?? acquireOutwardMutationFence;
  const ownsFence = deps.ownsFence ?? ownsOutwardMutationFence;
  const releaseFence = deps.releaseFence ?? releaseOutwardMutationFence;
  const killIsOn = deps.killSwitchOn ?? killSwitchOn;
  let fence: ReturnType<typeof acquireOutwardMutationFence> = null;
  try {
    fence = acquireFence();
    if (!ownsFence(fence)) return 1;

    // KILL must be observed only after entering the same serialization boundary
    // used by policy writers. Once commit begins, the durable write is allowed to
    // finish while a concurrent pause waits for this worker to release authority.
    if (killIsOn()) return 1;

    const now = deps.now ?? Date.now;
    const deadlineMs = deadlineAt ? Date.parse(deadlineAt) : NaN;
    const read = (deps.readState ?? readCutoffCaptureSchedulerState)();
    if (!attemptId || !Number.isFinite(deadlineMs) || now() >= deadlineMs ||
      read.sourceState !== 'healthy' || read.state?.active?.attemptId !== attemptId ||
      read.state.active.deadlineAt !== deadlineAt) return 1;
    const captured = (deps.capture ?? captureEnrollmentCutoffSnapshotV2)();
    if (!captured.ok || now() >= deadlineMs || !ownsFence(fence) || killIsOn() ||
      !(deps.beginCommit ?? beginCutoffCaptureCommit)(attemptId, deadlineAt!, now())) return 1;
    if (!ownsFence(fence)) return 1;
    const written = (deps.record ?? recordCutoffObservationCheckpoint)(captured.snapshot, {
      recoveryPolicy: 'root-required',
      captureAttemptId: attemptId,
    });
    return written.recorded === 1 || written.replayed === 1 ? 0 : 1;
  } catch { return 1; }
  finally { releaseFence(fence); }
}
