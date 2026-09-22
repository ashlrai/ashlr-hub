/**
 * routes/inbox/ConfirmDialog.tsx — explicit confirmation for approve/reject
 * (single or batch). Approve is the single most irreversible action in the
 * product (operator-console brief non-negotiable): it must require explicit
 * confirmation and clearly state what will happen, never fire on a single
 * click. Built on the shared Dialog primitive so it gets the same focus
 * trap / Escape / backdrop-close behavior as MutationTokenDialog and the
 * command palette for free.
 */
import { useId, useRef, type ReactNode } from 'react';
import { Dialog } from '../../components/primitives/Dialog.js';
import styles from './ConfirmDialog.module.css';

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  /**
   * Weight the confirm button as the dangerous one. The rule is IRREVERSIBLE,
   * not "negative-sounding": whichever branch the operator cannot undo gets
   * the weight. In Verse's approvals that is Approve — a `pr` pushes a branch
   * and opens a real pull request other people see immediately, a `patch`
   * writes to disk now — while Reject only discards a proposal that stays in
   * history. This doc used to say the opposite, which is how the red button
   * came to be the safe one.
   */
  destructive?: boolean;
  onConfirm: () => void;
  busy?: boolean;
  error?: string | null;
}

export function ConfirmDialog({ open, onClose, title, body, confirmLabel, destructive, onConfirm, busy, error }: ConfirmDialogProps) {
  const titleId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog open={open} onClose={onClose} titleId={titleId} title={title} initialFocusRef={confirmRef}>
      <div className={styles.body}>{body}</div>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <button type="button" className={styles.cancel} onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          ref={confirmRef}
          type="button"
          className={destructive ? styles.destructive : styles.confirm}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
