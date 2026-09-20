/**
 * components/auth/SessionGate.tsx — replaces the old bare "⚠ HTTP 401 +
 * Retry" first-run experience (foundation brief item 5). Shown whenever
 * auth-store's phase is 'unauthenticated': on first load before any read
 * token has been entered, AND any time a session expires mid-use (SSE
 * disconnects, the next GET reports 401).
 *
 * By default this screen owns nothing about the MUTATION token — that is a
 * separate, later step (MutationTokenDialog), because read authority and
 * dispatch authority are genuinely different capabilities on this server
 * (see server.ts). Surfaces where sending is the whole point (Verse) can opt
 * into an optional second field with `mutationField`; the authorities stay
 * separate (the mutation token only ever enters the memory-only hold), it
 * just spares the operator a second paste screen on the first Enter.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { adoptInjectedTokens, establishReadSession, setMutationToken } from '../../data/auth-store.js';
import styles from './SessionGate.module.css';

const TOKEN_RE = /^[a-f0-9]{64}$/;

export interface SessionGateProps {
  onAuthenticated?: () => void;
  heading?: string;
  command?: string;
  /** What the copy calls this surface ("This dashboard", "Ashlr Verse"). */
  subject?: string;
  /**
   * Also offer the mutation token on the same screen. The two authorities
   * stay separate (a pasted mutation token goes straight into the memory-only
   * hold, exactly as MutationTokenDialog would set it); this only collapses
   * two paste screens into one for surfaces where sending is the whole point.
   */
  mutationField?: boolean;
}

export function SessionGate({ onAuthenticated, heading = 'Connect to ashlr serve', command = 'ashlr serve', subject = 'This dashboard', mutationField = false }: SessionGateProps) {
  const [token, setToken] = useState('');
  const [mutation, setMutation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const mutationId = useId();
  const errorId = useId();
  const authenticatedRef = useRef(onAuthenticated);
  authenticatedRef.current = onAuthenticated;

  // Desktop wrapper: when the host injected tokens (window.__ASHLR_TOKENS__),
  // establish the session silently instead of asking for a paste.
  useEffect(() => {
    let cancelled = false;
    void adoptInjectedTokens().then((adopted) => {
      if (adopted && !cancelled) authenticatedRef.current?.();
    });
    return () => { cancelled = true; };
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const mutationTrimmed = mutation.trim();
    if (mutationField && mutationTrimmed && !TOKEN_RE.test(mutationTrimmed)) {
      setError('That does not look like a mutation token — expected 64 hex characters (leave it empty to unlock later).');
      return;
    }
    setBusy(true);
    try {
      await establishReadSession(token);
      setToken('');
      if (mutationField && mutationTrimmed) setMutationToken(mutationTrimmed);
      setMutation('');
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
        <h1 className={styles.heading}>{heading}</h1>
        <p className={styles.body}>
          {subject} only ever talks to the ashlr server running on this machine
          (<code>127.0.0.1</code>, never a remote host). To read data, paste the{' '}
          <strong>read token</strong> printed in the terminal where you ran:
        </p>
        <pre className={styles.code}>{command}</pre>
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
          {mutationField ? (
            <>
              <label htmlFor={mutationId} className={styles.label}>
                Mutation token <span className={styles.optional}>optional — paste it now to enable sending</span>
              </label>
              <input
                id={mutationId}
                name="mutation-token"
                type="password"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                inputMode="text"
                className={styles.input}
                value={mutation}
                onChange={(e) => setMutation(e.target.value)}
                placeholder="64 hex characters, printed under “Dispatch enabled”"
              />
            </>
          ) : null}
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
