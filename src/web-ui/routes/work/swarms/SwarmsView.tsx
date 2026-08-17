/**
 * routes/work/swarms/SwarmsView.tsx — multi-task DAG runs (GET /api/swarms).
 * List view with the same search/filter/sort treatment as RunsView, plus a
 * compact per-row burndown bar (ported convention from
 * routes/fleet-dashboard/SwarmsPanel.tsx). The full DAG lives on the detail
 * view (SwarmDetailView.tsx) — a list of up to 200 rows isn't the place for
 * one SVG diagram per row.
 */
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { swarmsQuery } from '../../../data/queries.js';
import { useQuery } from '../../../data/hooks.js';
import { useScrollRestore } from '../../../hooks/useScrollRestore.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { SkeletonRow } from '../../../components/primitives/Skeleton.js';
import type { SwarmRun } from '../../../data/api-types.js';
import styles from './SwarmsView.module.css';

type SortKey = 'createdAt' | 'updatedAt' | 'progress' | 'tokens' | 'estCostUsd';
type SortDir = 'asc' | 'desc';

function swarmTasksDone(sw: SwarmRun): number {
  return sw.tasks.filter((t) => t.status === 'done').length;
}
function swarmTasksTotal(sw: SwarmRun): number {
  // Some historical swarm records (e.g. very early smoke-test runs) predate
  // the `plan` field and have no plan at all — guard against that rather
  // than crashing the whole list (2 of 80 real records on this machine hit
  // this path).
  return Math.max(sw.plan?.tasks.length ?? 0, sw.tasks.length);
}
// Same historical records that predate `plan` (see swarmTasksTotal above)
// also predate `usage` — default to zeroed usage rather than crashing.
function swarmUsage(sw: SwarmRun): { tokensIn: number; tokensOut: number; estCostUsd: number } {
  return sw.usage ?? { tokensIn: 0, tokensOut: 0, estCostUsd: 0 };
}
function swarmTokens(sw: SwarmRun): number {
  const u = swarmUsage(sw);
  return u.tokensIn + u.tokensOut;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function SwarmsView() {
  const containerRef = useRef<HTMLDivElement>(null);
  useScrollRestore('/work/swarms', containerRef);

  const swarmsResult = useQuery(swarmsQuery);
  const swarms = useMemo(() => swarmsResult.data ?? [], [swarmsResult.data]);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortKey, setSortKey] = useState<SortKey>('createdAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const statuses = useMemo(() => Array.from(new Set(swarms.map((s) => s.status))).sort(), [swarms]);

  const filtered = useMemo(() => {
    let rows = swarms.filter((s) => {
      if (statusFilter !== 'all' && s.status !== statusFilter) return false;
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      return s.id.toLowerCase().includes(q) || s.goal.toLowerCase().includes(q);
    });

    rows = [...rows].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'createdAt':
          cmp = a.createdAt.localeCompare(b.createdAt);
          break;
        case 'updatedAt':
          cmp = a.updatedAt.localeCompare(b.updatedAt);
          break;
        case 'progress': {
          const pa = swarmTasksTotal(a) > 0 ? swarmTasksDone(a) / swarmTasksTotal(a) : 0;
          const pb = swarmTasksTotal(b) > 0 ? swarmTasksDone(b) / swarmTasksTotal(b) : 0;
          cmp = pa - pb;
          break;
        }
        case 'tokens':
          cmp = swarmTokens(a) - swarmTokens(b);
          break;
        case 'estCostUsd':
          cmp = swarmUsage(a).estCostUsd - swarmUsage(b).estCostUsd;
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return rows;
  }, [swarms, statusFilter, search, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('desc');
    }
  }
  function sortIndicator(key: SortKey): string {
    if (key !== sortKey) return '';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  }

  return (
    <div ref={containerRef} className={styles.view}>
      <header className={styles.header}>
        <h1 className={styles.title}>Swarms</h1>
        <div className={styles.freshness} aria-live="polite">
          {swarmsResult.status === 'refreshing' ? <RefreshIndicator /> : null}
          <span className={styles.count}>
            {filtered.length} of {swarms.length} swarms
          </span>
        </div>
      </header>

      <form className={styles.filters} role="search" aria-label="Filter swarms" onSubmit={(e) => e.preventDefault()}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Search</span>
          <input
            type="text"
            className={styles.input}
            placeholder="goal or swarm id"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Status</span>
          <select className={styles.select} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </form>

      {swarmsResult.status === 'loading' ? (
        <div className={styles.listWrap}>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : swarmsResult.status === 'error' ? (
        <div className={styles.error} role="alert">
          {swarmsResult.error?.message ?? 'Failed to load swarms.'}
        </div>
      ) : filtered.length === 0 ? (
        <p className={styles.empty}>No swarms match the current filters.</p>
      ) : (
        <div className={styles.listWrap}>
          <div className={styles.listHeader}>
            <span>Goal</span>
            <button type="button" className={styles.sortHeader} onClick={() => toggleSort('progress')}>
              Progress{sortIndicator('progress')}
            </button>
            <button type="button" className={styles.sortHeader} onClick={() => toggleSort('tokens')}>
              Tokens{sortIndicator('tokens')}
            </button>
            <button type="button" className={styles.sortHeader} onClick={() => toggleSort('estCostUsd')}>
              Cost{sortIndicator('estCostUsd')}
            </button>
            <button type="button" className={styles.sortHeader} onClick={() => toggleSort('createdAt')}>
              Created{sortIndicator('createdAt')}
            </button>
          </div>
          <ul className={styles.list}>
            {filtered.map((sw) => {
              const done = swarmTasksDone(sw);
              const total = swarmTasksTotal(sw);
              const pct = total > 0 ? Math.round((done / total) * 100) : 0;
              const usage = swarmUsage(sw);
              return (
                <li key={sw.id} className={styles.item}>
                  <Link
                    to={`/work/swarms/${sw.id}`}
                    data-focus-key={`swarm-${sw.id}`}
                    className={styles.goalLink}
                    title={sw.goal}
                  >
                    <span className={styles.goalText}>{sw.goal}</span>
                    <StatusBadge status={sw.status} />
                  </Link>
                  <div className={styles.burndown}>
                    <div className={styles.burndownTrack}>
                      <div className={styles.burndownFill} style={{ width: `${pct}%` }} />
                    </div>
                    <span className={styles.burndownLabel}>
                      {done}/{total}
                    </span>
                  </div>
                  <span className={styles.numeric}>
                    {usage.tokensIn.toLocaleString()}/{usage.tokensOut.toLocaleString()}
                  </span>
                  <span className={styles.numeric}>${usage.estCostUsd.toFixed(4)}</span>
                  <span className={styles.date}>{formatDate(sw.createdAt)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
