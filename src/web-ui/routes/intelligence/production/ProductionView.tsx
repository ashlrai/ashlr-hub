/**
 * routes/intelligence/production/ProductionView.tsx — ships-per-day, judge
 * verdict breakdown, auto-merges (DashboardSnapshot.production via
 * GET /api/snapshot) + per-model ship rate / cost-per-merge / best-of-N wins
 * (GET /api/models?window=).
 *
 * M331: previously-disclosed data gap NOW CLOSED. ProductionSummary.judgeVerdicts24h
 * is still built from JudgeTrace, whose `verdict` field is strictly
 * 'ship'|'review'|'noise'|'harmful' — a judge-parse-failure/judge-network-failure
 * (manager.ts's judgeProposal() fallback) sets `verdict: 'review'` because
 * that's the fail-closed choice for the AUTO-REJECT gate, and JudgeTrace
 * itself still can't re-split it. But the backend now ALSO exposes
 * `judgeFailures24h` (sourced from the decisions ledger's distinct
 * `judgeReasonCode`, not JudgeTrace) plus `judgeTraceSourceQuality` /
 * `judgeFailureSourceQuality` / `activeGoalsSourceQuality` on
 * DashboardProductionSummary (dashboard.ts). Judge failures are rendered
 * here as their own KPI tile — visually distinct from the verdict-breakdown
 * chart, never folded into 'review' — and every source-quality-bearing
 * number is wrapped in <Epistemic> so a degraded/incomplete backend read
 * shows "unknown", never a false zero.
 */
import { useState } from 'react';
import { dashboardSnapshotQuery, modelsQuery, type ModelStatsWindow } from '../../../data/queries.js';
import { useQuery } from '../../../data/hooks.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { Epistemic, isKnown } from '../../../components/primitives/Epistemic.js';
import { SkeletonCardGrid } from '../../../components/primitives/Skeleton.js';
import {
  ChartContainer,
  BarChart,
  StatTile,
  TableView,
  chartFormat,
  type CategoricalDatum,
  type TableColumn,
} from '../../../components/charts/index.js';
import type { ModelStats, DashboardProductionSummary } from '../../../data/api-types.js';
import styles from './ProductionView.module.css';

const WINDOWS: ModelStatsWindow[] = ['7d', '30d', 'all'];

function engineModelLabel(m: ModelStats): string {
  return `${m.engine}:${m.model}`;
}

export function ProductionView() {
  const [window, setWindow] = useState<ModelStatsWindow>('30d');
  const snapshotQuery = useQuery(dashboardSnapshotQuery);
  const modelsResult = useQuery(modelsQuery(window));

  // DashboardSnapshot types `.production` as the base ProductionSummary
  // (see the api-types.ts note on DashboardProductionSummary), but
  // buildSnapshot() always returns the richer DashboardProductionSummary
  // shape at runtime — this cast just recovers that at the type level.
  const production = snapshotQuery.data?.production as DashboardProductionSummary | undefined;

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <h1 className={styles.title}>Production</h1>
        <div aria-live="polite">
          {snapshotQuery.status === 'refreshing' || modelsResult.status === 'refreshing' ? (
            <RefreshIndicator />
          ) : null}
        </div>
      </header>

      {snapshotQuery.status === 'loading' ? (
        <SkeletonCardGrid count={4} />
      ) : snapshotQuery.status === 'error' ? (
        <div className={styles.error} role="alert">
          {snapshotQuery.error?.message ?? 'Failed to load production summary.'}
        </div>
      ) : !production ? (
        <p className={styles.notAvailable}>
          Production summary not available on this server (older producer, or not yet populated).
        </p>
      ) : (
        <ProductionSection production={production} />
      )}

      <div className={styles.filterRow} role="group" aria-label="Model stats window">
        <div className={styles.windowGroup}>
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              className={`${styles.windowButton} ${w === window ? styles.windowButtonActive : ''}`}
              aria-pressed={w === window}
              onClick={() => setWindow(w)}
            >
              {w}
            </button>
          ))}
        </div>
      </div>

      {modelsResult.status === 'loading' ? (
        <SkeletonCardGrid count={3} />
      ) : modelsResult.status === 'error' ? (
        <div className={styles.error} role="alert">
          {modelsResult.error?.message ?? 'Failed to load per-model stats.'}
        </div>
      ) : modelsResult.data ? (
        <ModelStatsSection result={modelsResult.data} />
      ) : null}
    </div>
  );
}

