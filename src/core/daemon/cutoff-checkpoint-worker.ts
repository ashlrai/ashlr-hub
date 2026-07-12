import { captureEnrollmentCutoffSnapshotV2 } from '../fleet/enrollment-cutoff-snapshot.js';
import { recordCutoffObservationCheckpoint } from '../fleet/cutoff-observation-checkpoints.js';
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
}

export function runCutoffCheckpointWorker(
  attemptId: string | undefined,
  deadlineAt: string | undefined,
  deps: CutoffCheckpointWorkerDependencies = {},
): number {
  try {
    const now = deps.now ?? Date.now;
    const deadlineMs = deadlineAt ? Date.parse(deadlineAt) : NaN;
    const read = (deps.readState ?? readCutoffCaptureSchedulerState)();
    if (!attemptId || !Number.isFinite(deadlineMs) || now() >= deadlineMs ||
      read.sourceState !== 'healthy' || read.state?.active?.attemptId !== attemptId ||
      read.state.active.deadlineAt !== deadlineAt || (deps.killSwitchOn ?? killSwitchOn)()) return 1;
    const captured = (deps.capture ?? captureEnrollmentCutoffSnapshotV2)();
    if (!captured.ok || now() >= deadlineMs || (deps.killSwitchOn ?? killSwitchOn)() ||
      !(deps.beginCommit ?? beginCutoffCaptureCommit)(attemptId, deadlineAt!, now())) return 1;
    const written = (deps.record ?? recordCutoffObservationCheckpoint)(captured.snapshot, {
      recoveryPolicy: 'root-required',
      captureAttemptId: attemptId,
    });
    return written.recorded === 1 || written.replayed === 1 ? 0 : 1;
  } catch { return 1; }
}
