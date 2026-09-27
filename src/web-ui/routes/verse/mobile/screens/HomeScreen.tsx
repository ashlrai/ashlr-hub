/**
 * routes/verse/mobile/screens/HomeScreen.tsx — Home's frame: the title, the
 * New-agent button, pull-to-refresh, and skeletons in the shape of the cards.
 *
 * FIRST PAINT (SPEC-310A's arrangement, as the workbench's Chat section does
 * it): this frame is the phone app's first-paint root, measured by
 * scripts/check-first-paint-budget.mjs against 250 KB — React alone is
 * ~220 KB of that. The cards (HomeBody.tsx: fleet, needs-you, working, spend,
 * seats) are a preloaded chunk: its download starts when this module
 * evaluates, in parallel with the session probe, and it renders synchronously
 * once in. On a warm launch (service worker cache) that is the same frame.
 */
import { Suspense } from 'react';
import { preloadedLazy } from '../../shell/preloaded.js';
import { canShowActions, useMobile } from '../mobile-context.js';
import { PlusGlyph } from '../mobile-icons.js';
import { Button, Screen, SkeletonList, ui } from '../ui.js';
import styles from './HomeScreen.module.css';

const loadBody = () => import('./HomeBody.js');
const Body = preloadedLazy<object>(() => loadBody().then((m) => m.HomeBody));

/** The cards' shape, drawn until they arrive. */
export function HomeSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading Home">
      <div className={`${ui.card} ${styles.fleet}`}>
        <span className={`skeleton ${styles.badgeSkeleton}`} aria-hidden="true" />
        <span className={`skeleton ${ui.skeletonLine}`} style={{ width: '80%' }} aria-hidden="true" />
      </div>
      <div className={styles.stats} aria-hidden="true">
        {[0, 1, 2].map((i) => <div key={i} className={`${styles.stat} skeleton`} style={{ height: '4.5rem' }} />)}
      </div>
      <SkeletonList rows={2} label="Loading running agents" />
    </div>
  );
}

export function HomeScreen() {
  const { permissions, navigate, refreshActivity } = useMobile();
  const canAct = canShowActions(permissions);
  const onRefresh = () => Promise.all([refreshActivity(), loadBody().then((m) => m.refreshHome())]);
  return (
    <Screen
      title="Verse"
      large
      subtitle={permissions.act === 'unavailable' ? 'Read-only on this device' : undefined}
      onRefresh={onRefresh}
      trailing={canAct ? (
        <Button variant="plain" icon aria-label="New agent" onClick={() => navigate({ screen: 'new' })}>
          <PlusGlyph size={22} />
        </Button>
      ) : null}
    >
      <Suspense fallback={<HomeSkeleton />}>
        <Body.Slot />
      </Suspense>
    </Screen>
  );
}
