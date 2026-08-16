/**
 * components/auth/MutationTokenDialog.tsx — replaces window.prompt() for
 * the mutation token (foundation brief item 5, the "biggest reason
 * operators abandon the UI for the CLI" finding). A focus-managed dialog
 * instead of a blocking native prompt, and a session-scoped hold (see
 * auth-store.ts) so approving 12 proposals is one paste, not twelve.
 *
 * The token is NEVER written to localStorage/sessionStorage/cookies — only
 * held in an in-memory module variable in auth-store.ts, cleared on tab
 * close, idle timeout, or the explicit "Lock" action here.
 */
import { useId, useRef, useState, type FormEvent } from 'react';
import { Dialog } from '../primitives/Dialog.js';
import { useMutationHold } from '../../data/hooks.js';
import styles from './MutationTokenDialog.module.css';

const TOKEN_RE = /^[a-f0-9]{64}$/;

export interface MutationTokenDialogProps {
  open: boolean;
  onClose: () => void;
  /** Human context for why the token is being requested right now. */
  reason?: string;
}

export function MutationTokenDialog({ open, onClose, reason }: MutationTokenDialogProps) {
  const { setToken } = useMutationHold();
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const inputId = useId();

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!TOKEN_RE.test(trimmed)) {
      setError('Expected 64 hex characters — the mutation token ashlr serve printed.');
      return;
    }
    setToken(trimmed);
    setValue('');
    setError(null);
    onClose();
  }

  return (
    <Dialog open={open} onClose={onClose} titleId={titleId} title="Unlock actions" initialFocusRef={inputRef}>
      <p className={styles.body}>
        {reason ?? 'This action mutates the fleet and requires the dispatch token.'} It is held in
        memory only, for this browser tab, and is cleared automatically after 20 minutes idle.
      </p>
      <form onSubmit={submit} className={styles.form} noValidate>
        <label htmlFor={inputId} className={styles.label}>
          Mutation token
        </label>
        <div className={styles.inputRow}>
          <input
            ref={inputRef}
            id={inputId}
            type={reveal ? 'text' : 'password'}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className={styles.input}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={error ? true : undefined}
            placeholder="64 hex characters"
          />
          <button
            type="button"
            className={styles.reveal}
            onClick={() => setReveal((r) => !r)}
            aria-pressed={reveal}
          >
            {reveal ? 'Hide' : 'Show'}
          </button>
        </div>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={styles.submit} disabled={value.trim().length === 0}>
            Unlock
          </button>
        </div>
      </form>
    </Dialog>
  );
}
