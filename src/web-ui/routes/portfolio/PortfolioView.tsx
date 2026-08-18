/**
 * routes/portfolio/PortfolioView.tsx — org-level roll-up across enrolled
 * repos (GET /api/portfolio -> DashboardSnapshot.portfolio ?? null). `null`
 * is a legitimate, non-error response (older producer or empty enrollment)
 * and is rendered as an honest "not available" state, never as a zeroed
 * chart pretending to be real data.
 */
import { dashboardSnapshotQuery, portfolioQuery } from '../../data/queries.js';
import { useQuery } from '../../data/hooks.js';
import { RefreshIndicator } from '../../components/primitives/RefreshIndicator.js';
import { SkeletonCardGrid } from '../../components/primitives/Skeleton.js';
import {
  ChartContainer,
  BarChart,
  StatTile,
  TableView,
  chartFormat,
  type CategoricalDatum,
  type TableColumn,
} from '../../components/charts/index.js';
import type {
  PortfolioBacklogItem,
  PortfolioGoalInFlight,
  PortfolioSummary,
} from '../../data/api-types.js';
import styles from './PortfolioView.module.css';

function formatRelative(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m ago`;
}

export function PortfolioView() {
  const query = useQuery(portfolioQuery);
  // Today-deltas are computed against a prior digest and live on the same
  // portfolio payload, but the digest itself is built server-side once a
  // day; the snapshot query keeps this view's freshness indicator honest
  // relative to the rest of the app even though portfolioQuery has no SSE
  // channel of its own.
  const snapshotQuery = useQuery(dashboardSnapshotQuery);

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <h1 className={styles.title}>Portfolio</h1>
        <div className={styles.freshness} aria-live="polite">
          {query.status === 'refreshing' || snapshotQuery.status === 'refreshing' ? <RefreshIndicator /> : null}
          {query.updatedAt ? <span className={styles.freshnessLabel}>Updated {formatRelative(query.updatedAt)}</span> : null}
        </div>
      </header>

      {query.status === 'loading' ? (
        <SkeletonCardGrid count={6} />
      ) : query.status === 'error' ? (
        <div className={styles.error} role="alert">
          {query.error?.message ?? 'Failed to load portfolio.'}
        </div>
      ) : query.data === null ? (
        <p className={styles.notAvailable}>
          No portfolio roll-up available — either this server has no enrolled repos, or it predates the portfolio
          feature.
        </p>
      ) : query.data ? (
        <PortfolioBody portfolio={query.data} />
      ) : null}
    </div>
  );
}

function PortfolioBody({ portfolio }: { portfolio: PortfolioSummary }) {
  const { health, goalsInFlight, backlogTop, cost, effectiveness, today } = portfolio;

  const worstRepoBars: CategoricalDatum[] = health.worstRepos.map((r) => ({
    label: r.repo.split('/').filter(Boolean).pop() ?? r.repo,
    value: r.score,
  }));

  const backlogColumns: TableColumn<PortfolioBacklogItem>[] = [
    { key: 'title', label: 'Item', render: (r) => r.title },
    { key: 'repo', label: 'Repo', render: (r) => r.repo ?? '—' },
    { key: 'score', label: 'Score', numeric: true, render: (r) => r.score.toFixed(1) },
  ];

  return (
    <>
      <div className={styles.kpiGrid}>
        <StatTile
          label="Portfolio health"
          value={`${health.averageScore.toFixed(0)} (${health.averageGrade})`}
          caption={`${health.reposScored} repos scored`}
          delta={
            today.healthScoreDelta !== null ? { value: today.healthScoreDelta, goodWhenPositive: true } : null
          }
        />
        <StatTile label="Goals in flight" value={String(goalsInFlight.length)} />
        <StatTile
          label="Backlog top items"
          value={String(backlogTop.length)}
          delta={
            today.pendingProposalsDelta !== null
              ? { value: today.pendingProposalsDelta, versus: 'pending proposals' }
              : null
          }
        />
        <StatTile
          label="Spend"
          value={chartFormat.formatUsd(cost.spentUsd)}
          caption={`${cost.window} window`}
          delta={today.spendUsdDelta !== null ? { value: today.spendUsdDelta, goodWhenPositive: false } : null}
        />
        <StatTile label="Local savings" value={chartFormat.formatUsd(cost.localSavingsUsd)} />
        <StatTile label="Projected monthly" value={chartFormat.formatUsd(cost.projectedMonthlyUsd)} />
      </div>

      {effectiveness ? (
        <div className={styles.effectiveness}>
          <p className={styles.effectivenessHeadline}>{effectiveness.headline}</p>
          <span className={styles.rowMeta}>
            Success rate {chartFormat.formatPercent(effectiveness.successRate)}
            {effectiveness.effectivenessDeltaPct !== null
              ? ` (${effectiveness.effectivenessDeltaPct >= 0 ? '+' : ''}${effectiveness.effectivenessDeltaPct.toFixed(1)}pp)`
              : ''}
          </span>
        </div>
      ) : null}

      <div className={styles.chartsGrid}>
        <ChartContainer
          title="Worst-scoring repos"
          empty={worstRepoBars.length === 0}
          emptyMessage="No enrolled repos scored yet."
          table={
            <TableView
              caption="Worst-scoring repos"
              rowKey={(r) => r.repo}
              rows={health.worstRepos}
              columns={[
                { key: 'repo', label: 'Repo', render: (r) => r.repo },
                { key: 'score', label: 'Score', numeric: true, render: (r) => r.score.toFixed(0) },
                { key: 'grade', label: 'Grade', render: (r) => r.grade },
              ]}
            />
          }
        >
          <BarChart
            data={worstRepoBars}
            orientation="horizontal"
            ariaLabel="Worst-scoring repos by health score"
            formatValue={(v) => v.toFixed(0)}
          />
        </ChartContainer>

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>In-flight goals</h2>
          {goalsInFlight.length === 0 ? (
            <p className={styles.notAvailable}>No goals currently in flight.</p>
          ) : (
            <ul className={styles.list}>
              {goalsInFlight.map((g: PortfolioGoalInFlight) => (
                <li key={g.goalId} className={styles.row}>
                  <span className={styles.rowTitle}>
                    {g.objective}
                    <span className={styles.rowMeta}>{Math.round(g.fractionDone * 100)}%</span>
                  </span>
                  <div className={styles.meterTrack}>
                    <div className={styles.meterFill} style={{ width: `${Math.round(g.fractionDone * 100)}%` }} />
                  </div>
                  <span className={styles.rowMeta}>
                    {g.nextActionable ? `Next: ${g.nextActionable}` : 'Nothing actionable queued'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Top backlog</h2>
        {backlogTop.length === 0 ? (
          <p className={styles.notAvailable}>Backlog is empty.</p>
        ) : (
          <TableView caption="Top backlog items" rowKey={(r) => r.title} rows={backlogTop} columns={backlogColumns} />
        )}
      </div>
    </>
  );
}
