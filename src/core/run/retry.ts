/**
 * Bounded exponential-backoff retry for `ashlr run`.
 *
 * Fully deterministic — no jitter, no nondeterminism.
 * Bounded by construction: never loops more than policy.maxAttempts times.
 * No runtime deps beyond Node built-ins.
 */

import type { RetryPolicy } from '../types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Maximum backoff cap in ms — prevents degenerate waits on high maxAttempts. */
const MAX_DELAY_MS = 30_000;

/**
 * Compute backoff delay for a completed attempt (1-based).
 * delay = min(baseDelayMs * 2^(attempt - 1), MAX_DELAY_MS)
 * attempt=1 → 0 delay (first retry fires immediately after first failure).
 *
 * We define attempt=1 as the first try; the delay before retry attempt N+1
 * is `baseDelayMs * 2^(N-1)` where N is the just-failed attempt number.
 */
function backoffMs(policy: RetryPolicy, failedAttempt: number): number {
  // failedAttempt is 1-based. Exponent: 0 on first failure (immediate retry).
  const exponent = failedAttempt - 1;
  const raw = policy.baseDelayMs * Math.pow(2, exponent);
  return Math.min(raw, MAX_DELAY_MS);
}

/** Sleep without side effects. Await-able, resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run `fn` with bounded exponential backoff.
 *
 * - `fn` receives the 1-based attempt number (1, 2, ..., maxAttempts).
 * - Retries ONLY while `isRetryable(err)` is true AND attempts < policy.maxAttempts.
 * - Backoff delay before retry N+1 = policy.baseDelayMs * 2^(N-1), capped at 30 s.
 *   (attempt 1 failure → 0 ms delay before attempt 2 when baseDelayMs is 0, else baseDelayMs).
 * - Rethrows the last error when attempts are exhausted or the error is non-retryable.
 * - Bounded by construction: NEVER loops more than policy.maxAttempts times.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  isRetryable: (e: unknown) => boolean,
): Promise<T> {
  const maxAttempts = Math.max(1, policy.maxAttempts);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      const isLast = attempt === maxAttempts;
      if (isLast || !isRetryable(err)) {
        // Either exhausted all attempts or this error is non-retryable — give up.
        throw lastError;
      }

      // Wait before the next attempt.
      const delay = backoffMs(policy, attempt);
      if (delay > 0) {
        await sleep(delay);
      }
    }
  }

  // Unreachable (loop always throws or returns), but satisfies TypeScript.
  throw lastError;
}
