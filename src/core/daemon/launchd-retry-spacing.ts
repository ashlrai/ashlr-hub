const POLL_INTERVAL_MS = 250;

export type LaunchdRetryWaitResult =
  | { status: 'ready'; nowMs: number }
  | { status: 'aborted' }
  | { status: 'clock-invalid' };

/** Wait for an externally signed not-before instant while polling the operator stop switch. */
export async function waitForLaunchdRetryNotBefore(
  notBeforeMs: number,
  now: () => number,
  aborted: () => boolean,
): Promise<LaunchdRetryWaitResult> {
  for (;;) {
    if (aborted()) return { status: 'aborted' };
    const current = now();
    if (!Number.isSafeInteger(current) || current < 0) return { status: 'clock-invalid' };
    if (current >= notBeforeMs) return { status: 'ready', nowMs: current };
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, Math.min(POLL_INTERVAL_MS, notBeforeMs - current));
    });
  }
}
