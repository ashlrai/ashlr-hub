/** Fixed fixture graph only. Never installed as a candidate-selected runner. */
import { performance } from 'node:perf_hooks';
import { runVerifySubprocessAsync as originalRun, type VerifySubprocessOptions } from '../../src/core/run/verify-commands.js';
import type { createBuiltinActivityTracker } from './preparation-verification-activity.mjs';
export * from '../../src/core/run/verify-commands.js';

export interface PreparationFixtureScope {
  activity?: ReturnType<typeof createBuiltinActivityTracker>;
  signal: AbortSignal;
  deadlineAt: string;
}
type Run = typeof originalRun;
const refused = () => new Error('Preparation fixture execution unavailable or unsettled');

/** Injectable only for pure wrapper tests; the shipped fixture entry uses originalRun. */
export function createPreparationFixtureRuntime(run: Run = originalRun) {
  let active: {
    abort: AbortController; signal: AbortSignal; deadline: number; wallDeadline: number;
    activity?: ReturnType<typeof createBuiltinActivityTracker>; pending: Set<Promise<unknown>>;
    closing: boolean; failed: boolean; processGroups: number;
  } | undefined;

  const wrapped: Run = async (argv, options) => {
    const context = active;
    if (!context || context.closing) throw refused();
    const remaining = () => Math.floor(Math.min(context.deadline - performance.now(), context.wallDeadline - Date.now()));
    if (context.signal.aborted || remaining() <= 0 || options.processGroupLifecycle !== undefined ||
        !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      context.failed = true; throw refused();
    }
    const signal = options.signal ? AbortSignal.any([context.signal, options.signal]) : context.signal;
    if (signal.aborted) { context.failed = true; throw refused(); }
    let lifecycle: VerifySubprocessOptions['processGroupLifecycle'];
    try { lifecycle = context.activity?.lifecycle('tool'); }
    catch (error) { context.failed = true; throw error; }
    const timeoutMs = Math.min(options.timeoutMs, remaining());
    if (signal.aborted || timeoutMs <= 0) { context.failed = true; throw refused(); }
    const supplied: VerifySubprocessOptions = { ...options, timeoutMs, signal, requireProcessGroupExit: true,
      ...(lifecycle ? { processGroupLifecycle: lifecycle } : {}) };
    const pending = Promise.resolve().then(() => {
      // The microtask gap must not renew a spent deadline or start after abort.
      supplied.timeoutMs = Math.min(supplied.timeoutMs, remaining());
      if (signal.aborted || supplied.timeoutMs <= 0) throw refused();
      return run(argv, supplied);
    }).then(result => {
      if (result.processGroupSettlement === 'group-exit-confirmed') context.processGroups++;
      if (result.processGroupSettlement !== 'group-exit-confirmed' ||
          signal.aborted || remaining() <= 0) throw refused();
      // A fixture may inspect a failed command, but cannot turn it into valid
      // setup by swallowing the result. Ownership settlement alone is not success.
      if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.cancelled ||
          result.outputTruncated || result.error !== undefined) context.failed = true;
      return result;
    }).catch(error => { context.failed = true; throw error; });
    context.pending.add(pending);
    try { return await pending; }
    finally { context.pending.delete(pending); }
  };

  async function withScope<T>(options: PreparationFixtureScope, action: (signal: AbortSignal, deadlineMonotonicMs: number) => Promise<T>) {
    if (active || !(options.signal instanceof AbortSignal) || typeof options.deadlineAt !== 'string') throw refused();
    const wallDeadline = Date.parse(options.deadlineAt), duration = wallDeadline - Date.now();
    if (!Number.isFinite(wallDeadline) || new Date(wallDeadline).toISOString() !== options.deadlineAt ||
        duration <= 0 || duration > 900000 || options.signal.aborted) throw refused();
    const abort = new AbortController();
    const context = { abort, signal: AbortSignal.any([options.signal, abort.signal]), deadline: performance.now() + duration,
      wallDeadline, ...(options.activity ? { activity: options.activity } : {}), pending: new Set<Promise<unknown>>(),
      closing: false, failed: false, processGroups: 0 };
    active = context;
    const timer = setTimeout(() => abort.abort(), duration);
    try {
      const fixture = await action(context.signal, context.deadline);
      if (context.pending.size) { context.failed = true; abort.abort(); }
      context.closing = true;
      await Promise.allSettled([...context.pending]);
      if (context.failed || context.signal.aborted || performance.now() >= context.deadline || Date.now() >= wallDeadline) throw refused();
      return { fixture, measurement: { processGroups: context.processGroups } };
    } catch (error) {
      context.closing = true; abort.abort();
      await Promise.allSettled([...context.pending]);
      throw error;
    } finally {
      clearTimeout(timer); active = undefined;
    }
  }
  return { run: wrapped, withScope };
}

const fixedRuntime = createPreparationFixtureRuntime();
export const runVerifySubprocessAsync = fixedRuntime.run;
export const withPreparationFixtureScope = fixedRuntime.withScope;
