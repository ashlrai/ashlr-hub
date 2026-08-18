/**
 * app/App.tsx — root composition: theme/reset CSS is imported once here,
 * the auth gate decides between <SessionGate/> and the routed shell, and
 * ToastProvider wraps everything so any component can surface an error
 * without prop-drilling a callback.
 *
 * BOOTSTRAP: on first mount we don't know yet whether the 15-minute read
 * session cookie from a previous page load is still valid, so we probe it
 * with a real protected GET rather than guessing from stored state (there
 * is deliberately nothing in storage that would tell us — see
 * data/auth-store.ts). A 200 means "still logged in, skip SessionGate"; a
 * 401 means show it. Either way this doubles as the first real data fetch,
 * not a throwaway ping.
 */
import { useEffect } from 'react';
import { HashRouter } from 'react-router-dom';
import { AppRoutes } from './routes.js';
import { SkipToContent } from './SkipToContent.js';
import { SessionGate } from '../components/auth/SessionGate.js';
import { ToastProvider } from '../components/primitives/Toast.js';
import { useAuthPhase } from '../data/hooks.js';
import { markCheckComplete } from '../data/auth-store.js';
import { runQuery, getQuerySnapshot } from '../data/cache.js';
import { dashboardSnapshotQuery } from '../data/queries.js';
import '../design/global.css';

function useBootstrapSessionProbe(phase: ReturnType<typeof useAuthPhase>) {
  useEffect(() => {
    if (phase !== 'checking') return;
    let cancelled = false;
    void runQuery(dashboardSnapshotQuery.key, dashboardSnapshotQuery.fetch).then(() => {
      if (cancelled) return;
      const entry = getQuerySnapshot(dashboardSnapshotQuery.key);
      markCheckComplete(entry.status === 'success');
    });
    return () => {
      cancelled = true;
    };
  }, [phase]);
}

export function App() {
  const phase = useAuthPhase();
  useBootstrapSessionProbe(phase);

  return (
    <ToastProvider>
      {phase === 'checking' ? (
        <div aria-live="polite" className="visually-hidden">
          Checking for an existing session…
        </div>
      ) : phase === 'unauthenticated' ? (
        <SessionGate />
      ) : (
        <HashRouter>
          <SkipToContent />
          <AppRoutes />
        </HashRouter>
      )}
    </ToastProvider>
  );
}
