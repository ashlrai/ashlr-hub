/**
 * routes/verse/shell/preloaded.tsx — chunks that start downloading when the
 * module DECLARING them evaluates, and render synchronously once they are in.
 *
 * Moved out of sections/ChatSection.tsx so the shell (guarded-action.tsx)
 * can keep its dialogs off the chat first-paint path the same way the Chat
 * section keeps its workspace, chat list and dialogs off it. A preloaded
 * dialog that has landed mounts in the same render that opens it, exactly as
 * a static import would; one opened in the few milliseconds before its chunk
 * lands shows a moment later.
 */
import { lazy, useEffect, useState, type ComponentType } from 'react';

/**
 * A component in its own chunk whose download starts the moment the module
 * declaring it evaluates — not when React first renders it — so it streams in
 * parallel with the chat's first paint instead of after it.
 *
 * WHY (SPEC-310A §1: chat first-paint critical JS ≤ 350 KB, measured by
 * scripts/check-first-paint-budget.mjs). React + react-dom alone are ~220 KB
 * of that; the chat list, the transcript, the composer and the markdown
 * renderer were another ~290 KB in this chunk. The section's frame (its
 * grid, the banners, every mutation and key handler) paints from this chunk;
 * the workspace and the chat list paint a beat later from theirs, over
 * skeletons in their own shape so nothing jumps.
 *
 * Once the module is in, every later mount renders it synchronously (no
 * Suspense flash when you come back to Chat). Which of the two a mount uses
 * is fixed for that mount's life: swapping the lazy wrapper for the loaded
 * component mid-life would remount the subtree and drop its state — the
 * composer's draft, the transcript's scroll.
 */
export function preloadedLazy<P extends object>(load: () => Promise<ComponentType<P>>): { Slot: ComponentType<P>; ready: () => Promise<ComponentType<P>> } {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const ready = (): Promise<ComponentType<P>> => {
    // A failed download is not cached: the next mount (or retry) asks again.
    pending ??= load().then((c) => (loaded = c), (err: unknown) => { pending = null; throw err; });
    return pending;
  };
  const Lazy = lazy(() => ready().then((c) => ({ default: c })));
  function Slot(props: P) {
    const [Ready] = useState<ComponentType<P> | null>(() => loaded);
    return Ready ? <Ready {...props} /> : <Lazy {...props} />;
  }
  if (typeof window !== 'undefined') void ready().catch(() => undefined);
  return { Slot, ready };
}

/**
 * A module (not a component) on the same terms as preloadedLazy: fetched when
 * the declaring module evaluates, read synchronously once in. useLoaded() re-renders
 * its caller once, when it lands; a failed load leaves it null (the values it
 * would have computed stay empty) and is retried on the next mount.
 */
export function preloadedModule<M>(load: () => Promise<M>): { ready: () => Promise<M>; useLoaded: () => M | null } {
  let loaded: M | null = null;
  let pending: Promise<M> | null = null;
  const ready = (): Promise<M> => {
    pending ??= load().then((m) => (loaded = m), (err: unknown) => { pending = null; throw err; });
    return pending;
  };
  function useLoaded(): M | null {
    const [mod, setMod] = useState<{ current: M | null }>(() => ({ current: loaded }));
    useEffect(() => {
      if (mod.current) return undefined;
      let live = true;
      ready().then((m) => { if (live) setMod({ current: m }); }, () => undefined);
      return () => { live = false; };
    }, [mod]);
    return mod.current;
  }
  if (typeof window !== 'undefined') void ready().catch(() => undefined);
  return { ready, useLoaded };
}
