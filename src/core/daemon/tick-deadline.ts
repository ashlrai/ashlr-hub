/**
 * The tick's preparation deadline: `hooks.beforeTick` (mirror prep, the
 * post-merge watch, ledger / presence / budget reads) may not hold a tick
 * open indefinitely.
 *
 * 2026-09-26, the first live standing tick: beforeTick's mirror prep waited
 * 10 minutes each on two stalled dependency installs and then several more
 * on a synchronous delete of their half-written node_modules; nothing was
 * recorded for ~16 minutes and `ashlr daemon status` could not say why. The
 * mirror phase now bounds itself (fleet/mirrors.ts MIRROR_TICK_PREP_DEADLINE_MS);
 * this is the backstop for the whole hook.
 *
 * Contract:
 *   - beforeTick gets an AbortSignal (TickHookContext.signal) that aborts at
 *     the deadline or when the daemon stops.
 *   - If the hook settles within the deadline, its result is returned as is.
 *   - If not, the signal aborts and the hook gets a short grace to wind down.
 *     Whatever it then returns (or if it still has not settled), the tick
 *     HOLDS PRODUCTION with a reason and goes on — verification and landing
 *     still run and the tick is recorded (`production-held`), exactly the
 *     fail-closed shape of a beforeTick that throws.
 *   - A hook still running past its grace is remembered; the NEXT tick does
 *     not start a second one on top of it (two mirror preps / watch passes
 *     racing) — it holds production until the first has settled.
 */
import type { BeforeTickResult } from './tick-hooks.js';

/** Default deadline for one tick's beforeTick (above the mirror phase's own 15 min). */
export const BEFORE_TICK_DEADLINE_MS = 25 * 60_000;
/** After the deadline aborts the hook, how long the tick waits for it to wind down. */
export const BEFORE_TICK_ABORT_GRACE_MS = 60_000;

let abandoned: { since: number; settled: Promise<void> } | null = null;

function minutes(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  if (ms >= 1_000) return `${Math.round(ms / 1_000)} s`;
  return `${Math.max(0, Math.round(ms))} ms`;
}

function held(reason: string): BeforeTickResult {
  return { pausedRepos: [], laneCaps: {}, holdProduction: reason };
}

/** True while a previous tick's abandoned beforeTick is still running (tests, status). */
export function abandonedBeforeTickRunning(): boolean {
  return abandoned !== null;
}

/**
 * Run `run(signal)` under the deadline contract above. Rejections propagate
 * (the loop's existing catch turns them into a production hold).
 */
export async function boundedBeforeTick(
  run: (signal: AbortSignal) => Promise<BeforeTickResult>,
  opts: { deadlineMs?: number; graceMs?: number; parentSignal?: AbortSignal; nowMs?: () => number } = {},
): Promise<BeforeTickResult> {
  const now = opts.nowMs ?? Date.now;
  if (abandoned) {
    return held(
      `the previous tick's preparation has not finished (abandoned at its deadline ${minutes(now() - abandoned.since)} ago); `
      + 'no new production until it settles',
    );
  }
  const deadlineMs = Math.max(1, opts.deadlineMs ?? BEFORE_TICK_DEADLINE_MS);
  const graceMs = Math.max(0, opts.graceMs ?? BEFORE_TICK_ABORT_GRACE_MS);
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort();
  if (opts.parentSignal?.aborted) controller.abort();
  else opts.parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  const started = now();
  const running = run(controller.signal);
  // Observed below in every branch; this only keeps a late rejection from
  // surfacing as an unhandled rejection once the tick has stopped waiting.
  running.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = <T>(ms: number, value: T): Promise<T> => new Promise((resolveWait) => {
    timer = setTimeout(() => resolveWait(value), ms);
  });
  try {
    const first = await Promise.race([running.then((result) => ({ result })), wait(deadlineMs, 'deadline' as const)]);
    if (first !== 'deadline') return first.result;
    if (timer) clearTimeout(timer);
    controller.abort();
    const reason = `tick preparation exceeded its ${minutes(deadlineMs)} deadline and was cancelled; production held this tick`;
    const second = await Promise.race([
      running.then((result) => ({ result }), () => ({ result: null })),
      wait(graceMs, 'grace' as const),
    ]);
    if (second !== 'grace') {
      const result = second.result;
      return result ? { ...result, holdProduction: result.holdProduction ?? reason } : held(reason);
    }
    const entry = {
      since: started + deadlineMs,
      settled: running.then(() => undefined, () => undefined).finally(() => {
        if (abandoned === entry) abandoned = null;
      }),
    };
    abandoned = entry;
    return held(`${reason}; it had not stopped ${minutes(graceMs)} later and is left to finish`);
  } finally {
    if (timer) clearTimeout(timer);
    opts.parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

/** Test-only: forget an abandoned hook. */
export function resetBoundedBeforeTickForTests(): void {
  abandoned = null;
}
