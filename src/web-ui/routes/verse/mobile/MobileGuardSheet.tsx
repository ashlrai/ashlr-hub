/**
 * routes/verse/mobile/MobileGuardSheet.tsx — the phone's confirmation and
 * unlock sheet, drawn over the SAME state machine as the desktop GuardHost
 * (shell/guard-store.ts): confirm first, then the mutation token if it is
 * not held, then the POST. An action that fails comes back to the sheet with
 * the server's sentence and a Try again.
 *
 * What the phone adds, and only adds:
 *   - the consequences are the sheet's body, in a block of their own, so the
 *     question is never "Are you sure?" but what will happen;
 *   - before a confirmed action runs, the transport's step-up provider (if
 *     one is registered — device-permissions.ts) is asked; a refusal leaves
 *     the sheet open with the reason and nothing sent.
 *
 * The token field accepts exactly what MutationTokenDialog accepts (64 hex),
 * and the token goes into the same memory-only hold. Nothing is stored.
 */
import { useEffect, useId, useState } from 'react';
import { setMutationToken } from '../../../data/auth-store.js';
import { cancelGuard, confirmGuard, guardTokenClosed, isCurrentGuardRequest, useGuardState } from '../shell/guard-store.js';
import { requestStepUp } from './device-permissions.js';
import { BottomSheet } from './sheet.js';
import { Button } from './ui.js';
import { ui } from './ui-parts.js';

const TOKEN_RE = /^[a-f0-9]{64}$/;

export function MobileGuardSheet() {
  const { request, phase, error } = useGuardState();
  const [token, setToken] = useState('');
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const tokenId = useId();

  // A new request starts clean.
  useEffect(() => {
    setToken('');
    setTokenError(null);
    setStepUpError(null);
    setChecking(false);
  }, [request]);

  if (!request) return null;

  if (phase === 'token') {
    const unlock = () => {
      const trimmed = token.trim();
      if (!TOKEN_RE.test(trimmed)) {
        setTokenError('Expected 64 hex characters — the mutation token `ashlr verse` printed on your Mac.');
        return;
      }
      setMutationToken(trimmed);
      setToken('');
      guardTokenClosed();
    };
    return (
      <BottomSheet
        open
        onClose={() => guardTokenClosed()}
        title="Unlock actions"
        footer={(
          <>
            <Button variant="primary" block onClick={unlock}>Unlock and {request.confirmLabel.toLowerCase()}</Button>
            <Button variant="plain" block onClick={() => guardTokenClosed()}>Cancel</Button>
          </>
        )}
      >
        <p className={ui.consequence}>{request.tokenReason ?? 'This action changes state on your Mac and needs the mutation token.'}</p>
        <div className={ui.field}>
          <label className={ui.label} htmlFor={tokenId}>Mutation token</label>
          <input
            id={tokenId}
            className={`${ui.input} ${ui.mono}`}
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            placeholder="64 hex characters"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setTokenError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') unlock();
            }}
            aria-invalid={tokenError ? true : undefined}
            aria-describedby={tokenError ? `${tokenId}-error` : undefined}
          />
          {tokenError ? <p id={`${tokenId}-error`} className={ui.error}>{tokenError}</p> : null}
        </div>
        <p className={ui.faint}>Held in memory for 20 idle minutes, then forgotten. Never saved on this phone.</p>
      </BottomSheet>
    );
  }

  if (request.skipConfirm) return null;

  const running = phase === 'running' || checking;
  const onConfirm = async () => {
    setStepUpError(null);
    setChecking(true);
    const ok = await requestStepUp({ action: request.confirmLabel, irreversible: true });
    if (!isCurrentGuardRequest(request)) return;
    setChecking(false);
    if (!ok) {
      setStepUpError('The extra device check did not complete, so nothing was sent.');
      return;
    }
    confirmGuard(request);
  };
  const message = stepUpError ?? error;
  return (
    <BottomSheet
      open
      onClose={cancelGuard}
      busy={running}
      role="alertdialog"
      title={request.title}
      footer={(
        <>
          <Button variant={request.destructive ? 'destructive' : 'primary'} block disabled={running} onClick={() => void onConfirm()}>
            {running ? 'Working…' : message ? 'Try again' : request.confirmLabel}
          </Button>
          <Button variant="plain" block disabled={running} onClick={cancelGuard}>Cancel</Button>
        </>
      )}
    >
      <div className={ui.consequence}>{request.body}</div>
      {message ? <p className={ui.error} role="alert">{message}</p> : null}
    </BottomSheet>
  );
}
