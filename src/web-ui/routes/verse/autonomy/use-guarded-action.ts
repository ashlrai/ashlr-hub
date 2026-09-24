/**
 * routes/verse/autonomy/use-guarded-action.ts — the one place a Verse control
 * surface turns "the operator clicked something destructive" into an actual
 * request. Shared by the Autonomy cockpit and the Approvals surface.
 *
 * It folds together the three things every mutating click in this app has to
 * do, which were previously re-implemented per call site:
 *
 *  - **Token hand-off.** No mutation hold yet → remember the action, open
 *    MutationTokenDialog, and run it once the token lands. The hold is read
 *    LIVE on dialog close, never from a render-time snapshot, because
 *    MutationTokenDialog's onClose fires before this component re-renders.
 *  - **Read-only sessions.** Every POST 404s when the server was started
 *    without dispatch. That is a session mode, not a failure, so it flips a
 *    `readOnly` flag the surface renders as an explanation — never as an error
 *    toast and never as a crash.
 *  - **Busy + error state** for exactly one in-flight action at a time.
 */
import { useCallback, useRef, useState } from 'react';
import { hasMutationHold } from '../../../data/auth-store.js';
import { ApiError, DispatchDisabledError } from '../../../data/client.js';
import { VerseControlLockedError } from './control-queries.js';
import { tidyProse } from './format.js';

export function describeControlError(err: unknown): string {
  if (err instanceof DispatchDisabledError) return 'This server runs without dispatch, so that action is unavailable.';
  if (err instanceof VerseControlLockedError) return err.message;
  if (err instanceof ApiError) {
    if (err.status === 401) return 'The mutation token was rejected. Unlock again with the token `ashlr verse` printed.';
    // The control plane writes a careful refusal ladder — "no repositories are
    // enrolled, so the loop would do nothing. Add scope first." — and returns
    // it as `note` on the 409 body. A blanket "something else is already
    // running" replaced every one of those with a sentence that was usually
    // false and never actionable. Show the server's own words whenever it
    // sent any; the generic line is now only the last resort. `tidyProse`
    // reads any ISO instant in those words as local time.
    if (err.detail) return tidyProse(err.detail);
    if (err.status === 400) return tidyProse(err.message);
    if (err.status === 409) return 'The server refused the action, and sent no reason.';
    return tidyProse(err.message);
  }
  return err instanceof Error ? tidyProse(err.message) : 'That action failed. Try again.';
}

export interface GuardedAction {
  /**
   * Run `fn`, prompting for the mutation token first when none is held.
   *
   * `onResult` receives `fn`'s resolved value when it succeeds. It exists
   * because the value was previously dropped on the floor, and for the daemon
   * routes that value carries the server's own account of what just happened
   * (`VerseDaemonActionResult.note` — e.g. that an ordinary stop also engaged
   * the global kill switch). It is not called when `fn` throws.
   */
  request: <T>(fn: () => Promise<T>, reason: string, onResult?: (result: T) => void) => void;
  busy: boolean;
  error: string | null;
  clearError: () => void;
  /** True once a POST 404'd — the server has no dispatch enabled. */
  readOnly: boolean;
  /** Bind these three to <MutationTokenDialog/>. */
  tokenOpen: boolean;
  tokenReason: string;
  closeToken: () => void;
}

export function useGuardedAction(): GuardedAction {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [tokenReason, setTokenReason] = useState('');
  // The deferred action and the callback that wants its result travel together
  // — the token dialog may run it a render later, long after `request` returned.
  const pending = useRef<{ fn: () => Promise<unknown>; onResult?: (result: never) => void } | null>(null);

  const perform = useCallback(
    async (fn: () => Promise<unknown>, onResult?: (result: never) => void) => {
      setBusy(true);
      setError(null);
      try {
        const result = await fn();
        onResult?.(result as never);
      } catch (err) {
        if (err instanceof DispatchDisabledError) setReadOnly(true);
        else setError(describeControlError(err));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const request = useCallback(
    <T,>(fn: () => Promise<T>, reason: string, onResult?: (result: T) => void) => {
      setError(null);
      const handler = onResult as ((result: never) => void) | undefined;
      if (hasMutationHold()) {
        void perform(fn, handler);
        return;
      }
      pending.current = { fn, onResult: handler };
      setTokenReason(reason);
      setTokenOpen(true);
    },
    [perform],
  );

  const closeToken = useCallback(() => {
    setTokenOpen(false);
    const next = pending.current;
    pending.current = null;
    // Live read: the dialog closes synchronously after setToken().
    if (next && hasMutationHold()) void perform(next.fn, next.onResult);
  }, [perform]);

  const clearError = useCallback(() => setError(null), []);

  return { request, busy, error, clearError, readOnly, tokenOpen, tokenReason, closeToken };
}
