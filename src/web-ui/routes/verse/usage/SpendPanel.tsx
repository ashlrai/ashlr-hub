/**
 * routes/verse/usage/SpendPanel.tsx — spend today and, when the data supports
 * one, spend per day.
 *
 * The only dated spend history any of this section's sources carries is the
 * daemon tick ledger. It is real but partial, so it renders with its caveat
 * attached and with gaps left as gaps. When it cannot support a trend the
 * panel says the series is unavailable and shows the aggregate — it never
 * draws a flat line out of one data point.
 */
import type { ReactNode } from 'react';
import { ChartContainer, LineChart, StatTile, TableView, chartFormat, type TableColumn } from '../../../components/charts/index.js';
import { isCurrentLedgerDay } from '../autonomy/format.js';
import type { SpendDay, SpendSeries } from './usage-model.js';
import styles from './usage.module.css';

const COLUMNS: TableColumn<SpendDay>[] = [
  { key: 'day', label: 'Day', render: (r) => chartFormat.formatDayLabel(r.day) },
  {
    key: 'usd',
    label: 'Spend',
    numeric: true,
    render: (r) => (r.usd === null ? 'no tick retained' : chartFormat.formatUsd(r.usd)),
  },
];

export function SpendPanel({
  series,
  todaySpentUsd,
  todaySpentDate,
  dailyBudgetUsd,
  showSeries = true,
}: {
  series: SpendSeries;
  todaySpentUsd: number | null;
  /**
   * The ledger day `todaySpentUsd` belongs to, or null when the source has
   * none. The daemon writes the figure once a day and leaves it, so a
   * `todaySpentDate` that is not the viewer's local today says nothing about
   * today and must not be rendered under that word (DESIGN-V2 §6: unknown is
   * not blank and not zero).
   */
  todaySpentDate: string | null;
  dailyBudgetUsd: number | null;
  /**
   * False when the real per-day series (GET /api/verse/usage-series) is on
   * screen already. The daemon tick ledger covers the autonomous loop only and
   * is capped, so next to the full rollup it is a narrower second line about
   * the same money — worth keeping as the fallback, not worth double-drawing.
   */
  showSeries?: boolean;
}): ReactNode {
  const stale = todaySpentDate !== null && !isCurrentLedgerDay(todaySpentDate);
  const spentToday = stale ? null : todaySpentUsd;
  const budgetCaption = stale
    ? `Nothing recorded today — the last ledger day is ${chartFormat.formatDayLabel(todaySpentDate)}`
    : dailyBudgetUsd === null
      ? 'Configured daily budget unavailable'
      : dailyBudgetUsd === 0
        ? 'Daily budget is 0 — the loop is stopped'
        : `of a ${chartFormat.formatUsd(dailyBudgetUsd)} daily budget`;

  return (
    <section className={styles.panel} aria-labelledby="verse-usage-spend">
      <div className={styles.panelHead}>
        <h3 id="verse-usage-spend" className={styles.panelTitle}>
          Spend
        </h3>
      </div>

      <div className={styles.tiles}>
        <StatTile
          label="Spend today"
          value={
            <span className={styles.num}>
              {spentToday === null ? 'unknown' : chartFormat.formatUsd(spentToday)}
            </span>
          }
          caption={budgetCaption}
        />
      </div>

      {!showSeries ? (
        <p className={styles.sourceLine}>
          Per-day spend is charted above from the full usage rollup. The daemon tick ledger is not
          drawn again here.
        </p>
      ) : (
      <div style={{ marginTop: 'var(--space-4)' }}>
        {series.available ? (
          <ChartContainer
            title="Spend per day"
            description="Autonomous loop, from the daemon tick ledger"
            caveat={series.caveat}
            table={
              <TableView
                caption="Spend per day from the daemon tick ledger"
                columns={COLUMNS}
                rows={series.days}
                rowKey={(r) => r.day}
              />
            }
          >
            <LineChart
              series={[
                {
                  id: 'spend',
                  label: 'Spend',
                  points: series.days.map((d) => ({ x: Date.parse(`${d.day}T00:00:00Z`), y: d.usd })),
                },
              ]}
              area
              formatX={(x) => chartFormat.formatTimeLabel(x)}
              formatY={(y) => chartFormat.formatUsd(y)}
              ariaLabel="Autonomous loop spend per day"
            />
          </ChartContainer>
        ) : (
          <ChartContainer title="Spend per day" empty emptyMessage={series.reason}>
            {null}
          </ChartContainer>
        )}
      </div>
      )}
    </section>
  );
}
