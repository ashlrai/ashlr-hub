/** One foreground owner's shared permits; this does not create or replace its durable lease. */
import type { VerifyProcessGroupLifecycle } from '../run/verify-commands.js';

type NativeActivity = { settle(): void; processGroupLifecycle?: VerifyProcessGroupLifecycle };
export interface NativeMetadataCoordinator {
  readonly signal: AbortSignal;
  run<T>(operation: (processGroupLifecycle?: VerifyProcessGroupLifecycle) => Promise<T>, settlementConfirmed?: (value: T) => boolean): Promise<T>;
  abort(): void;
  dispose(): void;
}

export function createNativeMetadataCoordinator(options: {
  signal?: AbortSignal; maxConcurrent?: number;
  /** Durable reservation before invocation; settlement requires an explicit result predicate. */
  beginNativeActivity?: () => NativeActivity;
} = {}): NativeMetadataCoordinator {
  const maxConcurrent = options.maxConcurrent ?? 2;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 2 ||
    options.signal !== undefined && !(options.signal instanceof AbortSignal) ||
    options.beginNativeActivity !== undefined && typeof options.beginNativeActivity !== 'function') {
    throw new Error('Invalid native metadata coordinator configuration');
  }
  const controller = new AbortController();
  const queue: Array<{ start: () => void; reject: (error: Error) => void }> = [];
  let active = 0; let disposed = false;
  const abortError = () => new Error('Native metadata collection cancelled');

  function abort(): void {
    if (controller.signal.aborted) return;
    // Detach waiting permits before notifying active operations. Active calls retain
    // their permits until their owned native process cleanup actually settles.
    const waiting = queue.splice(0);
    controller.abort();
    for (const entry of waiting) entry.reject(abortError());
  }
  function pump(): void {
    while (!controller.signal.aborted && active < maxConcurrent && queue.length > 0) {
      active++;
      queue.shift()!.start();
    }
  }
  function run<T>(operation: (processGroupLifecycle?: VerifyProcessGroupLifecycle) => Promise<T>, settlementConfirmed?: (value: T) => boolean): Promise<T> {
    if (controller.signal.aborted) return Promise.reject(abortError());
    if (typeof operation !== 'function') return Promise.reject(new Error('Invalid native metadata operation'));
    if (options.beginNativeActivity && typeof settlementConfirmed !== 'function') {
      return Promise.reject(new Error('Native metadata settlement predicate required'));
    }
    return new Promise<T>((resolve, reject) => {
      queue.push({ reject, start: () => {
        // Check again immediately before invocation: an abort can occur after
        // granting a permit but before this microtask starts native work.
        let invoked = false;
        let activity: NativeActivity | undefined;
        const pending = Promise.resolve().then(() => {
          if (controller.signal.aborted) throw abortError();
          // Include reservation publication in the terminal failure boundary.
          // It must finish durably before native work can start.
          invoked = true;
          activity = options.beginNativeActivity?.();
          if (controller.signal.aborted) { activity?.settle(); throw abortError(); }
          return operation(activity?.processGroupLifecycle);
        }).then((value) => {
          if (activity) {
            if (settlementConfirmed!(value) !== true) throw new Error('Native metadata settlement unconfirmed');
            activity.settle();
          }
          return value;
        });
        void pending.then((value) => {
          active--; resolve(value); pump();
        }, (error: unknown) => {
          // A thrown/rejected operation provides no native cleanup witness.
          // Stop peers and reject waiting work BEFORE releasing this permit;
          // otherwise the queue could launch a replacement into uncertain work.
          if (invoked) abort();
          active--; reject(error); pump();
        });
      } });
      pump();
    });
  }
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    options.signal?.removeEventListener('abort', abort);
    abort();
  }
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  return Object.freeze({ signal: controller.signal, run, abort, dispose });
}
