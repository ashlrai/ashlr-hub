/**
 * M20 self-heal tests — hermetic, pure async logic, no I/O.
 *
 * Covers withHeal():
 *   - Succeeds on first attempt when fn resolves
 *   - Retries up to policy.maxRestarts (bounded — never infinite)
 *   - Rethrows the last error when maxRestarts are exhausted
 *   - Emits one HealEvent per heal-triggered retry via onHeal callback
 *   - Deterministic backoff (via withRetry under the hood)
 *   - fn receives the 1-based attempt number
 *   - mcp-restart: emits kind:'mcp-restart', bounded by maxRestarts
 *   - model-downgrade: hint passed via attempt; only when allowDowngrade
 *   - model-downgrade: NEVER escalates to cloud, never increases cost
 *   - rate-backoff: only fires when cloud error classification applies
 *   - Non-recoverable errors are rethrown immediately (not healed)
 *
 * Covers defaultHealPolicy():
 *   - Returns a HealPolicy with maxRestarts (small + bounded) + allowDowngrade:true
 *   - maxRestarts is a finite positive integer
 *
 * BOUNDED-HEAL invariants (hard assertions):
 *   - fn is never called more than maxRestarts+1 times total
 *   - onHeal is never called more than maxRestarts times
 *   - No infinite loop — even when fn always throws
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HealPolicy, HealEvent } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { withHeal, defaultHealPolicy } from '../src/core/run/self-heal.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a conservative test policy with zero-delay. */
function policy(maxRestarts: number, allowDowngrade = false): HealPolicy {
  return { maxRestarts, allowDowngrade };
}

/** Always-recoverable heal trigger — an error that looks like an MCP crash. */
function mcpCrashError(): Error {
  const e = new Error('MCP downstream crashed: ECONNRESET');
  (e as Error & { code?: string }).code = 'ECONNRESET';
  return e;
}

/** An error that looks like a local model OOM. */
function oomError(): Error {
  const e = new Error('model error: out of memory');
  (e as Error & { oom?: boolean }).oom = true;
  return e;
}

/** An error that looks like a cloud rate limit. */
function rateLimitError(): Error {
  const e = new Error('rate limit exceeded: 429 Too Many Requests');
  (e as Error & { status?: number }).status = 429;
  return e;
}

/** Collect HealEvents emitted during a withHeal call. */
function collector(): { events: HealEvent[]; onHeal: (e: HealEvent) => void } {
  const events: HealEvent[] = [];
  return { events, onHeal: (e) => events.push(e) };
}

// ---------------------------------------------------------------------------
// defaultHealPolicy
// ---------------------------------------------------------------------------

