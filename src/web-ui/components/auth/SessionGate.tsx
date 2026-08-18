/**
 * components/auth/SessionGate.tsx — replaces the old bare "⚠ HTTP 401 +
 * Retry" first-run experience (foundation brief item 5). Shown whenever
 * auth-store's phase is 'unauthenticated': on first load before any read
 * token has been entered, AND any time a session expires mid-use (SSE
 * disconnects, the next GET reports 401).
 *
 * This screen owns nothing about the MUTATION token — that is a separate,
 * later step (MutationTokenDialog), because read authority and dispatch
 * authority are genuinely different capabilities on this server (see
 * server.ts) and conflating them in one prompt is exactly the kind of
 * blurred-authority UX this foundation is supposed to fix.
 */
import { useId, useRef, useState, type FormEvent } from 'react';
import { establishReadSession } from '../../data/auth-store.js';
import styles from './SessionGate.module.css';

export function SessionGate({ onAuthenticated }: { onAuthenticated?: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const errorId = useId();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await establishReadSession(token);
      setToken('');
      onAuthenticated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not establish a session.');
      inputRef.current?.select();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.badge} aria-hidden="true">
          ⛺
        </div>
        <h1 className={styles.heading}>Connect to ashlr serve</h1>
        <p className={styles.body}>
          This dashboard only ever talks to the ashlr server running on this machine
          (<code>127.0.0.1</code>, never a remote host). To read data, paste the{' '}
          <strong>read token</strong> printed in the terminal where you ran:
        </p>
        <pre className={styles.code}>ashlr serve</pre>
        <p className={styles.body}>
          It looks like a 64-character hex string, printed once at startup — something like{' '}
          <code className={styles.example}>a1b2c3…</code>. This dialog never stores it: it is
          exchanged once for a short-lived session cookie, then discarded.
        </p>
        <form onSubmit={onSubmit} className={styles.form} noValidate>
          <label htmlFor={inputId} className={styles.label}>
            Read token
          </label>
          <input
            ref={inputRef}
            id={inputId}
            name="read-token"
            type="password"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            className={styles.input}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            placeholder="64 hex characters"
            autoFocus
          />
          {error ? (
            <p id={errorId} className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className={styles.submit} disabled={busy || token.trim().length === 0}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </form>
      </div>
    </div>
  );
}
