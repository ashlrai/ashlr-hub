/**
 * routes/verse/command/actions.tsx — how every write on the four surfaces
 * reaches the server (unit C7).
 *
 * Order is fixed and the same for a click, a key and the palette
 * (SPEC-310C §1 "Guarded actions ask for confirmation, then the mutation
 * token"):
 *
 *   1. a confirmation dialog, when the action asks for one (Stop, Veto,
 *      Resume, every Needs-you approve / reject / veto);
 *   2. the mutation token, when none is held (useGuardedAction);
 *   3. the request, one at a time, with the server's own refusal sentence
 *      shown on failure and read-only sessions explained, never errored.
 *
 * LOWERING needs no confirmation (SPEC-310B I1: "lowering authority is
 * instant") — callers simply omit `confirm` for the switch-down path.
 */
import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { Button } from '../../../components/primitives/Button.js';
import { useGuardedAction } from '../autonomy/use-guarded-action.js';
import styles from './command.module.css';

export interface ConfirmSpec {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
}

export function ConfirmDialog({ spec, onConfirm, onCancel }: { spec: ConfirmSpec | null; onConfirm: () => void; onCancel: () => void }) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={spec !== null}
      onClose={onCancel}
      titleId={titleId}
      title={spec?.title ?? ''}
      // A destructive confirm starts on Cancel, so a stray Enter never stops the fleet.
      initialFocusRef={spec?.destructive ? cancelRef : confirmRef}
    >
      <div className={styles.confirmBody}>{spec?.body}</div>
      <div className={styles.confirmActions}>
        <Button ref={cancelRef} variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button ref={confirmRef} variant={spec?.destructive ? 'danger' : 'primary'} onClick={onConfirm}>
          {spec?.confirmLabel ?? 'Confirm'}
        </Button>
      </div>
    </Dialog>
  );
}

export interface SurfaceActions {
  /** Confirm (when asked), then token (when needed), then run `fn`. */
  act: <T>(fn: () => Promise<T>, reason: string, options?: { confirm?: ConfirmSpec; onDone?: (result: T) => void }) => void;
  busy: boolean;
  error: string | null;
  clearError: () => void;
  readOnly: boolean;
  /** Render once per surface. */
  dialogs: ReactNode;
}

export function useSurfaceActions(): SurfaceActions {
  const guard = useGuardedAction();
  const [pending, setPending] = useState<{ spec: ConfirmSpec; run: () => void } | null>(null);
  const { request } = guard;

  const act = useCallback(
    <T,>(fn: () => Promise<T>, reason: string, options: { confirm?: ConfirmSpec; onDone?: (result: T) => void } = {}) => {
      const run = () => request(fn, reason, options.onDone);
      if (options.confirm) setPending({ spec: options.confirm, run });
      else run();
    },
    [request],
  );

  const dialogs = (
    <>
      <ConfirmDialog
        spec={pending?.spec ?? null}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const next = pending;
          setPending(null);
          next?.run();
        }}
      />
      <MutationTokenDialog open={guard.tokenOpen} onClose={guard.closeToken} reason={guard.tokenReason} tokenHelp="the mutation token ashlr verse printed" />
    </>
  );

  return { act, busy: guard.busy, error: guard.error, clearError: guard.clearError, readOnly: guard.readOnly, dialogs };
}

/** The error / read-only line a surface shows under its top bar. */
export function ActionStatus({ actions }: { actions: Pick<SurfaceActions, 'error' | 'clearError' | 'readOnly'> }) {
  if (actions.readOnly) {
    return (
      <p className={styles.actionNote} role="status">
        Read-only session: this server was started without dispatch, so switching, stopping and vetoing are unavailable. Everything shown is live.
      </p>
    );
  }
  if (!actions.error) return null;
  return (
    <p className={styles.actionError} role="alert">
      {actions.error}
      <button type="button" className={styles.linkButton} onClick={actions.clearError}>
        Dismiss
      </button>
    </p>
  );
}
