/**
 * routes/verse/usage/series-model.ts — the daily token/spend series, shaped
 * for the chart primitives.
 *
 * `GET /api/verse/usage-series` returns `DailyUsage[]` straight off
 * `buildRollup(window, cfg).byDay`, which every current backend consumer
 * computes and then throws away. Charting it is the cheapest honest win on
 * this surface — but three of its columns are not what a glancing reader
 * would assume, so each one is labelled at the point of display:
 *
 *   - `estCostUsd` is ESTIMATED from a static price table in the repo. It is
 *     not a bill, not a quote, and will not match a provider invoice.
 *   - `cacheRead` / `cacheWrite` are HARDCODED 0 for Codex upstream. A window
 *     with Codex traffic therefore understates cache activity, and Codex's
 *     cache economics are not comparable to Claude's. Where no day in the
 *     window carries a rate at all, the chart is refused rather than drawn as
 *     a flat 0% line.
 *   - A day with no rollup row is a GAP (`null`), not a measured zero. The
 *     chart primitives break the line at a null by contract, so nothing here
 *     back-fills.
 *
 * Pure: no React, no I/O.
 */
import type { Series, SeriesPoint } from '../../../components/charts/index.js';
import type { DailyUsage, SeriesWindow, UsageSeries } from './usage-contract.js';

export const COST_ESTIMATE_NOTE =
  'Cost is ESTIMATED from a static price table in this repo, not billed. It will not match a provider invoice.';

export const CACHE_CAVEAT =
  'Codex reports cacheRead and cacheWrite as a hardcoded 0 upstream, so any window containing Codex traffic understates cache activity — its cache economics are not comparable to Claude’s.';

export const LOCAL_SAVINGS_NOTE =
  'A flat heuristic of $3 per 1M local tokens, not a quote and not a measured price.';

export const SERIES_TOO_THIN =
  'Fewer than two days in this window carry a rollup row, which is not a trend.';

/**
 * Why there is no per-day local/cloud line, stated where the chart would be.
 *
 * `GET /api/verse/usage-series` returns `buildRollup(window, cfg).byDay`, and
 * `DailyUsage` has no per-engine or per-tier columns at all — the tier split
 * exists only in `/api/control`'s `usage.byProvider`, which is a single
 * AGGREGATE for its window with no dates on it. Splitting the daily totals by
 * the aggregate's ratio would draw a smooth, plausible, entirely invented
 * pair of lines. So the chart is refused and the aggregate is shown instead,
 * under its own window, labelled as an aggregate.
 */
export const LOCAL_CLOUD_SERIES_UNAVAILABLE =
  'The daily rollup carries no per-engine or local/cloud columns, and the only tier split available is a single aggregate with no dates on it. Apportioning the daily totals by that aggregate\u2019s ratio would invent a shape nobody measured, so no per-day split is drawn — the aggregate below is the real figure.';

export type SeriesProjection =
  | { available: true; series: Series[]; days: DailyUsage[] }
  | { available: false; reason: string };

