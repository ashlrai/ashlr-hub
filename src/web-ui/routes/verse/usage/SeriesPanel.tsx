/**
 * routes/verse/usage/SeriesPanel.tsx — token output and spend over time.
 *
 * The series comes from `buildRollup(window, cfg).byDay`, which the backend
 * has always computed and always discarded. Three honesty rules travel with
 * it and are stated AT THE POINT OF DISPLAY, not in a footnote:
 *
 *   - the spend chart is titled "Estimated spend" and carries the static
 *     price-table caveat, because no part of this figure is billed;
 *   - the cache chart carries the Codex caveat (its cacheRead/cacheWrite are
 *     hardcoded 0 upstream, so the two providers are not comparable) and is
 *     REFUSED entirely when no day reported a rate — a flat 0% line would
 *     read as "the cache never hits";
 *   - a day with no rollup row is a gap, and the chart primitives break the
 *     line at a null by contract.
 *
 * Charts are the existing primitives only — no new chart code, no library.
 */
import type { ReactNode } from 'react';
import {
  ChartContainer,
  LineChart,
  StatTile,
  TableView,
  chartFormat,
  type TableColumn,
} from '../../../components/charts/index.js';
import { formatWholePercent } from '../autonomy/format.js';
import type { DailyUsage, SeriesWindow, UsageSeries } from './usage-contract.js';
import {
  CACHE_CAVEAT,
  COST_ESTIMATE_NOTE,
  LOCAL_CLOUD_SERIES_UNAVAILABLE,
  WINDOW_LABEL,
  averagesFor,
  buildCacheSeries,
  buildCacheTokenSeries,
  buildSpendSeries,
  buildTokenSeries,
  sparklinePoints,
  totalsFor,
} from './series-model.js';
import styles from './usage.module.css';

const WINDOWS: readonly SeriesWindow[] = ['7d', '30d'];

const TOKEN_COLUMNS: TableColumn<DailyUsage>[] = [
  { key: 'day', label: 'Day', render: (r) => chartFormat.formatDayLabel(r.day) },
  { key: 'in', label: 'Tokens in', numeric: true, render: (r) => chartFormat.formatCompact(r.tokensIn) },
  { key: 'out', label: 'Tokens out', numeric: true, render: (r) => chartFormat.formatCompact(r.tokensOut) },
  { key: 'sessions', label: 'Sessions', numeric: true, render: (r) => chartFormat.formatCompact(r.sessions) },
];

const SPEND_COLUMNS: TableColumn<DailyUsage>[] = [
  { key: 'day', label: 'Day', render: (r) => chartFormat.formatDayLabel(r.day) },
  {
    key: 'cost',
    label: 'Estimated spend',
    numeric: true,
    render: (r) => chartFormat.formatUsd(r.estCostUsd),
  },
];

const CACHE_TOKEN_COLUMNS: TableColumn<DailyUsage>[] = [
  { key: 'day', label: 'Day', render: (r) => chartFormat.formatDayLabel(r.day) },
  {
    key: 'read',
    label: 'Cache read',
    numeric: true,
    render: (r) => (r.cacheRead === null ? 'not reported' : chartFormat.formatCompact(r.cacheRead)),
  },
  {
    key: 'write',
    label: 'Cache write',
    numeric: true,
    render: (r) => (r.cacheWrite === null ? 'not reported' : chartFormat.formatCompact(r.cacheWrite)),
  },
];

const CACHE_COLUMNS: TableColumn<DailyUsage>[] = [
  { key: 'day', label: 'Day', render: (r) => chartFormat.formatDayLabel(r.day) },
  {
    key: 'rate',
    label: 'Cache hit rate',
    numeric: true,
    // "<1%" for a sliver of hits, never "0%" (the app-wide rule).
    render: (r) => (r.cacheHitRate === null ? 'not reported' : formatWholePercent(r.cacheHitRate)),
  },
  {
    key: 'read',
    label: 'Cache read',
    numeric: true,
    render: (r) => (r.cacheRead === null ? 'not reported' : chartFormat.formatCompact(r.cacheRead)),
  },
];

