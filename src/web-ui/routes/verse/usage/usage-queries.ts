/**
 * routes/verse/usage/usage-queries.ts — the reads behind the Usage section.
 *
 * `/api/control` is fetched through the shared `controlSnapshotQuery` so this
 * section rides the same cache (and the same SSE invalidation) as every other
 * view rather than opening a second copy of a large snapshot.
 *
 * `/api/verse/control` is owner B's new route. It is fetched through a
 * NON-throwing wrapper because this section must still render when the route
 * is absent (server started without --allow-dispatch, or B's route not landed
 * yet): a missing configured-caps source is a degraded panel, not a dead
 * section. 401 is the one error that still propagates — an expired read
 * session is an unauthorized state for the whole surface, not a degraded one.
 *
 * The cache key is deliberately NOT shared with the Autonomy section's own
 * read of the same route: this module stores a wrapper shape, and two owners
 * writing different value types under one key would be a real bug.
 */
import type { FrontierUsage } from '../../../../core/usage/frontier-usage.js';
import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { projectLocalModels, type SeriesWindow } from './usage-contract.js';

export const USAGE_FRONTIER_KEY = 'verse-usage-frontier';
export const USAGE_VERSE_CONTROL_KEY = 'verse-usage-control';

/** GET /api/usage — per-engine frontier usage (see core/usage/frontier-usage.ts). */
export const frontierUsageQuery: QueryDef<FrontierUsage> = {
  key: USAGE_FRONTIER_KEY,
  fetch: (signal) => apiGet<FrontierUsage>('/api/usage', signal),
};

export interface VerseControlRead {
  /** Raw body; narrowed by `projectVerseControl` (owner B's types are not landed). */
  raw: unknown;
  available: boolean;
  reason: string | null;
}

function describeControlFailure(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) {
      return 'This server does not expose /api/verse/control, so configured caps and today’s spend are unavailable here.';
    }
    return `Configured caps unavailable (HTTP ${err.status}).`;
  }
  return 'Configured caps unavailable: the request failed.';
}

export const verseControlQuery: QueryDef<VerseControlRead> = {
  key: USAGE_VERSE_CONTROL_KEY,
  fetch: async (signal) => {
    try {
      const raw = await apiGet<unknown>('/api/verse/control', signal);
      return { raw, available: true, reason: null };
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw err;
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      return { raw: null, available: false, reason: describeControlFailure(err) };
    }
  },
};

// ---------------------------------------------------------------------------
// Owner T's routes (GET /api/verse/{accounts,usage-series,local-models})
// ---------------------------------------------------------------------------
//
// These three are fetched through the SAME non-throwing wrapper pattern as
// /api/verse/control, for the same reason and one more: they are landing in
// parallel with this section. A server that predates them answers 404, and a
// 404 here means "this panel is degraded", not "the Usage view is broken".
// 401 still propagates, because an expired read session is an unauthorized
// state for the whole surface.
//
// The bodies are narrowed structurally by usage-contract.ts rather than cast,
// so a field-name drift between T's route and this client degrades to an
// honest "unknown" instead of throwing at render time.

export const USAGE_ACCOUNTS_KEY = 'verse-usage-accounts';
export const USAGE_LOCAL_MODELS_KEY = 'verse-usage-local-models';
export const USAGE_SERIES_KEY_PREFIX = 'verse-usage-series';

/** A read that is allowed to be absent. `raw` is null when it was. */
export interface OptionalRead {
  raw: unknown;
  available: boolean;
  reason: string | null;
}

function describeOptionalFailure(path: string, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) {
      return `This server does not expose ${path} yet, so this panel has no source.`;
    }
    return `${path} answered HTTP ${err.status}.`;
  }
  return `${path} could not be reached.`;
}

function optionalGet(path: string): (signal?: AbortSignal) => Promise<OptionalRead> {
  return async (signal) => {
    try {
      const raw = await apiGet<unknown>(path, signal);
      return { raw, available: true, reason: null };
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw err;
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      return { raw: null, available: false, reason: describeOptionalFailure(path, err) };
    }
  };
}

/** GET /api/verse/accounts — per-account state, windows, credits, plan. */
export const verseAccountsQuery: QueryDef<OptionalRead> = {
  key: USAGE_ACCOUNTS_KEY,
  fetch: optionalGet('/api/verse/accounts'),
};

// ---------------------------------------------------------------------------
// GET /api/verse/local-models — and why this one read retries
// ---------------------------------------------------------------------------
//
// `/api/verse/local-models` probes the runtimes live on every request, with a
// 2s per-probe timeout (core/verse/local-models.ts
// VERSE_LOCAL_PROBE_TIMEOUT_MS). A probe that times out is reported as
// `{reachable: false, reason: 'ollama-unreachable'}` in a perfectly ordinary
// HTTP 200 — which is correct on the server's terms (it genuinely did not get
// an answer) but is NOT the same fact as "Ollama is not running", and nothing
// in the payload distinguishes the two.
//
// That distinction matters here because this section is the thing that causes
// the timeout. Mounting Usage, and every press of its Refresh button, fires
// seven reads at once, several of which spawn short-lived account-probe
// processes server-side; measured against a live Ollama with twelve models,
// roughly one burst in ten starves the 2s probe and comes back
// `ollama-unreachable`. Nothing re-reads this route afterwards — it has no SSE
// invalidation key — so that one false negative is what the operator stares
// at, and pressing Refresh re-creates the very burst that produced it.
//
// So a reported-unreachable local stack is RE-READ, up to twice, with a short
// gap for the burst to drain. This is not "ignore the failure": the retries
// are bounded, each one is a real request, and whatever the last read says is
// what this section renders — a runtime that is genuinely down answers fast
// (connection refused, not a timeout) and still reports unreachable, three
// times, in well under a second.
//
// Only an AVAILABLE read is retried. A 404/500 (`available: false`) is a
// statement about the route, not about the runtime, and re-asking cannot
// change it.

/** Two extra reads at most, spaced so the section's own request burst drains. */
const LOCAL_MODELS_RETRY_DELAYS_MS = [350, 1200] as const;

const readLocalModels = optionalGet('/api/verse/local-models');

function reportsNothingReachable(read: OptionalRead): boolean {
  if (!read.available) return false;
  const snapshot = projectLocalModels(read.raw);
  return snapshot !== null && !snapshot.reachable;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** GET /api/verse/local-models — resident vs installed, VRAM split, tools. */
export const verseLocalModelsQuery: QueryDef<OptionalRead> = {
  key: USAGE_LOCAL_MODELS_KEY,
  fetch: async (signal) => {
    let read = await readLocalModels(signal);
    for (const delayMs of LOCAL_MODELS_RETRY_DELAYS_MS) {
      if (!reportsNothingReachable(read)) return read;
      await sleep(delayMs, signal);
      read = await readLocalModels(signal);
    }
    return read;
  },
};

// One QueryDef per window, created once at module scope: useQuery keys on
// `def.key`, and minting a fresh object per render would be harmless but
// useRefresh/useRefetch's useCallback deps would churn for no reason.
const SERIES_QUERIES: Record<SeriesWindow, QueryDef<OptionalRead>> = {
  '7d': {
    key: `${USAGE_SERIES_KEY_PREFIX}:7d`,
    fetch: optionalGet('/api/verse/usage-series?window=7d'),
  },
  '30d': {
    key: `${USAGE_SERIES_KEY_PREFIX}:30d`,
    fetch: optionalGet('/api/verse/usage-series?window=30d'),
  },
};

export function usageSeriesQuery(window: SeriesWindow): QueryDef<OptionalRead> {
  return SERIES_QUERIES[window];
}
