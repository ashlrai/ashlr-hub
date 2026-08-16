/**
 * routes/work/runs/RunsView.tsx — dispatched goal runs (GET /api/runs).
 *
 * The audit finding this replaces: the old UI rendered all ~200 runs
 * unsorted and unfiltered with no pagination, so "show me failed runs in
 * repo X since Tuesday" was impossible without reading the whole table by
 * eye. This view adds real search, status/engine/provider filters, a date
 * floor, and sortable columns instead.
 *
 * Note on "repo X": RunState (src/core/types.ts:1968) has no structured
 * `repo` field — runs are keyed by goal text, not by repository. The search
 * box matches against `goal` (which in practice names the target
 * repo/project) rather than a fabricated repo dropdown backed by nothing.
 *
 * /api/runs is server-capped at 200 (`listRuns({limit:200})`,
 * src/core/web/api.ts:1122) — there is no cursor/offset param to page
 * beyond that, so this view filters/sorts client-side over that window and
 * says so rather than implying it can reach further back.
 */
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { runsQuery } from '../../../data/queries.js';
import { useQuery } from '../../../data/hooks.js';
import { useScrollRestore } from '../../../hooks/useScrollRestore.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { SkeletonRow } from '../../../components/primitives/Skeleton.js';
import type { RunState } from '../../../data/api-types.js';
import styles from './RunsView.module.css';

type SortKey = 'createdAt' | 'updatedAt' | 'tokens' | 'estCostUsd' | 'steps' | 'status';
type SortDir = 'asc' | 'desc';

function runTokens(run: RunState): number {
  return run.usage.tokensIn + run.usage.tokensOut;
}

function matchesSearch(run: RunState, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return run.id.toLowerCase().includes(q) || run.goal.toLowerCase().includes(q);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function RunsView() {
  const containerRef = useRef<HTMLDivElement>(null);
  useScrollRestore('/work/runs', containerRef);

  const runsResult = useQuery(runsQuery);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [engineFilter, setEngineFilter] = useState<string>('all');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [since, setSince] = useState<string>('');
  const [sortKey, setSortKey] = useState<SortKey>('createdAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const runs = useMemo(() => runsResult.data ?? [], [runsResult.data]);

  const { statuses, engines, providers } = useMemo(() => {
    const statuses = new Set<string>();
    const engines = new Set<string>();
    const providers = new Set<string>();
    for (const r of runs) {
      statuses.add(r.status);
      engines.add(r.engine);
      providers.add(r.provider);
    }
    return {
      statuses: Array.from(statuses).sort(),
      engines: Array.from(engines).sort(),
      providers: Array.from(providers).sort(),
    };
  }, [runs]);

  const sinceMs = since ? new Date(since).getTime() : null;

  const filtered = useMemo(() => {
    let rows = runs.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (engineFilter !== 'all' && r.engine !== engineFilter) return false;
      if (providerFilter !== 'all' && r.provider !== providerFilter) return false;
      if (sinceMs !== null) {
        const createdMs = new Date(r.createdAt).getTime();
        if (Number.isNaN(createdMs) || createdMs < sinceMs) return false;
      }
      if (!matchesSearch(r, search.trim())) return false;
      return true;
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
        case 'tokens':
          cmp = runTokens(a) - runTokens(b);
          break;
        case 'estCostUsd':
          cmp = a.usage.estCostUsd - b.usage.estCostUsd;
          break;
        case 'steps':
          cmp = a.steps.length - b.steps.length;
          break;
        case 'status':
          cmp = a.status.localeCompare(b.status);
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return rows;
  }, [runs, statusFilter, engineFilter, providerFilter, sinceMs, search, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
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
        <h1 className={styles.title}>Runs</h1>
        <div className={styles.freshness} aria-live="polite">
          {runsResult.status === 'refreshing' ? <RefreshIndicator /> : null}
          <span className={styles.count}>
            {filtered.length} of {runs.length} runs (server caps at 200 most recent)
          </span>
        </div>
      </header>

      <form className={styles.filters} role="search" aria-label="Filter runs" onSubmit={(e) => e.preventDefault()}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Search</span>
          <input
            type="text"
            className={styles.input}
            placeholder="goal or run id (e.g. repo/project name)"
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
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Engine</span>
          <select className={styles.select} value={engineFilter} onChange={(e) => setEngineFilter(e.target.value)}>
            <option value="all">All</option>
            {engines.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Provider</span>
          <select className={styles.select} value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)}>
            <option value="all">All</option>
            {providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Since</span>
          <input type="date" className={styles.input} value={since} onChange={(e) => setSince(e.target.value)} />
        </label>
        {(statusFilter !== 'all' || engineFilter !== 'all' || providerFilter !== 'all' || since || search) && (
          <button
            type="button"
            className={styles.clear}
            onClick={() => {
              setSearch('');
              setStatusFilter('all');
              setEngineFilter('all');
              setProviderFilter('all');
              setSince('');
            }}
          >
            Clear filters
          </button>
        )}
      </form>

      {runsResult.status === 'loading' ? (
        <div className={styles.tableWrap}>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : runsResult.status === 'error' ? (
        <div className={styles.error} role="alert">
          {runsResult.error?.message ?? 'Failed to load runs.'}
        </div>
      ) : filtered.length === 0 ? (
        <p className={styles.empty}>No runs match the current filters.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Goal</th>
                <th scope="col">
                  <button type="button" className={styles.sortHeader} onClick={() => toggleSort('status')}>
                    Status{sortIndicator('status')}
                  </button>
                </th>
                <th scope="col">Engine</th>
                <th scope="col">Provider</th>
                <th scope="col">
                  <button type="button" className={styles.sortHeader} onClick={() => toggleSort('tokens')}>
                    Tokens in/out{sortIndicator('tokens')}
                  </button>
                </th>
                <th scope="col">
                  <button type="button" className={styles.sortHeader} onClick={() => toggleSort('estCostUsd')}>
                    Est cost{sortIndicator('estCostUsd')}
                  </button>
                </th>
                <th scope="col">
                  <button type="button" className={styles.sortHeader} onClick={() => toggleSort('steps')}>
                    Steps{sortIndicator('steps')}
                  </button>
                </th>
                <th scope="col">
                  <button type="button" className={styles.sortHeader} onClick={() => toggleSort('createdAt')}>
                    Created{sortIndicator('createdAt')}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((run) => (
                <tr key={run.id}>
                  <td className={styles.goalCell}>
                    <Link to={`/work/runs/${run.id}`} data-focus-key={`run-${run.id}`} className={styles.goalLink}>
                      {run.goal}
                    </Link>
                  </td>
                  <td>
                    <StatusBadge status={run.status} />
                  </td>
                  <td>{run.engine}</td>
                  <td>{run.provider}</td>
                  <td className={styles.numeric}>
                    {run.usage.tokensIn.toLocaleString()} / {run.usage.tokensOut.toLocaleString()}
                  </td>
                  <td className={styles.numeric}>${run.usage.estCostUsd.toFixed(4)}</td>
                  <td className={styles.numeric}>{run.steps.length}</td>
                  <td className={styles.date}>{formatDate(run.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
