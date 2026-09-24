/**
 * routes/verse/shell/section-visibility.tsx — "is this surface on screen?"
 * for the keep-alive shell (unit C0; SPEC-310C §1).
 *
 * 3.10 keeps the last three surfaces MOUNTED (hidden with `hidden` + `inert`)
 * so switching back is instant and keeps scroll, selection and filters. The
 * price is that a hidden surface's polls keep running: Fleet's live swimlane
 * polling every few seconds behind a chat the operator is reading. The shell
 * (C1) wraps each mounted surface in <SectionVisibilityProvider visible>, and
 * every surface polls through usePollWhileVisible — so a hidden surface, or a
 * hidden window, costs nothing.
 *
 * Outside any provider a section counts as visible: components rendered on
 * their own (tests, the legacy sections before C1 lands) behave as today.
 */
import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';

const SectionVisibleContext = createContext<boolean>(true);

export function SectionVisibilityProvider({ visible, children }: { visible: boolean; children: ReactNode }) {
  // A hidden surface nested in a visible one is hidden; a visible one nested
  // in a hidden one is hidden too.
  const parent = useContext(SectionVisibleContext);
  return <SectionVisibleContext.Provider value={parent && visible}>{children}</SectionVisibleContext.Provider>;
}

/** True while the surface this component lives in is the one on screen. */
export function useSectionVisible(): boolean {
  return useContext(SectionVisibleContext);
}

function documentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function subscribeDocument(onChange: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

/** True while the window itself is visible (not minimised, not a background tab). */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeDocument, documentVisible, () => true);
}

/**
 * The performance budget's floor (SPEC-310A §0: "no new polling faster than
 * 2 s"). Enforced here, in the one place surfaces poll from, rather than by
 * review.
 */
export const MIN_POLL_INTERVAL_MS = 2_000;

export interface PollOptions {
  /** Poll at all (e.g. only while a panel is expanded). Default true. */
  enabled?: boolean;
  /**
   * Tick once as soon as the surface becomes visible again, so data that went
   * stale while it was hidden is refreshed on sight instead of one interval
   * later. Default true. (The first mount is the caller's own fetch.)
   */
  refreshOnShow?: boolean;
}

/**
 * Run `tick` every `intervalMs` (at least MIN_POLL_INTERVAL_MS) while the
 * section AND the document are visible. The latest `tick` is always the one
 * called, so passing an inline closure does not restart the interval.
 */
export function usePollWhileVisible(tick: () => void, intervalMs: number, options: PollOptions = {}): void {
  const sectionVisible = useSectionVisible();
  const docVisible = useDocumentVisible();
  const visible = sectionVisible && docVisible;
  const active = (options.enabled ?? true) && visible;
  const refreshOnShow = options.refreshOnShow ?? true;
  const every = Math.max(MIN_POLL_INTERVAL_MS, Number.isFinite(intervalMs) ? intervalMs : MIN_POLL_INTERVAL_MS);

  const tickRef = useRef(tick);
  tickRef.current = tick;
  // VISIBILITY history, not activity: turning `enabled` on is the caller's
  // own decision (and it fetches for itself); coming back into view is not.
  const wasVisible = useRef<boolean | null>(null);

  useEffect(() => {
    const previouslyVisible = wasVisible.current;
    wasVisible.current = visible;
    if (!active) return;
    // Back in view after being hidden: catch up now rather than one interval late.
    if (previouslyVisible === false && refreshOnShow) tickRef.current();
    const id = setInterval(() => tickRef.current(), every);
    return () => clearInterval(id);
  }, [active, visible, every, refreshOnShow]);
}
