/**
 * routes/verse/shell/surface-prefetch.ts — the reads each rail surface opens
 * with, so the shell can warm them while the operator is still reading chat
 * (shell/warmup.ts, once the operator is idle after first paint). A first
 * visit to Command, Fleet, Growth or Mind then paints from the cache instead
 * of a skeleton; the surface's own useQuery still refreshes whatever is older
 * than it accepts.
 *
 * LAZY ONLY. shell/warmup.ts loads this module with import(): these query
 * defs pull in the surfaces' data modules, none of which may cost chat
 * first-paint bytes (VerseApp.first-paint.test.ts pins it). The QueryDefs
 * themselves are the surfaces' own — same keys, same fetchers — so a warmed
 * entry IS the entry the surface reads.
 *
 * Keep each list in step with its surface's useQuery calls:
 * surface-prefetch.test.ts renders Command, Growth and Mind and fails when
 * they read something this table does not warm.
 */
import { ensureQuery } from '../../../data/cache.js';
import { modelsQuery, type QueryDef } from '../../../data/queries.js';
import { overnightQuery } from '../autonomy/overnight-queries.js';
import { budgetPreviewQuery, budgetQuery } from '../budget/budget-queries.js';
import { cloudQuery } from '../cloud/cloud-queries.js';
import {
  authorityQuery,
  fleetHistoryQuery,
  fleetLiveQuery,
  leaderQuery,
  learningQuery,
  reasoningDigestQuery,
  seatHistoryQuery,
} from '../command/surface-data.js';
import { verseBootstrapQuery, verseSessionsQuery, verseWorkspacesQuery } from '../verse-queries.js';
import type { VerseSectionId } from '../verse-ui-store.js';

type AnyQuery = QueryDef<unknown>;

/** What each rail surface reads the moment it mounts. */
export const SURFACE_PREFETCH: Readonly<Partial<Record<VerseSectionId, readonly AnyQuery[]>>> = {
  // seatHistoryQuery: without it the first Command visit draws each seat's
  // burn-down from this page's own readings ("since Verse opened"), then
  // redraws once the recorded week lands — the reset-on-reload look 3.10.1
  // set out to remove.
  // cloudQuery (3.11): the Cloud card's overview — without it a first visit
  // paints "Reading the cloud lane…" under the burn-downs.
  command: [authorityQuery, fleetLiveQuery, leaderQuery, learningQuery, fleetHistoryQuery, budgetQuery, seatHistoryQuery, cloudQuery],
  fleet: [fleetLiveQuery, overnightQuery, budgetQuery, budgetPreviewQuery],
  growth: [fleetHistoryQuery, learningQuery, modelsQuery('30d')],
  mind: [leaderQuery, reasoningDigestQuery, verseBootstrapQuery, verseWorkspacesQuery],
  chat: [verseBootstrapQuery, verseSessionsQuery, verseWorkspacesQuery],
};

/**
 * A cached answer younger than this is left alone. The surfaces accept 10–60 s
 * old data on mount, so anything fresher than a minute is already as good as
 * a warm-up can make it.
 */
export const PREFETCH_FRESH_MS = 60_000;

type Ensure = (key: string, fetcher: () => Promise<unknown>, maxAgeMs: number) => Promise<void>;

export interface PrefetchOptions {
  /** The cache's mount path (a seam for tests). */
  ensure?: Ensure;
  /**
   * Awaited before EACH read (the warm-up's idle gate). Resolving false stops
   * the warm-up there — the gate was cancelled.
   */
  beforeEach?: () => Promise<boolean> | boolean;
}

/**
 * Warm one surface's reads through the shared cache (joins an in-flight read,
 * skips a fresh one, and goes through the cache's concurrency gate).
 *
 * ONE AT A TIME: each read is awaited before the next is even considered, so
 * the warm-up never holds more than one of the gate's slots, and the operator
 * (who gets the other three, and whose reads the next `beforeEach` waits out)
 * is never queued behind a burst of it.
 *
 * Never rejects: a read that fails leaves the surface to load it as it always did.
 */
export async function prefetchSurfaceData(id: VerseSectionId, options: PrefetchOptions = {}): Promise<void> {
  const ensure = options.ensure ?? ensureQuery;
  for (const def of SURFACE_PREFETCH[id] ?? []) {
    try {
      if (options.beforeEach && !(await options.beforeEach())) return;
      await ensure(def.key, () => def.fetch(), PREFETCH_FRESH_MS);
    } catch {
      // A warm-up read that fails (or cannot even start) is not worth surfacing.
    }
  }
}
