/**
 * routes/verse/shell/warmup.ts — what the shell warms after first paint, in
 * what order, and when (unit C1; review 3.10.1).
 *
 *   1. the overlay chunks, one at a time, so the first ⌘K / ⌘J / ⌘/ never
 *      waits on the network;
 *   2. each rail surface not yet open, in rail order — its chunk (VerseApp's
 *      one-per-tab load, so the first visit mounts it directly) and then the
 *      reads it opens with (shell/surface-prefetch.ts, one read at a time).
 *      A first visit then paints from cache instead of a skeleton.
 *
 * WHEN: every chunk and every read waits for the idle gate
 * (shell/idle-prefetch.ts): window shown, no operator input for a quiet
 * period, and NOTHING in the query cache's gate — no read of the operator's
 * running or queued. The warm-up therefore holds at most one of the gate's
 * four slots, never while the operator's own reads wait, and never in front
 * of the chat's first actions: a click or ⌘N restarts the quiet period, and
 * the reads it causes are waited out before the next warm-up read starts.
 *
 * LAZY ONLY. VerseApp loads this module with import() from a mount effect,
 * so neither the scheduler nor the surface table costs chat first-paint
 * bytes; the surface table is a further import() from here, at the first
 * surface step (VerseApp.first-paint.test.ts pins both).
 */
import { getVerseUiState, RAIL_SECTIONS, type VerseSectionId } from '../verse-ui-store.js';
import { runIdleSteps, type IdleGate, type IdleStep, type IdleStepsOptions } from './idle-prefetch.js';

export type WarmupOptions = IdleStepsOptions;

export interface WarmupDeps {
  /** VerseApp's one load per section (its lazy component shares it). */
  loadSection: (id: VerseSectionId) => Promise<unknown>;
  /** The overlay chunks, in the order they are worth having. */
  overlays: ReadonlyArray<() => Promise<unknown>>;
  /**
   * True while any read is running or queued in the query cache's gate
   * (VerseApp reads `queryGateStats`). Injected rather than imported: a
   * static data/cache.ts import from this chunk made the bundler split the
   * cache out of its shared first-paint chunk (+1.2 KB of chat critical JS,
   * more than moving the scheduler out saved).
   */
  readsInFlight: () => boolean;
}

const importSurfacePrefetch = () => import('./surface-prefetch.js');

/** Start the warm-up. Returns a cancel (VerseApp calls it on unmount). */
export function warmUpAfterFirstPaint(deps: WarmupDeps, options: WarmupOptions = {}): () => void {
  const overlay = (load: () => Promise<unknown>): IdleStep => async () => {
    await load();
  };
  const surface = (id: VerseSectionId): IdleStep => async (gate: IdleGate) => {
    // Already open: its reads are live, and its chunk is in.
    if (getVerseUiState().mounted.includes(id)) return;
    await deps.loadSection(id);
    const { prefetchSurfaceData } = await importSurfacePrefetch();
    await prefetchSurfaceData(id, { beforeEach: () => gate.wait() });
  };
  return runIdleSteps([...deps.overlays.map(overlay), ...RAIL_SECTIONS.map((s) => surface(s.id))], {
    busy: deps.readsInFlight,
    ...options,
  });
}
