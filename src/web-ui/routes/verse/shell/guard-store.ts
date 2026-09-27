/**
 * routes/verse/shell/guard-store.ts — the guarded-action STATE MACHINE
 * (confirm → token → run), without any dialog.
 *
 * Split out of guarded-action.tsx so a surface that draws its own
 * confirmation (the phone app, routes/verse/mobile/MobileGuardSheet.tsx) runs
 * exactly the same order as the desktop GuardHost — one machine, two
 * renderers — without evaluating guarded-action.tsx, whose preloaded desktop
 * dialogs would start downloading the moment it loads. guarded-action.tsx
 * re-exports everything here, so every existing import is unchanged.
 */
import { useSyncExternalStore, type ReactNode } from 'react';
import { hasMutationHold } from '../../../data/auth-store.js';
import { ApiError, DispatchDisabledError } from '../../../data/client.js';

export interface GuardedRequest {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  destructive: boolean;
  /** Ask for the mutation token before running (every server write does). */
  token: boolean;
  /** Why the token is needed, in the token dialog's own words. */
  tokenReason?: string;
  run: () => Promise<void>;
  /**
   * For actions the regular UI does not confirm either (Mark read, Reconnect
   * with no item copy): straight to the token (if needed), then run; a
   * failure goes to `onError` only, since there is no dialog to show it in.
   */
  skipConfirm?: boolean;
  onDone?: () => void;
  /** Called with the sentence when the run fails (after the dialog shows it). */
  onError?: (message: string) => void;
}

export type GuardPhase = 'confirm' | 'token' | 'running';

export interface GuardState {
  request: GuardedRequest | null;
  phase: GuardPhase;
  error: string | null;
}

const IDLE: GuardState = { request: null, phase: 'confirm', error: null };
let state: GuardState = IDLE;
const listeners = new Set<() => void>();

function set(next: GuardState): void {
  state = next;
  for (const l of [...listeners]) l();
}

/** Start a guarded action. A second request while one is open replaces nothing: it is ignored. */
export function requestGuarded(request: GuardedRequest): boolean {
  if (state.request) return false;
  if (request.skipConfirm) {
    if (request.token && !hasMutationHold()) set({ request, phase: 'token', error: null });
    else void execute(request);
    return true;
  }
  set({ request, phase: 'confirm', error: null });
  return true;
}

export function isGuardOpen(): boolean {
  return state.request !== null;
}

/** Test hygiene. */
export function resetGuard(): void {
  set(IDLE);
}

/** Operator language for a failed write — never a stack, never a path. */
export function describeActionError(err: unknown): string {
  if (err instanceof DispatchDisabledError) return 'This server was started without dispatch, so actions are unavailable. Run `ashlr verse` to act.';
  if (err instanceof ApiError) {
    if (err.status === 401) return 'The mutation token was rejected. Unlock again with the token `ashlr verse` printed.';
    if (err.status === 409) return err.detail ?? 'Something changed underneath this action. Refresh and try again.';
    return err.detail ?? `The server refused (HTTP ${err.status}).`;
  }
  return err instanceof Error && err.message ? err.message : 'Something went wrong.';
}

async function execute(request: GuardedRequest): Promise<void> {
  set({ request, phase: 'running', error: null });
  try {
    await request.run();
    set(IDLE);
    request.onDone?.();
  } catch (err) {
    const message = describeActionError(err);
    set(request.skipConfirm ? IDLE : { request, phase: 'confirm', error: message });
    request.onError?.(message);
  }
}

/** The confirm step's primary button. */
export function confirmGuard(): void {
  const { request } = state;
  if (!request || state.phase === 'running') return;
  if (request.token && !hasMutationHold()) {
    set({ request, phase: 'token', error: null });
    return;
  }
  void execute(request);
}

/** Cancel / Escape / backdrop — ignored while the action runs. */
export function cancelGuard(): void {
  if (state.phase === 'running') return;
  set(IDLE);
}

/** The token prompt closed: unlocked → run, otherwise → nothing happened. */
export function guardTokenClosed(): void {
  const { request } = state;
  if (!request) return;
  // MutationTokenDialog closes synchronously after storing the token, so a
  // live read says whether this close was "unlocked" or "cancelled".
  if (hasMutationHold()) void execute(request);
  else set(IDLE);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useGuardState(): GuardState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}
