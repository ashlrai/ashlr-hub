/**
 * app/VerseConsoleApp.tsx — isolated bootstrap for /verse (pattern:
 * ResourcePoolConsoleApp). No global dashboard shell, router, or observer
 * stream: the read session is probed against /api/verse/bootstrap, host-
 * injected tokens (desktop wrapper) are adopted before that probe, and the
 * full-bleed VerseApp takes over once authenticated.
 *
 * V3.10 — first paint without a serial wait. The chunk of the section the
 * shell will mount (Chat, unless the operator left another one open) used to
 * start downloading only AFTER the bootstrap probe answered: index →
 * this module → probe → section chunk, one round trip after another. Now
 * this module starts that import the moment it evaluates, in parallel with
 * the probe (Vite shares the in-flight import with the lazy() that mounts
 * it later), and preloads the two Latin font subsets the first paint needs.
 *
 * V3.10 — a restarted desktop sidecar is re-adopted at once. The desktop
 * shell restarts a crashed server in the background, hands the new tokens to
 * this page as `window.__ASHLR_TOKENS__` and fires `ashlr:sidecar-restarted`
 * (desktop/src-tauri/src/main.rs token_handoff_script). The old cookie died
 * with the old server, so without listening the page would sit until its
 * next 401 → failed renewal → SessionGate → adoption.
 */
import { lazy, Suspense, useEffect } from 'react';
import { ToastProvider } from '../components/primitives/Toast.js';
import { adoptInjectedTokens, markCheckComplete } from '../data/auth-store.js';
import { getQuerySnapshot, runQuery } from '../data/cache.js';
import { useAuthPhase } from '../data/hooks.js';
import { SECTION_MODULES, VerseApp } from '../routes/verse/VerseApp.js';
import { invalidateVerseLists, verseBootstrapQuery } from '../routes/verse/verse-queries.js';
import { getVerseUiState, VERSE_SECTIONS } from '../routes/verse/verse-ui-store.js';
import uiFontLatin from '../design/fonts/AshlrSans-latin.woff2?url';
import displayFontLatin from '../design/fonts/SpaceGrotesk-latin.woff2?url';
import { SkipToContent } from './SkipToContent.js';
import styles from './VerseConsoleApp.module.css';
import '../design/global.css';

/**
 * Start what the first paint will need, without waiting for the auth probe.
 * Everything here is a cache warm-up: a failure is ignored, because the real
 * mount (VerseApp's sectionLoader, the CSS @font-face) repeats the request
 * and owns the error handling.
 */
export function preloadVerseFirstPaint(doc: Document | null = typeof document === 'undefined' ? null : document): void {
  const section = VERSE_SECTIONS.find((s) => s.id === getVerseUiState().section);
  const importer = section ? SECTION_MODULES[`./sections/${section.module}.tsx`] : undefined;
  if (importer) void importer().catch(() => undefined);
  if (!doc?.head) return;
  for (const href of [uiFontLatin, displayFontLatin]) {
    const present = [...doc.head.querySelectorAll('link[rel="preload"]')].some((l) => l.getAttribute('href') === href);
    if (present) continue;
    const link = doc.createElement('link');
    link.rel = 'preload';
    link.as = 'font';
    link.type = 'font/woff2';
    // Font preloads are CORS requests even same-origin; without this the
    // browser fetches the file twice.
    link.crossOrigin = 'anonymous';
    link.href = href;
    doc.head.append(link);
  }
}

preloadVerseFirstPaint();

/**
 * The session gate is a dynamic import: a signed-in cold load (the common
 * case — the desktop shell injects its tokens) never draws it, and as a
 * static import it cost ~3 KB of chat first-paint critical JS (SPEC-310A §1).
 * `preloadSessionGate` starts the download while the auth probe is in flight,
 * so an unauthenticated answer finds the chunk already there instead of
 * paying a second round trip. Vite shares the in-flight import with lazy().
 */
const importSessionGate = () => import('../components/auth/SessionGate.js');
const SessionGate = lazy(() => importSessionGate().then((m) => ({ default: m.SessionGate })));
function preloadSessionGate(): void {
  void importSessionGate().catch(() => undefined);
}

/** DOM event the desktop shell fires after handing a restarted sidecar's tokens to this page. */
export const SIDECAR_RESTARTED_EVENT = 'ashlr:sidecar-restarted';

/**
 * Re-adopt host tokens whenever the desktop shell says its sidecar restarted.
 * Returns the disposer.
 *
 * Installed for the page's whole life, whatever the auth phase: the event may
 * land while the SessionGate is showing (adoption then replaces the prompt,
 * because establishReadSession flips the phase) or while the app looks
 * authenticated on a dead cookie. After a successful adoption the lists are
 * refetched — the restarted server may have marked turns interrupted — and
 * the live streams reconnect on their own: their next attempt now carries a
 * valid cookie. A failed adoption changes nothing; the ordinary 401 path
 * still ends at the SessionGate. The event carries no data, so a page script
 * firing it can at most make the page re-read tokens that are already there.
 */
export function listenForSidecarRestart(target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  let inFlight = false;
  let again = false;
  let disposed = false;
  const onRestart = (): void => {
    if (disposed) return;
    // Restarts in quick succession: adoption reads `window.__ASHLR_TOKENS__`
    // when it STARTS, so a second restart during an exchange left newer
    // tokens behind it. Run exactly once more after the current exchange
    // instead of racing a second one for the cookie.
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    void adoptInjectedTokens()
      .then((adopted) => { if (adopted) invalidateVerseLists(); })
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        if (again) {
          again = false;
          onRestart();
        }
      });
  };
  target.addEventListener(SIDECAR_RESTARTED_EVENT, onRestart);
  return () => {
    disposed = true;
    target.removeEventListener(SIDECAR_RESTARTED_EVENT, onRestart);
  };
}

export function VerseConsoleApp() {
  const phase = useAuthPhase();
  useEffect(() => listenForSidecarRestart(), []);
  useEffect(() => {
    if (phase !== 'checking') return;
    preloadSessionGate();
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
    return (
      <Suspense fallback={<p className={styles.checking} role="status">Checking for an existing Verse session…</p>}>
        <SessionGate heading="Connect to Ashlr Verse" command="ashlr verse" subject="Ashlr Verse" mutationField />
      </Suspense>
    );
  }
  return (
    <ToastProvider>
      <SkipToContent />
      <div className={styles.shell}><VerseApp /></div>
    </ToastProvider>
  );
}
