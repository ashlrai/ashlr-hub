/**
 * hooks/useScrollRestore.ts — React port of the one thing app.js got right
 * for view state (captureMainViewState / restoreMainViewState at
 * app.js:692-718), adapted to survive both route changes AND the
 * background-refresh re-renders the data layer now does constantly.
 *
 * The old bug this fixes: app.js captured `window.scrollY`, but the actual
 * scroll container was `.main` (styles.css sets `body.live-shell {overflow:
 * hidden}`), so scroll position always read 0 and reset on every ~8-15s
 * poll. Here the caller passes the REAL scrolling element's ref directly —
 * there is no ambiguity about which element scrolls.
 *
 * State survives:
 *   - scrollTop of the container
 *   - which element (if any) had focus, keyed by a stable `data-focus-key`
 *     attribute the view puts on focusable rows/controls
 *   - open/closed state of any `<details data-state-key>` in the subtree
 *
 * Keyed by `routeKey` (typically the route pathname) so switching views and
 * coming back restores each view's own scroll position independently.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

interface ViewState {
  scrollTop: number;
  focusKey: string | null;
  details: Map<string, boolean>;
}

const stateByKey = new Map<string, ViewState>();

function capture(container: HTMLElement): ViewState {
  const active = document.activeElement;
  const focusKey =
    active instanceof HTMLElement && container.contains(active)
      ? active.getAttribute('data-focus-key')
      : null;
  const details = new Map<string, boolean>();
  container.querySelectorAll('details[data-state-key]').forEach((node) => {
    const key = node.getAttribute('data-state-key');
    if (key) details.set(key, (node as HTMLDetailsElement).open);
  });
  return { scrollTop: container.scrollTop, focusKey, details };
}

function restore(container: HTMLElement, saved: ViewState): void {
  container.querySelectorAll('details[data-state-key]').forEach((node) => {
    const key = node.getAttribute('data-state-key');
    if (key && saved.details.has(key)) (node as HTMLDetailsElement).open = saved.details.get(key)!;
  });
  container.scrollTop = saved.scrollTop;
  if (!saved.focusKey) return;
  const target = container.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(saved.focusKey)}"]`);
  if (!target) return;
  try {
    target.focus({ preventScroll: true });
  } catch {
    target.focus();
  }
  container.scrollTop = saved.scrollTop;
}

/**
 * Attach to the scrolling container. Call `saveNow()` before any render
 * that's about to replace the subtree wholesale (rare in React, but
 * available for parity with the old imperative call sites); normally you
 * don't need to call anything — mount/unmount and periodic capture on
 * scroll/blur handle it.
 */
export function useScrollRestore(routeKey: string, containerRef: RefObject<HTMLElement | null>) {
  const routeKeyRef = useRef(routeKey);
  routeKeyRef.current = routeKey;

  // Restore synchronously before paint so there's no visible jump.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const saved = stateByKey.get(routeKey);
    if (saved) restore(el, saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately re-runs only on routeKey; the ref itself is stable for the shell's lifetime.
  }, [routeKey]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let raf = 0;
    function onScroll() {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (el) stateByKey.set(routeKeyRef.current, capture(el));
      });
    }
    el.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('focusout', onScroll);
    document.addEventListener('toggle', onScroll, true);

    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('scroll', onScroll);
      document.removeEventListener('focusout', onScroll);
      document.removeEventListener('toggle', onScroll, true);
      // Final capture on unmount so a same-tick route swap doesn't lose the
      // last scroll position (scroll events can be throttled by the
      // browser right before teardown). Uses the `el` captured when this
      // effect was set up, not containerRef.current — the ref may already
      // point elsewhere (or be null) by the time cleanup runs.
      stateByKey.set(routeKeyRef.current, capture(el));
    };
  }, [containerRef]);
}
