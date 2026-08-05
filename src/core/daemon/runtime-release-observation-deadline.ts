export interface RuntimeReleaseObservationDeadline {
  deadline: number;
  now: () => number;
}

export class RuntimeReleaseObservationDeadlineExceededError extends Error {
  override readonly name = 'RuntimeReleaseObservationDeadlineExceededError';
}

/**
 * Enforce a shared cooperative monotonic deadline between synchronous steps.
 * A blocking synchronous syscall cannot be preempted; callers must isolate the
 * work in a worker or native service if they need a hard wall-clock timeout.
 */
export function requireBeforeRuntimeReleaseObservationDeadline(
  observation: RuntimeReleaseObservationDeadline | undefined,
  label: string,
): void {
  if (!observation) return;
  let now: number;
  try {
    now = observation.now();
  } catch {
    throw new RuntimeReleaseObservationDeadlineExceededError(
      `${label} observation deadline exceeded`,
    );
  }
  if (!Number.isFinite(observation.deadline) || !Number.isFinite(now) ||
    now >= observation.deadline) {
    throw new RuntimeReleaseObservationDeadlineExceededError(
      `${label} observation deadline exceeded`,
    );
  }
}
