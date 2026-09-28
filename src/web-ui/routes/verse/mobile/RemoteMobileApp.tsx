/** Phone gateway entry: Access identity, a Mac-approved passkey, then Verse. */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { markCheckComplete, setRemoteActGranted } from '../../../data/auth-store.js';
import { useAuthPhase } from '../../../data/hooks.js';
import {
  authenticateRemoteDevice, claimRemotePairing, probeRemoteSession, remotePairStatus,
  type RemoteSession, RemoteClientError,
} from '../../../data/remote-session.js';
import { registerDeviceScopes } from './device-permissions.js';
import type { Button as MobileButton, ui as mobileUi } from './ui.js';

const DEVICE_KEY = 'ashlr.remoteDeviceId.v1';
const PENDING_KEY = 'ashlr.remotePairPending.v1';

function stored(key: string): string {
  try { return (localStorage.getItem(key) ?? '').slice(0, 200); } catch { return ''; }
}

function pendingPairing(): string {
  try { return (sessionStorage.getItem(PENDING_KEY) ?? '').slice(0, 200); } catch { return ''; }
}

function rememberDevice(id: string): void {
  try { localStorage.setItem(DEVICE_KEY, id); } catch { /* sign-in still works until reload */ }
}

function rememberPending(id: string): void {
  try { sessionStorage.setItem(PENDING_KEY, id); } catch { /* keep this page open */ }
}

function forgetPending(): void {
  try { sessionStorage.removeItem(PENDING_KEY); } catch { /* best effort */ }
}

function message(error: unknown): string {
  if (error instanceof RemoteClientError) return error.message;
  if (error instanceof DOMException && error.name === 'NotAllowedError') return 'The passkey check was canceled or unavailable. Try again.';
  return 'The phone gateway could not complete this step. Try again.';
}

type View =
  | { kind: 'loading' }
  | { kind: 'error'; reason: string }
  | { kind: 'ready'; session: RemoteSession };