function ProductionSection({ production }: { production: DashboardProductionSummary }) {
  const jv = production.judgeVerdicts24h;
  const jf = production.judgeFailures24h;
  const verdictBars: CategoricalDatum[] = [
    { label: 'ship', value: jv.ship },
    { label: 'review', value: jv.review },
    { label: 'noise', value: jv.noise },
    { label: 'harmful', value: jv.harmful },
  ];
  const shipTrend: CategoricalDatum[] = production.shipsPerDayTrend.map((d) => ({
    label: chartFormat.formatDayLabel(d.date),
    value: d.count,
  }));
  const totalShipped = production.shipsPerDayTrend.reduce((sum, d) => sum + d.count, 0);

  const judgeTraceKnown = isKnown(production.judgeTraceSourceQuality as never);
  const judgeFailureKnown = isKnown(production.judgeFailureSourceQuality as never);
  const goalsKnown = isKnown(production.activeGoalsSourceQuality as never);

  return (
    <>
      <div className={styles.kpiGrid}>
        <StatTile
          label="Proposals (24h)"
          value={String(production.proposals24h.total)}
          caption={`${production.proposals24h.pending} pending`}
        />
        <StatTile label="Auto-merges today" value={String(production.autoMergesToday.count)} />
        <StatTile
          label="Judged (24h)"
          value={
            <Epistemic quality={production.judgeTraceSourceQuality as never} label="judged (24h)">
              {String(jv.total)}
            </Epistemic>
          }
        />
        <StatTile
          label="Active goals"
          value={
            <Epistemic quality={production.activeGoalsSourceQuality as never} label="active goals">
              {String(production.activeGoals.length)}
            </Epistemic>
          }
        />
        {/*
         * Judge failures are infrastructure faults (parse/network), not
         * judgments — kept as their own KPI tile rather than folded into the
         * verdict breakdown below, so a spike here reads as "the judge is
         * unreachable/misbehaving" and never as "proposals are being reviewed."
         */}
        <StatTile
          label="Judge failures (24h)"
          value={
            <Epistemic quality={production.judgeFailureSourceQuality as never} label="judge failures (24h)">
              {String(jf.total)}
            </Epistemic>
          }
          caption={
            judgeFailureKnown
              ? `${jf.parse} parse · ${jf.network} network — infra faults, not judgments`
              : 'source degraded — count unknown, not confirmed zero'
          }
        />
      </div>

      <div className={styles.chartsGrid}>
        <ChartContainer
          title="Ships per day"
          description="last 7 days"
          empty={shipTrend.length === 0}
          emptyMessage="No ship history recorded yet."
          table={
            <TableView
              caption="Ships per day"
              rowKey={(r) => r.label}
              rows={shipTrend}
              columns={[
                { key: 'day', label: 'Day', render: (r) => r.label },
                { key: 'count', label: 'Ships', numeric: true, render: (r) => String(r.value ?? 0) },
              ]}
            />
          }
        >
          {totalShipped === 0 ? (
            <p className={styles.notAvailable}>
              0 ships in the last 7 days — this is the real number, not a loading state.
            </p>
          ) : null}
          <BarChart data={shipTrend} ariaLabel="Ships per day, last 7 days" formatValue={(v) => String(v)} />
        </ChartContainer>

        <ChartContainer
          title="Judge verdict breakdown"
          description="last 24h"
          caveat="A judge-parse-failure or judge-network-failure fallback records verdict='review' upstream (manager.ts's fail-closed default), so 'review' here may still include a small number of infrastructure faults alongside genuine human-review holds — but every failure is now counted precisely in the separate 'Judge failures (24h)' tile above, sourced from the decisions ledger rather than this chart's verdict trace."
          empty={!judgeTraceKnown || jv.total === 0}
          emptyMessage={
            judgeTraceKnown
              ? 'No judge verdicts recorded in the last 24h.'
              : 'Judge-trace source is degraded or incomplete — counts unknown, not confirmed zero.'
          }
        >
          {judgeTraceKnown ? (
            <BarChart data={verdictBars} ariaLabel="Judge verdict breakdown, last 24h" formatValue={(v) => String(v)} />
          ) : null}
        </ChartContainer>
      </div>

      {!goalsKnown ? (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Active goals</h2>
          <Epistemic quality={production.activeGoalsSourceQuality as never} label="active goals">
            {null}
          </Epistemic>
        </div>
      ) : production.activeGoals.length > 0 ? (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Active goals</h2>
          <ul className={styles.goalsList}>
            {production.activeGoals.map((g) => {
              const fraction = g.totalMilestones > 0 ? g.doneMilestones / g.totalMilestones : 0;
              return (
                <li key={g.goalId} className={styles.goalRow}>
                  <span className={styles.goalObjective}>{g.objective}</span>
                  <div className={styles.meterTrack}>
                    <div className={styles.meterFill} style={{ width: `${Math.round(fraction * 100)}%` }} />
                  </div>
                  <span className={styles.goalMeta}>
                    {g.doneMilestones} / {g.totalMilestones} milestones
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function ModelStatsSection({ result }: { result: { models: ModelStats[]; bestOfNSource: unknown } }) {
  const models = [...result.models].sort((a, b) => b.dispatches - a.dispatches).slice(0, 12);
  const shipRateBars: CategoricalDatum[] = models.map((m) => ({
    label: engineModelLabel(m),
    value: m.judged > 0 ? m.shipRate : null,
  }));

  const columns: TableColumn<ModelStats>[] = [
    { key: 'model', label: 'Model', render: (r) => engineModelLabel(r) },
    { key: 'dispatches', label: 'Dispatches', numeric: true, render: (r) => String(r.dispatches) },
    {
      key: 'shipRate',
      label: 'Ship rate',
      numeric: true,
      render: (r) => (r.judged > 0 ? chartFormat.formatPercent(r.shipRate) : '—'),
    },
    { key: 'merged', label: 'Merged', numeric: true, render: (r) => String(r.merged) },
    {
      key: 'costPerMerged',
      label: 'Cost / merge',
      numeric: true,
      render: (r) => (r.costPerMergedUsd !== null ? chartFormat.formatUsd(r.costPerMergedUsd) : '—'),
    },
    {
      key: 'bestOfN',
      label: 'Best-of-N win rate',
      numeric: true,
      render: (r) =>
        r.bestOfNAvailable ? (
          <Epistemic quality={result.bestOfNSource as never} label="best-of-N win rate">
            {chartFormat.formatPercent(r.bestOfN.winRate)}
          </Epistemic>
        ) : (
          '—'
        ),
    },
  ];

  return (
    <div className={styles.chartsGrid}>
      <ChartContainer
        title="Ship rate by model"
        description="judged proposals only; 672 proposals / 0 merged historically means this can legitimately read 0%"
        empty={models.length === 0}
        emptyMessage="No dispatch history for this window."
        table={<TableView caption="Per-model economics" rowKey={engineModelLabel} rows={models} columns={columns} />}
      >
        <BarChart
          data={shipRateBars}
          ariaLabel="Ship rate by model"
          formatValue={(v) => chartFormat.formatPercent(v)}
        />
      </ChartContainer>
    </div>
  );
}
