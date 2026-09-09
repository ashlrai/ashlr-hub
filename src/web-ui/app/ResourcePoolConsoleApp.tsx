import { useEffect } from 'react';
import { SessionGate } from '../components/auth/SessionGate.js';
import { clearReadSession, markCheckComplete } from '../data/auth-store.js';
import { getQuerySnapshot, runQuery } from '../data/cache.js';
import { useAuthPhase, useQuery, useRefetch, useTheme } from '../data/hooks.js';
import { resourceConsoleScopeQuery } from '../data/resource-pool-queries.js';
import { ResourcePoolView } from '../routes/resources/ResourcePoolView.js';
import { SkipToContent } from './SkipToContent.js';
import styles from './ResourcePoolConsoleApp.module.css';
import '../design/global.css';

function ScopedResourceWorkspace() {
  const scope = useQuery(resourceConsoleScopeQuery);
  const retry = useRefetch(resourceConsoleScopeQuery);
  const theme = useTheme();
  return <>
    <SkipToContent />
    <header className={styles.bar}>
      <div className={styles.identity}><div className={styles.brand}>
        <svg className={styles.brandMark} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          <path d="m5 11 11-6 11 6-11 6Z M5 16l11 6 11-6 M5 21l11 6 11-6" />
        </svg><strong>Ashlrverse</strong><span className={styles.workspace}>Resources</span></div>
        {scope.data ? <><span className={styles.scopeBadge}>{scope.data.readOnly
          ? scope.data.allocationWritable ? 'Fleet policy controls · tasks disabled' : 'Read-only console' : 'Foreground task console'}</span>
          <details className={styles.store}><summary>Resource store</summary><code aria-label="Resource store">{scope.data.root}</code></details></> : null}</div>
      <div className={styles.actions}>
        <button type="button" onClick={theme.cycle}>Theme: {theme.theme}</button>
        <button type="button" onClick={() => { void clearReadSession(); }}>Disconnect</button>
      </div>
    </header>
    <main id="main-content" tabIndex={-1} className={styles.main}>
      {scope.status === 'error' ? <section role="alert" className={styles.notice}>
        <h1>Resource scope unavailable</h1><p>{scope.error?.message} No pool data is shown until its scope is checked.</p>
        <button type="button" onClick={retry}>Retry scope check</button>
      </section> : scope.data ? <ResourcePoolView key={`${scope.data.root}:${scope.data.poolId}`} scope={scope.data} />
        : <p role="status">Checking the selected resource pool…</p>}
    </main>
  </>;
}

/** Isolated bootstrap: no global dashboard, default configuration, or observer stream. */
export function ResourcePoolConsoleApp() {
  const phase = useAuthPhase();
  useEffect(() => {
    if (phase !== 'checking') return;
    let cancelled = false;
    void runQuery(resourceConsoleScopeQuery.key, resourceConsoleScopeQuery.fetch).then(() => {
      if (!cancelled) markCheckComplete(getQuerySnapshot(resourceConsoleScopeQuery.key).status === 'success');
    });
    return () => { cancelled = true; };
  }, [phase]);
  if (phase === 'checking') return <p className={styles.checking} role="status">Checking for an existing resource session…</p>;
  if (phase === 'unauthenticated') return <SessionGate heading="Connect to Ashlrverse resources"
    command="ashlr resources pool console --root /absolute/resource-store --pool /absolute/pool.json --bindings /absolute/bindings.json --observations /absolute/observations.json" />;
  return <ScopedResourceWorkspace />;
}
