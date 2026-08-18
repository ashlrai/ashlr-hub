/**
 * routes/intelligence/production/ProductionView.tsx — ships-per-day, judge
 * verdict breakdown, auto-merges (DashboardSnapshot.production via
 * GET /api/snapshot) + per-model ship rate / cost-per-merge / best-of-N wins
 * (GET /api/models?window=).
 *
 * Source-backed production truth: every persisted aggregate is rendered
 * through its corresponding source-quality contract.
 * ProductionSummary.judgeVerdicts24h is built from JudgeTrace, whose
 * `verdict` field is strictly 'ship'|'review'|'noise'|'harmful' — a
 * judge-parse-failure/judge-network-failure (manager.ts's judgeProposal()
 * fallback, ~line 611-626) sets `verdict: 'review'` because that's the
 * fail-closed choice for the AUTO-REJECT gate, and nothing downstream of
 * that field currently re-splits it. The recent fix (commit 5db524aa) tags
 * the distinction correctly in the decisions ledger's `judgeReasonCode`
 * ('judge-parse-failure' / 'judge-network-failure', see
 * judge-decision-metadata.ts) for LEARNING purposes, but that tag isn't
 * propagated into JudgeTrace or ProductionSummary, the only judge-verdict
 * aggregate exposed via any GET route today. Per this build's scope
 * (src/core/dashboard.ts and src/core/web/api.ts are off-limits), this view
 * cannot re-derive the split client-side — so it discloses the gap instead
 * of pretending the 'review' bucket is clean. Flagged separately for a
 * backend follow-up (add parse/network counts to ProductionSummary).
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
import type { ModelStats, ProductionSummary } from '../../../data/api-types.js';
import styles from './ProductionView.module.css';

const WINDOWS: ModelStatsWindow[] = ['7d', '30d', 'all'];

function engineModelLabel(m: ModelStats): string {
  return `${m.engine}:${m.model}`;
}

export function ProductionView() {
  const [window, setWindow] = useState<ModelStatsWindow>('30d');
  const snapshotQuery = useQuery(dashboardSnapshotQuery);
  const modelsResult = useQuery(modelsQuery(window));

  const production = snapshotQuery.data?.production;

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

function ProductionSection({ production }: { production: ProductionSummary }) {
  const jv = production.judgeVerdicts24h;
  const judgeFailures = production.judgeFailures24h ?? { total: 0, parse: 0, network: 0 };
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
  const proposalsKnown = isKnown(production.proposalSourceQuality);
  const verdictsKnown = isKnown(production.judgeTraceSourceQuality);

  return (
    <>
      <div className={styles.kpiGrid}>
        <StatTile
          label="Proposals (24h)"
          value={<Epistemic quality={production.proposalSourceQuality} label="proposals">{String(production.proposals24h.total)}</Epistemic>}
          caption={<Epistemic quality={production.proposalSourceQuality} label="pending proposals">{`${production.proposals24h.pending} pending`}</Epistemic>}
        />
        <StatTile label="Auto-merges today" value={<Epistemic quality={production.proposalSourceQuality} label="auto-merges">{String(production.autoMergesToday.count)}</Epistemic>} />
        <StatTile label="Judged (24h)" value={<Epistemic quality={production.judgeTraceSourceQuality} label="judge verdicts">{String(jv.total)}</Epistemic>} />
        <StatTile label="Judge failures (24h)" value={<Epistemic quality={production.judgeFailureSourceQuality} label="judge failures">{String(judgeFailures.total)}</Epistemic>} caption={<Epistemic quality={production.judgeFailureSourceQuality}>{`${judgeFailures.parse} parse · ${judgeFailures.network} network`}</Epistemic>} />
        <StatTile label="Active goals" value={<Epistemic quality={production.activeGoalsSourceQuality} label="active goals">{String(production.activeGoals.length)}</Epistemic>} />
      </div>

      <div className={styles.chartsGrid}>
        <ChartContainer
          title="Ships per day"
          description="last 7 days"
          empty={proposalsKnown && shipTrend.length === 0}
          emptyMessage="No ship history recorded yet."
          table={proposalsKnown ? (
            <TableView
              caption="Ships per day"
              rowKey={(r) => r.label}
              rows={shipTrend}
              columns={[
                { key: 'day', label: 'Day', render: (r) => r.label },
                { key: 'count', label: 'Ships', numeric: true, render: (r) => String(r.value ?? 0) },
              ]}
            />
          ) : undefined}
        >
          {!proposalsKnown ? (
            <Epistemic quality={production.proposalSourceQuality} label="ship history">ship history</Epistemic>
          ) : totalShipped === 0 ? (
            <p className={styles.notAvailable}>
              0 ships in the last 7 days — this is the real number, not a loading state.
            </p>
          ) : null}
          {proposalsKnown ? <BarChart data={shipTrend} ariaLabel="Ships per day, last 7 days" formatValue={(v) => String(v)} /> : null}
        </ChartContainer>

        <ChartContainer
          title="Judge verdict breakdown"
          description="last 24h"
          empty={verdictsKnown && jv.total === 0}
          emptyMessage="No judge verdicts recorded in the last 24h."
        >
          {verdictsKnown
            ? <BarChart data={verdictBars} ariaLabel="Judge verdict breakdown, last 24h" formatValue={(v) => String(v)} />
            : <Epistemic quality={production.judgeTraceSourceQuality} label="judge verdicts">judge verdicts</Epistemic>}
        </ChartContainer>
      </div>

      {!isKnown(production.activeGoalsSourceQuality) ? (
        <div className={styles.section}><h2 className={styles.sectionTitle}>Active goals</h2><Epistemic quality={production.activeGoalsSourceQuality} label="active goals">active goals</Epistemic></div>
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
        description="judged proposals in the selected window"
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