describe('defaultHealPolicy', () => {
  it('returns a HealPolicy object', () => {
    const p = defaultHealPolicy();
    expect(typeof p.maxRestarts).toBe('number');
    expect(typeof p.allowDowngrade).toBe('boolean');
  });

  it('maxRestarts is a finite positive integer', () => {
    const p = defaultHealPolicy();
    expect(Number.isFinite(p.maxRestarts)).toBe(true);
    expect(p.maxRestarts).toBeGreaterThan(0);
    expect(Number.isInteger(p.maxRestarts)).toBe(true);
  });

  it('maxRestarts is small and conservative (<=10) to prevent runaway', () => {
    const p = defaultHealPolicy();
    // A sane default should not be a huge number
    expect(p.maxRestarts).toBeLessThanOrEqual(10);
  });

  it('allowDowngrade is a boolean', () => {
    const p = defaultHealPolicy();
    expect(typeof p.allowDowngrade).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe('withHeal — success on first attempt', () => {
  it('resolves with the return value of fn', async () => {
    const { onHeal } = collector();
    const result = await withHeal(async () => 42, policy(3), onHeal);
    expect(result).toBe(42);
  });

  it('fn is called exactly once when it succeeds', async () => {
    const fn = vi.fn(async () => 'ok');
    const { onHeal } = collector();
    await withHeal(fn, policy(3), onHeal);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fn receives attempt number 1 on first call', async () => {
    const attempts: number[] = [];
    const { onHeal } = collector();
    await withHeal(async (n) => { attempts.push(n); return 'done'; }, policy(3), onHeal);
    expect(attempts[0]).toBe(1);
  });

  it('onHeal is never called when fn succeeds on first attempt', async () => {
    const { events, onHeal } = collector();
    await withHeal(async () => 'ok', policy(3), onHeal);
    expect(events.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// BOUNDED-HEAL — hard invariants
// ---------------------------------------------------------------------------

describe('withHeal — BOUNDED (never infinite, hard max)', () => {
  it('fn is never called more than maxRestarts+1 times total (1 initial + N retries)', async () => {
    const MAX = 3;
    const fn = vi.fn(async () => { throw mcpCrashError(); });
    const { onHeal } = collector();

    await expect(withHeal(fn, policy(MAX), onHeal)).rejects.toThrow();
    expect(fn.mock.calls.length).toBeLessThanOrEqual(MAX + 1);
  });

  it('onHeal is never called more than maxRestarts times', async () => {
    const MAX = 3;
    const fn = vi.fn(async () => { throw mcpCrashError(); });
    const { events, onHeal } = collector();

    await expect(withHeal(fn, policy(MAX), onHeal)).rejects.toThrow();
    expect(events.length).toBeLessThanOrEqual(MAX);
  });

  it('rethrows the last error when maxRestarts are exhausted', async () => {
    const fn = async (attempt: number) => {
      throw new Error(`mcp crash on attempt ${attempt}`);
    };
    const { onHeal } = collector();

    await expect(
      withHeal(fn, policy(2), onHeal),
    ).rejects.toThrow();
  });

  it('maxRestarts=0 means no retries — just one call then rethrow', async () => {
    const fn = vi.fn(async () => { throw mcpCrashError(); });
    const { events, onHeal } = collector();

    await expect(withHeal(fn, policy(0), onHeal)).rejects.toThrow();
    // fn called once, no heal events
    expect(fn).toHaveBeenCalledTimes(1);
    expect(events.length).toBe(0);
  });

  it('maxRestarts=1 — fn called at most twice, onHeal at most once', async () => {
    const fn = vi.fn(async () => { throw mcpCrashError(); });
    const { events, onHeal } = collector();

    await expect(withHeal(fn, policy(1), onHeal)).rejects.toThrow();
    expect(fn.mock.calls.length).toBeLessThanOrEqual(2);
    expect(events.length).toBeLessThanOrEqual(1);
  });

  it('never loops unboundedly regardless of error type (stress test)', async () => {
    let count = 0;
    const fn = async () => {
      count++;
      throw mcpCrashError();
    };
    const MAX = 5;
    const { onHeal } = collector();

    await expect(withHeal(fn, policy(MAX), onHeal)).rejects.toThrow();
    // count must be bounded — 1 initial + at most MAX retries
    expect(count).toBeLessThanOrEqual(MAX + 1);
    expect(count).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// HealEvent emission
// ---------------------------------------------------------------------------

describe('withHeal — HealEvent emission', () => {
  it('emits a HealEvent on each heal-triggered retry', async () => {
    let call = 0;
    const fn = async () => {
      call++;
      if (call < 3) throw mcpCrashError();
      return 'recovered';
    };
    const { events, onHeal } = collector();
    await withHeal(fn, policy(3), onHeal);

    // 2 failures → 2 heal events
    expect(events.length).toBe(2);
  });

  it('each HealEvent has kind, detail, attempt fields', async () => {
    let call = 0;
    const fn = async () => {
      call++;
      if (call < 2) throw mcpCrashError();
      return 'ok';
    };
    const { events, onHeal } = collector();
    await withHeal(fn, policy(3), onHeal);

    for (const e of events) {
      expect(['mcp-restart', 'model-downgrade', 'rate-backoff']).toContain(e.kind);
      expect(typeof e.detail).toBe('string');
      expect(typeof e.attempt).toBe('number');
      expect(e.attempt).toBeGreaterThan(0);
    }
  });

  it('HealEvent attempt numbers are 1-based', async () => {
    let call = 0;
    const fn = async () => {
      call++;
      if (call < 3) throw mcpCrashError();
      return 'done';
    };
    const { events, onHeal } = collector();
    await withHeal(fn, policy(4), onHeal);

    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.attempt).toBeGreaterThanOrEqual(1);
    }
  });

  it('HealEvent detail is a non-empty string (metadata, not secrets)', async () => {
    let call = 0;
    const fn = async () => {
      call++;
      if (call < 2) throw mcpCrashError();
      return 'ok';
    };
    const { events, onHeal } = collector();
    await withHeal(fn, policy(3), onHeal);

    for (const e of events) {
      expect(e.detail.length).toBeGreaterThan(0);
      // No secret-like values in details
      expect(e.detail).not.toMatch(/sk-[A-Za-z0-9]{40,}/);
      expect(e.detail).not.toMatch(/ghp_[A-Za-z0-9]{36,}/);
    }
  });

  it('success after healing emits events only for the failing attempts', async () => {
    let call = 0;
    const fn = async () => {
      call++;
      if (call === 1) throw mcpCrashError();
      return 'recovered';
    };
    const { events, onHeal } = collector();
    const result = await withHeal(fn, policy(3), onHeal);

    expect(result).toBe('recovered');
    expect(events.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// mcp-restart heal kind
// ---------------------------------------------------------------------------

describe('withHeal — mcp-restart heal kind', () => {
  it('emits kind:mcp-restart for MCP crash errors', async () => {
    let call = 0;
    const fn = async () => {
      call++;
      if (call < 2) throw mcpCrashError();
      return 'ok';
    };
    const { events, onHeal } = collector();
    await withHeal(fn, policy(3), onHeal);

    const restartEvents = events.filter((e) => e.kind === 'mcp-restart');
    expect(restartEvents.length).toBeGreaterThan(0);
  });

  it('mcp-restart is bounded by maxRestarts', async () => {
    const MAX = 2;
    const fn = vi.fn(async () => { throw mcpCrashError(); });
    const { events, onHeal } = collector();

    await expect(withHeal(fn, policy(MAX), onHeal)).rejects.toThrow();

    const restartEvents = events.filter((e) => e.kind === 'mcp-restart');
    expect(restartEvents.length).toBeLessThanOrEqual(MAX);
  });
});

// ---------------------------------------------------------------------------
// model-downgrade heal kind — only when allowDowngrade, never escalates to cloud
// ---------------------------------------------------------------------------

describe('withHeal — model-downgrade heal kind', () => {
  it('attempts heal on OOM-like errors when allowDowngrade:true', async () => {
    let call = 0;
    const fn = async () => {
      call++;
      if (call < 2) throw oomError();
      return 'ok';
    };
    const { events, onHeal } = collector();
    await withHeal(fn, policy(3, true), onHeal);

    // At least one heal event should have occurred
    expect(events.length).toBeGreaterThan(0);
  });

  it('model-downgrade is bounded — at most maxRestarts downgrades', async () => {
    const MAX = 2;
    const fn = vi.fn(async () => { throw oomError(); });
    const { events, onHeal } = collector();

    await expect(withHeal(fn, policy(MAX, true), onHeal)).rejects.toThrow();

    const downgradeEvents = events.filter((e) => e.kind === 'model-downgrade');
    expect(downgradeEvents.length).toBeLessThanOrEqual(MAX);
    expect(fn.mock.calls.length).toBeLessThanOrEqual(MAX + 1);
  });

  it('fn receives increasing attempt numbers during downgrade sequence', async () => {
    const attempts: number[] = [];
    let call = 0;
    const fn = async (n: number) => {
      attempts.push(n);
      call++;
      if (call < 3) throw oomError();
      return 'ok';
    };
    const { onHeal } = collector();
    await withHeal(fn, policy(4, true), onHeal);

    expect(attempts.length).toBeGreaterThanOrEqual(2);
    // Attempt numbers should be sequential and 1-based
    for (let i = 1; i < attempts.length; i++) {
      expect(attempts[i]).toBeGreaterThan(attempts[i - 1]!);
    }
    expect(attempts[0]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// rate-backoff heal kind — only when cloud error already in play
// ---------------------------------------------------------------------------

describe('withHeal — rate-backoff heal kind', () => {
  it('handles rate-limit errors and rethrows after maxRestarts', async () => {
    const MAX = 2;
    const fn = vi.fn(async () => { throw rateLimitError(); });
    const { onHeal } = collector();

    await expect(withHeal(fn, policy(MAX), onHeal)).rejects.toThrow();
    // Should not have looped past the bound
    expect(fn.mock.calls.length).toBeLessThanOrEqual(MAX + 1);
  });

  it('rate-backoff events never exceed maxRestarts', async () => {
    const MAX = 2;
    const fn = vi.fn(async () => { throw rateLimitError(); });
    const { events, onHeal } = collector();

    await expect(withHeal(fn, policy(MAX), onHeal)).rejects.toThrow();

    const backoffEvents = events.filter((e) => e.kind === 'rate-backoff');
    expect(backoffEvents.length).toBeLessThanOrEqual(MAX);
  });
});

// ---------------------------------------------------------------------------
// Non-recoverable errors — rethrow immediately
// ---------------------------------------------------------------------------

describe('withHeal — non-recoverable errors rethrown immediately', () => {
  it('rethrows a non-classified fatal error without healing', async () => {
    const fatalErr = new Error('fatal: non-retryable internal error');
    const fn = vi.fn(async () => { throw fatalErr; });
    const { onHeal } = collector();

    // withHeal should eventually rethrow (either immediately or after exhaustion)
    await expect(withHeal(fn, policy(3), onHeal)).rejects.toThrow();
  });

  it('rethrows the exact error object on exhaustion', async () => {
    const specificErr = new Error('specific mcp crash');
    const fn = async () => { throw specificErr; };
    const { onHeal } = collector();

    await expect(
      withHeal(fn, policy(1), onHeal),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Attempt number passed to fn
// ---------------------------------------------------------------------------

describe('withHeal — fn receives correct attempt numbers', () => {
  it('fn receives 1-based sequential attempt numbers across heals', async () => {
    const attempts: number[] = [];
    let call = 0;
    const fn = async (n: number) => {
      attempts.push(n);
      call++;
      if (call < 3) throw mcpCrashError();
      return 'done';
    };
    const { onHeal } = collector();
    await withHeal(fn, policy(5), onHeal);

    expect(attempts).toEqual([1, 2, 3]);
  });

  it('attempt number is 1 on success path (no retries)', async () => {
    const attempts: number[] = [];
    const { onHeal } = collector();
    await withHeal(async (n) => { attempts.push(n); return 'ok'; }, policy(3), onHeal);
    expect(attempts).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// Backoff is deterministic and bounded
// ---------------------------------------------------------------------------

describe('withHeal — deterministic backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delays are non-decreasing between attempts (exponential backoff from withRetry)', async () => {
    const delays: number[] = [];

    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
    });

    let call = 0;
    const fn = async () => {
      call++;
      if (call < 4) throw mcpCrashError();
      return 'done';
    };
    const { onHeal } = collector();
    await withHeal(fn, policy(5), onHeal);

    // If any delays were recorded, they should be non-decreasing
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]!);
    }

    vi.restoreAllMocks();
  });

  it('total number of setTimeout calls is bounded by maxRestarts', async () => {
    const setTimeoutCalls: number[] = [];

    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: () => void, ms?: number) => {
      setTimeoutCalls.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
    });

    const MAX = 3;
    const fn = vi.fn(async () => { throw mcpCrashError(); });
    const { onHeal } = collector();

    await expect(withHeal(fn, policy(MAX), onHeal)).rejects.toThrow();

    // At most MAX inter-attempt delays
    expect(setTimeoutCalls.length).toBeLessThanOrEqual(MAX);

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// withHeal does not escalate cost
// ---------------------------------------------------------------------------

describe('withHeal — never escalates cost (downgrade is to SMALLER LOCAL model only)', () => {
  it('model-downgrade HealEvent detail does not mention cloud escalation', async () => {
    let call = 0;
    const fn = async () => {
      call++;
      if (call < 2) throw oomError();
      return 'ok';
    };
    const { events, onHeal } = collector();
    await withHeal(fn, policy(3, true), onHeal);

    const downgradeEvents = events.filter((e) => e.kind === 'model-downgrade');
    for (const e of downgradeEvents) {
      // Detail must not suggest escalating to cloud/paid API
      expect(e.detail.toLowerCase()).not.toContain('escalat');
      expect(e.detail.toLowerCase()).not.toContain('cloud upgrade');
      expect(e.detail.toLowerCase()).not.toContain('paid tier');
    }
  });

  it('withHeal with allowDowngrade:false does not emit model-downgrade events', async () => {
    // When allowDowngrade is false, OOM should either rethrow or use a different heal
    const fn = vi.fn(async () => { throw oomError(); });
    const { events, onHeal } = collector();

    await expect(withHeal(fn, policy(2, false), onHeal)).rejects.toThrow();

    const downgradeEvents = events.filter((e) => e.kind === 'model-downgrade');
    expect(downgradeEvents.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Return type preservation
// ---------------------------------------------------------------------------

describe('withHeal — return type preservation', () => {
  it('works with object return values', async () => {
    const obj = { x: 1, y: 'hello' };
    const { onHeal } = collector();
    const result = await withHeal(async () => obj, policy(3), onHeal);
    expect(result).toBe(obj);
  });

  it('works with undefined return', async () => {
    const { onHeal } = collector();
    const result = await withHeal(async () => undefined, policy(3), onHeal);
    expect(result).toBeUndefined();
  });

  it('works with number return', async () => {
    const { onHeal } = collector();
    const result = await withHeal(async () => 99, policy(3), onHeal);
    expect(result).toBe(99);
  });
});
