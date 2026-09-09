import { useEffect } from 'react';
import { SessionGate } from '../components/auth/SessionGate.js';
import { clearReadSession, markCheckComplete } from '../data/auth-store.js';
import { getQuerySnapshot, runQuery } from '../data/cache.js';
import { apiGet } from '../data/client.js';
import { useAuthPhase, useQuery, useRefetch, useTheme } from '../data/hooks.js';
import { UniverseRootContext } from '../routes/universe/UniverseScope.js';
import { UniverseView } from '../routes/universe/UniverseView.js';
import { SkipToContent } from './SkipToContent.js';
import styles from './UniverseConsoleApp.module.css';
import '../design/global.css';

interface ConsoleScope {
  schemaVersion: 1;
  mode: 'universe';
  root: string;
  readOnly: true;
}

const scopeQuery = {
  key: 'universe-console-scope',
  async fetch(): Promise<ConsoleScope> {
    const scope = await apiGet<ConsoleScope>('/api/universe/console');
    if (scope?.schemaVersion !== 1 || scope.mode !== 'universe' || scope.readOnly !== true ||
      typeof scope.root !== 'string' || !/^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(scope.root) ||
      [...scope.root].some((character) => character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159)) {
      throw new Error('The server did not establish an explicit read-only Universe scope.');
    }
    return scope;
  },
};

function ScopedWorkspace() {
  const scope = useQuery(scopeQuery);
  const retry = useRefetch(scopeQuery);
  const theme = useTheme();
  return <>
    <SkipToContent />
    <div className={styles.shell}>
      <header className={styles.scopeBar}>
        <div className={styles.scope}>
          <div className={styles.brand}>
            <svg className={styles.brandMark} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
              <path d="m5 11 11-6 11 6-11 6Z M5 16l11 6 11-6 M5 21l11 6 11-6" />
            </svg><strong>Ashlrverse</strong><span className={styles.workspace}>Experiments</span>
          </div>
          <span className={styles.badge}>Read-only observation</span>
          {scope.data ? <details className={styles.store}><summary>Universe store</summary>
            <code aria-label="Universe store" className={styles.root}>{scope.data.root}</code></details> : null}
        </div>
        <div className={styles.actions}>
          <button type="button" onClick={theme.cycle}>Theme: {theme.theme}</button>
          <button type="button" onClick={() => { void clearReadSession(); }}>Disconnect</button>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className={styles.main}>
        {scope.status === 'error' ? <section role="alert" className={styles.notice}>
          <h1>Console scope unavailable</h1>
          <p>{scope.error?.message} No project data is shown until the scope can be checked.</p>
          <button type="button" onClick={retry}>Retry scope check</button>
        </section> : scope.data ? <UniverseRootContext.Provider value={scope.data.root}>
          <p className={styles.explanation}>This console observes the selected Universe store. Run campaigns from your terminal; opening this page does not start work.</p>
          <UniverseView />
        </UniverseRootContext.Provider> : <p role="status">Checking the selected Universe store…</p>}
      </main>
    </div>
  </>;
}

/** Never mounts the general Hub shell, snapshot probe, or dispatch controls. */
export function UniverseConsoleApp() {
  const phase = useAuthPhase();
  useEffect(() => {
    if (phase !== 'checking') return;
    let cancelled = false;
    void runQuery(scopeQuery.key, scopeQuery.fetch).then(() => {
      if (!cancelled) markCheckComplete(getQuerySnapshot(scopeQuery.key).status === 'success');
    });
    return () => { cancelled = true; };
  }, [phase]);

  if (phase === 'checking') return <p className={styles.checking} role="status">Checking for an existing console session…</p>;
  if (phase === 'unauthenticated') return <SessionGate
    heading="Connect to Ashlrverse"
    command="ashlr universe console --root /absolute/universe-store"
  />;
  return <ScopedWorkspace />;
}
