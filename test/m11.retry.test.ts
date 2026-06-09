/**
 * M11 retry tests — hermetic, pure async logic, no I/O.
 *
 * Covers withRetry:
 *   - Succeeds on first attempt when fn resolves.
 *   - Retries only when isRetryable returns true.
 *   - Does NOT retry when isRetryable returns false (rethrows immediately).
 *   - Respects maxAttempts (bounded: never loops more than maxAttempts times).
 *   - Backoff order: baseDelayMs * 2^(attempt-1) for each inter-attempt delay.
 *   - Rethrows the last error when all attempts exhausted.
 *   - Rethrows the first non-retryable error.
 *   - fn receives the 1-based attempt number.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RetryPolicy } from '../src/core/types.js';
import { withRetry } from '../src/core/run/retry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a policy. */
function policy(maxAttempts: number, baseDelayMs = 0): RetryPolicy {
  // baseDelayMs=0 so tests run instantly; the ORDER of calls still verifies backoff.
  return { maxAttempts, baseDelayMs };
}

/** An isRetryable that matches only Error instances with message containing 'transient'. */
function transientOnly(e: unknown): boolean {
  return e instanceof Error && e.message.includes('transient');
}

/** Always retryable. */
const alwaysRetryable = () => true;

/** Never retryable. */
const neverRetryable = () => false;

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe('withRetry — success on first attempt', () => {
  it('resolves with the return value of fn', async () => {
    const result = await withRetry(async () => 42, policy(3), alwaysRetryable);
    expect(result).toBe(42);
  });

  it('calls fn exactly once when it succeeds', async () => {
    const fn = vi.fn(async () => 'ok');
    await withRetry(fn, policy(3), alwaysRetryable);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fn receives attempt number 1 on first call', async () => {
    const attempts: number[] = [];
    await withRetry(async (n) => { attempts.push(n); return 'done'; }, policy(3), alwaysRetryable);
    expect(attempts).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// Success after retries
// ---------------------------------------------------------------------------

describe('withRetry — success after retries', () => {
  it('resolves after the first failure then success', async () => {
    let call = 0;
    const fn = async () => {
      call++;
      if (call === 1) throw new Error('transient fail');
      return 'recovered';
    };
    const result = await withRetry(fn, policy(3), transientOnly);
    expect(result).toBe('recovered');
  });

  it('fn is called twice (1 fail + 1 success)', async () => {
    let call = 0;
    const fn = vi.fn(async () => {
      call++;
      if (call < 2) throw new Error('transient error');
      return 'ok';
    });
    await withRetry(fn, policy(3), transientOnly);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('attempt numbers are 1-based and sequential', async () => {
    const attempts: number[] = [];
    let call = 0;
    await withRetry(
      async (n) => {
        attempts.push(n);
        call++;
        if (call < 3) throw new Error('transient');
        return 'done';
      },
      policy(5),
      transientOnly,
    );
    expect(attempts).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Non-retryable errors
// ---------------------------------------------------------------------------

describe('withRetry — non-retryable error', () => {
  it('rethrows immediately without retrying', async () => {
    const fn = vi.fn(async () => { throw new Error('fatal'); });
    await expect(withRetry(fn, policy(5), neverRetryable)).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rethrows the exact error object', async () => {
    const err = new Error('specific fatal error');
    await expect(
      withRetry(async () => { throw err; }, policy(5), neverRetryable),
    ).rejects.toBe(err);
  });

  it('does not retry when isRetryable returns false for a transient-looking error', async () => {
    const fn = vi.fn(async () => { throw new Error('transient'); });
    // Override: never retryable regardless of message
    await expect(withRetry(fn, policy(5), neverRetryable)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// maxAttempts enforcement
// ---------------------------------------------------------------------------

describe('withRetry — maxAttempts bound', () => {
  it('never calls fn more than maxAttempts times', async () => {
    const fn = vi.fn(async () => { throw new Error('transient always'); });
    await expect(withRetry(fn, policy(3), alwaysRetryable)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rethrows the last error after maxAttempts exhausted', async () => {
    const fn = async (attempt: number) => {
      throw new Error(`transient attempt ${attempt}`);
    };
    await expect(withRetry(fn, policy(4), alwaysRetryable)).rejects.toThrow(
      'transient attempt 4',
    );
  });

  it('maxAttempts=1 means no retries — just one call then rethrow', async () => {
    const fn = vi.fn(async () => { throw new Error('transient'); });
    await expect(withRetry(fn, policy(1), alwaysRetryable)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('maxAttempts=1 succeeds if fn resolves', async () => {
    const result = await withRetry(async () => 'yes', policy(1), alwaysRetryable);
    expect(result).toBe('yes');
  });

  it('never loops unboundedly regardless of error type', async () => {
    let count = 0;
    const fn = async () => {
      count++;
      throw new Error('transient');
    };
    const MAX = 7;
    await expect(withRetry(fn, policy(MAX), alwaysRetryable)).rejects.toThrow();
    expect(count).toBe(MAX);
  });
});

// ---------------------------------------------------------------------------
// Backoff order — verify delay sequence is non-decreasing (exponential)
// ---------------------------------------------------------------------------

describe('withRetry — backoff order', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delay between attempt 1→2 is baseDelayMs * 2^0 = baseDelayMs', async () => {
    const delays: number[] = [];

    // Spy on setTimeout to capture delay values
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      // Execute immediately in fake-timer context
      fn();
      return 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
    });

    let call = 0;
    const fn = async () => {
      call++;
      if (call < 3) throw new Error('transient');
      return 'done';
    };

    await withRetry(fn, { maxAttempts: 5, baseDelayMs: 100 }, transientOnly);

    // Should have two delays for attempts 1→2 and 2→3
    // Delay[0] = 100 * 2^0 = 100
    // Delay[1] = 100 * 2^1 = 200
    expect(delays.length).toBeGreaterThanOrEqual(2);
    expect(delays[0]).toBeLessThanOrEqual(delays[1]!);
    vi.restoreAllMocks();
  });

  it('delays are non-decreasing (exponential, not fixed)', async () => {
    const delays: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const fn = vi.fn(async () => { throw new Error('transient'); });
    await expect(
      withRetry(fn, { maxAttempts: 4, baseDelayMs: 50 }, alwaysRetryable),
    ).rejects.toThrow();

    // 3 inter-attempt delays for 4 attempts
    expect(delays.length).toBe(3);
    // Each delay must be >= the previous
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]!);
    }
    // Should follow 2^n pattern: 50, 100, 200
    expect(delays[0]).toBe(50);
    expect(delays[1]).toBe(100);
    expect(delays[2]).toBe(200);
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Mixed retryable / non-retryable in sequence
// ---------------------------------------------------------------------------

describe('withRetry — mixed retryable/non-retryable', () => {
  it('stops retrying the moment isRetryable returns false', async () => {
    let call = 0;
    const fn = vi.fn(async () => {
      call++;
      throw new Error(call <= 2 ? 'transient' : 'fatal');
    });
    // retryable only for 'transient'
    await expect(withRetry(fn, policy(10), transientOnly)).rejects.toThrow('fatal');
    // Called: 1(transient→retry) + 2(transient→retry) + 3(fatal→stop)
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Return-type preservation
// ---------------------------------------------------------------------------

describe('withRetry — return type', () => {
  it('works with object return values', async () => {
    const obj = { a: 1, b: 'hello' };
    const result = await withRetry(async () => obj, policy(3), alwaysRetryable);
    expect(result).toBe(obj);
  });

  it('works with undefined return', async () => {
    const result = await withRetry(async () => undefined, policy(3), alwaysRetryable);
    expect(result).toBeUndefined();
  });
});
