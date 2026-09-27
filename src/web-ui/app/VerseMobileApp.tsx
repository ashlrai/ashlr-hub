/**
 * app/VerseMobileApp.tsx — isolated bootstrap for /verse/m, Verse on a phone
 * (pattern: VerseConsoleApp). No workbench, no global dashboard shell, no
 * Hub observer stream: the read session is probed against
 * /api/verse/bootstrap, and the phone shell (routes/verse/mobile/) takes over
 * once authenticated.
 *
 * AUTH IS THE WEB UI'S, UNCHANGED: the SessionGate exchanges the read token
 * for the HttpOnly cookie and (optionally, same screen) puts the mutation
 * token in the memory-only hold. This page stores nothing else. The remote
 * transport (relay / tunnel pairing) plugs in through
 * routes/verse/mobile/device-permissions.ts, never by widening this.
 *
 * On mount it also: moves `/verse/m` to the canonical `/verse/m/` (the
 * service worker's scope), writes the PWA head tags, and registers the
 * service worker (routes/verse/mobile/pwa.ts).
 */
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { adoptInjectedTokens, markCheckComplete } from '../data/auth-store.js';
import { getQuerySnapshot, runQuery } from '../data/cache.js';
import { ApiError } from '../data/client.js';
import { useAuthPhase } from '../data/hooks.js';
import { MobileShell } from '../routes/verse/mobile/MobileShell.js';
import { SkeletonList, ui } from '../routes/verse/mobile/ui.js';
import { verseBootstrapQuery } from '../routes/verse/verse-bootstrap-query.js';
import { VERSE_MOBILE_PATH } from './console-mode.js';
import '../design/global.css';

const importSessionGate = () => import('../components/auth/SessionGate.js');
const SessionGate = lazy(() => importSessionGate().then((m) => ({ default: m.SessionGate })));

/** `/verse/m` → `/verse/m/`, keeping the hash (the screen). */
export function canonicalizeMobilePath(win: Window = window): void {
  if (win.location.pathname === VERSE_MOBILE_PATH) return;
  try {
    win.history.replaceState(win.history.state, '', `${VERSE_MOBILE_PATH}${win.location.hash}`);
  } catch {
    /* the app works at either path; only offline launch needs the slash */
  }
}

/**
 * Safe-area insets are 0 until the viewport opts in, so this runs as the
 * module evaluates — before the first paint, not after pwa.ts's chunk — or a
 * home-screen launch would draw under the notch for a frame.
 */
export function coverViewport(doc: Document | null = typeof document === 'undefined' ? null : document): void {
  const meta = doc?.head?.querySelector('meta[name="viewport"]');
  const content = meta?.getAttribute('content') ?? '';
  if (meta && !content.includes('viewport-fit')) meta.setAttribute('content', `${content}, viewport-fit=cover`);
}

coverViewport();

/**
 * The probe's answer. A probe that never reached the Mac (asleep, offline,
 * the tunnel down) or reached a failing one is not a reason to ask for a
 * token — it gets its own screen and a retry.
 */
export function probeOutcome(status: string, error: unknown): 'authenticated' | 'unauthenticated' | 'unreachable' {
  if (status === 'success') return 'authenticated';
  // A 4xx is the Mac answering (401: no session; 404: a build without Verse) — the gate explains it.
  if (error instanceof ApiError) return error.status >= 500 ? 'unreachable' : 'unauthenticated';
  return 'unreachable';
}

/** The page before the shell: connecting, out of reach, or the session gate. One frame for all three. */
function Boot({ children }: { children: ReactNode }) {
  return (
    <div className={ui.app}>
      <div className={ui.scroller} style={{ paddingTop: 'calc(env(safe-area-inset-top) + var(--space-6))' }}>{children}</div>
    </div>
  );
}

const CONNECTING = (
  <>
    <p className={ui.muted} role="status">Connecting to your Mac…</p>
    <SkeletonList rows={3} label="Connecting" />
  </>
);

export function VerseMobileApp() {
  const phase = useAuthPhase();
  const [unreachable, setUnreachable] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    canonicalizeMobilePath();
    // Head tags and the worker matter from the SECOND launch on (install,
    // offline), never to this paint: their module loads after it.
    void import('../routes/verse/mobile/pwa.js')
      .then((pwa) => {
        pwa.installMobileHead(document);
        return pwa.registerMobileServiceWorker();
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (phase !== 'checking') return;
    void importSessionGate().catch(() => undefined);
    let cancelled = false;
    setUnreachable(false);
    void adoptInjectedTokens().then((adopted) => {
      if (cancelled || adopted) return;
      return runQuery(verseBootstrapQuery.key, verseBootstrapQuery.fetch).then(() => {
        if (cancelled) return;
        const snap = getQuerySnapshot(verseBootstrapQuery.key);
        const outcome = probeOutcome(snap.status, snap.error);
        if (outcome === 'unreachable') setUnreachable(true);
        else markCheckComplete(outcome === 'authenticated');
      });
    });
    return () => {
      cancelled = true;
    };
  }, [phase, attempt]);

  if (phase === 'authenticated') return <MobileShell />;
  return (
    <Boot>
      {phase === 'unauthenticated' ? (
        <Suspense fallback={CONNECTING}>
          <SessionGate heading="Connect to your Mac" command="ashlr verse" subject="Ashlr Verse" mutationField />
        </Suspense>
      ) : unreachable ? (
        <div role="alert">
          <h1 className={ui.largeTitle}>Can’t reach your Mac</h1>
          <p className={ui.muted}>Verse runs on your Mac. It may be asleep, offline, or the connection to it is down. Nothing was sent.</p>
          <button type="button" className={`${ui.btn} ${ui.primary}`} onClick={() => setAttempt((n) => n + 1)}>Try again</button>
        </div>
      ) : CONNECTING}
    </Boot>
  );
}
