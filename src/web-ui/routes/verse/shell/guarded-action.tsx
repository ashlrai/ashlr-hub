/**
 * routes/verse/shell/guarded-action.tsx — confirmation FIRST, then the
 * mutation token, then the action (unit C1; SPEC-310C §1 "Guarded actions ask
 * for confirmation, then the mutation token").
 *
 * The palette and the drawer's single-letter keys are the fastest way to do
 * anything in Verse, which is exactly why they must not be a shortcut around
 * the confirm step the regular UI requires. Every guarded path — a catalog
 * command with a `guard`, a Needs-you approve / reject / veto — goes through
 * ONE host, so the order can never differ between two entry points:
 *
 *   confirm ──Cancel──▶ nothing happened
 *      │ Confirm
 *      ├─ token needed and not held ─▶ MutationTokenDialog ──Cancel──▶ nothing
 *      │                                   │ unlocked
 *      ▼                                   ▼
 *   running (the confirm dialog shows "Working…")
 *      ├─ ok ─▶ closed (the caller's own onDone decides the toast)
 *      └─ error ─▶ back to confirm, with the sentence; Confirm retries
 *
 * Why confirm before token (the old ApprovalDetail asked for the token
 * first): an operator who presses A by mistake should be able to back out at
 * the FIRST prompt, which should describe what is about to happen — not a
 * prompt asking for a secret.
 */
import { Suspense, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react';
import type { MutationTokenDialog as MutationTokenDialogComponent } from '../../../components/auth/MutationTokenDialog.js';
import { hasMutationHold } from '../../../data/auth-store.js';
import { ApiError, DispatchDisabledError } from '../../../data/client.js';
import type { ConfirmDialog as ConfirmDialogComponent } from '../../inbox/ConfirmDialog.js';
import { preloadedLazy } from './preloaded.js';

/**
 * The two dialogs are preloaded, not static imports: GuardHost is mounted by
 * the shell at first paint but draws nothing until a guarded action starts,
 * and the dialogs (with the dialog primitive and its focus trap) were ~4 KB
 * of chat first-paint critical JS. Their download starts when this module
 * evaluates, so the first guarded action finds them in and they mount in the
 * same render that opens them.
 */
const ConfirmDialogModule = preloadedLazy<ComponentProps<typeof ConfirmDialogComponent>>(
  () => import('../../inbox/ConfirmDialog.js').then((m) => m.ConfirmDialog),
);
const ConfirmDialog = ConfirmDialogModule.Slot;
const TokenDialogModule = preloadedLazy<ComponentProps<typeof MutationTokenDialogComponent>>(
  () => import('../../../components/auth/MutationTokenDialog.js').then((m) => m.MutationTokenDialog),
);
const MutationTokenDialog = TokenDialogModule.Slot;

/** Resolves once both dialogs are in (tests await it; the app never needs to). */
export function preloadGuardDialogs(): Promise<unknown> {
  return Promise.all([ConfirmDialogModule.ready(), TokenDialogModule.ready()]);
}

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

type Phase = 'confirm' | 'token' | 'running';

interface GuardState {
  request: GuardedRequest | null;
  phase: Phase;
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

function confirm(): void {
  const { request } = state;
  if (!request || state.phase === 'running') return;
  if (request.token && !hasMutationHold()) {
    set({ request, phase: 'token', error: null });
    return;
  }
  void execute(request);
}

function cancel(): void {
  if (state.phase === 'running') return;
  set(IDLE);
}

function tokenClosed(): void {
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

/** Mounted once by the shell. */
export function GuardHost() {
  const { request, phase, error } = useGuardState();
  if (!request) return null;
  return (
    <Suspense fallback={null}>
      <ConfirmDialog
        open={phase !== 'token' && !request.skipConfirm}
        onClose={cancel}
        title={request.title}
        body={request.body}
        confirmLabel={error ? 'Try again' : request.confirmLabel}
        destructive={request.destructive}
        busy={phase === 'running'}
        error={error}
        onConfirm={confirm}
      />
      <MutationTokenDialog
        open={phase === 'token'}
        onClose={tokenClosed}
        reason={request.tokenReason ?? 'This action changes state on this machine and requires the dispatch token.'}
        tokenHelp="the mutation token ashlr verse printed"
      />
    </Suspense>
  );
}