export function RemoteMobileApp({ shell, Button, ui }: { shell: ReactNode; Button: typeof MobileButton; ui: typeof mobileUi }) {
  const phase = useAuthPhase();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [deviceId, setDeviceId] = useState(() => stored(DEVICE_KEY));
  const [pendingId, setPendingId] = useState(() => pendingPairing());
  const [pairing, setPairing] = useState(false);
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('My phone');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const accept = useCallback((next: RemoteSession) => {
    const canAct = next.authenticated && next.scopes?.act === true && next.capabilities.writes;
    setRemoteActGranted(canAct);
    registerDeviceScopes(next.authenticated ? {
      read: true, act: next.scopes!.act, label: next.label, gatewayWritesEnabled: next.capabilities.writes,
    } : null);
    markCheckComplete(next.authenticated);
    setView({ kind: 'ready', session: next });
  }, []);

  const refresh = useCallback(async () => {
    setView({ kind: 'loading' });
    setActionError(null);
    try { accept(await probeRemoteSession()); }
    catch (error) {
      setRemoteActGranted(false);
      registerDeviceScopes(null);
      markCheckComplete(false);
      setView({ kind: 'error', reason: message(error) });
    }
  }, [accept]);

  useEffect(() => {
    void refresh();
    return () => { registerDeviceScopes(null); setRemoteActGranted(false); };
  }, [refresh]);

  // More's Sign out clears the remote cookie through auth-store. Fetch a new
  // preauth cookie/CSRF before offering another passkey operation.
  useEffect(() => {
    if (phase === 'unauthenticated' && view.kind === 'ready' && view.session.authenticated) void refresh();
  }, [phase, view, refresh]);

  useEffect(() => {
    if (view.kind !== 'ready' || !view.session.authenticated || !view.session.expiresAt) return;
    // A gateway that returns a near-expiry cookie must not trigger a zero-delay refresh loop.
    const delay = Math.max(1_000, view.session.expiresAt - Date.now() - 5_000);
    const timer = setTimeout(() => { void refresh(); }, delay);
    return () => clearTimeout(timer);
  }, [view, refresh]);

  const signIn = async () => {
    if (!deviceId || busy) return;
    setBusy(true);
    setActionError(null);
    try { accept(await authenticateRemoteDevice(deviceId)); }
    catch (error) { setActionError(message(error)); }
    finally { setBusy(false); }
  };

  const pair = async () => {
    if (!code.trim() || !label.trim() || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const started = await claimRemotePairing(code, label);
      rememberPending(started.pendingId);
      setPendingId(started.pendingId);
      setCode('');
    } catch (error) { setActionError(message(error)); }
    finally { setBusy(false); }
  };

  const checkApproval = async () => {
    if (!pendingId || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const status = await remotePairStatus(pendingId);
      if (status.state === 'approved' && status.deviceId) {
        rememberDevice(status.deviceId);
        setDeviceId(status.deviceId);
        forgetPending();
        setPendingId('');
        setPairing(false);
      } else if (status.state === 'denied') {
        forgetPending();
        setPendingId('');
        setActionError('Pairing was declined on your Mac. Ask for a new code to try again.');
      }
    } catch (error) { setActionError(message(error)); }
    finally { setBusy(false); }
  };

  if (view.kind === 'ready' && view.session.authenticated && phase === 'authenticated') return shell;

  return (
    <main className={ui.app}>
      <div className={ui.scroller} style={{ paddingTop: 'calc(env(safe-area-inset-top) + var(--space-6))' }}>
        <h1 className={ui.largeTitle}>Verse on your phone</h1>
        {view.kind === 'loading' ? <p role="status">Checking this phone’s gateway session…</p> : null}
        {view.kind === 'error' ? (
          <>
            <p role="alert">{view.reason}</p>
            <Button variant="primary" onClick={() => void refresh()}>Try again</Button>
            <Button variant="plain" onClick={() => window.location.assign('/verse/m/')}>Reload sign-in</Button>
          </>
        ) : null}
        {view.kind === 'ready' && !view.session.authenticated ? (
          <>
            <p className={ui.subtitle}>Sign in through Cloudflare Access, then use a passkey approved on your Mac.</p>
            {pendingId ? (
              <>
                <p role="status">Your Mac needs to approve this phone. Keep this page open until it does.</p>
                <Button variant="primary" disabled={busy} onClick={() => void checkApproval()}>Check approval</Button>
              </>
            ) : deviceId && !pairing ? (
              <>
                <Button variant="primary" disabled={busy} onClick={() => void signIn()}>Sign in with passkey</Button>
                {view.session.capabilities.pairing ? <Button variant="plain" disabled={busy} onClick={() => setPairing(true)}>Pair another phone</Button> : null}
              </>
            ) : view.session.capabilities.pairing ? (
              <div className={ui.card}>
                <h2>Pair this phone</h2>
                <p>Enter the one-time code shown on your Mac. Your Mac must approve the new passkey before this phone can read Verse.</p>
                <div className={ui.field}>
                  <label className={ui.label} htmlFor="remote-pair-code">Pairing code</label>
                  <input id="remote-pair-code" className={ui.input} value={code} autoComplete="off" onChange={(event) => setCode(event.target.value)} />
                </div>
                <div className={ui.field}>
                  <label className={ui.label} htmlFor="remote-pair-label">Phone name</label>
                  <input id="remote-pair-label" className={ui.input} maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} />
                </div>
                <Button variant="primary" disabled={!code.trim() || !label.trim() || busy} onClick={() => void pair()}>Create passkey</Button>
                {deviceId ? <Button variant="plain" disabled={busy} onClick={() => setPairing(false)}>Back to sign in</Button> : null}
              </div>
            ) : <p role="status">Phone pairing is not enabled on this Mac yet. Open Verse on your Mac to finish gateway setup.</p>}
            {actionError ? <p className={ui.error} role="alert">{actionError}</p> : null}
          </>
        ) : null}
      </div>
    </main>
  );
}