export function SeriesPanel({
  series,
  window,
  onWindowChange,
  unavailableReason,
  loading,
}: {
  series: UsageSeries | null;
  window: SeriesWindow;
  onWindowChange: (next: SeriesWindow) => void;
  /** Non-null when the route could not be read at all. */
  unavailableReason: string | null;
  loading: boolean;
}): ReactNode {
  const totals = series ? totalsFor(series.days) : null;
  const averages = series ? averagesFor(series.days) : null;
  const tokens = buildTokenSeries(series);
  const spend = buildSpendSeries(series);
  const cache = buildCacheSeries(series);
  const cacheTokens = buildCacheTokenSeries(series);

  return (
    <section className={styles.panel} aria-labelledby="verse-usage-series">
      <div className={styles.panelHead}>
        <h3 id="verse-usage-series" className={styles.panelTitle}>
          Token output and spend
        </h3>
        <div className={styles.segmented} role="group" aria-label="Series window">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              className={styles.segment}
              aria-pressed={w === window}
              onClick={() => onWindowChange(w)}
            >
              {w}
            </button>
          ))}
        </div>
      </div>

      {unavailableReason ? (
        <p className={styles.muted}>
          {unavailableReason} No token or spend series can be drawn, and none is invented in its place.
        </p>
      ) : loading && series === null ? (
        <p className={styles.muted} aria-busy="true">
          Loading the {WINDOW_LABEL[window].toLowerCase()} rollup…
        </p>
      ) : series === null || series.days.length === 0 ? (
        <p className={styles.muted}>
          No days in the {WINDOW_LABEL[window].toLowerCase()} rollup.
        </p>
      ) : (
        <>
          <div className={styles.tiles}>
            <StatTile
              label={`Tokens in · ${window}`}
              value={<span className={styles.num}>{chartFormat.formatCompact(totals?.tokensIn ?? 0)}</span>}
              caption={`Across ${totals?.dayCount ?? 0} recorded days`}
              trend={sparklinePoints(series, (d) => d.tokensIn)}
              trendLabel="Tokens in per day"
            />
            <StatTile
              label={`Tokens out · ${window}`}
              value={<span className={styles.num}>{chartFormat.formatCompact(totals?.tokensOut ?? 0)}</span>}
              caption="What the models actually produced"
              trend={sparklinePoints(series, (d) => d.tokensOut)}
              trendLabel="Tokens out per day"
            />
            <StatTile
              label={`Estimated spend · ${window}`}
              value={<span className={styles.num}>{chartFormat.formatUsd(totals?.estCostUsd ?? 0)}</span>}
              caption="Estimated from a static price table — not billed"
              trend={sparklinePoints(series, (d) => d.estCostUsd)}
              trendLabel="Estimated spend per day"
            />
            <StatTile
              label={`Sessions · ${window}`}
              value={<span className={styles.num}>{chartFormat.formatCompact(totals?.sessions ?? 0)}</span>}
              caption="Rollup rows, not billed calls"
              trend={sparklinePoints(series, (d) => d.sessions)}
              trendLabel="Sessions per day"
            />
            {/* Averages are per RECORDED day, never per calendar day: dividing
                by the window length would understate every figure by however
                many days the rollup has no row for. */}
            <StatTile
              label="Estimated spend per active day"
              value={
                <span className={styles.num}>
                  {averages?.estCostUsdPerDay === null || averages === null
                    ? 'unknown'
                    : chartFormat.formatUsd(averages.estCostUsdPerDay)}
                </span>
              }
              caption={`Across the ${totals?.dayCount ?? 0} days that carry a rollup row — not the ${window} calendar span`}
            />
            <StatTile
              label="Heaviest day"
              value={
                <span className={styles.num}>
                  {averages?.peakCostDay ? chartFormat.formatUsd(averages.peakCostDay.usd) : 'unknown'}
                </span>
              }
              caption={
                averages?.peakCostDay
                  ? `${chartFormat.formatDayLabel(averages.peakCostDay.day)} — estimated, not billed`
                  : 'No day in this window carries a cost row.'
              }
            />
          </div>

          <div className={styles.charts}>
            <ChartContainer
              title="Tokens per day"
              description={WINDOW_LABEL[window]}
              empty={!tokens.available}
              emptyMessage={tokens.available ? '' : tokens.reason}
              table={
                <TableView
                  caption="Tokens in and out per day"
                  columns={TOKEN_COLUMNS}
                  rows={series.days}
                  rowKey={(r) => r.day}
                />
              }
            >
              {tokens.available ? (
                <LineChart
                  series={tokens.series}
                  formatX={(x) => chartFormat.formatTimeLabel(x)}
                  formatY={(y) => chartFormat.formatCompact(y)}
                  ariaLabel={`Tokens in and out per day over ${WINDOW_LABEL[window].toLowerCase()}`}
                />
              ) : null}
            </ChartContainer>

            <ChartContainer
              title="Estimated spend per day"
              description={WINDOW_LABEL[window]}
              caveat={COST_ESTIMATE_NOTE}
              empty={!spend.available}
              emptyMessage={spend.available ? '' : spend.reason}
              table={
                <TableView
                  caption="Estimated spend per day"
                  columns={SPEND_COLUMNS}
                  rows={series.days}
                  rowKey={(r) => r.day}
                />
              }
            >
              {spend.available ? (
                <LineChart
                  series={spend.series}
                  area
                  formatX={(x) => chartFormat.formatTimeLabel(x)}
                  formatY={(y) => chartFormat.formatUsd(y)}
                  ariaLabel={`Estimated spend per day over ${WINDOW_LABEL[window].toLowerCase()}`}
                />
              ) : null}
            </ChartContainer>

            <ChartContainer
              title="Cache hit rate"
              description={WINDOW_LABEL[window]}
              caveat={CACHE_CAVEAT}
              empty={!cache.available}
              emptyMessage={cache.available ? '' : cache.reason}
              table={
                cache.available ? (
                  <TableView
                    caption="Cache hit rate per day"
                    columns={CACHE_COLUMNS}
                    rows={series.days}
                    rowKey={(r) => r.day}
                  />
                ) : undefined
              }
            >
              {cache.available ? (
                <LineChart
                  series={cache.series}
                  formatX={(x) => chartFormat.formatTimeLabel(x)}
                  formatY={(y) => chartFormat.formatPercent(y)}
                  ariaLabel={`Cache hit rate per day over ${WINDOW_LABEL[window].toLowerCase()}`}
                />
              ) : null}
            </ChartContainer>

            <ChartContainer
              title="Cache read and write tokens"
              description={WINDOW_LABEL[window]}
              caveat={CACHE_CAVEAT}
              empty={!cacheTokens.available}
              emptyMessage={cacheTokens.available ? '' : cacheTokens.reason}
              table={
                cacheTokens.available ? (
                  <TableView
                    caption="Cache read and write tokens per day"
                    columns={CACHE_TOKEN_COLUMNS}
                    rows={series.days}
                    rowKey={(r) => r.day}
                  />
                ) : undefined
              }
            >
              {cacheTokens.available ? (
                <LineChart
                  series={cacheTokens.series}
                  formatX={(x) => chartFormat.formatTimeLabel(x)}
                  formatY={(y) => chartFormat.formatCompact(y)}
                  ariaLabel={`Cache read and write tokens per day over ${WINDOW_LABEL[window].toLowerCase()}`}
                />
              ) : null}
            </ChartContainer>

            {/* The local/cloud split has no dated source. Refusing the chart
                out loud, in the place the chart would occupy, is the honest
                answer — see LOCAL_CLOUD_SERIES_UNAVAILABLE. */}
            <ChartContainer
              title="Local vs cloud per day"
              description={WINDOW_LABEL[window]}
              empty
              emptyMessage={LOCAL_CLOUD_SERIES_UNAVAILABLE}
            >
              {null}
            </ChartContainer>
          </div>

          {series.caveats.length > 0 ? (
            <ul className={styles.noteList}>
              {series.caveats.map((c) => (
                <li key={c} className={styles.capacityMuted}>
                  {c}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </section>
  );
}
