/**
 * routes/control/security/SecurityView.tsx — supply-chain / binshield
 * findings by severity (GET /api/control's `.security`, built by
 * `buildSecurity()` in src/core/web/control.ts:528-569, reading the cached
 * backlog only — never a live re-scan).
 *
 * `ControlSecurity.available` is NOT a sourceQuality field (no
 * `{sourceState, complete, reason}` shape) but the same epistemic instinct
 * applies: `available: false` means "no cached security data was found" —
 * absent backlog, empty backlog, or no security-source items — and must
 * render distinctly from "available: true, 0 findings" (an actually clean
 * scan). Collapsing those two into one "0 findings" state would be exactly
 * the kind of guess-dressed-as-fact Epistemic exists to prevent elsewhere.
 *
 * Severity ('critical'|'high'|'medium'|'low') isn't in StatusBadge's
 * STATUS_TONE map (it's a priority scale, not a lifecycle status) — mapped
 * to a tone locally and passed via StatusBadge's existing `tone` override
 * rather than editing the shared statusToTone() mapping other views depend
 * on.
 */
import { useMemo, useRef, useState } from 'react';
import { controlSnapshotQuery } from '../../../data/queries.js';
import { useQuery } from '../../../data/hooks.js';
import { useScrollRestore } from '../../../hooks/useScrollRestore.js';
import { StatusBadge, type Tone } from '../../../components/primitives/StatusBadge.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import styles from './SecurityView.module.css';

const SEVERITY_TONE: Record<string, Tone> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
};

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function SecurityView() {
  const containerRef = useRef<HTMLDivElement>(null);
  useScrollRestore('/control/security', containerRef);

  const query = useQuery(controlSnapshotQuery);
  const security = query.data?.security;

  const [search, setSearch] = useState('');
  const [severityFilter, setSeverityFilter] = useState('all');
  const [repoFilter, setRepoFilter] = useState('all');

  const repos = useMemo(
    () => Array.from(new Set((security?.findings ?? []).map((f) => f.repo))).sort(),
    [security],
  );

  const filtered = useMemo(() => {
    const findings = security?.findings ?? [];
    return findings
      .filter((f) => (severityFilter === 'all' ? true : f.severity === severityFilter))
      .filter((f) => (repoFilter === 'all' ? true : f.repo === repoFilter))
      .filter((f) => {
        if (!search.trim()) return true;
        const q = search.trim().toLowerCase();
        return f.title.toLowerCase().includes(q) || f.repo.toLowerCase().includes(q);
      })
      .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  }, [security, severityFilter, repoFilter, search]);

  return (
    <div ref={containerRef} className={styles.view}>
      <header className={styles.header}>
        <h1 className={styles.title}>Security</h1>
        <div className={styles.freshness} aria-live="polite">
          {query.status === 'refreshing' ? <RefreshIndicator /> : null}
        </div>
      </header>

      {query.status === 'loading' ? (
        <SkeletonLine width="60%" />
      ) : query.status === 'error' || !security ? (
        <p className={styles.error} role="alert">
          {query.error?.message ?? 'Failed to load control snapshot.'}
        </p>
      ) : !security.available ? (
        <p className={styles.unavailable}>
          No cached security data available — the backlog is absent, empty, or has no security-source findings.
          This is not the same as "clean": it means binshield hasn't produced cached findings for this fleet yet.
        </p>
      ) : (
        <>
          <div className={styles.counts}>
            <div className={`${styles.countTile} ${styles.critical}`}>
              <span className={styles.countValue}>{security.counts.critical}</span>
              <span className={styles.countLabel}>Critical</span>
            </div>
            <div className={`${styles.countTile} ${styles.high}`}>
              <span className={styles.countValue}>{security.counts.high}</span>
              <span className={styles.countLabel}>High</span>
            </div>
            <div className={`${styles.countTile} ${styles.medium}`}>
              <span className={styles.countValue}>{security.counts.medium}</span>
              <span className={styles.countLabel}>Medium</span>
            </div>
            <div className={`${styles.countTile} ${styles.low}`}>
              <span className={styles.countValue}>{security.counts.low}</span>
              <span className={styles.countLabel}>Low</span>
            </div>
          </div>

          <form
            className={styles.filters}
            role="search"
            aria-label="Filter findings"
            onSubmit={(e) => e.preventDefault()}
          >
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Search</span>
              <input
                type="text"
                className={styles.input}
                placeholder="title or repo"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Severity</span>
              <select className={styles.select} value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)}>
                <option value="all">All</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Repo</span>
              <select className={styles.select} value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)}>
                <option value="all">All</option>
                {repos.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          </form>

          {filtered.length === 0 ? (
            <p className={styles.empty}>No findings match the current filters.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Severity</th>
                    <th scope="col">Repo</th>
                    <th scope="col">Finding</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((f, i) => (
                    <tr key={`${f.repo}-${f.title}-${i}`}>
                      <td>
                        <StatusBadge status={f.severity} tone={SEVERITY_TONE[f.severity] ?? 'neutral'} />
                      </td>
                      <td className={styles.mono}>{f.repo}</td>
                      <td>{f.title}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
