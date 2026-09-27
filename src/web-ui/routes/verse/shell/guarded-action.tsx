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
import { Suspense, type ComponentProps } from 'react';
import type { MutationTokenDialog as MutationTokenDialogComponent } from '../../../components/auth/MutationTokenDialog.js';
import type { ConfirmDialog as ConfirmDialogComponent } from '../../inbox/ConfirmDialog.js';
import { cancelGuard, confirmGuard, guardTokenClosed, useGuardState } from './guard-store.js';
import { preloadedLazy } from './preloaded.js';

export {
  cancelGuard,
  confirmGuard,
  describeActionError,
  guardTokenClosed,
  isGuardOpen,
  requestGuarded,
  resetGuard,
  useGuardState,
  type GuardedRequest,
  type GuardPhase,
  type GuardState,
} from './guard-store.js';

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

/** Mounted once by the shell. */
export function GuardHost() {
  const { request, phase, error } = useGuardState();
  if (!request) return null;
  return (
    <Suspense fallback={null}>
      <ConfirmDialog
        open={phase !== 'token' && !request.skipConfirm}
        onClose={cancelGuard}
        title={request.title}
        body={request.body}
        confirmLabel={error ? 'Try again' : request.confirmLabel}
        destructive={request.destructive}
        busy={phase === 'running'}
        error={error}
        onConfirm={confirmGuard}
      />
      <MutationTokenDialog
        open={phase === 'token'}
        onClose={guardTokenClosed}
        reason={request.tokenReason ?? 'This action changes state on this machine and requires the dispatch token.'}
        tokenHelp="the mutation token ashlr verse printed"
      />
    </Suspense>
  );
}
