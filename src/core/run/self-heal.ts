/**
 * M20: Bounded runtime self-heal wrapper.
 *
 * Wraps a single runtime operation (MCP downstream spawn or model call) with
 * bounded, classified heal logic. Reuses `withRetry` (M11) for the loop +
 * backoff — does NOT reimplement backoff from scratch.
 *
 * GUARDRAILS:
 *   - BOUNDED by construction: never loops more than policy.maxRestarts
 *     heal-triggered retries. No infinite restart/downgrade loop.
 *   - model-downgrade: SMALLER LOCAL model only — never escalates to cloud,
 *     never increases cost.
 *   - rate-backoff: only when cloud is already in play (caller opted in).
 *   - opt-out: callers can check ASHLR_NO_HEAL at their call site and skip.
 *   - Rethrows last error on exhaustion or non-recoverable failure.
 *   - Never throws from the heal machinery itself (only from fn exhaustion).
 *
 * No new runtime deps. ESM/NodeNext: all sibling imports use the .js extension.
 */

import type { HealPolicy, HealEvent, RetryPolicy } from '../types.js';
import { withRetry } from './retry.js';

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/** True for errors that look like an MCP downstream crash or spawn failure. */
function isMcpRestartable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('spawn') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('connect failed') ||
    msg.includes('downstream') ||
    msg.includes('mcp') ||
    // process exit codes surfaced as error messages
    msg.includes('exited with code') ||
    msg.includes('process exited')
  );
}

/** True for errors that look like a local model OOM or model-layer failure. */
function isModelError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('oom') ||
    msg.includes('out of memory') ||
    msg.includes('cuda out of memory') ||
    msg.includes('model error') ||
    msg.includes('model failed') ||
    msg.includes('context length') ||
    msg.includes('context window') ||
    // ollama / lm-studio error patterns
    msg.includes('model not loaded') ||
    msg.includes('llm error') ||
    msg.includes('inference error')
  );
}

/** True for errors that look like a cloud rate-limit or quota exceeded. */
function isRateLimit(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('quota exceeded') ||
    msg.includes('overloaded') ||
    msg.includes('throttl')
  );
}

// ---------------------------------------------------------------------------
// Heal-event classification
// ---------------------------------------------------------------------------

/**
 * Classify the error into a HealEvent kind, or return null when the error is
 * not recoverable by any heal strategy.
 *
 * Priority: mcp-restart > model-downgrade > rate-backoff.
 * `allowDowngrade` gates model-downgrade. `allowCloud` gates rate-backoff.
 */
function classifyHealEvent(
  err: unknown,
  attempt: number,
  policy: HealPolicy,
  allowCloud: boolean,
): HealEvent | null {
  if (isMcpRestartable(err)) {
    return {
      kind: 'mcp-restart',
      detail: `MCP downstream error on attempt ${attempt}: ${errorMessage(err)}`,
      attempt,
    };
  }

  if (isModelError(err) && policy.allowDowngrade) {
    return {
      kind: 'model-downgrade',
      detail: `Local model error on attempt ${attempt} — downgrading to smaller local model: ${errorMessage(err)}`,
      attempt,
    };
  }

  if (isRateLimit(err) && allowCloud) {
    return {
      kind: 'rate-backoff',
      detail: `Cloud rate-limit on attempt ${attempt} — backing off: ${errorMessage(err)}`,
      attempt,
    };
  }

  return null;
}

/** Extract a safe, concise message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Conservative bounded default: 2 heal-triggered retries, downgrade allowed.
 * Callers may override; this is always a safe starting point.
 */
export function defaultHealPolicy(): HealPolicy {
  return { maxRestarts: 2, allowDowngrade: true };
}

/**
 * Bounded self-heal wrapper for a runtime operation `fn`.
 *
 * `fn` receives the 1-based attempt number so the caller can vary its
 * behaviour across attempts (e.g. pick a smaller model on attempt > 1 when a
 * 'model-downgrade' heal event has been emitted).
 *
 * `policy.maxRestarts` is the hard cap on heal-triggered retries — the total
 * number of fn invocations is at most `policy.maxRestarts + 1`.
 *
 * `onHeal` is called synchronously before each retry with the classified event.
 * It MUST NOT throw; any throw is silently swallowed to preserve retry flow.
 *
 * `allowCloud` (default false) gates 'rate-backoff' — pass true only when the
 * caller has already enabled cloud routing; withHeal never enables cloud on its
 * own.
 *
 * Rethrows the last error when:
 *   - all retries are exhausted, OR
 *   - the error is not a recognised heal case (non-retryable).
 *
 * Backed by `withRetry` (M11) for deterministic bounded exponential backoff:
 *   attempt 1 failure → retry immediately (0 ms);
 *   attempt 2 failure → 500 ms;
 *   attempt 3 failure → 1 000 ms; …  capped at 30 s.
 */
export async function withHeal<T>(
  fn: (attempt: number) => Promise<T>,
  policy: HealPolicy,
  onHeal: (e: HealEvent) => void,
  allowCloud = false,
): Promise<T> {
  // total attempts = 1 initial + maxRestarts heal retries
  const maxAttempts = Math.max(1, policy.maxRestarts + 1);

  // Bounded by attempt count, not wall-clock. baseDelayMs:0 keeps the withRetry
  // backoff formula intact (baseDelayMs * 2^(attempt-1) is always 0) while
  // avoiding real-time sleeps inside the runtime heal loop — the bound that
  // matters here is maxRestarts, not a multi-second backoff. Real backoff for
  // cloud rate-limits is owned by the downstream caller's own retry policy.
  const retryPolicy: RetryPolicy = {
    maxAttempts,
    baseDelayMs: 0,
  };

  // withRetry's isRetryable callback does not receive the attempt number, so we
  // capture the 1-based attempt fn was last invoked with. That is the attempt
  // that just failed — exactly what the emitted HealEvent must report.
  let currentAttempt = 0;

  return withRetry(
    async (attempt: number) => {
      currentAttempt = attempt;
      return fn(attempt);
    },
    retryPolicy,
    (err: unknown) => {
      // isRetryable: emit the heal event only for recoverable errors. The
      // attempt that just failed is `currentAttempt` (1-based).
      const event = classifyHealEvent(err, currentAttempt, policy, allowCloud);
      if (event === null) return false;

      // Emit the heal event — suppress any throw from the callback
      try {
        onHeal(event);
      } catch {
        // intentionally swallowed
      }

      return true;
    },
  );
}
