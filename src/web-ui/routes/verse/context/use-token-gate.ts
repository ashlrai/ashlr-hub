/**
 * routes/verse/context/use-token-gate.ts — the mutation-token hand-off for
 * the self-contained context surfaces (handoff dialog, memory panel).
 *
 * Same contract as ChatSection's `withToken`, extracted because these
 * components are mounted by OTHER owners (the workspace header, the resources
 * panel) that cannot thread a guard down to them:
 *
 *  - a held token → the action runs now;
 *  - no token → the action is parked, MutationTokenDialog opens with a reason
 *    saying what the click will do, and the action runs once unlocked;
 *  - the dialog dismissed → the promise resolves `null`, so the caller can
 *    tell "not done" from "done" without an exception.
 *
 * The hold is read LIVE (`hasMutationHold()`), never from a render snapshot:
 * MutationTokenDialog calls `onClose` before `onUnlocked` in the same tick,
 * so a snapshot taken at render time is always one step behind.
 */
import { useCallback, useRef, useState } from 'react';
import { hasMutationHold } from '../../../data/auth-store.js';
import { ApiError, DispatchDisabledError } from '../../../data/client.js';
import { VerseMutationLockedError } from '../verse-queries.js';

export interface TokenGateDialogProps {
  open: boolean;
  reason: string;
  onClose: () => void;
  onUnlocked: () => void;
}

export interface TokenGate {
  run<T>(reason: string, action: () => Promise<T>): Promise<T | null>;
  /** Spread onto <MutationTokenDialog />. */
  dialog: TokenGateDialogProps;
}

export function useTokenGate(): TokenGate {
  const [prompt, setPrompt] = useState<{ open: boolean; reason: string }>({ open: false, reason: '' });
  const pending = useRef<{ run: () => void; cancel: () => void } | null>(null);

  const run = useCallback(<T,>(reason: string, action: () => Promise<T>): Promise<T | null> => {
    if (hasMutationHold()) return action();
    // A second click while the prompt is up supersedes the first: the earlier
    // caller is told "not done" rather than left waiting forever.
    pending.current?.cancel();
    return new Promise<T | null>((resolve, reject) => {
      pending.current = {
        run: () => { action().then(resolve, reject); },
        cancel: () => resolve(null),
      };
      setPrompt({ open: true, reason });
    });
  }, []);

  const onClose = useCallback(() => {
    setPrompt({ open: false, reason: '' });
    // onClose fires BEFORE onUnlocked on a successful submit, so only treat
    // this as a dismissal if nothing claimed the parked action by next tick.
    const parked = pending.current;
    if (!parked) return;
    setTimeout(() => {
      if (pending.current === parked) {
        pending.current = null;
        parked.cancel();
      }
    }, 0);
  }, []);

  const onUnlocked = useCallback(() => {
    const parked = pending.current;
    pending.current = null;
    parked?.run();
  }, []);

  return { run, dialog: { open: prompt.open, reason: prompt.reason, onClose, onUnlocked } };
}

/**
 * One sentence for a failed context action. Prefers the server's own words
 * (`ApiError.detail`), which the context routes write for a person.
 */
export function describeContextError(err: unknown): string {
  if (err instanceof DispatchDisabledError) {
    // A CODELESS 404 on a write: the dispatch gate, or a server that predates
    // this route — the two answer the same bare body by design (client.ts).
    // A missing chat is NOT this: it carries VERSE_SESSION_NOT_FOUND below.
    return 'This server is read-only (started without dispatch — run `ashlr verse`), or older than this console.';
  }
  if (err instanceof VerseMutationLockedError) return 'Unlock actions with the mutation token first.';
  if (err instanceof ApiError) {
    if (err.status === 401) return 'The mutation token was rejected. Unlock again with the token `ashlr verse` printed.';
    if (err.code === 'VERSE_SESSION_NOT_FOUND') return 'This chat no longer exists on the server — it may have been deleted. Refresh the chat list.';
    if (err.detail) return err.detail;
    if (err.status === 404) return 'This server does not have that route yet — update Ashlr and restart `ashlr verse`.';
    if (err.status === 409) return 'A turn is already running in this chat. Wait for it or stop it first.';
    return err.message;
  }
  return err instanceof Error && err.message ? err.message : 'Something went wrong.';
}
