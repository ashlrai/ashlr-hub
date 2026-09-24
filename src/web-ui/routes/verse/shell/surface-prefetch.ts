/**
 * routes/verse/shell/surface-prefetch.ts — the reads each rail surface opens
 * with, so the shell can warm them while the operator is still reading chat
 * (VerseApp `prefetchSurfaces`, on idle after first paint). A first visit to
 * Fleet, Growth or Mind then paints from the cache instead of a skeleton; the
 * surface's own useQuery still refreshes whatever is older than it accepts.
 *
 * LAZY ONLY. VerseApp loads this module with import(): these query defs pull
 * in the surfaces' data modules, none of which may cost chat first-paint
 * bytes (VerseApp.first-paint.test.ts pins it). The QueryDefs themselves are
 * the surfaces' own — same keys, same fetchers — so a warmed entry IS the
 * entry the surface reads.
 *
 * Keep each list in step with its surface's useQuery calls:
 * surface-prefetch.test.ts renders Growth and Mind and fails when they read
 * something this table does not warm.
 */
import { ensureQuery } from '../../../data/cache.js';
import { modelsQuery, type QueryDef } from '../../../data/queries.js';
import { overnightQuery } from '../autonomy/overnight-queries.js';
import { budgetPreviewQuery, budgetQuery } from '../budget/budget-queries.js';
import {
  authorityQuery,
  fleetHistoryQuery,
  fleetLiveQuery,
  leaderQuery,
  learningQuery,
  reasoningDigestQuery,
} from '../command/surface-data.js';
import { verseBootstrapQuery, verseSessionsQuery, verseWorkspacesQuery } from '../verse-queries.js';
import type { VerseSectionId } from '../verse-ui-store.js';

type AnyQuery = QueryDef<unknown>;

/** What each rail surface reads the moment it mounts. */
export const SURFACE_PREFETCH: Readonly<Partial<Record<VerseSectionId, readonly AnyQuery[]>>> = {
  command: [authorityQuery, fleetLiveQuery, leaderQuery, learningQuery, fleetHistoryQuery, budgetQuery],
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

/**
 * Warm one surface's reads through the shared cache (joins an in-flight read,
 * skips a fresh one, and queues behind the cache's concurrency gate). Never
 * throws: a read that fails leaves the surface to load it as it always did.
 */
export function prefetchSurfaceData(id: VerseSectionId, ensure: Ensure = ensureQuery): void {
  for (const def of SURFACE_PREFETCH[id] ?? []) {
    try {
      void ensure(def.key, () => def.fetch(), PREFETCH_FRESH_MS).catch(() => undefined);
    } catch {
      // A warm-up that cannot even start is not worth surfacing.
    }
  }
}
