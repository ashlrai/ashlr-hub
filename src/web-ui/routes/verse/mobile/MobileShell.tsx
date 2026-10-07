/**
 * routes/verse/mobile/MobileShell.tsx — Verse on a phone: five tabs (Home,
 * Agents, Needs you, Leader, More), one screen at a time, one activity loop.
 *
 * FIRST PAINT: this shell and Home's frame are the whole first-paint bundle
 * (check-first-paint-budget.mjs measures them against 250 KB; React is ~220 KB
 * of it). Everything live is a chunk of its own that starts downloading when
 * this module evaluates (preloadedLazy), in parallel with the session probe
 * it would have to wait for anyway:
 *
 *   MobileRuntime   activity loop, permissions, reachability, sheet, toasts
 *   HomeBody        Home's cards (screens/HomeScreen.tsx)
 *   ScreenHost      every other screen, each its own chunk, prefetched idle
 *
 * Until the runtime lands the frame draws with BOOT_CONTEXT (mobile-context.ts):
 * no badges, no actions, skeletons where data goes.
 */
import { PRODUCT_NAME } from '../../../app/product-brand.js';
import { Component, Suspense, useCallback, useEffect, type ComponentType, type ReactNode } from 'react';
import { preloadedLazy } from '../shell/preloaded.js';
import { BOOT_CONTEXT, MobileContext, type MobileContextValue } from './mobile-context.js';
import { AgentsGlyph, HomeGlyph, LeaderGlyph, MoreGlyph, NeedsGlyph } from './mobile-icons.js';
import { tabOf, tabRoot, useMobileRoute, type MobileRoute, type MobileTab } from './mobile-router.js';
import type { MobileRuntimeProps } from './MobileRuntime.js';
import { HomeScreen } from './screens/HomeScreen.js';
import { SkeletonList, ui } from './ui.js';
import styles from './MobileShell.module.css';

const Runtime = preloadedLazy<MobileRuntimeProps>(() => import('./MobileRuntime.js').then((m) => m.MobileRuntime)).Slot;

/** Every screen but Home (ScreenHost.tsx), preloaded the same way. */
const loadHost = () => import('./ScreenHost.js');
const Host = preloadedLazy<{ route: Exclude<MobileRoute, { screen: 'home' }> }>(() => loadHost().then((m) => m.ScreenHost)).Slot;

/** Warm every screen chunk once the phone is idle. */
export function prefetchMobileScreens(): void {
  void loadHost().then((m) => m.prefetchMobileScreens(), () => undefined);
}

const TABS: ReadonlyArray<{ id: MobileTab; label: string; Glyph: ComponentType<{ size?: number }> }> = [
  { id: 'home', label: 'Home', Glyph: HomeGlyph },
  { id: 'agents', label: 'Agents', Glyph: AgentsGlyph },
  { id: 'needs', label: 'Needs you', Glyph: NeedsGlyph },
  { id: 'leader', label: 'Leader', Glyph: LeaderGlyph },
  { id: 'more', label: 'More', Glyph: MoreGlyph },
];

function ScreenFallback() {
  return (
    <div className={ui.screen}>
      <div className={ui.scroller}>
        <div className={styles.boot}>
          <SkeletonList rows={4} label="Loading screen" />
        </div>
      </div>
    </div>
  );
}

/**
 * A chunk that cannot load (offline and not yet cached, or the Mac went away
 * mid-download) must not blank the app: the failed part says so and offers a
 * reload; everything around it keeps working.
 */
export class ChunkBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return this.props.fallback ?? (
      <div className={ui.screen}>
        <div className={ui.scroller}>
          <div className={styles.boot} role="alert">
            <p className={ui.muted}>This screen could not load — this phone is offline or your Mac is out of reach.</p>
            <button type="button" className={`${ui.btn} ${ui.tinted}`} onClick={() => window.location.reload()}>Try again</button>
          </div>
        </div>
      </div>
    );
  }
}

interface FrameProps {
  route: MobileRoute;
  context: MobileContextValue;
  overlays?: ReactNode;
}

/** The tab bar and the current screen; the context comes from the runtime (or BOOT_CONTEXT). */
function Frame({ route, context, overlays }: FrameProps) {
  const current = tabOf(route);
  const { navigate, needsCount, workingCount } = context;
  const onTab = useCallback((tab: MobileTab) => {
    // Re-tapping the active tab pops back to its root, as on iOS.
    navigate(tabRoot(tab), { replace: tab === current });
  }, [navigate, current]);

  return (
    <div className={ui.app} data-mobile-app="">
      <main id="main" className={styles.stage}>
        <ChunkBoundary key={route.screen}>
          <Suspense fallback={<ScreenFallback />}>
            {route.screen === 'home' ? <HomeScreen /> : <Host route={route} />}
          </Suspense>
        </ChunkBoundary>
      </main>
      {overlays}
      <nav className={styles.tabbar} aria-label={PRODUCT_NAME}>
        {TABS.map(({ id, label, Glyph }) => {
          const badge = id === 'needs' ? needsCount : id === 'agents' ? workingCount : null;
          const spoken = badge ? `${label}, ${badge} ${id === 'needs' ? 'waiting' : 'working'}` : label;
          return (
            <button
              key={id}
              type="button"
              className={styles.tab}
              aria-current={current === id ? 'page' : undefined}
              aria-label={spoken}
              onClick={() => onTab(id)}
            >
              <Glyph size={24} />
              <span className={styles.tabLabel} aria-hidden="true">{label}</span>
              {badge ? (
                <span className={styles.tabBadge} data-tone={id === 'agents' ? 'running' : undefined} aria-hidden="true">
                  {badge > 99 ? '99+' : badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

export function MobileShell() {
  const [route, navigate] = useMobileRoute();

  useEffect(() => {
    // Safari has no requestIdleCallback; a short timeout after first paint stands in.
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(prefetchMobileScreens, { timeout: 4000 });
      return () => window.cancelIdleCallback(handle);
    }
    const handle = window.setTimeout(prefetchMobileScreens, 1500);
    return () => window.clearTimeout(handle);
  }, []);

  const boot = { ...BOOT_CONTEXT, navigate };
  const bootFrame = <MobileContext.Provider value={boot}><Frame route={route} context={boot} /></MobileContext.Provider>;
  // Without the runtime the frame still navigates and reads; it just knows nothing live.
  return (
    <ChunkBoundary fallback={bootFrame}>
      <Suspense fallback={bootFrame}>
        <Runtime navigate={navigate}>
          {(context, overlays) => <Frame route={route} context={context} overlays={overlays} />}
        </Runtime>
      </Suspense>
    </ChunkBoundary>
  );
}
