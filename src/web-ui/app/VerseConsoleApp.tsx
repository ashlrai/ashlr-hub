/**
 * app/VerseConsoleApp.tsx — isolated bootstrap for /verse (pattern:
 * ResourcePoolConsoleApp). No global dashboard shell, router, or observer
 * stream: the read session is probed against /api/verse/bootstrap, host-
 * injected tokens (desktop wrapper) are adopted before that probe, and the
 * full-bleed VerseApp takes over once authenticated.
 */
import { useEffect } from 'react';
import { SessionGate } from '../components/auth/SessionGate.js';
import { ToastProvider } from '../components/primitives/Toast.js';
import { adoptInjectedTokens, markCheckComplete } from '../data/auth-store.js';
import { getQuerySnapshot, runQuery } from '../data/cache.js';
import { useAuthPhase } from '../data/hooks.js';
import { VerseApp } from '../routes/verse/VerseApp.js';
import { verseBootstrapQuery } from '../routes/verse/verse-queries.js';
import { SkipToContent } from './SkipToContent.js';
import styles from './VerseConsoleApp.module.css';
import '../design/global.css';

export function VerseConsoleApp() {
  const phase = useAuthPhase();
  useEffect(() => {
    if (phase !== 'checking') return;
    let cancelled = false;
    void adoptInjectedTokens().then((adopted) => {
      if (cancelled || adopted) return;
      return runQuery(verseBootstrapQuery.key, verseBootstrapQuery.fetch).then(() => {
        if (!cancelled) markCheckComplete(getQuerySnapshot(verseBootstrapQuery.key).status === 'success');
      });
    });
    return () => { cancelled = true; };
  }, [phase]);
  if (phase === 'checking') return <p className={styles.checking} role="status">Checking for an existing Verse session…</p>;
  if (phase === 'unauthenticated') {
    return <SessionGate heading="Connect to Ashlr Verse" command="ashlr verse" subject="Ashlr Verse" mutationField />;
  }
  return (
    <ToastProvider>
      <SkipToContent />
      <div className={styles.shell}><VerseApp /></div>
    </ToastProvider>
  );
}
