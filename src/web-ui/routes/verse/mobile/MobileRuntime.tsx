/**
 * routes/verse/mobile/MobileRuntime.tsx — the live half of the phone shell:
 * the activity loop (shell/useActivity.ts, the workbench rail's own cursor
 * loop), this device's permissions, reachability, the Needs-you count with
 * acted-on items hidden at once, the confirmation sheet and the toasts.
 *
 * WHY A CHUNK OF ITS OWN: none of it can show anything before the session
 * probe answers — the activity poll needs the session, permissions need the
 * bootstrap. So its download runs in parallel with that probe (MobileShell
 * preloads it) and costs no time, while the first paint stays a frame of
 * skeletons inside the 250 KB phone budget.
 */
import { Suspense, useMemo, type ReactNode } from 'react';
import { useQuery } from '../../../data/hooks.js';
import { preloadedLazy } from '../shell/preloaded.js';
import { useGuardState } from '../shell/guard-store.js';
import { useResolvedIds } from '../shell/resolved-store.js';
import { refreshActivity, useActivity } from '../shell/useActivity.js';
import { verseBootstrapQuery } from '../verse-bootstrap-query.js';
import { reachabilityOf, sinceText, useOnline, type Reachability } from './connectivity.js';
import { useDevicePermissions } from './device-permissions.js';
import { MobileContext, type MobileContextValue } from './mobile-context.js';
import type { MobileRoute, NavigateOptions } from './mobile-router.js';
import { MobileToasts } from './mobile-toast.js';
import styles from './MobileShell.module.css';

/**
 * The confirmation / unlock sheet draws nothing until an action starts; its
 * chunk (with the focus trap) is in long before the first tap.
 */
const GuardSheet = preloadedLazy<object>(() => import('./MobileGuardSheet.js').then((m) => m.MobileGuardSheet)).Slot;

export function ReachStrip({ state, updatedAt }: { state: Reachability; updatedAt: number | null }) {
  if (state === 'live' || state === 'connecting') return null;
  const text = state === 'offline'
    ? 'This phone is offline — showing the last update.'
    : `Can’t reach your Mac. ${sinceText(updatedAt)}.`;
  return (
    <div className={styles.reach} data-state={state} role="status">
      {text}
    </div>
  );
}

export interface MobileRuntimeProps {
  navigate: (route: MobileRoute, options?: NavigateOptions) => void;
  /** Renders the frame with the live context (and where the reach strip goes). */
  children: (context: MobileContextValue, overlays: ReactNode) => ReactNode;
}

export function MobileRuntime({ navigate, children }: MobileRuntimeProps) {
  const activity = useActivity();
  const online = useOnline();
  const bootstrap = useQuery(verseBootstrapQuery);
  const permissions = useDevicePermissions(bootstrap.data?.dispatchEnabled ?? null);
  const resolved = useResolvedIds();
  const reachability = reachabilityOf(online, activity);
  const guardOpen = useGuardState().request !== null;

  const needsCount = useMemo(() => {
    const items = activity.data?.needsYou;
    return items ? items.filter((i) => !resolved.has(i.id)).length : null;
  }, [activity.data, resolved]);
  const workingCount = activity.data?.counts.running ?? null;

  const context = useMemo<MobileContextValue>(
    () => ({ ready: true, permissions, reachability, activity, navigate, needsCount, workingCount, refreshActivity }),
    [permissions, reachability, activity, navigate, needsCount, workingCount],
  );

  const overlays = (
    <>
      <ReachStrip state={reachability} updatedAt={activity.updatedAt} />
      {guardOpen ? <Suspense fallback={null}><GuardSheet /></Suspense> : null}
      <MobileToasts />
    </>
  );
  return <MobileContext.Provider value={context}>{children(context, overlays)}</MobileContext.Provider>;
}