function dayX(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

/** Days that carry at least one non-null reading for `pick`. */
function knownCount(days: readonly DailyUsage[], pick: (d: DailyUsage) => number | null): number {
  return days.reduce((acc, d) => acc + (pick(d) === null ? 0 : 1), 0);
}

function points(days: readonly DailyUsage[], pick: (d: DailyUsage) => number | null): SeriesPoint[] {
  return days.map((d) => ({ x: dayX(d.day), y: pick(d) }));
}

export interface SeriesTotals {
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
  sessions: number;
  /** Days actually present in the window — the denominator behind any average. */
  dayCount: number;
}

export function totalsFor(days: readonly DailyUsage[]): SeriesTotals {
  return days.reduce<SeriesTotals>(
    (acc, d) => ({
      tokensIn: acc.tokensIn + d.tokensIn,
      tokensOut: acc.tokensOut + d.tokensOut,
      estCostUsd: acc.estCostUsd + d.estCostUsd,
      sessions: acc.sessions + d.sessions,
      dayCount: acc.dayCount + 1,
    }),
    { tokensIn: 0, tokensOut: 0, estCostUsd: 0, sessions: 0, dayCount: 0 },
  );
}

/** Tokens in and out as two named series — never stacked, never summed away. */
export function buildTokenSeries(series: UsageSeries | null): SeriesProjection {
  if (!series) return { available: false, reason: 'No usage series has been loaded.' };
  if (series.days.length < 2) return { available: false, reason: SERIES_TOO_THIN };
  return {
    available: true,
    days: series.days,
    series: [
      { id: 'tokensIn', label: 'Tokens in', points: points(series.days, (d) => d.tokensIn) },
      { id: 'tokensOut', label: 'Tokens out', points: points(series.days, (d) => d.tokensOut) },
    ],
  };
}

export function buildSpendSeries(series: UsageSeries | null): SeriesProjection {
  if (!series) return { available: false, reason: 'No usage series has been loaded.' };
  if (series.days.length < 2) return { available: false, reason: SERIES_TOO_THIN };
  return {
    available: true,
    days: series.days,
    series: [
      { id: 'estCostUsd', label: 'Estimated spend', points: points(series.days, (d) => d.estCostUsd) },
    ],
  };
}

/**
 * Cache hit rate, only where the provider actually gave one. A window in which
 * NO day carries a rate is refused outright — drawing it would put a flat 0%
 * line on screen that a glancing reader would take for "the cache never hits",
 * when the truth is "nothing reported a rate".
 */
export function buildCacheSeries(series: UsageSeries | null): SeriesProjection {
  if (!series) return { available: false, reason: 'No usage series has been loaded.' };
  const known = knownCount(series.days, (d) => d.cacheHitRate);
  if (known === 0) {
    return {
      available: false,
      reason:
        'No day in this window reported a cache hit rate, so there is nothing to plot. This is an absent signal, not a 0% hit rate.',
    };
  }
  if (known < 2) {
    return {
      available: false,
      reason: `Only ${known} day in this window reported a cache hit rate, which is not a trend.`,
    };
  }
  return {
    available: true,
    days: series.days,
    series: [
      { id: 'cacheHitRate', label: 'Cache hit rate', points: points(series.days, (d) => d.cacheHitRate) },
    ],
  };
}

/**
 * Cache READ and WRITE token counts, which are a different fact from the hit
 * RATE: a day can have a healthy rate on tiny volume. Refused outright when no
 * day reports either column, because a flat pair of zero lines would read as
 * "the cache did nothing" when the truth is "nothing was reported".
 */
export function buildCacheTokenSeries(series: UsageSeries | null): SeriesProjection {
  if (!series) return { available: false, reason: 'No usage series has been loaded.' };
  const known =
    knownCount(series.days, (d) => d.cacheRead) + knownCount(series.days, (d) => d.cacheWrite);
  if (known === 0) {
    return {
      available: false,
      reason:
        'No day in this window reported cache read or write tokens, so there is nothing to plot. This is an absent signal, not zero cache activity.',
    };
  }
  if (series.days.length < 2) return { available: false, reason: SERIES_TOO_THIN };
  return {
    available: true,
    days: series.days,
    series: [
      { id: 'cacheRead', label: 'Cache read', points: points(series.days, (d) => d.cacheRead) },
      { id: 'cacheWrite', label: 'Cache write', points: points(series.days, (d) => d.cacheWrite) },
    ],
  };
}

export interface SeriesAverages {
  /** Per RECORDED day, not per calendar day — the denominator is stated. */
  tokensInPerDay: number | null;
  tokensOutPerDay: number | null;
  estCostUsdPerDay: number | null;
  /** The busiest recorded day, for "what does a heavy day cost me". */
  peakCostDay: { day: string; usd: number } | null;
}

/**
 * Averages over the days that actually carry a row. Dividing by the window
 * length instead would understate every figure by however many days the
 * rollup has no data for, which is the difference between "I spend $4 a day"
 * and "I spend $4 on the days I work".
 */
export function averagesFor(days: readonly DailyUsage[]): SeriesAverages {
  if (days.length === 0) {
    return {
      tokensInPerDay: null,
      tokensOutPerDay: null,
      estCostUsdPerDay: null,
      peakCostDay: null,
    };
  }
  const totals = totalsFor(days);
  const peak = days.reduce((best, d) => (d.estCostUsd > best.estCostUsd ? d : best));
  return {
    tokensInPerDay: totals.tokensIn / days.length,
    tokensOutPerDay: totals.tokensOut / days.length,
    estCostUsdPerDay: totals.estCostUsd / days.length,
    peakCostDay: { day: peak.day, usd: peak.estCostUsd },
  };
}

/** Sparkline input for a stat tile: gaps preserved as nulls. */
export function sparklinePoints(
  series: UsageSeries | null,
  pick: (d: DailyUsage) => number | null,
): (number | null)[] | undefined {
  if (!series || series.days.length < 2) return undefined;
  return series.days.map(pick);
}

export const WINDOW_LABEL: Record<SeriesWindow, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};
