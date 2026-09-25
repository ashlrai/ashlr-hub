/**
 * routes/verse/usage/LocalCloudPanel.tsx — where the period's work actually
 * ran, and what running it locally did NOT cost.
 *
 * `localSavingsUsd` is framed as money not spent rather than as revenue or a
 * balance, because that is exactly what it is: an estimate of what the same
 * local tokens would have cost at cloud list price. The bar chart is single-
 * hue (nominal providers never get a value ramp) and ships the table twin
 * that ChartContainer expects.
 */
import type { CSSProperties, ReactNode } from 'react';
import {
  BarChart,
  ChartContainer,
  Legend,
  StatTile,
  TableView,
  chartFormat,
  seriesColor,
  type TableColumn,
} from '../../../components/charts/index.js';
import { percentText } from '../autonomy/format.js';
import { COST_ESTIMATE_NOTE } from './series-model.js';
import type { LocalCloudSplit, ProviderSlice } from './usage-model.js';
import styles from './usage.module.css';

const LOCAL_COLOR = seriesColor(0);
const CLOUD_COLOR = seriesColor(1);

const COLUMNS: TableColumn<ProviderSlice>[] = [
  { key: 'provider', label: 'Provider', render: (r) => r.provider },
  { key: 'tier', label: 'Tier', render: (r) => r.tier },
  { key: 'tokens', label: 'Tokens', numeric: true, render: (r) => chartFormat.formatCompact(r.tokens) },
  { key: 'cost', label: 'Cost', numeric: true, render: (r) => chartFormat.formatUsd(r.costUsd) },
  { key: 'share', label: 'Share', numeric: true, render: (r) => percentText(r.sharePct) },
];

function SplitRow({ label, tokens, total, color }: { label: string; tokens: number; total: number; color: string }): ReactNode {
  const share = total > 0 ? (tokens / total) * 100 : 0;
  const pct = Math.round(share);
  return (
    <div className={styles.splitRow}>
      <span>{label}</span>
      <div
        className={styles.splitBar}
        role="meter"
        aria-label={`${label} share of tokens`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className={styles.splitFill} style={{ width: `${pct}%`, '--split-color': color } as CSSProperties} />
      </div>
      <span className={styles.num}>
        {chartFormat.formatCompact(tokens)} · {percentText(share)}
      </span>
    </div>
  );
}

export function LocalCloudPanel({
  split,
  savingsNote,
}: {
  split: LocalCloudSplit;
  /**
   * The estimate disclosure for `localSavingsUsd`. It is a flat heuristic with
   * the constant inlined in control.ts, so the caption says so at the point of
   * display rather than letting a dollar figure imply a measured price.
   */
  savingsNote?: string;
}): ReactNode {
  const totalTokens = split.localTokens + split.cloudTokens;
  const chartData = split.byProvider.map((p) => ({ label: p.provider, value: p.tokens }));

  return (
    <section className={styles.panel} aria-labelledby="verse-usage-split">
      <div className={styles.panelHead}>
        <h3 id="verse-usage-split" className={styles.panelTitle}>
          Local vs cloud · {split.window}
        </h3>
      </div>

      <div className={styles.tiles}>
        <StatTile
          label="Not spent (ran locally)"
          value={<span className={styles.num}>{chartFormat.formatUsd(split.localSavingsUsd)}</span>}
          caption={`Estimated cloud list price of the ${split.window} local tokens. ${
            savingsNote ?? 'A heuristic, not a quote.'
          }`}
        />
        {/* Two things this tile used to get wrong, and both mattered.
            (1) NOT BILLED: the figure is `rollup.totals.estCostUsd` — the same
            static price-table estimate SeriesPanel labels "Estimated spend" —
            so captioning it "Billed" invited planning a month around it.
            (2) NOT CLOUD: `totalCostUsd` is the rollup total across every
            model, local included. `cloudCostUsd` is the cloud-only figure and
            is what this tile claims to show. */}
        <StatTile
          label={`Estimated cloud spend · ${split.window}`}
          value={<span className={styles.num}>{chartFormat.formatUsd(split.cloudCostUsd)}</span>}
          caption={COST_ESTIMATE_NOTE}
        />
        <StatTile
          label={`Tokens · ${split.window}`}
          value={<span className={styles.num}>{chartFormat.formatCompact(split.totalTokens)}</span>}
          caption="Local and cloud combined"
        />
      </div>

      {split.empty ? (
        <p className={styles.muted} style={{ marginTop: 'var(--space-4)' }}>
          No provider activity recorded in this window. Choose a longer window, or run a chat turn and it
          appears here.
        </p>
      ) : (
        <>
          <div className={styles.split} style={{ marginTop: 'var(--space-4)' }}>
            <SplitRow label="Local" tokens={split.localTokens} total={totalTokens} color={LOCAL_COLOR} />
            <SplitRow label="Cloud" tokens={split.cloudTokens} total={totalTokens} color={CLOUD_COLOR} />
          </div>
          <Legend
            items={[
              { label: 'Local', color: LOCAL_COLOR, kind: 'swatch' },
              { label: 'Cloud', color: CLOUD_COLOR, kind: 'swatch' },
            ]}
          />
          <ChartContainer
            title="Tokens by provider"
            description={`Share of the ${split.window} window`}
            empty={chartData.length === 0}
            emptyMessage="No provider rows in this window."
            table={
              <TableView
                caption="Tokens and cost by provider"
                columns={COLUMNS}
                rows={split.byProvider}
                rowKey={(r) => r.provider}
              />
            }
          >
            <BarChart
              data={chartData}
              orientation="horizontal"
              height={Math.max(120, chartData.length * 34)}
              formatValue={(v) => chartFormat.formatCompact(v)}
              ariaLabel={`Tokens by provider over the ${split.window} window`}
            />
          </ChartContainer>
        </>
      )}
    </section>
  );
}
