/**
 * Walk the Leader's seat chain (3.14) — try each planned seat in order until
 * one answers with a parseable memo, recording every attempt.
 *
 *   - A transport failure (fetch failed, HTTP error, CLI exit, per-attempt
 *     timeout) moves on to the next seat.
 *   - Unparseable output gets ONE re-ask on the same seat when that seat is
 *     free (local) — as before 3.14 — and then moves on only to a FREE seat:
 *     a paid seat answered and was paid for; spending a second paid seat on
 *     the same memo is not a fallback, it is a double charge.
 *
 * The seats themselves (and which may be tried at all) come from
 * `planLeaderSeats`; this module adds nothing to that list.
 */
import type { LeaderSeatPlanStep } from './leader-seat.js';
import { LeaderTimeoutError } from './leader-seat.js';
import type { LeaderSeatAttempt } from './leader-types.js';

export type ChainParse<T> = (raw: string) => { ok: true; draft: T } | { ok: false; reason: string };

export type LeaderChainResult<T> =
  | { ok: true; draft: T; step: LeaderSeatPlanStep; attempts: LeaderSeatAttempt[] }
  | { ok: false; outcome: 'failed' | 'parse-failed'; reason: string; lastStep: LeaderSeatPlanStep | null; attempts: LeaderSeatAttempt[] };

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return 'error';
  // undici hides the useful part ("headers timeout", "ECONNREFUSED") in `cause`.
  const cause = (err as Error & { cause?: unknown }).cause;
  const detail = cause instanceof Error && cause.message && cause.message !== err.message ? ` (${cause.message})` : '';
  return `${err.message}${detail}`.slice(0, 240);
}

function isTimeout(err: unknown): boolean {
  return err instanceof LeaderTimeoutError || (err instanceof Error && /timed out after/.test(err.message));
}

export async function runLeaderSeatChain<T>(
  steps: readonly LeaderSeatPlanStep[],
  call: { system: string; user: string; parse: ChainParse<T>; reask: (reason: string) => string },
  now: () => number,
): Promise<LeaderChainResult<T>> {
  const attempts: LeaderSeatAttempt[] = [];
  let lastStep: LeaderSeatPlanStep | null = null;
  let parseFailure: string | null = null;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    lastStep = step;
    const base = { seatId: step.choice.seatId, engine: step.choice.engine, model: step.choice.model, timeoutMs: step.budget.timeoutMs };
    const t0 = now();
    let raw: string;
    try {
      raw = await step.complete(call.system, call.user);
    } catch (err) {
      attempts.push({ ...base, outcome: isTimeout(err) ? 'timeout' : 'failed', reason: `The ${step.choice.engine} call failed: ${errorText(err)}`, ms: now() - t0 });
      continue;
    }
    let parsed = call.parse(raw);
    if (!parsed.ok && step.choice.engine === 'local') {
      try {
        parsed = call.parse(await step.complete(call.system, call.reask(parsed.reason)));
      } catch { /* keep the first parse failure */ }
    }
    if (parsed.ok) {
      attempts.push({ ...base, outcome: 'served', reason: null, ms: now() - t0 });
      return { ok: true, draft: parsed.draft, step, attempts };
    }
    parseFailure = parsed.reason;
    attempts.push({ ...base, outcome: 'parse-failed', reason: parsed.reason, ms: now() - t0 });
    const next = steps[i + 1];
    if (!next || next.choice.engine !== 'local') break;
  }
  if (parseFailure !== null) return { ok: false, outcome: 'parse-failed', reason: parseFailure, lastStep, attempts };
  const reason = attempts.length === 1
    ? attempts[0]!.reason ?? 'The seat call failed.'
    : `Every seat failed: ${attempts.map((a) => `${a.seatId} ${a.outcome === 'timeout' ? 'timed out' : 'failed'}`).join('; ')}. Last: ${attempts.at(-1)?.reason ?? 'error'}`;
  return { ok: false, outcome: 'failed', reason, lastStep, attempts };
}
