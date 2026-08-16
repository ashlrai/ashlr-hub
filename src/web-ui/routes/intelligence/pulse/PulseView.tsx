/**
 * routes/intelligence/pulse/PulseView.tsx — cost/token rollups over
 * 1d/7d/30d windows (GET /api/pulse?window=). Reference pattern followed:
 * routes/fleet-dashboard/FleetDashboardView.tsx (useQuery, status branching,
 * never blank on refresh) + DESIGN.md "Adding a new view" checklist.
 */
import { useState } from 'react';
import { pulseQuery, type PulseWindow } from '../../../data/queries.js';
import { useQuery } from '../../../data/hooks.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { StatusBadge, type Tone } from '../../../components/primitives/StatusBadge.js';
import { SkeletonCardGrid } from '../../../components/primitives/Skeleton.js';
import {
  ChartContainer,
  LineChart,
  BarChart,
  StatTile,
  TableView,
  chartFormat,
  type Series,
  type CategoricalDatum,
  type TableColumn,
} from '../../../components/charts/index.js';
import type { ActivityRollup, ProjectActivity, ModelUsage } from '../../../data/api-types.js';
import styles from './PulseView.module.css';

const WINDOWS: PulseWindow[] = ['1d', '7d', '30d'];

const BUDGET_TONE: Record<string, Tone> = { ok: 'success', warn: 'warning', over: 'danger' };

function projectLabel(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || path;
}

export function PulseView() {
  const [window, setWindow] = useState<PulseWindow>('7d');
  const query = useQuery(pulseQuery(window));

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <h1 className={styles.title}>Pulse</h1>
        <div className={styles.freshness} aria-live="polite">
          {query.status === 'refreshing' ? <RefreshIndicator /> : null}
          {query.updatedAt ? (
            <span className={styles.freshnessLabel}>Updated {formatRelative(query.updatedAt)}</span>
          ) : null}
        </div>
      </header>

      <div className={styles.filterRow} role="group" aria-label="Time window">
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
        {query.data ? <StatusBadge status={query.data.budget.level} tone={BUDGET_TONE[query.data.budget.level]}>
          {query.data.budget.message}
        </StatusBadge> : null}
      </div>

      {query.status === 'loading' ? (
        <SkeletonCardGrid count={4} />
      ) : query.status === 'error' ? (
        <div className={styles.error} role="alert">
          {query.error?.message ?? 'Failed to load pulse data.'}
        </div>
      ) : query.data ? (
        <PulseBody rollup={query.data} />
      ) : null}
    </div>
  );
}

function PulseBody({ rollup }: { rollup: ActivityRollup }) {
  const costSeries: Series[] = [
    {
      id: 'cost',
      label: 'Est. cost (USD)',
      points: rollup.byDay.map((d) => ({ x: Date.parse(`${d.day}T00:00:00Z`), y: d.estCostUsd })),
    },
  ];

  const topProjects = [...rollup.byProject]
    .sort((a, b) => b.estCostUsd - a.estCostUsd)
    .slice(0, 8);
  const projectBars: CategoricalDatum[] = topProjects.map((p) => ({
    label: projectLabel(p.project),
    value: p.estCostUsd,
  }));

  const topModels = [...rollup.byModel].sort((a, b) => b.estCostUsd - a.estCostUsd).slice(0, 8);
  const modelBars: CategoricalDatum[] = topModels.map((m) => ({ label: m.model, value: m.estCostUsd }));

  const projectColumns: TableColumn<ProjectActivity>[] = [
    { key: 'project', label: 'Project', render: (r) => projectLabel(r.project) },
    { key: 'sessions', label: 'Sessions', numeric: true, render: (r) => String(r.sessions) },
    { key: 'commits', label: 'Commits', numeric: true, render: (r) => String(r.commits) },
    { key: 'cost', label: 'Cost', numeric: true, render: (r) => chartFormat.formatUsd(r.estCostUsd) },
  ];

  const modelColumns: TableColumn<ModelUsage>[] = [
    { key: 'model', label: 'Model', render: (r) => r.model },
    { key: 'calls', label: 'Calls', numeric: true, render: (r) => String(r.calls) },
    {
      key: 'tokens',
      label: 'Tokens',
      numeric: true,
      render: (r) => chartFormat.formatCompact(r.tokensIn + r.tokensOut),
    },
    { key: 'cost', label: 'Cost', numeric: true, render: (r) => chartFormat.formatUsd(r.estCostUsd) },
  ];

  return (
    <>
      <div className={styles.kpiGrid}>
        <StatTile label="Est. cost" value={chartFormat.formatUsd(rollup.totals.estCostUsd)} caption={rollup.window} />
        <StatTile
          label="Tokens"
          value={chartFormat.formatCompact(rollup.totals.tokensIn + rollup.totals.tokensOut)}
          caption={`${chartFormat.formatCompact(rollup.totals.tokensIn)} in / ${chartFormat.formatCompact(rollup.totals.tokensOut)} out`}
        />
        <StatTile label="Sessions" value={String(rollup.totals.sessions)} />
        <StatTile label="Commits" value={String(rollup.totals.commits)} />
      </div>

      <div className={styles.chartsGrid}>
        <ChartContainer
          title="Cost over time"
          description={`since ${new Date(rollup.since).toLocaleDateString()}`}
          empty={rollup.byDay.length === 0}
          emptyMessage="No activity recorded in this window."
          table={
            <TableView
              caption="Daily cost"
              rowKey={(r) => r.day}
              rows={rollup.byDay}
              columns={[
                { key: 'day', label: 'Day', render: (r) => r.day },
                { key: 'cost', label: 'Cost', numeric: true, render: (r) => chartFormat.formatUsd(r.estCostUsd) },
                { key: 'sessions', label: 'Sessions', numeric: true, render: (r) => String(r.sessions) },
              ]}
            />
          }
        >
          <LineChart
            series={costSeries}
            area
            ariaLabel="Estimated cost over time"
            formatX={(x) => new Date(x).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            formatY={(y) => chartFormat.formatUsd(y)}
          />
        </ChartContainer>

        <ChartContainer
          title="Top projects by cost"
          empty={projectBars.length === 0}
          emptyMessage="No project activity in this window."
          table={
            <TableView caption="Cost by project" rowKey={(r) => r.project} rows={topProjects} columns={projectColumns} />
          }
        >
          <BarChart
            data={projectBars}
            orientation="horizontal"
            ariaLabel="Top projects by estimated cost"
            formatValue={(v) => chartFormat.formatUsd(v)}
          />
        </ChartContainer>

        <ChartContainer
          title="Cost by model"
          empty={modelBars.length === 0}
          emptyMessage="No model activity in this window."
          table={
            <TableView caption="Cost by model" rowKey={(r) => r.model} rows={topModels} columns={modelColumns} />
          }
        >
          <BarChart
            data={modelBars}
            ariaLabel="Cost by model"
            formatValue={(v) => chartFormat.formatUsd(v)}
          />
        </ChartContainer>
      </div>
    </>
  );
}

function formatRelative(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m ago`;
}
